# Change Log - VSS Bridge

All notable changes to the VSS Bridge extension are documented here.

## [0.2.0] - 2026-10-28

### Fixed
- **Check In says "checked out by someone else" for users with long VSS names.** `ss Status` pads the user column to 14 characters but never cuts it, so a 14+ character name runs straight into the type column: `errorhandle.php     firstname.lastnamExc  26-10-26  5:44p`. The parser read the user as `firstname.lastnamExc`, so your own checkout was not recognised as yours. Verified against all 1,891 checkout lines of a real 23,000-item VSS tree.
- **Every VSS command hangs for 60 s, then says "ss.exe did not respond... check your network".** This happens when `vssBridge.username` is not a VSS user: ss.exe ignores `-I-`, asks `Password:` on the console and waits forever. The prompt is now detected, ss.exe is stopped at once, and you get a clear "VSS did not accept the login" error.
- **Login or network errors read as "not checked out".** `ss Status` errors were treated as "file is free", so Check In said "there is nothing to check in". They are now reported as errors.
- **Dates in other regional formats** (`27-Oct-26`, `2026-10-27`, `27.10.2026`, 24-hour times) are now recognised, so checkouts are still detected on PCs with different date settings.
- **Check Out on an editable file could silently destroy local edits** (`ss Checkout -I-Y` replaces writable files). It now asks first.
- **Right-click a folder > VSS: Check Out / Check In...** ran ss.exe on the folder with the wrong local folder. It now works on the files inside the folder.

### Added
- **Explorer badges**: files checked out in VSS show a ✓. Green means you have them, and their parent folders turn green too. Red means someone else has them; hover to see who. Only the folders you have open are read (one quick `ss Dir -E` each, about 0.3 s), and they refresh every `vssBridge.explorerRefreshMinutes` (default 5), after your own VSS actions, and on **VSS: Refresh Status**.
- **Multiple files at once**: select several files or a folder in the Explorer, then use Check Out / Check In / Undo Checkout / Get Latest. Check In asks for one comment for all of them. Files that do not apply are skipped (for example, Check In skips files that are not checked out by you). Progress is shown and can be cancelled, and a summary lists failures with a link to the log.
- **VSS: Check In My Checkouts...** lists every workspace file you have checked out (all ticked), and checks in the ones you keep ticked.
- Settings `vssBridge.explorerDecorations` and `vssBridge.explorerRefreshMinutes`.

## [0.1.8] - 2026-10-27

### Fixed
- **Check In failing with "You currently have file ... checked out"** (root cause of the check-in problems since 0.1.5). The `ss Status` parser looked for `User: X  Date:` lines, a format `ss Status` never prints. Real output is `login.php   moizbohra   Exc  27-10-26  3:50p`, so every checked-out file was reported as "not checked out". The check-in pre-flight then started the "Check Out, Keep My Changes & Check In" flow, and its `ss Checkout` failed because you already had the file. The parser now reads the real column format (verified against 69 real `ss Status` outputs). This also fixes:
  - the status bar always showing "Checked in" for files you have checked out
  - files checked out by someone else not being detected on open or check in
- **"Not in VSS" detection**: the real ss.exe message `... is not an existing filename or project` is now recognised, so you get the mapping-help dialog instead of a generic error.
- **False "VSS login failed"**: any ss.exe error for a file with "password" in its name (e.g. `change_password.php`) was reported as a login failure.
- **Get Latest could overwrite saved edits**: it only asked for confirmation when the editor had unsaved changes, so a checked-out file with saved edits was silently replaced. It now also asks when the local file is editable.

## [0.1.7] - 2026-10-27

### Fixed
- **Smart Check In: file-restore robustness** - `ss Checkout` was sometimes leaving the local file with the read-only attribute set, which made the in-flight `fs.writeFileSync` (the step that restores your local edits on top of the freshly checked-out file) fail with `EACCES`. The smart flow now explicitly clears the read-only attribute before writing your content back, and logs every step (`SMART-CHECKIN step 1/3`, `2/3`, `3/3`) to the Output panel so you can see exactly where it stops if it ever does.
- **"Checked out by someone else" false positive** - if your VSS username in settings did not exactly match the name VSS reports (case, `DOMAIN\user` prefix, multi-checkout where you are one of several users), the pre-flight check used to say the file was checked out by someone else and BLOCK your check-in. The parser now:
  - Collects ALL `User:` lines (multi-checkout aware) - if any of them is you, `byMe = true`.
  - Matches `DOMAIN\user` against the bare username in your settings.
  - Stays case-insensitive.
- **Safety net in the check-in dialog**: even if the parser still concludes "someone else has it" but your local copy is editable (which strongly suggests it is actually your checkout), the extension now asks "Check In Anyway?" instead of hard-blocking, with an explanation of why the mismatch happened.

### Added
- Detailed `CHECK-IN pre-flight status` and `SMART-CHECKIN step N/3` lines in the Output log channel for easier debugging.
- 4 new unit tests for the parser (multi-checkout, `DOMAIN\user`, case-insensitive match) - 36 tests total, all green.

