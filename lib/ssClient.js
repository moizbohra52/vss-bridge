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
const path = require('path');

/** VSS error markers that mean "the item is not in the database". */
const NOT_IN_VSS_RE =
  /(is not (an )?existing|not found|does not exist|no items? (was|were) found|invalid dos path|file or project not found)/i;

/** VSS auth / connection error markers. (No bare "password": it matched file names like change_password.php.) */
const AUTH_ERROR_RE =
  /(invalid password|invalid user|access denied|you are not allowed|unable to locate srcsafe\.ini|network connection problem)/i;

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
        this.log(`< exit ${code}${timedOut ? ' (TIMED OUT, process killed)' : ''}`);
        resolve({ code: code === null || code === undefined ? -1 : code, output: out, timedOut });
      });
    });
  }

  /** Wrap exec() with error classification used by the extension. */
  async run(args, { expectFailure = false } = {}) {
    const res = await this.exec(args);
    if (res.timedOut) {
      throw new SsError(
        'ss.exe did not respond within ' + Math.round(this.timeoutMs / 1000) +
        's. Check your VSS network/database path in settings.', 'error', -1, res.output);
    }
    if (res.code !== 0 && !expectFailure) {
      if (NOT_IN_VSS_RE.test(res.output)) {
        throw new SsError('Item not found in VSS: ' + (args[1] || ''), 'notfound', res.code, res.output);
      }
      if (AUTH_ERROR_RE.test(res.output)) {
        throw new SsError(
          'VSS login failed. Check username/password and database path (SSDIR). Details: ' +
          firstMeaningfulLine(res.output), 'auth', res.code, res.output);
      }
      throw new SsError(
        'ss.exe failed (exit code ' + res.code + '). Details: ' +
        firstMeaningfulLine(res.output), 'error', res.code, res.output);
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
    const res = await this.run(
      ['Status', vssPath, '-I-', this._credArg()],
      { expectFailure: true } // exit 1 when not checked out on some versions
    );
    const info = parseStatusOutput(res.output, this.username);
    info.raw = res.output;
    return info;
  }

  /** Check out a file into the given local folder. */
  async checkout(vssPath, localDir) {
    await this.run([
      'Checkout', vssPath,
      `-GL${localDir}`,
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

  /** Get latest version of a file (or whole project path) into localDir. */
  async get(vssPath, localDir) {
    await this.run([
      'Get', vssPath,
      `-GL${localDir}`,
      '-I-Y',
      this._credArg()
    ]);
  }

  /** Full version history of one file. */
  async history(vssPath) {
    const res = await this.run(['History', vssPath, '-I-', this._credArg()]);
    return parseHistoryOutput(res.output);
  }

  /** Files currently checked out by a specific user (recursive). */
  async checkedOutBy(vssProject, username) {
    const res = await this.run(
      ['Status', vssProject || '$/', '-R', `-U${username}`, '-I-', this._credArg()],
      { expectFailure: true }
    );
    return res.output;
  }
}

// ---------------------------------------------------------------------- //
//  Output parsers (pure functions - unit tested in test/parse.test.js)   //
// ---------------------------------------------------------------------- //

/**
 * Parse `ss Status <file>` output.
 *
 * Checked out example (real ss.exe output; file name column is 19 chars,
 * the working folder wraps to the next line when it is long; exit code 1):
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

  // One line per checkout: "<file> <user> [Exc|Mul] <date> <time>". The user
  // is the token right before the type/date. The first user is kept in `user`.
  const userRe = /^.*?[ \t](\S+)[ \t]+(?:(?:Exc|Mul)[ \t]+)?\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2,4}[ \t]+\d{1,2}:\d{2}/gim;
  let m;
  while ((m = userRe.exec(text)) !== null) {
    const u = m[1].trim();
    if (!result.checkedOut) {
      result.checkedOut = true;
      result.user = u;
    }
    if (!result.allUsers.includes(u)) { result.allUsers.push(u); }
  }

  if (!result.checkedOut && NOT_IN_VSS_RE.test(text)) {
    result.exists = false;
    return result;
  }

  if (result.checkedOut && myUsername) {
    const me = String(myUsername).toLowerCase();
    // Match if any of the recorded users equals me, ends with "\me" (DOMAIN\user
    // form), or equals me when both sides are stripped to the bare user name.
    result.byMe = result.allUsers.some(u => {
      const v = String(u).toLowerCase();
      if (v === me) { return true; }
      const bare = v.split(/[\\\/]/).pop();
      return bare === me;
    });
  }
  return result;
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
  glDir,
  path
};
