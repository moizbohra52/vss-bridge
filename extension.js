'use strict';

/**
 * VSS Bridge - Dreamweaver-style Visual SourceSafe integration for VS Code.
 *
 * Core behaviour (like Dreamweaver's "Check In/Out" site feature):
 *   - When you OPEN a file that belongs to a VSS project, the extension asks:
 *       [Check Out and Edit] [View Only] [Don't Ask Again]
 *   - Files already checked out by you are opened silently in edit mode.
 *   - Files checked out by somebody else are reported and opened read-only.
 *   - "View Only" keeps the Windows read-only attribute on the file, so an
 *     accidental save cannot modify the working copy.
 *
 * All VSS work is delegated to ss.exe (see lib/ssClient.js).
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const PKG = require('./package.json');
const { SsClient, SsError, glDir, lookupListing } = require('./lib/ssClient');
const { HistoryPanel } = require('./lib/historyPanel');
const { mapToVssPath: computeVssPath, normalizeVssProject } = require('./lib/vssPaths');

const BRAND = 'Developed by Moiz Bohra';                     // author credit
const BRAND_LINE = `VSS Bridge v${PKG.version} \u00b7 ${BRAND}`; // tooltip footer

let client = null;              // current SsClient
let context = null;             // vscode.ExtensionContext
let statusBarItem = null;       // status bar entry
let logChannel = null;          // vscode.OutputChannel
let statusCache = new Map();    // uri string -> { when, info }
const handledDocs = new Set();  // uris already prompted / decided this session
let activating = false;

// --------------------------------------------------------------------- //
//  Configuration                                                        //
// --------------------------------------------------------------------- //

function readConfig() {
  const cfg = vscode.workspace.getConfiguration('vssBridge');
  const folder = firstWorkspaceFolder();
  return {
    ssExePath: (cfg.get('ssExePath') || 'ss.exe').trim(),
    databasePath: (cfg.get('databasePath') || '').trim(),
    username: (cfg.get('username') || '').trim(),
    password: cfg.get('password') || '',
    vssProject: normalizeVssProject(cfg.get('vssProject') || '$/'),
    mappings: cfg.get('mappings') || [],
    promptOnOpen: cfg.get('promptOnOpen', true),
    ignoredFileTypes: new Set((cfg.get('ignoredFileTypes') || [])
      .map(e => String(e).replace(/^\./, '').toLowerCase())),
    autoGetWhenMissing: cfg.get('autoGetWhenMissing', true),
    timeoutSeconds: cfg.get('timeoutSeconds', 60),
    statusBarEnabled: cfg.get('statusBarEnabled', true),
    explorerDecorations: cfg.get('explorerDecorations', true),
    explorerRefreshMinutes: cfg.get('explorerRefreshMinutes', 5),
    workspaceFolder: folder
  };
}

function firstWorkspaceFolder() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length ? folders[0] : null;
}

/** Append a line to the "VSS Bridge" output channel (lazy created). */
function log(line) {
  if (!logChannel) {
    logChannel = vscode.window.createOutputChannel('VSS Bridge');
    if (context) { context.subscriptions.push(logChannel); }
  }
  const now = new Date().toTimeString().slice(0, 8);
  logChannel.appendLine(`[${now}] ${line}`);
}

function rebuildClient() {
  const cfg = readConfig();
  client = new SsClient({
    ssExePath: cfg.ssExePath,
    databasePath: cfg.databasePath,
    username: cfg.username,
    password: cfg.password,
    timeoutMs: Math.max(5, cfg.timeoutSeconds) * 1000,
    cwd: cfg.workspaceFolder ? cfg.workspaceFolder.uri.fsPath : undefined,
    logger: (line) => log(line)
  });
  statusCache.clear();
  folderStatus.clear();
  badgesChanged.fire(undefined);
  return cfg;
}

function configMissing(cfg) {
  const problems = [];
  if (!cfg.databasePath) { problems.push('vssBridge.databasePath (folder that contains srcsafe.ini)'); }
  if (!cfg.username) { problems.push('vssBridge.username'); }
  return problems;
}

// --------------------------------------------------------------------- //
//  Path helpers                                                         //
// --------------------------------------------------------------------- //

/** Map a workspace file URI to its VSS path, e.g. $/MyApp/src/main.frm. */
function mapToVssPath(uri) {
  const cfg = readConfig();
  if (!cfg.workspaceFolder) { return null; }
  return computeVssPath(uri.fsPath, cfg.workspaceFolder.uri.fsPath, cfg.mappings, cfg.vssProject);
}

function fileIsIgnored(uri) {
  const cfg = readConfig();
  const ext = path.extname(uri.fsPath).replace(/^\./, '').toLowerCase();
  return ext !== '' && cfg.ignoredFileTypes.has(ext);
}

function isWritable(fsPath) {
  try { fs.accessSync(fsPath, fs.constants.W_OK); return true; }
  catch (e) { return false; }
}

function setReadOnly(fsPath, readOnly) {
  try {
    const stat = fs.statSync(fsPath);
    let mode = stat.mode;
    if (readOnly) { mode &= ~(0o200 | 0o020 | 0o002); }
    else { mode |= 0o200; }
    fs.chmodSync(fsPath, mode);
    return true;
  } catch (e) {
    return false;
  }
}

// --------------------------------------------------------------------- //
//  Serialized ss.exe access (avoid concurrent VSS operations)           //
// --------------------------------------------------------------------- //

function serialQueue() {
  let tail = Promise.resolve();
  return (job) => {
    const run = tail.then(job, job);
    tail = run.catch(() => { /* keep queue alive */ });
    return run;
  };
}
// NOTE: never call the do* commands (doCheckout / doCheckin / doGetLatest ...)
// from INSIDE an enqueued job - they enqueue again, so the inner job would
// wait for the outer one to finish while the outer one waits for the inner:
// a deadlock that silently stops every later VSS operation until reload.
const enqueue = serialQueue();
// Read-only `ss Dir` for Explorer badges: own lane so badges never delay a check-in.
const enqueueListing = serialQueue();

// --------------------------------------------------------------------- //
//  Explorer badges: one quick `ss Dir -E` per folder you look at        //
//  (a recursive scan of a big project takes a minute, one folder ~0.3s) //
// --------------------------------------------------------------------- //

const folderStatus = new Map();                    // lower-case VSS folder -> { when, listing, loading, stale }
const badgesChanged = new vscode.EventEmitter();
let badgeTimer = null;

/** VSS path of a local file, split into its project folder and file name. */
function vssLocation(uri) {
  const vssPath = mapToVssPath(uri);
  if (!vssPath) { return null; }
  const i = vssPath.lastIndexOf('/');
  return { vssPath, folder: i <= 1 ? '$/' : vssPath.slice(0, i), name: vssPath.slice(i + 1) };
}

