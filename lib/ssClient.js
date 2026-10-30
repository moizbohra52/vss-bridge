'use strict';

/**
 * VSS Bridge - ss.exe command line client wrapper.
 *
 * All VSS operations are executed through the official Visual SourceSafe
 * command line utility (ss.exe) which ships with every VSS client install
 * (VSS 6.0 and VSS 2005 both). This module:
 *
 *   - spawns ss.exe with the right environment (SSDIR / SSUSER / SSPWD)
 *   - appends the -Y<user>,<pass> credentials flag
 *   - uses -I- (no interactive prompts) so nothing can hang
 *   - captures stdout + stderr together (some VSS builds write to either)
 *   - parses Status and History output into structured objects
 *
 * Exit codes used by ss.exe: 0 = success, 100 = error, 1 = "not checked out"
 * style informational results (varies by command / version).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** VSS error markers that mean "the item is not in the database". */
const NOT_IN_VSS_RE =
  /(is not (an )?existing|not found|does not exist|no items? (was|were) found|invalid dos path|file or project not found)/i;

/** VSS auth / connection error markers. (No bare "password": it matched file names like change_password.php.) */
const AUTH_ERROR_RE =
  /(invalid password|invalid user|access denied|you are not allowed|unable to locate srcsafe\.ini|network connection problem)/i;

/**
 * One checkout line of `ss Status` or `ss Dir -E` (real VSS 2005 output). The name
 * column is 19 chars (longer names are cut). The user column is padded to 14 but
 * never cut, so a 14+ char user runs straight into the type (Status) or date (Dir -E):
 *   login.php           MoizBohra     Exc  27-10-26  3:50p
 *   errorhandle.php     firstname.lastnamExc  26-10-26  5:44p
 *   errorhandle.php     firstname.lastnam26-10-26  5:44p
 *                       otheruser     Mul  10/09/25  9:00a      <- multi-checkout, blank name
 * Groups: 1 = name, 2 = user, 3 = date, 4 = time. Dates in any locale order, numeric or month names.
 */
const CHECKOUT_LINE_RE =
  /^(.*?)[ \t]+(\S+?)[ \t]*(?:Exc|Mul)?[ \t]*(\d{1,4}[-\/.][0-9A-Za-z]{1,9}[-\/.]\d{1,4})[ \t]+(\d{1,2}[:.]\d{2}[aApP]?)/;

/** ss.exe cuts file names in checkout lines to this many chars. */
const NAME_COL = 19;

class SsError extends Error {
  constructor(message, kind, code, output) {
    super(message);
    this.name = 'SsError';
    this.kind = kind || 'error'; // 'auth' | 'notfound' | 'error'
    this.code = code;
    this.output = output || '';
  }
}

/**
 * @param {object} cfg
 *   ssExePath     - full path to ss.exe
 *   databasePath  - folder that contains srcsafe.ini (becomes SSDIR)
 *   username      - VSS user
 *   password      - VSS password (may be empty)
 *   timeoutMs     - per-command timeout in milliseconds
 *   cwd           - default working directory for spawned processes
 *   logger        - optional function(line) called with every command + output
 */
class SsClient {
  constructor(cfg) {
    cfg = cfg || {};
    this.ssExePath = cfg.ssExePath || 'ss.exe';
    this.databasePath = cfg.databasePath || '';
    this.username = cfg.username || '';
    this.password = cfg.password || '';
    this.timeoutMs = cfg.timeoutMs || 60000;
    this.cwd = cfg.cwd || undefined;
    this.logger = typeof cfg.logger === 'function' ? cfg.logger : null;
  }

  /** Safe logging - never throws, masks the password. */
  log(line) {
    if (!this.logger) { return; }
    try { this.logger(line); } catch (e) { /* ignore */ }
  }

  logBlock(text) {
    if (!this.logger) { return; }
    const lines = String(text || '').split(/\r?\n/).map(l => '    ' + l.trimEnd()).filter(l => l.trim());
    for (const l of lines) { this.log(l); }
  }

  get configured() {
    return Boolean(this.ssExePath && this.databasePath && this.username);
  }