## [0.1.6] - 2026-10-27

### Fixed
- **Smart Check In preserves local edits when a file is not checked out** (fixes the data-loss bug introduced by the 0.1.5 "Check Out and Edit" button). Previously, when you tried to check in a file that was NOT checked out but had local edits, the "Check Out and Edit" button ran `ss Checkout` which **overwrote the local file with the VSS version and silently destroyed your work**. The Check In command now detects this scenario and offers three explicit choices:
  - **Check Out, Keep My Changes & Check In** - backs up your local file, runs `ss Checkout` (which overwrites the local copy with the VSS version), restores your content from the backup, and then runs `ss Checkin` - all in one atomic queue job. Your edits end up committed to VSS without ever being at risk.
  - **Just Check Out (Discard My Changes)** - the old behaviour, for when you really do want to throw away local edits and start fresh from VSS.
  - **Cancel** - abort, file is untouched.
  - If the smart flow fails partway (e.g. checkout succeeded but checkin failed), the file is left checked out to you with your local content safely on disk and a clear message tells you to retry Check In or Undo Checkout.

### Changed
- The "NOT checked out" warning now branches on whether you have local edits:
  - **writable local file** (you edited it) -> the smart-flow dialog above
  - **read-only local file** (pristine VSS copy) -> the simpler "nothing to check in" message with a plain "Check Out and Edit" button (no data loss possible because there are no local edits)

## [0.1.5] - 2026-10-27

### Added
- **Smart Check In pre-flight check** (runs before the comment box):
  - Trying to check in a file that is **not checked out** -> warning: "This file is NOT checked out - there is nothing to check in", with a one-click "Check Out and Edit" button. *(Note: in 0.1.6 this button was replaced with a safer smart flow when local edits exist.)*
  - File is **checked out by someone else** -> error names the user: "checked out by \"<user>\" (someone else) - ask them to check it in first".
  - File is **not in the VSS database** -> friendly not-found dialog with mapping help.

## [0.1.4] - 2026-10-27

### Fixed
- **Critical deadlock**: choosing "Check Out and Edit" (or "Get Latest Copy" / "Try Check Out Anyway") in the open-file prompt froze the whole extension - the checkout never ran and every later VSS operation (right-click Check Out / Check In, Get Latest, History, status bar) hung until VS Code was reloaded. The prompt now runs its VSS work and the user question in two separate phases, so the action queue can never deadlock again. Bonus: while the prompt is open, other VSS operations keep working.

## [0.1.3] - 2026-10-27

### Changed
- **All texts are now in English**: the full README guide, every error message, the Test Connection results and the Change Log - no Hinglish strings remain anywhere in the extension.

## [0.1.2] - 2026-10-27

### Changed
- **New logo**: modern gradient design with check-out / check-in arrows and the "Developed by Moiz Bohra" badge.
- The extension is now published as **Moiz Bohra** - it appears as the author/publisher in the Extensions panel.

### Added
- "Developed by Moiz Bohra" branding: status bar tooltips, quick action menu footer, history panel footer, and a one-time welcome message.

## [0.1.1] - 2026-10-27

### Fixed
- **Check In with empty comment failed**: ss.exe was given a bare `-C` flag which makes it ask for a comment interactively. An empty comment is now correctly sent as `-C-` (documented VSS switch for "no comment"). This was the cause of "checkout works but checkin does not".

### Added
- **Per-folder mapping support** (`vssBridge.mappings`): map any local folder to any VSS project when the local layout does not mirror the VSS tree - fixes "$/MyProject/test.php is not an existing filename or project" type errors caused by structure mismatch.
- **`VSS: Test Connection & Mapping` command**: step-by-step diagnosis (ss.exe location, srcsafe.ini reachability, login, and whether the active file's mapped VSS path actually exists in the database).
- **Output log channel** ("VSS Bridge" in the Output panel + `VSS: Show Output Log` command): every ss.exe command, exit code and raw output is logged (password masked) for easy troubleshooting.
- Friendly error dialog for "not found in VSS" errors showing the local path, the mapped VSS path, and quick buttons to test mapping or open settings.
- Check In now pre-validates: file must exist in VSS and be checked out by you, with clear messages instead of cryptic ss.exe output.

## [0.1.0] - 2026-10-27

### Added
- Dreamweaver-style prompt when a file is opened: `Check Out and Edit` / `View Only` / `Don't Ask for This File`
- Smart skip: files already checked out by you open silently in edit mode
- Warning prompt when a file is checked out by another user (with Get Latest / Try Checkout options)
- Commands: Check Out, Check In (with comment), Undo Checkout, Get Latest Version, Show History, View or Check Out, Refresh Status, Open Settings
- Status bar indicator for the active file's VSS state, with quick action menu
- File history viewer panel (version, user, date/time, action, comment)
- Explorer + editor context menu integration
- Windows read-only attribute used to protect "View Only" files
- Automatic Get Latest when the local copy is missing (configurable)
- ss.exe client wrapper with SSDIR/SSUSER/SSPWD environment handling, per-operation timeout and serialized (non-concurrent) VSS operations