/** (Re)read one VSS folder in the background; resolves when the listing is in. */
function loadFolderStatus(folder) {
  const key = folder.toLowerCase();
  const entry = folderStatus.get(key) || { when: 0, listing: null };
  folderStatus.set(key, entry);
  entry.stale = false;
  const job = enqueueListing(async () => {
    try {
      entry.listing = await client.dirListing(folder);
    } catch (err) {
      if (err instanceof SsError && err.kind === 'notfound') { entry.listing = { free: new Set(), out: [] }; }
      else { log(`Explorer status of ${folder} failed: ${err && err.message ? err.message : err}`); }
    }
    entry.when = Date.now();
    if (entry.loading === job) { entry.loading = null; }
    badgesChanged.fire(undefined);
  });
  entry.loading = job;
  return job;
}

/** Last known VSS state of a file from its folder listing, or null if not loaded. */
function cachedStatus(loc) {
  const e = folderStatus.get(loc.folder.toLowerCase());
  return e && e.listing ? lookupListing(e.listing, loc.name) : null;
}

/** Re-read the folder of a file after one of our own VSS actions changed it. */
function refreshBadges(uri) {
  const loc = vssLocation(uri);
  if (loc && folderStatus.has(loc.folder.toLowerCase())) { loadFolderStatus(loc.folder); }
}

const badgeProvider = {
  onDidChangeFileDecorations: badgesChanged.event,
  provideFileDecoration(uri) {
    if (uri.scheme !== 'file' || !client.configured) { return undefined; }
    const cfg = readConfig();
    if (!cfg.explorerDecorations) { return undefined; }
    const loc = vssLocation(uri);
    if (!loc) { return undefined; }
    const e = folderStatus.get(loc.folder.toLowerCase());
    const maxAge = cfg.explorerRefreshMinutes * 60000;
    if (!e || (!e.loading && (e.stale || (maxAge > 0 && Date.now() - e.when > maxAge)))) {
      loadFolderStatus(loc.folder);
    }
    const st = cachedStatus(loc);
    if (!st || !st.checkedOut) { return undefined; }
    const deco = new vscode.FileDecoration('✓',
      st.byMe ? 'VSS: checked out by you' : `VSS: checked out by ${st.user}`,
      new vscode.ThemeColor(st.byMe ? 'vssBridge.checkedOutByMe' : 'vssBridge.checkedOutByOther'));
    deco.propagate = st.byMe; // tint parent folders only for your own checkouts
    return deco;
  }
};

/** Periodic refresh: VS Code re-asks the visible files, stale folders reload. */
function restartBadgeTimer() {
  clearInterval(badgeTimer);
  const minutes = readConfig().explorerRefreshMinutes;
  badgeTimer = minutes > 0 ? setInterval(() => badgesChanged.fire(undefined), minutes * 60000) : null;
}

// --------------------------------------------------------------------- //
//  Document reload helper                                               //
// --------------------------------------------------------------------- //

async function revertDocument(uri) {
  const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
  if (!doc) { return; }
  try {
    const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());
    if (editor) {
      await vscode.window.showTextDocument(editor.document, editor.viewColumn);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    } else {
      await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  } catch (e) {
    // revert is best effort
  }
}

// --------------------------------------------------------------------- //
//  THE Dreamweaver-style open prompt                                    //
// --------------------------------------------------------------------- //

/**
 * Decide what to do with a file that was just opened in the editor.
 *
 * Runs in TWO phases (this avoids the nested-enqueue deadlock):
 *   Phase 1 - enqueued: ss.exe status + auto Get Latest for missing files.
 *   Phase 2 - the queue is FREE: show the Dreamweaver prompt and, on choice,
 *   call the normal do* wrappers (they enqueue their own work safely).
 */
async function handleOpenDocument(uri, source) {
  if (!uri || uri.scheme !== 'file') { return; }
  const key = uri.toString();
  if (handledDocs.has(key)) { return; }
  handledDocs.add(key); // mark early so parallel open events don't double-prompt

  const cfg = readConfig();

  if (!cfg.promptOnOpen) { return; }
  if (fileIsIgnored(uri)) { return; }

  const vssPath = mapToVssPath(uri);
  if (!vssPath) { return; } // outside the mapped workspace folder

  const fsPath = uri.fsPath;
  const writable = fs.existsSync(fsPath) && isWritable(fsPath);

  // Smart skip: a writable file means it is (almost certainly) already
  // checked out to us - open silently like Dreamweaver does.
  if (writable) {
    updateStatusBarFor(uri);
    return;
  }

  if (!client.configured) {
    const problems = configMissing(cfg);
    const choice = await vscode.window.showInformationMessage(
      'VSS Bridge is not configured yet, so this file was opened as view only. Configure VSS settings now?',
      'Open Settings'
    );
    if (choice === 'Open Settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:MoizBohra');
    }
    return;
  }

  // ---- Phase 1: VSS status + auto get-latest (serialized queue work) ----
  let info = null;
  try {
    info = await enqueue(async () => {
      let st;
      try {
        st = await client.status(vssPath);
      } catch (err) {
        if (err instanceof SsError && err.kind === 'notfound') {
          // File is not in VSS (e.g. brand new local file) - nothing to ask.
          updateStatusBarFor(uri);
          return null;
        }
        throw err;
      }

      statusCache.set(key, { when: Date.now(), info: st });

      if (!st.exists) {
        updateStatusBarFor(uri);
        return null;
      }

      if (st.checkedOut && st.byMe) {
        // Checked out by me but the file is read-only locally (unusual).
        // Clear the read-only attribute so it can be edited.
        setReadOnly(fsPath, false);
        await revertDocument(uri);
        updateStatusBarFor(uri);
        return null;
      }

      // Local copy missing? Fetch the latest before asking.
      if (!fs.existsSync(fsPath) && cfg.autoGetWhenMissing) {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `VSS: getting ${path.basename(fsPath)}...` },
          () => client.get(vssPath, glDir(path.dirname(fsPath)))
        );
        setReadOnly(fsPath, true);
      }
      return st;
    });
  } catch (err) {
    handledDocs.delete(key); // allow retry on next open
    showVssError(err, vssPath);
    return;
  }

  if (!info) { return; } // fully handled inside the queue job

  // ---- Phase 2: ask the user (the queue is free here, so calling the
  // do* commands below is safe - each one enqueues its own work). ----
  if (info.checkedOut && !info.byMe) {
    const choice = await vscode.window.showWarningMessage(
      `"${path.basename(fsPath)}" is checked out from VSS by ${info.user}. It will open as view only.`,
      'View Only',
      'Get Latest Copy',
      'Try Check Out Anyway'
    );
    if (choice === 'Get Latest Copy') {
      await doGetLatest(uri, { skipConfirm: true });
    } else if (choice === 'Try Check Out Anyway') {
      await doCheckout(uri, { silent: false });
    } else {
      setReadOnly(fsPath, true);
    }
    updateStatusBarFor(uri);
    return;
  }

  // Free file - the classic Dreamweaver question.
  const choice = await vscode.window.showInformationMessage(
    `You opened "${path.basename(fsPath)}" from VSS. How do you want to continue?`,
    { modal: false },
    'Check Out and Edit',
    'View Only',
    "Don't Ask for This File"
  );

  if (choice === 'Check Out and Edit') {
    await doCheckout(uri, { silent: true });
  } else if (choice === "Don't Ask for This File") {
    // keep as view only; do nothing (already read-only)
    vscode.window.showInformationMessage(
      `VSS Bridge will not ask again for "${path.basename(fsPath)}" in this session. You can still check it out from the context menu or status bar.`);
  } else {
    // View Only (or Esc) - ensure read-only so accidental saves fail.
    if (fs.existsSync(fsPath)) { setReadOnly(fsPath, true); }
  }
  updateStatusBarFor(uri);
}