  /** -Y<user>[,<pass>] credentials flag. Trailing comma when password empty. */
  _credArg() {
    return `-Y${this.username},${this.password || ''}`;
  }

  _env() {
    const env = Object.assign({}, process.env);
    // SSDIR must point to the FOLDER containing srcsafe.ini (no file name).
    if (this.databasePath) { env.SSDIR = this.databasePath; }
    if (this.username) { env.SSUSER = this.username; }
    if (this.password) { env.SSPWD = this.password; }
    return env;
  }

  /**
   * Run ss.exe with the given arguments.
   * @returns {Promise<{code:number, output:string, timedOut:boolean}>}
   */
  exec(args) {
    const masked = args
      .map(a => (/^-Y/.test(a)
        ? '-Y' + this.username + ',' + (this.password ? '***' : '')
        : a))
      .join(' ');
    this.log(`> ss ${masked}`);
    this.log(`  (SSDIR=${this.databasePath || '(not set)'})`);

    return new Promise((resolve) => {
      let out = '';
      let timedOut = false;
      let loginPrompt = false;
      let settled = false;

      let proc;
      try {
        proc = spawn(this.ssExePath, args, {
          env: this._env(),
          cwd: this.cwd,
          windowsHide: true
        });
      } catch (err) {
        resolve({ code: -1, output: 'Failed to launch ss.exe: ' + err.message, timedOut: false });
        return;
      }

      const timer = setTimeout(() => {
        timedOut = true;
        try { proc.kill(); } catch (e) { /* already gone */ }
      }, this.timeoutMs);

      const onData = (chunk) => {
        // ss.exe console output is OEM encoded; latin1 keeps bytes intact
        // and is safe for the ASCII messages we parse.
        out += chunk.toString('latin1');
        // An unknown -Y user makes ss.exe ask "Password:" on the console (ignoring
        // -I-) and wait forever - stop it now instead of at the timeout.
        if (!loginPrompt && /(^|\n)Password: *$/.test(out)) {
          loginPrompt = true;
          try { proc.kill(); } catch (e) { /* already gone */ }
        }
      };

      proc.stdout && proc.stdout.on('data', onData);
      proc.stderr && proc.stderr.on('data', onData);

      proc.on('error', (err) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        this.logBlock(out);
        this.log(`< LAUNCH ERROR: ${err.message}`);
        resolve({ code: -1, output: out + '\n' + err.message, timedOut });
      });

      proc.on('close', (code) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        this.logBlock(out);
        this.log(`< exit ${code}${timedOut ? ' (TIMED OUT, process killed)' : ''}${loginPrompt ? ' (LOGIN REFUSED, process killed)' : ''}`);
        resolve({ code: code === null || code === undefined ? -1 : code, output: out, timedOut, loginPrompt });
      });
    });
  }

  /** Wrap exec() with error classification used by the extension. */
  async run(args, { expectFailure = false } = {}) {
    const res = await this.exec(args);
    if (res.loginPrompt) {
      throw new SsError(
        `VSS did not accept the login for user "${this.username}" (ss.exe asked for a password). ` +
        'Check vssBridge.username - it must be your VSS user name exactly as in VSS Admin - and vssBridge.password.',
        'auth', res.code, res.output);
    }
    if (res.timedOut) {
      throw new SsError(
        'ss.exe did not respond within ' + Math.round(this.timeoutMs / 1000) +
        's. Check your VSS network/database path in settings.', 'error', -1, res.output);
    }
    if (res.code !== 0 && !expectFailure) {
      throw ssFailure(res, args);
    }
    return res;
  }

  // ------------------------------------------------------------------ //
  //  High level operations                                             //
  // ------------------------------------------------------------------ //

  /**
   * Status of a single VSS item.
   * @returns {Promise<{exists:boolean, checkedOut:boolean, byMe:boolean, user:string, raw:string}>}
   */
  async status(vssPath) {
    const args = ['Status', vssPath, '-I-', this._credArg()];
    const res = await this.run(args, { expectFailure: true }); // exit 1 = checked out
    const info = parseStatusOutput(res.output, this.username);
    // Any other exit code that is not "not in VSS" is a real failure (login, network...).
    // Reading it as "free" made Check In say "not checked out" when the login was wrong.
    if (res.code !== 0 && res.code !== 1 && info.exists) { throw ssFailure(res, args); }
    info.raw = res.output;
    return info;
  }

  /**
   * Check out a file into the given local folder. -GWR replaces a writable local
   * copy (without it ss.exe fails: "A writable copy of ... already exists");
   * callers keep your changes themselves (backup + put back) or have asked first.
   */
  async checkout(vssPath, localDir) {
    await this.run([
      'Checkout', vssPath,
      `-GL${localDir}`,
      '-GWR',
      '-I-Y',          // answer Yes to any confirmation (overwrite local copy)
      this._credArg()
    ]);
  }

  /**
   * Check a file back in with an (optional) comment.
   *
   * IMPORTANT: an empty comment MUST be passed as `-C-` (documented VSS
   * switch meaning "no comment"). A bare `-C` makes ss.exe ask for a
   * comment interactively and the command then fails under -I-Y.
   */
  async checkin(vssPath, localDir, comment) {
    const c = String(comment || '').replace(/\s*\r?\n\s*/g, ' ').trim();
    const args = [
      'Checkin', vssPath,
      `-GL${localDir}`
    ];
    if (c) { args.push(`-C${c}`); }
    else { args.push('-C-'); }
    args.push('-I-Y', this._credArg());
    await this.run(args);
  }

  /** Undo checkout - local copy is replaced with the latest stored version. */
  async undoCheckout(vssPath, localDir) {
    await this.run([
      'Undocheckout', vssPath,
      `-GL${localDir}`,
      '-I-Y',
      this._credArg()
    ]);
  }

  /** Get latest version of a file (or whole project path) into localDir (-GWR: see checkout). */
  async get(vssPath, localDir) {
    await this.run([
      'Get', vssPath,
      `-GL${localDir}`,
      '-GWR',
      '-I-Y',
      this._credArg()
    ]);
  }

  /** Version history of one file, newest first (all versions, or only the newest `count`). */
  async history(vssPath, count) {
    const args = ['History', vssPath];
    if (count) { args.push(`-#${count}`); }
    const res = await this.run(args.concat('-I-', this._credArg()));
    return parseHistoryOutput(res.output);
  }

  /** Bytes of the latest VSS version, fetched into a throw-away folder (your files are untouched). */
  async latestContent(vssPath) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vss-bridge-'));
    try {
      await this.get(vssPath, dir);
      return fs.readFileSync(path.join(dir, vssPath.slice(vssPath.lastIndexOf('/') + 1)));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Files checked out under a project (recursive), by one user or (no username) by anyone, parsed like parseDirListing. */
  async checkedOutBy(vssProject, username) {
    const args = ['Status', vssProject || '$/', '-R'].concat(username ? `-U${username}` : [], '-I-', this._credArg());
    const res = await this.run(args, { expectFailure: true });
    if (res.code !== 0 && res.code !== 1) { throw ssFailure(res, args); }
    return parseDirListing(res.output, this.username);
  }

  /** One project's files with their checkout state (`ss Dir -E`, not recursive). */
  async dirListing(vssFolder) {
    const res = await this.run(['Dir', vssFolder, '-E', '-I-', this._credArg()]);
    return parseDirListing(res.output, this.username).values().next().value || { free: new Set(), out: [] };
  }
}

