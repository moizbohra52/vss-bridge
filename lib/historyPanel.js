'use strict';

/**
 * VSS Bridge - file history viewer (webview panel).
 * Shows every version with user, date/time, action and comment.
 */

const vscode = require('vscode');

class HistoryPanel {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {string} fileName  display name of the file
   * @param {Array}  versions  parsed history records
   */
  static show(context, fileName, versions) {
    if (HistoryPanel.current) {
      HistoryPanel.current.panel.reveal(vscode.ViewColumn.Beside);
    } else {
      HistoryPanel.current = new HistoryPanel(context);
    }
    HistoryPanel.current.update(fileName, versions);
  }

  static disposeCurrent() {
    if (HistoryPanel.current) {
      try { HistoryPanel.current.panel.dispose(); } catch (e) { /* noop */ }
      HistoryPanel.current = null;
    }
  }

  constructor(context) {
    const panel = vscode.window.createWebviewPanel(
      'vssBridgeHistory',
      'VSS File History',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: false, retainContextWhenHidden: true }
    );
    panel.onDidDispose(() => {
      if (HistoryPanel.current && HistoryPanel.current.panel === panel) {
        HistoryPanel.current = null;
      }
    });
    this.panel = panel;
  }

  update(fileName, versions) {
    this.panel.title = 'VSS History - ' + fileName;
    this.panel.webview.html = this._html(fileName, versions || []);
  }

  _html(fileName, versions) {
    const esc = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    const rows = versions.map((v, i) => `
      <tr class="${i === 0 ? 'latest' : ''}">
        <td class="ver">v${esc(v.version)}${i === 0 ? '<span class="tag">latest</span>' : ''}</td>
        <td>${esc(v.user)}</td>
        <td class="nowrap">${esc(v.date)} ${esc(v.time)}</td>
        <td>${esc(v.action)}</td>
        <td class="comment">${esc(v.comment) || '<span class="dim">(no comment)</span>'}</td>
      </tr>`).join('');

    const body = versions.length
      ? rows
      : `<tr><td colspan="5" class="empty">No history entries were returned by VSS for this file.</td></tr>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --border: var(--vscode-panel-border, rgba(128,128,128,.35));
    --accent: var(--vscode-focusBorder, #3794ff);
    --dim: var(--vscode-descriptionForeground);
    --row-hover: rgba(128,128,128,.12);
  }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--fg); background: var(--bg);
    margin: 0; padding: 16px 20px 40px;
  }
  h1 { font-size: 16px; font-weight: 600; margin: 0 0 4px; }
  .sub { color: var(--dim); margin: 0 0 16px; font-size: 12px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); border-bottom: 1px solid var(--border); }
  tbody tr:hover { background: var(--row-hover); }
  tr.latest td.ver { color: var(--accent); font-weight: 700; }
  .ver { white-space: nowrap; }
  .tag {
    display: inline-block; margin-left: 8px; padding: 1px 7px;
    font-size: 10px; font-weight: 600; letter-spacing: .05em;
    border: 1px solid var(--accent); border-radius: 999px; color: var(--accent);
  }
  .nowrap { white-space: nowrap; }
  .comment { max-width: 420px; word-break: break-word; }
  .dim { color: var(--dim); }
  .empty { color: var(--dim); text-align: center; padding: 32px 0; }
  .count { color: var(--dim); font-size: 11px; margin-top: 10px; }
  .credit { color: var(--dim); font-size: 11px; margin-top: 14px; border-top: 1px solid var(--border); padding-top: 10px; }
</style>
</head>
<body>
  <h1>Version History</h1>
  <p class="sub">${esc(fileName)}</p>
  <table>
    <thead>
      <tr><th>Version</th><th>User</th><th>Date / Time</th><th>Action</th><th>Comment</th></tr>
    </thead>
    <tbody>${body}</tbody>
  </table>
  <p class="count">${versions.length} version(s) found in VSS.</p>
  <p class="credit">VSS Bridge \u00b7 Developed by Moiz Bohra</p>
</body>
</html>`;
  }
}

HistoryPanel.current = null;

module.exports = { HistoryPanel };