// --------------------------------------------------------------------- //
//  Command implementations                                              //
// --------------------------------------------------------------------- //

/** Resolve the target URI from a command argument or the active editor. */
function resolveTargetUri(arg) {
  if (arg && arg.fsPath) { return arg; }              // vscode.Uri
  if (arg && arg.resourceUri && arg.resourceUri.fsPath) { return arg.resourceUri; }
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file') { return editor.document.uri; }
  return null;
}

async function doCheckout(uri, { silent = false, overwriteOk = false } = {}) {
  if (!uri) { uri = resolveTargetUri(); }
  if (!uri) { return; }
  const vssPath = mapToVssPath(uri);
  if (!vssPath) { vscode.window.showErrorMessage('VSS Bridge: this file is outside the mapped workspace folder.'); return; }

  // ss Checkout -I-Y replaces a writable local copy, which would silently destroy local edits.
  if (!overwriteOk && fs.existsSync(uri.fsPath) && isWritable(uri.fsPath)) {
    const choice = await vscode.window.showWarningMessage(
      `"${path.basename(uri.fsPath)}" is editable locally (already checked out, or it has local changes). ` +
      'Check Out replaces it with the VSS version. Continue?',
      { modal: true },
      'Overwrite and Check Out'
    );
    if (choice !== 'Overwrite and Check Out') { return; }
  }

  const key = uri.toString();
  await enqueue(async () => {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `VSS: checking out ${path.basename(uri.fsPath)}...` },
        () => client.checkout(vssPath, glDir(path.dirname(uri.fsPath)))
      );
      setReadOnly(uri.fsPath, false);
      statusCache.delete(key);
      refreshBadges(uri);
      await revertDocument(uri);
      updateStatusBarFor(uri);
      if (!silent) {
        vscode.window.showInformationMessage(`VSS Bridge: "${path.basename(uri.fsPath)}" checked out - you can edit it now.`);
      }
    } catch (err) {
      handleOperationError(err, uri, vssPath, 'checkout');
    }
  });
}

async function doCheckin(uri) {
  if (!uri) { uri = resolveTargetUri(); }
  if (!uri) { return; }
  const vssPath = mapToVssPath(uri);
  if (!vssPath) { vscode.window.showErrorMessage('VSS Bridge: this file is outside the mapped workspace folder.'); return; }

  // Save any pending changes first (VSS checks in what is on disk).
  const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
  if (doc && doc.isDirty) {
    await doc.save();
  }

  const key = uri.toString();

  // ---- Pre-flight check (own queue job, BEFORE asking for a comment) ----
  // Gives friendly warnings instead of cryptic ss.exe errors:
  //   - file not in VSS              -> not-found dialog
  //   - checked out by someone else  -> says WHO has it
  //   - not checked out at all       -> "there is nothing to check in"
  let info = null;
  try {
    info = await enqueue(async () => {
      try {
        const st = await client.status(vssPath);
        log(`CHECK-IN pre-flight status for ${vssPath}: ` +
          `exists=${st.exists} checkedOut=${st.checkedOut} byMe=${st.byMe} user="${st.user}"`);
        return st;
      }
      catch (preErr) {
        log(`CHECK-IN pre-flight status FAILED for ${vssPath}: ${preErr && preErr.message ? preErr.message : preErr}`);
        return null; /* let ss.exe decide during checkin */
      }
    });
  } catch (preErr) {
    info = null; // never block the check-in flow on a status hiccup
  }

  if (info && !info.exists) {
    handleOperationError(
      new SsError(`"${path.basename(uri.fsPath)}" is not in the VSS database at ${vssPath}. ` +
        'Add it from VSS Explorer first, or fix the folder mapping.', 'notfound', 100),
      uri, vssPath, 'checkin');
    return;
  }
  if (info && info.exists && info.checkedOut && !info.byMe) {
    // Sanity check: maybe the byMe comparison failed due to a username
    // formatting mismatch (DOMAIN\user vs user, case, etc). If the local
    // file is writable (which strongly suggests we have it checked out),
    // ask the user before blocking the check-in.
    const localWritable = fs.existsSync(uri.fsPath) && isWritable(uri.fsPath);
    if (localWritable) {
      const choice = await vscode.window.showWarningMessage(
        `VSS Bridge: VSS reports that "${path.basename(uri.fsPath)}" is checked out by "${info.user}", ` +
        `but your local copy is editable (which usually means you have it checked out).\n\n` +
        'This can happen when the VSS username in your settings does not exactly match the name VSS reports. ' +
        'Do you want to proceed with the check-in anyway?',
        { modal: true },
        'Check In Anyway',
        'Cancel'
      );
      if (choice !== 'Check In Anyway') { return; }
      // Fall through to the normal check-in flow below.
    } else {
      vscode.window.showErrorMessage(
        `VSS Bridge: "${path.basename(uri.fsPath)}" is checked out by "${info.user}" (someone else). ` +
        'You cannot check in a file that another user has checked out - ask them to check it in first.\n\n' +
        'If you believe this is your own checkout, check that "vssBridge.username" matches the name VSS knows you by.',
        'Open Settings'
      ).then(c => { if (c === 'Open Settings') { vscode.commands.executeCommand('vssBridge.configure'); } });
      return;
    }
  }
  if (info && info.exists && !info.checkedOut) {
    // File is checked in (free) - there is nothing to submit to VSS.
    // Branch on whether the user has local edits worth preserving:
    //   - writable local file -> they edited it without checking out, and a
    //     naive "Check Out" would overwrite + destroy their work -> smart flow
    //   - read-only local file -> pristine VSS copy, just offer Check Out
    const hasLocalEdits = fs.existsSync(uri.fsPath) && isWritable(uri.fsPath);

    if (hasLocalEdits) {
      // Smart flow: preserve the user's local changes through the checkout.
      const choice = await vscode.window.showWarningMessage(
        `"${path.basename(uri.fsPath)}" is NOT checked out in VSS, but your local copy is editable and may contain changes.\n\n` +
        'A normal "Check Out" would overwrite your local file with the VSS version, and your work would be LOST.\n\n' +
        'What do you want to do?',
        { modal: true },
        'Check Out, Keep My Changes & Check In',
        'Just Check Out (Discard My Changes)',
        'Cancel'
      );
      if (!choice || choice === 'Cancel') { return; }
      if (choice === 'Just Check Out (Discard My Changes)') {
        await doCheckout(uri, { silent: false, overwriteOk: true }); // safe: pre-flight job already finished
        return;
      }
      await smartCheckoutAndCheckin(uri, vssPath); // smart flow (atomic, deadlock-safe)
      return;
    }

    // No local edits - simple "nothing to check in" message + offer Check Out.
    const choice = await vscode.window.showWarningMessage(
      `"${path.basename(uri.fsPath)}" is NOT checked out. Its latest version is already in VSS, ` +
      'so there is nothing to check in.\n\n' +
      'If you want to make changes, check out the file first.',
      'Check Out and Edit',
      'OK'
    );
    if (choice === 'Check Out and Edit') {
      await doCheckout(uri, { silent: false }); // safe: the pre-flight job above has finished
    }
    return;
  }

  const comment = await vscode.window.showInputBox({
    prompt: `Check-in comment for "${path.basename(uri.fsPath)}" (optional - press Enter to skip)`,
    placeHolder: 'e.g. Fixed null reference in payment module'
  });
  if (comment === undefined) { return; } // user cancelled

  await enqueue(async () => {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `VSS: checking in ${path.basename(uri.fsPath)}...` },
        () => client.checkin(vssPath, glDir(path.dirname(uri.fsPath)), comment.trim())
      );
      setReadOnly(uri.fsPath, true);
      statusCache.delete(key);
      handledDocs.delete(key); // next open should ask again
      refreshBadges(uri);
      await revertDocument(uri);
      updateStatusBarFor(uri);
      vscode.window.showInformationMessage(`VSS Bridge: "${path.basename(uri.fsPath)}" checked in successfully.`);
    } catch (err) {
      handleOperationError(err, uri, vssPath, 'checkin');
    }
  });
}