/** Classify a failed ss.exe run into an SsError ('notfound' | 'auth' | 'error'). */
function ssFailure(res, args) {
  if (NOT_IN_VSS_RE.test(res.output)) {
    return new SsError('Item not found in VSS: ' + (args[1] || ''), 'notfound', res.code, res.output);
  }
  if (AUTH_ERROR_RE.test(res.output)) {
    return new SsError(
      'VSS login failed. Check username/password and database path (SSDIR). Details: ' +
      firstMeaningfulLine(res.output), 'auth', res.code, res.output);
  }
  return new SsError(
    'ss.exe failed (exit code ' + res.code + '). Details: ' +
    firstMeaningfulLine(res.output), 'error', res.code, res.output);
}

// ---------------------------------------------------------------------- //
//  Output parsers (pure functions - unit tested in test/parse.test.js)   //
// ---------------------------------------------------------------------- //

/**
 * Parse `ss Status <file>` output.
 *
 * Checked out example (real ss.exe output, see CHECKOUT_LINE_RE; the working
 * folder wraps to the next line when it is long; exit code 1):
 *   login.php           MoizBohra     Exc  27-10-26  3:50p
 *   \\fileserver\wwwroot\MyProject\webapp\api
 *
 * Not checked out example (exit code 0):
 *   No checked out files found.
 *
 * Multi-checkout: one such line per user (type "Mul" instead of "Exc").
 *
 * @returns {{exists:boolean, checkedOut:boolean, byMe:boolean, user:string, allUsers:string[]}}
 */
