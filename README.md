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

## Requirements

1. A **Windows machine** running VS Code (VSS exists only on Windows).
2. **VSS client installed** - as it already is on your office machine. The extension only needs `ss.exe`.
3. The **VSS database path** - the folder where `srcsafe.ini` lives (a network share works too, e.g. `\\vssserver\vss\`).
4. Your **VSS username/password**.

The extension calls VSS's official command line tool `ss.exe`, so it works with both VSS 6.0 and VSS 2005. No extra server component is required.

## Install

### Method 1 - Command line (easiest)

```cmd
code --install-extension VSS-Bridge-0.1.7.vsix
```

### Method 2 - VS Code UI

1. Open VS Code
2. Click the **Extensions** icon on the left (or press `Ctrl+Shift+X`)
3. In the Extensions panel, open the top-right `...` menu -> **Install from VSIX...**
4. Select the `VSS-Bridge-0.1.7.vsix` file
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
| `VSS: Undo Checkout` | Discard changes and release the lock |
| `VSS: Get Latest Version` | Pull the latest copy from VSS |
| `VSS: Show History` | Open the history panel |
| `VSS: View or Check Out...` | Show the open prompt again |
| `VSS: Refresh File Status` | Refresh the status bar |
| `VSS: Test Connection & Mapping` | Step-by-step diagnosis: ss.exe, srcsafe.ini, login, file mapping |
| `VSS: Show Output Log` | Full log of ss.exe commands (debugging) |
| `VSS: Open Settings` | Open the extension settings |

## Troubleshooting

| Problem | Solution |
|---|---|
| `is not an existing filename or project` | **The mapping is wrong.** The local file path and the VSS project path do not match. Check `vssBridge.vssProject` and use `vssBridge.mappings` if needed (full example above in this README). You can also run **Test Connection & Mapping** directly from the error dialog buttons |
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