/**
 * Smart Check In flow for the case where the file is NOT checked out in VSS
 * but the user has local edits they want to commit.
 *
 * The naive approach (run ss Checkout) would overwrite the local file with
 * the VSS version and silently destroy the user's work. To avoid this we:
 *   1. Read the current local file content into memory (backup buffer).
 *   2. Ask for the check-in comment (outside the queue, so the queue is not
 *      blocked while the user thinks).
 *   3. In a SINGLE enqueued job (atomic w.r.t. other VSS operations):
 *      a) ss Checkout    -> VSS marks the file as checked out by us; ss.exe
 *                           also writes the latest VSS version to disk,
 *                           overwriting the user's local file.
 *      b) fs.writeFileSync(backup) -> restore the user's content on disk.
 *      c) ss Checkin     -> commit the restored content to VSS with comment.
 *   4. On success: file is now checked in (read-only), status cache cleared,
 *      document reloaded, success message shown.
 *   5. On failure: if (a) succeeded but (c) failed, the file is now checked
 *      out to us with the user's content safely on disk - we tell the user
 *      to retry Check In or Undo Checkout. If (a) failed, nothing changed.
 */
async function smartCheckoutAndCheckin(uri, vssPath) {
  const fsPath = uri.fsPath;
  const basename = path.basename(fsPath);
  const localDir = glDir(path.dirname(fsPath));
  const key = uri.toString();

  // 1. Read a backup of the user's local content (synchronous, outside queue).
  let backupContent;
  try {
    backupContent = fs.readFileSync(fsPath);
  } catch (e) {
    vscode.window.showErrorMessage(
      `VSS Bridge: cannot read the local file to back up your changes - ${e.message}`);
    return;
  }

  // 2. Ask for the check-in comment BEFORE entering the queue (so the queue
  //    is not stalled while the user is typing).
  const comment = await vscode.window.showInputBox({
    prompt: `Check-in comment for "${basename}" (optional - press Enter to skip)`,
    placeHolder: 'e.g. Fixed null reference in payment module'
  });
  if (comment === undefined) { return; } // user cancelled - file untouched

  // 3. Atomic checkout -> restore -> checkin (single enqueued job).
  await enqueue(async () => {
    let checkoutSucceeded = false;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification,
          title: `VSS: preserving your changes and checking in ${basename}...` },
        async () => {
          // (a) ss Checkout - marks the file as checked out by us in VSS, and
          //     overwrites the local file with the VSS version.
          log(`SMART-CHECKIN step 1/3: ss Checkout ${vssPath}`);
          await client.checkout(vssPath, localDir);
          checkoutSucceeded = true;

          // (b) Restore the user's content on top of the freshly checked-out
          //     file. ss Checkout MAY leave the local file read-only on some
          //     VSS configurations, so clear the attribute first - otherwise
          //     writeFileSync throws EACCES and the user's edits never reach
          //     the check-in step.
          setReadOnly(fsPath, false);
          log(`SMART-CHECKIN step 2/3: restoring user content (${backupContent.length} bytes)`);
          try {
            fs.writeFileSync(fsPath, backupContent);
          } catch (writeErr) {
            // Restore failed - the file is checked out to us but contains the
            // VSS version. Tell the user their edits are lost from disk but
            // still safe in our in-memory backup; they can paste them back.
            log(`SMART-CHECKIN step 2/3 FAILED: ${writeErr.message}`);
            throw new Error(
              'Could not restore your local changes after checkout: ' + writeErr.message +
              '. Your edits are still in memory but the file on disk now has the VSS version.');
          }

          // (c) ss Checkin - commits the restored content to VSS.
          log(`SMART-CHECKIN step 3/3: ss Checkin ${vssPath}`);
          await client.checkin(vssPath, localDir, comment.trim());
        }
      );

      // 4. Success: file is now checked in (read-only), refresh state.
      setReadOnly(fsPath, true);
      statusCache.delete(key);
      handledDocs.delete(key);
      refreshBadges(uri);
      await revertDocument(uri);
      updateStatusBarFor(uri);
      log(`SMART-CHECKIN SUCCESS: ${basename}`);
      vscode.window.showInformationMessage(
        `VSS Bridge: "${basename}" was checked out, your local changes were preserved, and the file was checked in successfully.`);
    } catch (err) {
      log(`SMART-CHECKIN FAILED: ${err && err.message ? err.message : err}`);
      // 5. Failure handling - keep the user's content safe and tell them what to do.
      if (checkoutSucceeded) {
        // Best-effort: make sure the user's content is on disk.
        try { setReadOnly(fsPath, false); fs.writeFileSync(fsPath, backupContent); }
        catch (e) { /* best effort - log only */ log(`SMART-CHECKIN restore-on-failure failed: ${e.message}`); }
        // Make the file writable so they can keep editing if they want.
        setReadOnly(fsPath, false);
        statusCache.delete(key);
        handledDocs.delete(key);
        refreshBadges(uri);
        updateStatusBarFor(uri);
        const detail = (err && err.message) ? err.message : String(err);
        vscode.window.showErrorMessage(
          `VSS Bridge: the smart check-in did not finish. ${detail}\n\n` +
          'Your local changes are safe on disk and the file is now checked out to you in VSS. ' +
          'You can retry "VSS: Check In", or "VSS: Undo Checkout" to discard.',
          'Show Output Log'
        ).then(c => { if (c === 'Show Output Log') { logChannel && logChannel.show(); } });
        return;
      }
      // Checkout itself failed - nothing changed, file is in its original state.
      handleOperationError(err, uri, vssPath, 'smart-checkin');
    }
  });
}

