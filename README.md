# VSS Bridge (Visual SourceSafe) - VS Code Extension

> Developed by **Moiz Bohra**

A **Dreamweaver-style Visual SourceSafe (VSS) experience inside VS Code**.

Just like Dreamweaver asks "View or Check Out?" the moment you open a file with VSS connected - this extension does exactly the same. It talks to your VSS database through `ss.exe`, so you can do all of your work inside VS Code: open files, check out, edit, check in and browse history.

---

## Features

| Feature | What it does |
|---|---|
| **Open Prompt** (Dreamweaver style) | The moment you open a file, a popup appears: `Check Out and Edit` / `View Only` / `Don't Ask for This File` |
| **Smart Skip** | Files you have already checked out (writable) never trigger the prompt again - you can edit right away |
| **Check In** | Submits the file back to VSS together with a comment |
| **Undo Checkout** | Discards local changes and releases the lock |
| **Get Latest Version** | Pulls the newest copy from VSS to your local folder |
| **Show History** | Detail panel for every version - which user, when, with which comment |
| **Status Bar** | Shows the VSS state of the active file: `Checked in` / `Checked out (you)` / `Checked out by <user>` |
| **Read-only View** | "View Only" keeps the Windows read-only attribute on the file, so it cannot be saved by accident |
| **Explorer badges** | Files checked out in VSS get a ✓ in the Explorer: **green** = checked out by you (parent folders turn green too), **red** = checked out by someone else (hover to see who) |
| **Multiple files at once** | Select several files or a folder in the Explorer -> Check Out / Check In / Undo Checkout / Get Latest. One comment for the whole check-in |
| **Check In My Checkouts** | One list of every file you have checked out - untick what you want to keep and check in the rest |
| **Search results in one click** | Search in VS Code, then Check Out or Check In every file in the results with one button in the Search view |
| **VSS Checkouts view** | A list in the Explorer of every checked-out file (yours and other people's), sortable by **date**, **user** or **default** (folder and name) |
| **Editor tab buttons** | Check Out / Check In buttons at the top right of every open file |
| **Keyboard shortcuts** | `Ctrl+Alt+V` then one key for every VSS action (see the table below) |

## Requirements

1. A **Windows machine** running VS Code (VSS exists only on Windows).
2. **VSS client installed** - as it already is on your office machine. The extension only needs `ss.exe`.
3. The **VSS database path** - the folder where `srcsafe.ini` lives (a network share works too, e.g. `\\vssserver\vss\`).
4. Your **VSS username/password**.

The extension calls VSS's official command line tool `ss.exe`, so it works with both VSS 6.0 and VSS 2005. No extra server component is required.

## Install

### Method 1 - Command line (easiest)

```cmd
code --install-extension vss-bridge-0.2.1.vsix
```

### Method 2 - VS Code UI

1. Open VS Code
2. Click the **Extensions** icon on the left (or press `Ctrl+Shift+X`)
3. In the Extensions panel, open the top-right `...` menu -> **Install from VSIX...**
4. Select the `vss-bridge-0.2.1.vsix` file
5. Reload VS Code

## Settings (Essential Configuration)

After installing, configure the settings once. Open `File > Preferences > Settings`, search for `VSS Bridge`, or write this directly into `settings.json`:

```jsonc
{
  // Full path to ss.exe (found in the VSS client install folder)
  "vssBridge.ssExePath": "C:\\Program Files (x86)\\Microsoft Visual SourceSafe\\ss.exe",

  // Path of the FOLDER that contains srcsafe.ini (not the file itself - only the folder!)
  "vssBridge.databasePath": "\\\\vssserver\\vss",

  // Your VSS login
  "vssBridge.username": "moizbohra",
  "vssBridge.password": "",

  // Which VSS project your VS Code folder is mapped to
  // Example: C:\dev\MyApp\Source  <->  $/MyApp/Source
  "vssBridge.vssProject": "$/MyApp/Source",

  // Should the "View or Check Out" popup appear when a file is opened? (default: true)
  "vssBridge.promptOnOpen": true
}
```

### Complete settings list

| Setting | Default | Purpose |
|---|---|---|
| `vssBridge.ssExePath` | `C:\Program Files (x86)\Microsoft Visual SourceSafe\ss.exe` | Location of ss.exe |
| `vssBridge.databasePath` | (empty) | The folder containing `srcsafe.ini`. This becomes `SSDIR` |
| `vssBridge.username` | (empty) | VSS user name |
| `vssBridge.password` | (empty) | VSS password (leave empty if your account has no password) |
| `vssBridge.vssProject` | `$/` | The VSS project that corresponds to the workspace folder |
| `vssBridge.mappings` | `[]` | Per-folder mappings for when the local layout differs from VSS (see example below) |
| `vssBridge.promptOnOpen` | `true` | View/Checkout prompt when a file is opened |
| `vssBridge.ignoredFileTypes` | (binary list) | Files with these extensions never trigger the prompt |
| `vssBridge.autoGetWhenMissing` | `true` | If the local file is missing, run Get Latest first |
| `vssBridge.timeoutSeconds` | `60` | Timeout for every ss.exe operation |
| `vssBridge.statusBarEnabled` | `true` | Status bar indicator |
| `vssBridge.explorerDecorations` | `true` | ✓ badges on checked-out files in the Explorer |
| `vssBridge.explorerRefreshMinutes` | `5` | How often visible folders are re-read to pick up other people's checkouts (`0` = only after your own actions and **VSS: Refresh Status**) |

### Understanding vssProject mapping (important - fixes "is not an existing filename")

`vssProject` tells the extension which VSS project matches the folder you opened in VS Code:

```
VS Code folder:              C:\dev\api
vssBridge.vssProject:        $/MyProject/webapp/api

C:\dev\api\test.php         ->  $/MyProject/webapp/api/test.php
C:\dev\api\orders\save.php  ->  $/MyProject/webapp/api/orders/save.php
```

**Rule: the structure of the VS Code folder must EXACTLY mirror the structure inside the VSS project.** If it does not match, you get this error:

```
$/MyProject/test.php is not an existing filename or project
```

### Problem: the local folder layout differs from VSS? -> use `vssBridge.mappings`

Example - you opened `C:\htdocs\MyProject` in VS Code, but in VSS the files live inside `$/MyProject/webapp/api`:

```jsonc
{
  "vssBridge.vssProject": "$/MyProject/webapp/api",
  "vssBridge.mappings": [
    { "local": "webapp\\api", "vss": "$/MyProject/webapp/api" }
  ]
}
```

With this configuration:

```
C:\htdocs\MyProject\test.php                    -> $/MyProject/webapp/api/test.php          (fallback rule)
C:\htdocs\MyProject\webapp\api\index.php        -> $/MyProject/webapp/api/index.php         (mapping rule - no doubled path)
C:\htdocs\MyProject\webapp\api\orders\save.php  -> $/MyProject/webapp/api/orders/save.php
```

- `local` = the path inside the VS Code workspace folder (both `\\` and `/` work) - an absolute path is also allowed
- `vss` = the VSS project this folder is mapped to (with or without the `$/` prefix, both work)
- The deepest matching mapping wins; anything that does not match falls back to `vssProject`
- Different folders can be mapped to different VSS projects (multiple mappings allowed)

### Verifying the mapping: "VSS: Test Connection & Mapping"

Open the Command Palette (`Ctrl+Shift+P`) and run **`VSS: Test Connection & Mapping`**. It checks step by step:

1. Is `ss.exe` present at the configured path?
2. Is `srcsafe.ini` reachable?
3. Does the login with username/password work?
4. **Does the mapped VSS path of the active file really exist in the database?**

The result appears in the Output panel ("VSS Bridge" channel) - if you suspect a mapping problem, run this first.

### Viewing the ss.exe command log

Every checkout/checkin/status command is fully logged in the Output panel: **View > Output > "VSS Bridge"** (or run `VSS: Show Output Log` from the Command Palette). If an error appears, copy the exact ss.exe output from there to debug it.

## How to work with it (Daily Workflow)

### 1. Open a file -> the prompt appears

As soon as you open any mapped file in VS Code:

```
You opened "login.frm" from VSS. How do you want to continue?

[ Check Out and Edit ]  [ View Only ]  [ Don't Ask for This File ]
```

- **Check Out and Edit** -> locks the file in VSS, gets the latest version locally, ready to edit
- **View Only** -> opens the file read-only (it cannot be saved by accident)
- **Don't Ask** -> no more prompts for this file in this session
- **Esc / close** -> nothing happens, the file stays open in view mode

**Smart Skip:** if the file is already checked out in your name (writable), the prompt is skipped - you can edit straight away.

### 2. When the work is done, Check In

- **Right-click the file -> VSS: Check In** (or click the status bar and choose it from the menu)
- A comment box appears - whatever you type goes into the VSS history
- After check in, the file becomes read-only again

**If you forgot to check out first** but already have local edits, the extension detects this and offers a **smart flow**:

```
This file is NOT checked out in VSS, but your local copy has unsaved changes.
A normal "Check Out" would overwrite your local file with the VSS version,
and your work would be LOST.

[ Check Out, Keep My Changes & Check In ]  [ Just Check Out (Discard My Changes) ]  [ Cancel ]
```

- **Check Out, Keep My Changes & Check In** - the extension backs up your local file, runs `ss Checkout` (which overwrites the local copy with the VSS version), restores your content from the backup, and then runs `ss Checkin` - all atomically. Your edits end up committed to VSS without being at risk.
- **Just Check Out (Discard My Changes)** - the old behaviour, when you really do want to start fresh from VSS.
- **Cancel** - abort, file is untouched.

If the file is NOT checked out and you have **no local edits** (read-only pristine copy), you simply get "there is nothing to check in" with a plain Check Out button.

### 3. To cancel changes, Undo Checkout

- **Right-click -> VSS: Undo Checkout** - local changes are discarded and the latest VSS copy is restored (it asks for confirmation first)

### Working with several files

- **Ctrl/Shift-click several files** in the Explorer (or right-click a **folder**) -> **VSS: Check Out / Check In / Undo Checkout / Get Latest**. A folder includes every file under it.
- Only files where the action makes sense are touched; the rest are counted as "skipped". For example, Check In and Undo Checkout only take files checked out by you, and Check Out leaves out files you already have.
- Check In asks for **one comment** for all files. If some files are editable locally, Check Out / Get Latest ask before overwriting them (**Overwrite** or **Skip Editable Files**).
- A progress notification shows `3/12 file.php` and can be cancelled. At the end you get a summary (`10 checked in, 2 failed`) with a button to the Output log.
- **VSS: Check In My Checkouts...** (Command Palette, status bar menu or Explorer right-click) lists every workspace file you have checked out, all ticked. Untick the ones to keep and press Enter.
- **Search results**: search in the Search view (`Ctrl+Shift+F`), then click the ✎ (**Check Out All Search Results**) or ☁ (**Check In All Search Results**) button at the top of the Search view. Every file in the results goes through the same multi-file flow as above. Shortcuts: `Ctrl+Alt+V` `Shift+O` / `Ctrl+Alt+V` `Shift+I`.
- On an open file, the **✎ Check Out** and **☁ Check In** buttons sit at the top right of the editor, next to the tabs.

### VSS Checkouts view (sort by date / user)

The Explorer has a **VSS Checkouts** section (collapsed at first - click to open it). It lists every workspace file that is checked out in VSS, by you or anyone else, as `user · date · folder`.

- The sort button at the top picks the order: **Date** (newest checkout first), **User** (A-Z), or **Default** (folder and file name). The choice is remembered per workspace.
- Click a file to open it. Right-click your own files for **Check In** / **Undo Checkout** (also as an inline button), any file for **Show History**. Ctrl/Shift-click to select several.
- The list is read from VSS when you open the section, after your own VSS actions, and with the refresh button. VS Code's own Explorer tree cannot be re-sorted by an extension, which is why this is a separate list.

### When someone else changed the same file

Suppose you opened `tax.php`, a colleague then checked in their own changes, and you have changes too (unsaved typing, or edits saved without checking out). **Check Out** and **Check In** then stop and ask:

```
Rupendra.agrawal changed "tax.php" in VSS after your copy was taken
(version 6, 28-10-26 2:30p: "fix tax"). You have changes too.

Do you want to keep their changes?

[ Merge (Compare Both) ]  [ Keep Their Changes ]  [ Keep Only Mine ]
```

- **Merge (Compare Both)**: the file is checked out *with your changes*, and their version opens on the left (read-only) next to yours. Click the arrow next to each change you want from them, save, then **Check In**.
- **Keep Their Changes**: your copy is replaced with their version.
- **Keep Only Mine**: your version wins (their changes are overwritten when you check in).

You are only asked when both sides changed something. If only you changed the file, Check Out keeps your changes without asking. If only they changed it, Check Out brings their version and tells you who changed it.

For files you have open you also get a heads-up when someone else **checks one out** ("Ankit just checked out tax.php") or **releases** it. The release notice has *Compare With Their Version* / *Get Their Version* buttons. These come with the Explorer badge refresh. If you open a writable file that someone else has checked out (shared working folder), you are warned that your saves go into their checkout.

### Explorer badges

| Badge | Meaning |
|---|---|
| green ✓ (folder name green too) | Checked out by you |
| red ✓ | Checked out by someone else - hover to see who |
| no badge | Checked in, or not in VSS |

Only the folders you have open in the Explorer are read from VSS (one quick `ss Dir` per folder). The badges refresh after your own VSS actions, every `vssBridge.explorerRefreshMinutes`, and when you run **VSS: Refresh Status**.

### 4. Viewing history

- **Right-click -> VSS: Show History** - a side panel shows all versions: version number, user, date/time, action and comment

### 5. Status bar indicator

At the bottom-left of the editor, the state of the active file:

| Icon | Meaning |
|---|---|
| `$(check) VSS: Checked in` | The file is locked in VSS, you are viewing it |
| `$(pencil) VSS: Checked out (you)` | You have checked it out and can edit |
| `$(lock) VSS: otheruser` | The file is checked out by another user |
| `$(circle-slash) VSS` | The file is not in VSS (new local file) |

Click the status bar -> the quick menu with all VSS actions opens.

### Commands (type `VSS:` in the Command Palette)

| Command | Action |
|---|---|
| `VSS: Check Out` | Check out (on a file or Explorer selection) |
| `VSS: Check In` | Check in with a comment |
| `VSS: Check In My Checkouts...` | Pick from every file you have checked out and check them in together |
| `VSS: Check Out All Search Results` | Check out every file in the Search view's results |
| `VSS: Check In All Search Results` | Check in every file in the Search view's results (one comment) |
| `VSS: Sort Checkouts (Date / User / Default)...` | Order of the VSS Checkouts view |
| `VSS: Undo Checkout` | Discard changes and release the lock |
| `VSS: Get Latest Version` | Pull the latest copy from VSS |
| `VSS: Show History` | Open the history panel |
| `VSS: View or Check Out...` | Show the open prompt again |
| `VSS: Actions for This File...` | The quick menu of the status bar |
| `VSS: Refresh Status` | Re-read the status bar, Explorer badges and VSS Checkouts view from VSS |
| `VSS: Test Connection & Mapping` | Step-by-step diagnosis: ss.exe, srcsafe.ini, login, file mapping |
| `VSS: Show Output Log` | Full log of ss.exe commands (debugging) |
| `VSS: Open Settings` | Open the extension settings |

### Keyboard shortcuts

Press `Ctrl+Alt+V`, let go, then press the second key. File commands work on the active editor.

| Keys | Action |
|---|---|
| `Ctrl+Alt+V` `O` | Check Out |
| `Ctrl+Alt+V` `I` | Check In |
| `Ctrl+Alt+V` `U` | Undo Checkout |
| `Ctrl+Alt+V` `G` | Get Latest Version |
| `Ctrl+Alt+V` `H` | Show History |
| `Ctrl+Alt+V` `P` | View or Check Out... (the open prompt) |
| `Ctrl+Alt+V` `M` | Check In My Checkouts... |
| `Ctrl+Alt+V` `Shift+O` | Check Out All Search Results |
| `Ctrl+Alt+V` `Shift+I` | Check In All Search Results |
| `Ctrl+Alt+V` `C` | Show the VSS Checkouts view |
| `Ctrl+Alt+V` `S` | Sort the VSS Checkouts view |
| `Ctrl+Alt+V` `R` | Refresh Status |
| `Ctrl+Alt+V` `V` | Quick menu with all actions |
| `Ctrl+Alt+V` `T` | Test Connection & Mapping |
| `Ctrl+Alt+V` `L` | Show Output Log |
| `Ctrl+Alt+V` `,` | Open Settings |

To change a key: `File > Preferences > Keyboard Shortcuts`, search for `VSS`.

## Troubleshooting

| Problem | Solution |
|---|---|
| `is not an existing filename or project` | **The mapping is wrong.** The local file path and the VSS project path do not match. Check `vssBridge.vssProject` and use `vssBridge.mappings` if needed (full example above in this README). You can also run **Test Connection & Mapping** directly from the error dialog buttons |
| Check In says "checked out by someone else" although it is yours | Fixed in **0.2.0**: VSS user names of 14+ characters (e.g. `firstname.lastname`) were read wrongly. Also check that `vssBridge.username` is your VSS user name (the one shown in VSS Explorer), not your Windows login |
| `A writable copy of ... already exists` | Fixed in **0.2.1**: ss.exe will not replace an edited (writable) file unless told to. Check Out / Get Latest now pass `-GWR`, and your changes are backed up and put back (or you are asked first) |
| Every VSS command takes a minute and then says "ss.exe did not respond" | Before 0.2.0 this meant `vssBridge.username` is not a VSS user: ss.exe waited for a password. 0.2.0 shows "VSS did not accept the login" at once - fix the username/password |
| Check In fails | (1) The file is not checked out? Since 0.1.6 the extension detects whether you have local edits and offers a smart flow that preserves them. (2) Checked out by someone else? The error names the user - ask them to check it in first. (3) Left the comment empty? That was fixed in v0.1.1 - please update. (4) For the exact error, open `VSS: Show Output Log` |
| "Check Out and Edit" destroyed my local edits | Fixed in **0.1.6** - the Check In command on a not-checked-out file now branches: writable file (you have edits) -> smart flow with a backup/restore step that preserves your work; read-only file -> safe plain Check Out. The 0.1.5 button ran `ss Checkout` directly which overwrote the local copy |
| `ss.exe was not found` | Check `vssBridge.ssExePath`. Look in the VSS install folder - right-click the "Microsoft Visual SourceSafe" shortcut in the Start menu -> Open file location. `ss.exe` is in the same folder |
| `unable to locate srcsafe.ini` | `vssBridge.databasePath` is wrong. Give the path of the FOLDER that contains `srcsafe.ini` (do not include the file name). For a network share write it like `\\server\share\vss\` |
| `VSS login failed / invalid password` | Check `vssBridge.username` / `vssBridge.password`. Verify with the VSS Admin that the account is active |
| `File ... is not existing` | Check the `vssBridge.vssProject` mapping - the VS Code folder structure must match the VSS project |
| Nothing happens, no prompt | (1) Is the file inside the mapped workspace folder? (2) Is the extension in the ignored list? (3) Is `vssBridge.promptOnOpen: true`? (4) Check View > Output > "VSS Bridge" ... (test manually with the log commands - see below) |
| Checkout feels slow | This is normal on a VSS network database. Increase `vssBridge.timeoutSeconds` for large files |
| Two users on the same file | VSS allows multi-checkout (if enabled in the database). The other user's name appears in the status bar |

### Manual test (to verify the settings)

Open Command Prompt outside VS Code and run this to confirm the ss.exe settings are correct:

```cmd
set SSDIR=\\vssserver\vss
"C:\Program Files (x86)\Microsoft Visual SourceSafe\ss.exe" Status "$/MyApp/Source/login.frm" -Ymoizbohra,
```

If this works, the extension will work too - these are exactly the commands the extension runs internally.

## Security Note

`vssBridge.password` is stored in plain text inside `settings.json`. Therefore:

- Prefer **Workspace settings** (`\.vscode\settings.json`) over **User settings**, and never share that file
- Or leave the password empty - the VSS Admin can remove the password from your account (an empty password is valid in VSS)
- Decide according to your office policy

## Known Limitations

- **Add file / Delete file** is not supported yet (use VSS Explorer to add new files to VSS) - may be added in a future version
- **Pin / Label / Branch / Share** operations are not in the UI
- **Diff** uses VS Code's built-in timeline/local diff; there is no VSS version-diff panel
- The Windows read-only attribute is what enforces "view only" - if someone removes the attribute manually, VS Code will allow editing (the VSS lock itself stays safe in VSS)
- One workspace folder = one VSS project mapping (multi-root workspaces use the first folder)

## How this extension works internally (technical)

For every operation the extension runs a command like this:

```
ss.exe Checkout "$/MyApp/Source/login.frm" -GLC:\dev\MyApp\Source -I-Y -Ymoizbohra,
```

- The `SSDIR` environment variable provides the database location
- `-I-Y` / `-I-` prevent any interactive prompt from hanging ss.exe
- `-GL<folder>` controls the working folder (your VS Code folder)
- `-Y<user>,<pass>` performs the login
- Status/History output is parsed and displayed inside VS Code

Look at the source code: `lib/ssClient.js` (ss.exe wrapper), `extension.js` (prompt + commands + status bar) and `lib/historyPanel.js` (history webview). To modify it yourself, just edit these files and package again:

```cmd
npm install -g @vscode/vsce
cd vss-bridge
vsce package
```

## Author

Developed by **Moiz Bohra**. This extension is built on top of Visual SourceSafe's official `ss.exe` command line tool - no server component or extra installation needed. If your office workflow needs any new feature, it can easily be added through the source code.

## License

MIT - feel free to modify it for your office.
