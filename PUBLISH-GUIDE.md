# How to Publish VSS Bridge to the VS Code Marketplace

Complete step-by-step guide. Publishing is **free** — you only need a Microsoft account and about 10 minutes.

---

## What You Need

- A **Microsoft account** (any Outlook / Hotmail / Live account works)
- The `vss-bridge` source folder (already packaged and tested — version 0.1.3)

---

## Step 1 — Get a Personal Access Token (PAT)

1. Open **https://dev.azure.com** and sign in with your Microsoft account.
   - First time? It will ask you to create an "organization" — accept the defaults (any name is fine).
   - First-time login may also ask for phone/identity verification — complete it once.
2. Click the **User settings icon** (top-right) → **Personal Access Tokens** → **+ New Token**
3. Fill the form:

   | Field | Value |
   |---|---|
   | Name | `marketplace` |
   | Organization | **All accessible organizations** |
   | Expiration | 90 days (or as you prefer) |
   | Scopes | **Custom defined → Show all scopes → Marketplace → tick "Manage"** |

4. Click **Create** and **copy the token immediately** — it is shown only once.

> ⚠️ The scope must be **Marketplace → Manage**. Without it, publish fails with a 401 error.

---

## Step 2 — Create Your Publisher

1. Open **https://marketplace.visualstudio.com/manage**
2. Sign in with the same Microsoft account
3. Click **Create publisher**
4. Fill it in:

   | Field | Value |
   |---|---|
   | **ID** | `MoizBohra` — **must exactly match** the `"publisher"` field in package.json |
   | Name | Moiz Bohra |
   | Website / Email | your choice |

> If you prefer a different publisher ID, change `"publisher"` in `package.json` to the same value first. The two must match.

---

## Step 3 (Recommended) — Put the Source on GitHub

The Marketplace shows a "Repository" link on the extension page. To set it up:

1. Create a GitHub repository, e.g. `moizbohra/vss-bridge`, and push the `vss-bridge` folder to it.
2. Edit `package.json` and replace the placeholder repository:

```json
"repository": {
  "type": "git",
  "url": "https://github.com/moizbohra/vss-bridge.git"
}
```

> You can skip this step — publishing still works without a real repository — but a real repo looks more professional on the listing page.

---

## Step 4 — Publish

Open Command Prompt in the `vss-bridge` folder:

```cmd
cd vss-bridge

:: one time - saves the PAT (paste it when asked)
npx @vscode/vsce login MoizBohra

:: publish the current version (0.1.3)
npx @vscode/vsce publish
```

Or do it in a single command without login:

```cmd
npx @vscode/vsce publish -p YOUR_PAT_HERE
```

Within ~5 minutes the extension is live at:

```
https://marketplace.visualstudio.com/items?itemName=MoizBohra.vss-bridge
```

After that, anyone can install it directly from the Extensions panel in VS Code by searching "VSS Bridge".

---

## Future Updates

```cmd
:: bumps 0.1.3 -> 0.1.4 and publishes in one step
npx @vscode/vsce publish patch

:: other options: minor (0.2.0), major (1.0.0)
```

Rules to remember:

- The **same version can never be published twice** — always bump the version first (`patch` / `minor` / `major`).
- For README / icon / description changes, bump the version and publish again.
- Manage everything (listing, versions, delete/unpublish) at **https://marketplace.visualstudio.com/manage**

---

## Optional — Also Publish to Open VSX

Open VSX (https://open-vsx.org) is the marketplace used by VSCodium, Gitpod and other VS Code forks:

1. Create an account at open-vsx.org → Settings → Access Tokens → generate one
2. Publish from the same folder:

```cmd
npx ovsx publish -p YOUR_OPENVSX_TOKEN
```

---

## Common Errors

| Error | Cause / Fix |
|---|---|
| `401 Unauthorized` | PAT expired, or the scope "Marketplace → Manage" was not ticked. Create a fresh PAT. |
| `Publisher 'MoizBohra' not found` | You did not create the publisher yet (Step 2), or the ID spelling does not match package.json. |
| `Invalid repository URL` warning | The placeholder `https://example.invalid/vss-bridge` is still in package.json — set your real GitHub URL (Step 3). |
| `Make sure to edit the README.md` | Cosmetic warning — the README already exists, safe to ignore. |
| PAT not asked again but 401 | The saved token expired — run `npx @vscode/vsce logout MoizBohra` then `login` again with a fresh PAT. |

---

## Quick Checklist

- [ ] PAT created with **Marketplace → Manage** scope
- [ ] Publisher **MoizBohra** created at marketplace.visualstudio.com/manage
- [ ] (Optional) Real GitHub repository URL in package.json
- [ ] `npx @vscode/vsce publish -p <PAT>`
- [ ] Live listing verified at `https://marketplace.visualstudio.com/items?itemName=MoizBohra.vss-bridge`