async function doUndoCheckout(uri) {
  if (!uri) { uri = resolveTargetUri(); }
  if (!uri) { return; }
  const vssPath = mapToVssPath(uri);
  if (!vssPath) { vscode.window.showErrorMessage('VSS Bridge: this file is outside the mapped workspace folder.'); return; }

  const choice = await vscode.window.showWarningMessage(
    `Undo checkout of "${path.basename(uri.fsPath)}"? Your local changes will be REPLACED with the latest VSS version.`,
    { modal: true },
    'Undo Checkout'
  );
  if (choice !== 'Undo Checkout') { return; }

  const key = uri.toString();
  await enqueue(async () => {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `VSS: undoing checkout of ${path.basename(uri.fsPath)}...` },
        () => client.undoCheckout(vssPath, glDir(path.dirname(uri.fsPath)))
      );
      setReadOnly(uri.fsPath, true);
      statusCache.delete(key);
      handledDocs.delete(key);
      refreshBadges(uri);
      await revertDocument(uri);
      updateStatusBarFor(uri);
      vscode.window.showInformationMessage(`VSS Bridge: checkout of "${path.basename(uri.fsPath)}" was undone.`);
    } catch (err) {
      showVssError(err, vssPath);
    }
  });
}

async function doGetLatest(uri, { skipConfirm = false } = {}) {
  if (!uri) { uri = resolveTargetUri(); }
  if (!uri) { return; }
  const vssPath = mapToVssPath(uri);
  if (!vssPath) { vscode.window.showErrorMessage('VSS Bridge: this file is outside the mapped workspace folder.'); return; }

  const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
  // A writable file may hold saved edits (e.g. checked out) - ss Get -I-Y would silently overwrite them.
  if (!skipConfirm && ((doc && doc.isDirty) || isWritable(uri.fsPath))) {
    const choice = await vscode.window.showWarningMessage(
      `"${path.basename(uri.fsPath)}" may have local changes (unsaved, or saved in an editable / checked-out file). Get Latest will overwrite the local file. Continue?`,
      { modal: true },
      'Overwrite and Get'
    );
    if (choice !== 'Overwrite and Get') { return; }
  }

  const key = uri.toString();
  await enqueue(async () => {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `VSS: getting latest ${path.basename(uri.fsPath)}...` },
        () => client.get(vssPath, glDir(path.dirname(uri.fsPath)))
      );
      if (!isWritable(uri.fsPath)) { setReadOnly(uri.fsPath, true); }
      statusCache.delete(key);
      await revertDocument(uri);
      updateStatusBarFor(uri);
      vscode.window.showInformationMessage(`VSS Bridge: latest version of "${path.basename(uri.fsPath)}" retrieved.`);
    } catch (err) {
      showVssError(err, vssPath);
    }
  });
}

async function doShowHistory(uri) {
  if (!uri) { uri = resolveTargetUri(); }
  if (!uri) { return; }
  const vssPath = mapToVssPath(uri);
  if (!vssPath) { vscode.window.showErrorMessage('VSS Bridge: this file is outside the mapped workspace folder.'); return; }

  await enqueue(async () => {
    try {
      const versions = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `VSS: loading history of ${path.basename(uri.fsPath)}...` },
        () => client.history(vssPath)
      );
      HistoryPanel.show(context, path.basename(uri.fsPath) + '  (' + vssPath + ')', versions);
    } catch (err) {
      showVssError(err, vssPath);
    }
  });
}

/** Manual trigger of the View/Checkout prompt (context menu / palette). */
async function doOpenPrompt(uri) {
  if (!uri) { uri = resolveTargetUri(); }
  if (!uri) { return; }
  const key = uri.toString();
  handledDocs.delete(key);
  statusCache.delete(key);
  await handleOpenDocument(uri, 'manual');
}

// --------------------------------------------------------------------- //
//  Several files at once (Explorer multi-select, folders, my checkouts) //
// --------------------------------------------------------------------- //

const BATCH_OPS = {
  checkout: { title: 'Check Out', done: 'checked out', run: (v, d) => client.checkout(v, d), readOnly: false },
  checkin: { title: 'Check In', done: 'checked in', run: (v, d, c) => client.checkin(v, d, c), readOnly: true },
  undo: { title: 'Undo Checkout', done: 'undone', run: (v, d) => client.undoCheckout(v, d), readOnly: true },
  get: { title: 'Get Latest', done: 'retrieved', run: (v, d) => client.get(v, d), readOnly: null }
};

/**
 * Explorer commands get (clicked, allSelected). One file keeps the detailed
 * single-file flow; several files or a folder (recursive) go to runBatch.
 */
async function runOn(op, single, arg, selected) {
  const picked = Array.isArray(selected) && selected.length ? selected : [resolveTargetUri(arg)];
  const files = [];
  let hadFolder = false;
  for (const u of picked) {
    if (!u || u.scheme !== 'file') { continue; }
    let isDir = false;
    try { isDir = fs.statSync(u.fsPath).isDirectory(); } catch (e) { /* not on disk yet - still a VSS file */ }
    if (!isDir) { files.push(u); continue; }
    hadFolder = true;
    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(u, '**/*'));
    files.push(...found.filter(f => !/\.scc$/i.test(f.fsPath))); // vssver2.scc = VSS bookkeeping
  }
  const unique = [...new Map(files.map(u => [u.toString(), u])).values()];
  if (unique.length === 1 && !hadFolder) { return single(unique[0]); }
  if (unique.length) { return runBatch(op, unique); }
  if (hadFolder) { vscode.window.showInformationMessage('VSS Bridge: no files found in the selected folder.'); }
}