function parseStatusOutput(output, myUsername) {
  const text = (output || '').replace(/\u0000/g, '');
  const result = { exists: true, checkedOut: false, byMe: false, user: '', allUsers: [] };

  for (const line of text.split(/\r?\n/)) {
    const m = CHECKOUT_LINE_RE.exec(line);
    if (!m) { continue; }
    if (!result.checkedOut) {
      result.checkedOut = true;
      result.user = m[2]; // first user
    }
    if (!result.allUsers.includes(m[2])) { result.allUsers.push(m[2]); }
  }

  if (!result.checkedOut && NOT_IN_VSS_RE.test(text)) {
    result.exists = false;
    return result;
  }

  result.byMe = result.allUsers.some(u => isSameUser(u, myUsername));
  return result;
}

/** VSS user names are case-insensitive and may come back as DOMAIN\user. */
function isSameUser(reported, me) {
  if (!me) { return false; }
  const v = String(reported).toLowerCase();
  const m = String(me).toLowerCase();
  return v === m || v.split(/[\\\/]/).pop() === m;
}

/**
 * Parse `ss Dir <project> -E [-R]` (or `ss Status -R`) into one listing per project.
 * Real VSS 2005 output; ss.exe hard-wraps lines at 79 chars, which also splits
 * long project headers ("$/.../views" + ":" on the next line):
 *   $/MyApp/api:
 *   $subproject                                         <- sub project (skipped)
 *   index.php                                           <- free file, full name
 *   customer_report_lis otheruser     27-10-26 12:11p   <- checked out, name cut to 19
 *   \\server\wwwroot\MyApp\api                          <- its working folder (skipped)
 *
 *   972 item(s)
 *
 * @returns {Map<string, {free:Set<string>, out:Array<{name:string,user:string,byMe:boolean}>}>}
 *          keyed by lower-case project path; file names are lower-case
 */
function parseDirListing(output, myUsername) {
  const lines = String(output || '').replace(/\u0000/g, '').split(/\r?\n/);
  const tree = new Map();
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    while (line.startsWith('$/') && line.length % 79 === 0 && !line.endsWith(':') && i + 1 < lines.length) {
      line += lines[++i]; // re-join a wrapped project path
    }
    line = line.trim();
    if (line.startsWith('$/') && line.endsWith(':')) {
      cur = { free: new Set(), out: [] };
      tree.set(line.slice(0, -1).toLowerCase(), cur);
      continue;
    }
    if (!cur || !line || line.startsWith('$') || /^\d+ item\(s\)$/.test(line) || /^(\\\\|[A-Za-z]:\\)/.test(line)) {
      continue;
    }
    const m = CHECKOUT_LINE_RE.exec(lines[i]);
    if (m) {
      const prev = cur.out[cur.out.length - 1];
      const name = m[1].trim().toLowerCase() || (prev ? prev.name : '');
      cur.out.push({ name, user: m[2], byMe: isSameUser(m[2], myUsername), date: m[3] + ' ' + m[4] });
    } else {
      cur.free.add(line.toLowerCase());
    }
  }
  return tree;
}

