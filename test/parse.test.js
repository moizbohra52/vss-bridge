'use strict';

/**
 * Unit tests for the VSS output parsers.
 * Run: node test/parse.test.js
 */

const assert = require('assert');
const {
  SsClient,
  SsError,
  parseStatusOutput,
  parseHistoryOutput,
  glDir
} = require('../lib/ssClient');

let passed = 0;
let failed = 0;
let chain = Promise.resolve();

function test(name, fn) {
  chain = chain.then(fn).then(() => {
    passed++;
    console.log('  ok  - ' + name);
  }, (err) => {
    failed++;
    console.error('  FAIL - ' + name);
    console.error('        ' + err.message);
  });
}

// ------------------------------------------------------------------ //
//  Status output samples (real ss.exe format, dummy names/paths)    //
// ------------------------------------------------------------------ //

const STATUS_CHECKED_OUT_ME = [
  'login.php           MoizBohra     Exc  27-10-26  3:50p',
  '\\\\fileserver\\wwwroot\\MyProject\\webapp\\api',
  ''
].join('\r\n');

const STATUS_CHECKED_OUT_OTHER = [
  'customer_report_lis otheruser     Exc  10/08/25  2:45p',
  'D:\\Work\\MyApp\\src',
  ''
].join('\r\n');

const STATUS_CHECKED_IN = 'No checked out files found.\r\n';

const STATUS_NOT_FOUND =
  '$/MyProject/ghost.php is not an existing filename or project\r\n';

const STATUS_NO_ITEMS = 'No items checked out\r\n';

test('parseStatusOutput: checked out by me', () => {
  const r = parseStatusOutput(STATUS_CHECKED_OUT_ME, 'moizbohra');
  assert.strictEqual(r.exists, true);
  assert.strictEqual(r.checkedOut, true);
  assert.strictEqual(r.byMe, true);
  assert.strictEqual(r.user, 'MoizBohra');
});

test('parseStatusOutput: checked out by other user', () => {
  const r = parseStatusOutput(STATUS_CHECKED_OUT_OTHER, 'moizbohra');
  assert.strictEqual(r.exists, true);
  assert.strictEqual(r.checkedOut, true);
  assert.strictEqual(r.byMe, false);
  assert.strictEqual(r.user, 'otheruser');
});

test('parseStatusOutput: checked in (free file)', () => {
  const r = parseStatusOutput(STATUS_CHECKED_IN, 'moizbohra');
  assert.strictEqual(r.exists, true);
  assert.strictEqual(r.checkedOut, false);
  assert.strictEqual(r.byMe, false);
});

test('parseStatusOutput: file not existing in VSS', () => {
  const r = parseStatusOutput(STATUS_NOT_FOUND, 'moizbohra');
  assert.strictEqual(r.exists, false);
  assert.strictEqual(r.checkedOut, false);
});

test('parseStatusOutput: "No items checked out" is a free file', () => {
  const r = parseStatusOutput(STATUS_NO_ITEMS, 'moizbohra');
  assert.strictEqual(r.exists, true);
  assert.strictEqual(r.checkedOut, false);
});

test('parseStatusOutput: null/empty output treated as free file', () => {
  const r = parseStatusOutput('', 'moizbohra');
  assert.strictEqual(r.exists, true);
  assert.strictEqual(r.checkedOut, false);
});

// ---- Multi-checkout and DOMAIN\user (format assumed from the single-user line) ---- //

const STATUS_MULTI_CHECKOUT = [
  'form1.frm           otheruser     Mul  10/08/25  2:45p',
  'D:\\Work\\MyApp\\src',
  '                    moizbohra     Mul  10/09/25  9:00a',
  'C:\\dev\\MyApp\\src',
  ''
].join('\r\n');

const STATUS_DOMAIN_USER = [
  'form1.frm           DOMAIN\\moizbohra Exc  10/09/25  9:00a',
  ''
].join('\r\n');

test('parseStatusOutput: "not an existing filename or project" -> not in VSS', () => {
  const r = parseStatusOutput(STATUS_NOT_FOUND, 'moizbohra');
  assert.strictEqual(r.exists, false);
});

test('parseStatusOutput: filename column containing a space does not shift the user', () => {
  const r = parseStatusOutput('my report.php       MoizBohra     Exc  27-10-26  3:50p\r\n', 'moizbohra');
  assert.strictEqual(r.user, 'MoizBohra');
  assert.strictEqual(r.byMe, true);
});

test('parseStatusOutput: multi-checkout includes me', () => {
  const r = parseStatusOutput(STATUS_MULTI_CHECKOUT, 'moizbohra');
  assert.strictEqual(r.checkedOut, true);
  assert.strictEqual(r.byMe, true, 'byMe should be true when I am one of the users');
  assert.strictEqual(r.allUsers.length, 2);
  assert.strictEqual(r.allUsers[0], 'otheruser');
  assert.strictEqual(r.allUsers[1], 'moizbohra');
});

test('parseStatusOutput: multi-checkout without me', () => {
  const r = parseStatusOutput(STATUS_MULTI_CHECKOUT, 'nobody');
  assert.strictEqual(r.checkedOut, true);
  assert.strictEqual(r.byMe, false);
});

test('parseStatusOutput: DOMAIN\\user matches bare username', () => {
  const r = parseStatusOutput(STATUS_DOMAIN_USER, 'moizbohra');
  assert.strictEqual(r.checkedOut, true);
  assert.strictEqual(r.byMe, true, 'byMe should be true when VSS reports DOMAIN\\user and config has bare user');
});