async function runBatch(op, uris) {
  const spec = BATCH_OPS[op];
  if (!client.configured) { await vscode.commands.executeCommand('vssBridge.configure'); return; }
  const items = uris.map(uri => ({ uri, loc: vssLocation(uri) })).filter(x => x.loc);
  let skipped = uris.length - items.length; // outside the mapped folders

  // Fresh state of every involved folder, so only files that make sense are touched.
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'VSS: reading file status...' },
    () => Promise.all([...new Set(items.map(x => x.loc.folder))].map(loadFolderStatus)));
  // Unknown state (listing failed) falls back to the writable-file heuristic.
  const mine = x => { const st = cachedStatus(x.loc); return st ? st.byMe : isWritable(x.uri.fsPath); };
  const inVss = x => { const st = cachedStatus(x.loc); return !st || st.exists; };
  const wanted = op === 'checkin' || op === 'undo' ? mine
    : op === 'checkout' ? (x => inVss(x) && !mine(x))
    : inVss;
  let targets = items.filter(wanted);
  skipped += items.length - targets.length;

  let comment = '';
  if (targets.length && op === 'checkin') {
    for (const x of targets) {
      const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === x.uri.toString());
      if (doc && doc.isDirty) { await doc.save(); } // VSS checks in what is on disk
    }
    comment = await vscode.window.showInputBox({
      prompt: `Check-in comment for ${targets.length} file(s) (optional - press Enter to skip)`,
      placeHolder: 'e.g. Fixed null reference in payment module'
    });
    if (comment === undefined) { return; }
  } else if (targets.length && op === 'undo') {
    const choice = await vscode.window.showWarningMessage(
      `Undo checkout of ${targets.length} file(s)? Their local changes will be REPLACED with the latest VSS version.`,
      { modal: true }, 'Undo Checkout');
    if (choice !== 'Undo Checkout') { return; }
  } else if (targets.length) {
    // checkout / get: ss -I-Y overwrites writable local copies, which may hold edits.
    const editable = targets.filter(x => isWritable(x.uri.fsPath));
    if (editable.length) {
      const choice = await vscode.window.showWarningMessage(
        `${editable.length} of ${targets.length} file(s) are editable locally and may contain changes. ` +
        `${spec.title} replaces them with the VSS version.`,
        { modal: true }, 'Overwrite', 'Skip Editable Files');
      if (!choice) { return; }
      if (choice === 'Skip Editable Files') {
        targets = targets.filter(x => !editable.includes(x));
        skipped += editable.length;
      }
    }
  }
  if (!targets.length) {
    vscode.window.showInformationMessage(
      `VSS Bridge: nothing to ${spec.title.toLowerCase()} - ${skipped} file(s) skipped ` +
      (op === 'checkin' || op === 'undo' ? '(not checked out by you).' : '(not in VSS, or already checked out by you).'));
    return;
  }

  let done = 0;
  const failed = [];
  await enqueue(() => vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `VSS: ${spec.title} (${targets.length} files)`, cancellable: true },
    async (progress, token) => {
      for (const [i, x] of targets.entries()) {
        if (token.isCancellationRequested) { break; }
        progress.report({ message: `${i + 1}/${targets.length} ${path.basename(x.uri.fsPath)}`, increment: 100 / targets.length });
        try {
          await spec.run(x.loc.vssPath, glDir(path.dirname(x.uri.fsPath)), comment.trim());
          if (spec.readOnly !== null) { setReadOnly(x.uri.fsPath, spec.readOnly); }
          statusCache.delete(x.uri.toString());
          if (spec.readOnly) { handledDocs.delete(x.uri.toString()); } // next open should ask again
          await revertDocument(x.uri);
          done++;
        } catch (err) {
          failed.push(x);
          log(`!! ${op} failed for ${x.loc.vssPath}: ${err && err.message ? err.message : err}`);
        }
      }
    }));

  for (const f of new Set(targets.map(x => x.loc.folder))) { loadFolderStatus(f); }
  if (vscode.window.activeTextEditor) { updateStatusBarFor(vscode.window.activeTextEditor.document.uri); }
  const summary = `VSS Bridge: ${done} file(s) ${spec.done}` +
    (failed.length ? `, ${failed.length} failed` : '') + (skipped ? `, ${skipped} skipped` : '') + '.';
  if (failed.length) {
    vscode.window.showWarningMessage(summary + ' The output log has the ss.exe errors.', 'Show Output Log')
      .then(c => { if (c === 'Show Output Log') { doShowLog(); } });
  } else {
    vscode.window.showInformationMessage(summary);
  }
}

/** VSS projects the workspace maps to, minus ones nested inside another. */
function vssRoots(cfg) {
  const all = [cfg.vssProject, ...cfg.mappings.filter(m => m && m.vss).map(m => normalizeVssProject(m.vss))]
    .sort((a, b) => a.length - b.length);
  const inside = (r, p) => {
    r = r.toLowerCase(); p = p.toLowerCase();
    return r === p || r.startsWith(p === '$/' ? p : p + '/');
  };
  return all.filter((r, i) => !all.slice(0, i).some(p => inside(r, p)));
}

/** List every workspace file you have checked out and check in the ones you pick. */
async function doCheckinMine() {
  const cfg = readConfig();
  if (!client.configured) { await vscode.commands.executeCommand('vssBridge.configure'); return; }
  let uris;
  try {
    uris = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'VSS: finding files checked out by you...' },
      async () => {
        // 1. Folders holding my checkouts (ss.exe filters by user; names are cut to 19 chars).
        const mine = new Map();
        for (const root of vssRoots(cfg)) {
          const tree = await enqueue(() => client.checkedOutBy(root, cfg.username));
          for (const [folder, listing] of tree) { if (listing.out.length) { mine.set(folder, listing); } }
        }
        if (!mine.size) { return []; }
        // 2. Local files in those folders whose name matches.
        const found = (await vscode.workspace.findFiles('**/*')).filter(u => {
          const loc = vssLocation(u);
          const listing = loc && mine.get(loc.folder.toLowerCase());
          return listing && lookupListing(listing, loc.name).checkedOut;
        });
        // 3. Exact state from the full folder listings (tells apart names that share 19 chars).
        await Promise.all([...new Set(found.map(u => vssLocation(u).folder))].map(loadFolderStatus));
        return found.filter(u => { const st = cachedStatus(vssLocation(u)); return !st || st.byMe; });
      });
  } catch (err) {
    showVssError(err);
    return;
  }
  if (!uris.length) {
    vscode.window.showInformationMessage('VSS Bridge: you have no files checked out in the mapped VSS project(s).');
    return;
  }
  const picks = await vscode.window.showQuickPick(
    uris.map(uri => ({ label: path.basename(uri.fsPath), description: vscode.workspace.asRelativePath(uri), picked: true, uri })),
    { canPickMany: true, placeHolder: `${uris.length} file(s) checked out by you - untick any you do not want to check in` });
  if (picks && picks.length) { await runBatch('checkin', picks.map(p => p.uri)); }
}

/**
 * Step-by-step diagnosis: ss.exe location, srcsafe.ini reachability,
 * login, and whether the active file's mapped VSS path really exists.
 * Everything is written to the output channel and shown to the user.
 */