/** VSS state of one file from its folder's listing (see parseDirListing). */
function lookupListing(listing, fileName) {
  const n = String(fileName).toLowerCase();
  const none = { exists: true, checkedOut: false, byMe: false, user: '' };
  if (listing.free.has(n)) { return none; }
  // Free files are listed in full, so a cut name can only be one of the checked-out ones.
  const hits = listing.out.filter(o => o.name === n || (o.name.length === NAME_COL && n.startsWith(o.name)));
  if (!hits.length) { return Object.assign(none, { exists: false }); }
  return { exists: true, checkedOut: true, byMe: hits.some(h => h.byMe), user: hits[0].user, date: hits[0].date };
}

const MONTHS = 'janfebmaraprmayjunjulaugsepoctnovdec';

/**
 * Sortable number for a checkout date as ss.exe prints it ("27-10-26 3:50p", "27-Oct-26 15:50").
 * ss.exe uses the PC's short-date order, so the caller says which: 'dmy' | 'mdy' | 'ymd'.
 */
function dateKey(text, order) {
  const m = /^(\w+)[-\/.](\w+)[-\/.](\w+)\s+(\d+)[:.](\d+)([ap]?)/i.exec(String(text || '').trim());
  if (!m) { return 0; }
  const [a, b, c] = [m[1], m[2], m[3]].map(s => (/^\d+$/.test(s) ? +s : MONTHS.indexOf(s.slice(0, 3).toLowerCase()) / 3 + 1));
  let [y, mo, d] = m[1].length === 4 || order === 'ymd' ? [a, b, c] : order === 'mdy' ? [c, a, b] : [c, b, a];
  if (y < 100) { y += y < 70 ? 2000 : 1900; }
  const h = m[6] ? (+m[4] % 12) + (/p/i.test(m[6]) ? 12 : 0) : +m[4];
  return (((y * 100 + mo) * 100 + d) * 100 + h) * 100 + +m[5];
}

/**
 * Parse `ss History <file>` output into version records.
 *
 * Sample per version:
 *   *****************  Version 5  *****************
 *   User: moizbohra     Date:  5/02/01   Time: 10:12a
 *   Checked in $/MyApp/src/form1.frm
 *   Comment: fixed login bug
 *
 * @returns {Array<{version:string,user:string,date:string,time:string,action:string,comment:string}>}
 */
function parseHistoryOutput(output) {
  const versions = [];
  const lines = String(output || '').split(/\r?\n/);
  let cur = null;

  for (const line of lines) {
    const header = /^\s*\*+\s*Version\s+(\d+)\s*\*+\s*$/i.exec(line);
    if (header) {
      if (cur) { versions.push(finishRecord(cur)); }
      cur = { version: header[1], user: '', date: '', time: '', action: '', comment: '' };
      continue;
    }
    if (!cur) { continue; }

    const user = /^user:\s*(.+?)\s+date:\s*(\S+)\s+time:\s*(.+)$/i.exec(line);
    if (user) {
      cur.user = user[1].trim();
      cur.date = user[2].trim();
      cur.time = user[3].trim();
      continue;
    }

    const comment = /^(label comment|comment):\s*(.*)$/i.exec(line);
    if (comment) {
      cur.comment = (comment[2] || '').trim();
      continue;
    }

    const action = /^(checked in|checked out|added|deleted|recovered|destroyed|branched|pinned|shared to|created|labeled|renamed|moved from)/i.exec(line.trim());
    if (action) {
      cur.action = line.trim();
      continue;
    }

    // Continuation lines of a multi-line comment.
    const t = line.trim();
    if (t && cur.comment) { cur.comment += ' ' + t; }
  }
  if (cur) { versions.push(finishRecord(cur)); }
  return versions;
}

/** Strip the wrapping quotes VSS puts around comments (after joining lines). */
function finishRecord(rec) {
  rec.comment = rec.comment.replace(/^"|"$/g, '').trim();
  return rec;
}

function firstMeaningfulLine(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return lines.length ? lines[0].slice(0, 300) : '(no output from ss.exe)';
}

/** Normalize a windows path for -GL argument quoting safety. */
function glDir(fsPath) {
  return String(fsPath || '').replace(/[\\/]+$/, '');
}

module.exports = {
  SsClient,
  SsError,
  parseStatusOutput,
  parseHistoryOutput,
  parseDirListing,
  lookupListing,
  dateKey,
  isSameUser,
  glDir,
  path
};