test('parseStatusOutput: case-insensitive username match', () => {
  const r = parseStatusOutput(STATUS_CHECKED_OUT_ME, 'MOIZBOHRA');
  assert.strictEqual(r.byMe, true);
});

test('SsClient.run: filename containing "password" is not reported as a login failure', async () => {
  const c = new SsClient({ username: 'moizbohra' });
  c.exec = async () => ({
    code: 100, timedOut: false,
    output: 'You do not have file $/x/change_password.php currently checked out.'
  });
  await assert.rejects(c.run(['Checkin', '$/x/change_password.php']), e => e.kind === 'error');
});

// ------------------------------------------------------------------ //
//  History output samples                                            //
// ------------------------------------------------------------------ //

const HISTORY_SAMPLE = [
  'History of $/MyApp/src/form1.frm:',
  '',
  '*****************  Version 5  *****************',
  'User: moizbohra        Date: 12/03/25    Time:  4:31p',
  'Checked in $/MyApp/src/form1.frm',
  'Comment: "Fixed login validation bug 1234"',
  '',
  '*****************  Version 4  *****************',
  'User: otheruser        Date: 10/03/25    Time: 11:02a',
  'Checked in $/MyApp/src/form1.frm',
  'Comment: "Added new payment module integration',
  'second line of comment"',
  '',
  '*****************  Version 3  *****************',
  'User: otheruser        Date: 28/02/25    Time:  9:15a',
  'Added $/MyApp/src/form1.frm',
  'Comment: ""',
  '',
  '*****************  Version 2  *****************',
  'User: moizbohra        Date: 20/02/25    Time:  3:40p',
  'Checked in $/MyApp/src/form1.frm',
  '',
  '*****************  Version 1  *****************',
  'User: admin            Date: 18/02/25    Time: 10:00a',
  'Added $/MyApp/src/form1.frm',
  'Comment: "Initial version"',
  ''
].join('\r\n');

test('parseHistoryOutput: parses all versions', () => {
  const versions = parseHistoryOutput(HISTORY_SAMPLE);
  assert.strictEqual(versions.length, 5);
  assert.strictEqual(versions[0].version, '5');
  assert.strictEqual(versions[0].user, 'moizbohra');
  assert.strictEqual(versions[0].date, '12/03/25');
  assert.strictEqual(versions[0].time, '4:31p');
  assert.strictEqual(versions[0].action, 'Checked in $/MyApp/src/form1.frm');
  assert.strictEqual(versions[0].comment, 'Fixed login validation bug 1234');
});

test('parseHistoryOutput: multi-line comments are joined', () => {
  const versions = parseHistoryOutput(HISTORY_SAMPLE);
  assert.strictEqual(
    versions[1].comment,
    'Added new payment module integration second line of comment');
});

test('parseHistoryOutput: empty comment stays empty', () => {
  const versions = parseHistoryOutput(HISTORY_SAMPLE);
  assert.strictEqual(versions[2].comment, '');
});

test('parseHistoryOutput: version without comment line', () => {
  const versions = parseHistoryOutput(HISTORY_SAMPLE);
  assert.strictEqual(versions[3].comment, '');
  assert.strictEqual(versions[3].user, 'moizbohra');
});

test('parseHistoryOutput: newest first ordering preserved', () => {
  const versions = parseHistoryOutput(HISTORY_SAMPLE);
  assert.strictEqual(versions[0].version, '5');
  assert.strictEqual(versions[4].version, '1');
  assert.strictEqual(versions[4].user, 'admin');
});

test('parseHistoryOutput: empty output -> empty list', () => {
  assert.deepStrictEqual(parseHistoryOutput(''), []);
  assert.deepStrictEqual(parseHistoryOutput(null), []);
});

// Project-style history (labelled, from ss History $/project -R)
const HISTORY_PROJECT = [
  'History of project $/MyApp:',
  '',
  '******************************',
  'Label: "RELEASE_1.0"',
  'User: builder          Date: 31/07/25    Time:  5:02p',
  'Labeled',
  'Label comment: "Automated build 1.0"',
  ''
].join('\r\n');

test('parseHistoryOutput: label entries do not crash parser', () => {
  const versions = parseHistoryOutput(HISTORY_PROJECT);
  // No "Version N" header -> no version records (labels are skipped).
  assert.deepStrictEqual(versions, []);
});

// ------------------------------------------------------------------ //
//  Misc helpers                                                      //
// ------------------------------------------------------------------ //

test('glDir: strips trailing slash', () => {
  assert.strictEqual(glDir('C:\\dev\\app\\'), 'C:\\dev\\app');
  assert.strictEqual(glDir('C:\\dev\\app'), 'C:\\dev\\app');
});

test('SsError carries kind and code', () => {
  const e = new SsError('boom', 'auth', 100, 'out');
  assert.strictEqual(e.kind, 'auth');
  assert.strictEqual(e.code, 100);
  assert.ok(e instanceof Error);
});

test('SsClient: credential arg has trailing comma when password empty', () => {
  const c = new SsClient({ username: 'moizbohra', password: '' });
  assert.strictEqual(c._credArg(), '-Ymoizbohra,');
  const c2 = new SsClient({ username: 'moizbohra', password: 'secret' });
  assert.strictEqual(c2._credArg(), '-Ymoizbohra,secret');
});

test('SsClient: configured flag requires db + user', () => {
  const c = new SsClient({ ssExePath: 'ss.exe', databasePath: '', username: '' });
  assert.strictEqual(c.configured, false);
  const c2 = new SsClient({ ssExePath: 'ss.exe', databasePath: '\\\\srv\\vss', username: 'moizbohra' });
  assert.strictEqual(c2.configured, true);
});

// ------------------------------------------------------------------ //

chain.then(() => {
  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