async function doTestConnection(uri) {
  if (!uri) { uri = resolveTargetUri(); }
  const cfg = readConfig();
  const results = [];
  const add = (ok, label, detail) => {
    results.push({ ok, label, detail });
    log(`TEST ${ok ? 'OK  ' : 'FAIL'} - ${label}${detail ? ' :: ' + detail : ''}`);
  };

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'VSS: testing connection & mapping...' },
    async () => {
      // 1. ss.exe present?
      const ssExists = fs.existsSync(cfg.ssExePath);
      add(ssExists, `ss.exe found at ${cfg.ssExePath}`,
        ssExists ? '' : 'Check vssBridge.ssExePath (typical: C:\\Program Files (x86)\\Microsoft Visual SourceSafe\\ss.exe)');

      // 2. srcsafe.ini reachable?
      const iniPath = cfg.databasePath ? require('path').join(cfg.databasePath, 'srcsafe.ini') : '';
      const iniExists = iniPath ? fs.existsSync(iniPath) : false;
      add(iniExists, `srcsafe.ini found in ${cfg.databasePath}`,
        iniExists ? '' : 'vssBridge.databasePath must be the FOLDER containing srcsafe.ini (SSDIR) - network shares work too');

      if (!ssExists || !iniExists || !client.configured) {
        return;
      }

      // 3. Login + database reachable?
      try {
        await client.run(['Dir', '$/', '-I-', client._credArg()]);
        add(true, `Login OK (user "${cfg.username}"), database reachable`);
      } catch (err) {
        add(false, 'Login / database test', err.message);
        return;
      }

      // 4. Mapping of the active file (or just the root project).
      if (uri) {
        const vssPath = mapToVssPath(uri);
        if (!vssPath) {
          add(false, 'File mapping', `${uri.fsPath} is outside the workspace folder`);
          return;
        }
        add(true, `Mapped VSS path: ${vssPath}`);
        try {
          const info = await client.status(vssPath);
          add(info.exists, `File exists in VSS at ${vssPath}`,
            info.exists
              ? (info.checkedOut ? `checked out by ${info.user}` : 'checked in (free)')
              : 'ss.exe says: not an existing filename or project -> the mapping is wrong');
        } catch (err) {
          add(false, `File exists in VSS at ${vssPath}`, err.message);
        }
      }
    }
  );

  const failed = results.filter(r => !r.ok);
  const summary = results.map(r => (r.ok ? 'OK   ' : 'FAIL ') + r.label + (r.detail ? '\n        ' + r.detail : '')).join('\n');
  log('==== TEST SUMMARY ====\n' + summary);

  if (logChannel) { logChannel.show(true); }
  vscode.window.showInformationMessage(
    failed.length === 0
      ? `VSS Bridge: all checks passed!\n\n${summary}`
      : `VSS Bridge: ${failed.length} problem(s) found - see the Output panel (VSS Bridge) for details:\n\n${summary}`
  );
}

/** Show the ss.exe command log (best debugging tool). */
async function doShowLog() {
  if (!logChannel) { log('VSS Bridge log started.'); }
  logChannel.show(true);
}

// --------------------------------------------------------------------- //
//  Status bar                                                           //
// --------------------------------------------------------------------- //

function ensureStatusBar() {
  if (statusBarItem) { return; }
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBarItem.name = 'VSS Bridge';
  statusBarItem.command = 'vssBridge.quickMenu';
  statusBarItem.hide();
  if (context) { context.subscriptions.push(statusBarItem); }
}

async function updateStatusBarFor(uri) {
  if (!statusBarItem) { return; }
  const cfg = readConfig();
  if (!cfg.statusBarEnabled || !uri || uri.scheme !== 'file') { statusBarItem.hide(); return; }
  const vssPath = mapToVssPath(uri);
  if (!vssPath) { statusBarItem.hide(); return; }

  const key = uri.toString();
  let info = null;
  const cached = statusCache.get(key);
  if (cached && Date.now() - cached.when < 10000) {
    info = cached.info;
  } else if (client.configured) {
    // Non-blocking best effort: refresh cache but show old value meanwhile.
    enqueue(async () => {
      try {
        const fresh = await client.status(vssPath);
        statusCache.set(key, { when: Date.now(), info: fresh });
        renderStatusBar(uri, fresh, vssPath);
      } catch (e) { /* silent */ }
    });
    info = cached ? cached.info : { exists: true, checkedOut: false, byMe: false, user: '' };
  }

  renderStatusBar(uri, info, vssPath);
}

function renderStatusBar(uri, info, vssPath) {
  if (!info || !info.exists) {
    statusBarItem.text = '$(circle-slash) VSS';
    statusBarItem.tooltip = 'File is not in the VSS database (' + vssPath + ')';
  } else if (info.checkedOut && info.byMe) {
    statusBarItem.text = '$(pencil) VSS: Checked out (you)';
    statusBarItem.tooltip = 'You have this file checked out from VSS. Click for VSS actions (Check In, Undo...).';
  } else if (info.checkedOut) {
    statusBarItem.text = `$(lock) VSS: ${info.user}`;
    statusBarItem.tooltip = `Checked out from VSS by ${info.user}. Click for VSS actions.`;
  } else {
    statusBarItem.text = '$(check) VSS: Checked in';
    statusBarItem.tooltip = 'File is checked in to VSS (view only). Click for VSS actions (Check Out, History...).';
  }
  statusBarItem.tooltip += '\n\n' + BRAND_LINE;
  statusBarItem.show();
}

async function showQuickMenu() {
  const uri = resolveTargetUri();
  if (!uri) { return; }
  const items = [
    { label: '$(pencil)  Check Out', description: 'Lock for editing and get the latest version', cmd: 'vssBridge.checkout' },
    { label: '$(cloud-upload)  Check In', description: 'Submit your changes with a comment', cmd: 'vssBridge.checkin' },
    { label: '$(checklist)  Check In My Checkouts...', description: 'Pick from every file you have checked out', cmd: 'vssBridge.checkinMine' },
    { label: '$(discard)  Undo Checkout', description: 'Discard local changes and release the lock', cmd: 'vssBridge.undoCheckout' },
    { label: '$(cloud-download)  Get Latest Version', description: 'Refresh local copy from VSS', cmd: 'vssBridge.getLatest' },
    { label: '$(history)  Show History', description: 'All versions with users and comments', cmd: 'vssBridge.history' },
    { label: '$(question)  View or Check Out...', description: 'Show the open prompt again', cmd: 'vssBridge.openPrompt' }
  ];
  // branding footer (separator + non-actionable credit row)
  const SEP = vscode.QuickPickItemKind ? vscode.QuickPickItemKind.Separator : undefined;
  items.push(
    { label: '\u2014', kind: SEP },
    { label: `$(verified)  ${BRAND}`, description: `VSS Bridge v${PKG.version}` }
  );
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'VSS actions for ' + path.basename(uri.fsPath) });
  if (pick && pick.cmd) { await vscode.commands.executeCommand(pick.cmd, uri); }
}

// --------------------------------------------------------------------- //
//  Errors / activation                                                  //
// --------------------------------------------------------------------- //

/**
 * Central error handler for checkout/checkin/get/undo operations.
 * "Not found in VSS" errors get a special, actionable message because they
 * are almost always caused by a wrong folder mapping.
 */
async function handleOperationError(err, uri, vssPath, op) {
  log(`!! ${op} failed for ${vssPath}: ${err && err.message ? err.message : err}`);
  if (err instanceof SsError && err.kind === 'notfound') {
    const localPath = uri ? uri.fsPath : '?';
    const mapped = uri ? mapToVssPath(uri) : vssPath;
    const choice = await vscode.window.showErrorMessage(
      `VSS Bridge: ${err.message}\n\n` +
      `Local file : ${localPath}\n` +
      `VSS path   : ${mapped}\n\n` +
      'This happens when the VS Code folder structure does not match the VSS project structure. ' +
      'Fix vssBridge.vssProject / vssBridge.mappings in the settings.',
      'Test Connection & Mapping',
      'Open Mapping Settings'
    );
    if (choice === 'Test Connection & Mapping') {
      await doTestConnection(uri);
    } else if (choice === 'Open Mapping Settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', '@id:vssBridge.vssProject @id:vssBridge.mappings');
    }
    return;
  }
  showVssError(err, vssPath);
}

function showVssError(err, vssPath) {
  const msg = err && err.message ? err.message : String(err);
  if (err instanceof SsError && err.kind === 'auth') {
    vscode.window.showErrorMessage('VSS Bridge: ' + msg, 'Open Settings')
      .then(c => { if (c === 'Open Settings') { vscode.commands.executeCommand('vssBridge.configure'); } });
  } else {
    vscode.window.showErrorMessage(`VSS Bridge (${vssPath || 'VSS'}): ${msg}`);
  }
}

function ssExeExists(cfg) {
  try { return fs.existsSync(cfg.ssExePath); } catch (e) { return false; }
}

async function activate(ctx) {
  if (activating) { return; }
  activating = true;
  context = ctx;

  ctx.subscriptions.push({ dispose: () => HistoryPanel.disposeCurrent() });
  ensureStatusBar();

  const cfg = rebuildClient();
  ensureStatusBar();

  // --- commands -------------------------------------------------------
  const reg = (id, fn) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('vssBridge.checkout', (arg, all) => runOn('checkout', doCheckout, arg, all));
  reg('vssBridge.checkin', (arg, all) => runOn('checkin', doCheckin, arg, all));
  reg('vssBridge.undoCheckout', (arg, all) => runOn('undo', doUndoCheckout, arg, all));
  reg('vssBridge.getLatest', (arg, all) => runOn('get', doGetLatest, arg, all));
  reg('vssBridge.checkinMine', () => doCheckinMine());
  reg('vssBridge.history', (arg) => doShowHistory(resolveTargetUri(arg)));
  reg('vssBridge.openPrompt', (arg) => doOpenPrompt(resolveTargetUri(arg)));
  reg('vssBridge.refreshStatus', (arg) => {
    const uri = resolveTargetUri(arg);
    if (uri) { statusCache.delete(uri.toString()); updateStatusBarFor(uri); }
    for (const e of folderStatus.values()) { e.stale = true; }
    badgesChanged.fire(undefined);
  });
  reg('vssBridge.configure', async () => {
    const cfgNow = readConfig();
    if (cfgNow.ssExePath && !ssExeExists(cfgNow)) {
      vscode.window.showWarningMessage(
        `VSS Bridge: ss.exe was not found at "${cfgNow.ssExePath}". ` +
        'Check the vssBridge.ssExePath setting (typical: C:\\Program Files (x86)\\Microsoft Visual SourceSafe\\ss.exe).');
    }
    await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:MoizBohra.vss-bridge');
  });
  reg('vssBridge.quickMenu', () => showQuickMenu());
  reg('vssBridge.testConnection', (arg) => doTestConnection(resolveTargetUri(arg)));
  reg('vssBridge.showLog', () => doShowLog());

  // --- explorer badges ------------------------------------------------
  ctx.subscriptions.push(
    vscode.window.registerFileDecorationProvider(badgeProvider),
    badgesChanged,
    { dispose: () => clearInterval(badgeTimer) });
  restartBadgeTimer();

  // --- events ---------------------------------------------------------
  ctx.subscriptions.push(vscode.workspace.onDidOpenTextDocument((doc) => {
    handleOpenDocument(doc.uri, 'open');
  }));

  ctx.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor && editor.document.uri.scheme === 'file') {
      handledDocs.add(editor.document.uri.toString()); // tab switches never re-prompt
      updateStatusBarFor(editor.document.uri);
    } else if (statusBarItem) {
      statusBarItem.hide();
    }
  }));

  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('vssBridge') || e.affectsConfiguration('workbench')) {
      rebuildClient();
      restartBadgeTimer();
      if (vscode.window.activeTextEditor) { updateStatusBarFor(vscode.window.activeTextEditor.document.uri); }
    }
  }));

  ctx.subscriptions.push(vscode.workspace.onDidCloseTextDocument((doc) => {
    statusCache.delete(doc.uri.toString());
  }));

  // --- startup --------------------------------------------------------
  if (vscode.window.activeTextEditor) {
    const uri = vscode.window.activeTextEditor.document.uri;
    handledDocs.add(uri.toString()); // no surprise prompt on window restore
    updateStatusBarFor(uri);
  }

  const problems = configMissing(cfg);
  if (problems.length) {
    const choice = await vscode.window.showInformationMessage(
      'VSS Bridge: to enable Visual SourceSafe integration, set ' + problems.join(' and ') + ' in settings.',
      'Open Settings',
      'Later'
    );
    if (choice === 'Open Settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:MoizBohra.vss-bridge');
    }
  } else if (cfg.ssExePath && !ssExeExists(cfg)) {
    vscode.window.showWarningMessage(
      `VSS Bridge: ss.exe was not found at "${cfg.ssExePath}". Check the vssBridge.ssExePath setting.`);
  }

  // one-time welcome + author credit (shown once per version, only when setup is complete)
  if (!problems.length) {
    const brandKey = 'brandToast.v' + PKG.version;
    if (!ctx.globalState.get(brandKey)) {
      ctx.globalState.update(brandKey, true);
      vscode.window.showInformationMessage(`VSS Bridge v${PKG.version} active \u2014 ${BRAND}.`);
    }
  }

  activating = false;
}

function deactivate() {
  HistoryPanel.disposeCurrent();
}

module.exports = { activate, deactivate };
