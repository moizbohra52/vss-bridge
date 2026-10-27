'use strict';

/**
 * VSS Bridge - local folder to VSS project path mapping.
 *
 * Two ways to map:
 *
 *   1. vssBridge.vssProject  - the WHOLE workspace folder maps to one VSS
 *      project (simplest; local structure must mirror the VSS project).
 *
 *   2. vssBridge.mappings    - list of { "local": "...", "vss": "..." } pairs
 *      for when your local folder layout does NOT match the VSS tree, e.g.:
 *
 *        VS Code folder:      C:\htdocs\MyProject
 *        VSS project:         $/MyProject/webapp/api
 *
 *        "vssBridge.mappings": [
 *          { "local": "webapp\\api", "vss": "$/MyProject/webapp/api" }
 *        ]
 *
 *      `local` may be relative to the workspace folder OR an absolute path.
 *      The most specific (deepest) matching mapping wins; everything else
 *      falls back to vssProject.
 *
 * Windows path semantics are used explicitly (path.win32) because VSS only
 * exists on Windows - this also makes the functions deterministic for tests.
 */

const win = require('path').win32;

/** Normalize a VSS project path: backslashes -> slashes, ensure $/ prefix,
 *  strip trailing slashes. e.g. "MyProject/webapp/api/" -> "$/MyProject/webapp/api" */
function normalizeVssProject(p) {
  p = String(p || '$/').trim().replace(/\\/g, '/');
  if (!p.startsWith('$/')) { p = '$/' + p; }
  while (p.length > 2 && p.endsWith('/')) { p = p.slice(0, -1); }
  return p;
}

/** Join a VSS project with a relative rest path. */
function joinVss(project, rest) {
  const base = normalizeVssProject(project);
  if (!rest) { return base; }
  const cleanRest = String(rest).replace(/\\/g, '/').replace(/^\/+/, '');
  return base === '$/' ? '$/' + cleanRest : base + '/' + cleanRest;
}

/** Validate / normalize the user's mappings setting. */
function normalizeMappings(mappings) {
  const out = [];
  for (const m of (mappings || [])) {
    if (!m || typeof m !== 'object' || !m.vss) { continue; }
    if (typeof m.local !== 'string') { continue; } // local is required
    const vss = normalizeVssProject(m.vss);
    const local = m.local.trim();
    if (!local) {
      // explicit empty local = the workspace root itself
      out.push({ localPosix: '', localAbs: null, vss });
      continue;
    }
    if (win.isAbsolute(local)) {
      out.push({ localPosix: null, localAbs: local.replace(/[\\/]+$/, ''), vss });
    } else {
      out.push({
        localPosix: local.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
        localAbs: null,
        vss
      });
    }
  }
  return out;
}

/**
 * Map a local file path to its VSS item path.
 *
 * @param {string} fsPath          absolute local file path
 * @param {string} workspaceRootFs absolute workspace folder path
 * @param {Array}  mappings        vssBridge.mappings setting (raw)
 * @param {string} fallbackProject vssBridge.vssProject setting
 * @returns {string|null} VSS path like $/MyProject/webapp/api/test.php,
 *                        or null when the file is outside the workspace.
 */
function mapToVssPath(fsPath, workspaceRootFs, mappings, fallbackProject) {
  if (!fsPath) { return null; }
  const norm = normalizeMappings(mappings);

  let best = null;
  let bestLen = -1;

  const rel = workspaceRootFs ? win.relative(workspaceRootFs, fsPath) : null;
  const insideWorkspace = Boolean(
    rel && !rel.startsWith('..') && !win.isAbsolute(rel));

  if (insideWorkspace) {
    const relPosix = rel.split(win.sep).join('/');
    const relLower = relPosix.toLowerCase();

    // Workspace-relative mappings first (deepest wins).
    for (const m of norm) {
      if (m.localAbs !== null) { continue; }
      if (m.localPosix === '') {
        if (bestLen < 0) { bestLen = 0; best = joinVss(m.vss, relPosix); }
        continue;
      }
      const lp = m.localPosix;
      const lpLower = lp.toLowerCase();
      if (relLower === lpLower) {
        if (lp.length > bestLen) { bestLen = lp.length; best = joinVss(m.vss, ''); }
      } else if (relLower.startsWith(lpLower + '/')) {
        const rest = relPosix.slice(lp.length + 1);
        if (lp.length > bestLen) { bestLen = lp.length; best = joinVss(m.vss, rest); }
      }
    }

    if (best) { return best; }

    // Absolute mappings also apply to workspace files when no relative
    // mapping matched (e.g. a mapping pointing into the workspace).
    for (const m of norm) {
      if (m.localAbs === null) { continue; }
      const relAbs = win.relative(m.localAbs, fsPath);
      if (relAbs && !relAbs.startsWith('..') && !win.isAbsolute(relAbs)) {
        const rest = relAbs.split(win.sep).join('/');
        return joinVss(m.vss, rest);
      }
    }

    return joinVss(fallbackProject, relPosix);
  }

  // File outside the workspace: only absolute mappings can map it.
  for (const m of norm) {
    if (m.localAbs === null) { continue; }
    const relAbs = win.relative(m.localAbs, fsPath);
    if (relAbs && !relAbs.startsWith('..') && !win.isAbsolute(relAbs)) {
      const rest = relAbs.split(win.sep).join('/');
      if (m.localAbs.length > bestLen) {
        bestLen = m.localAbs.length;
        best = joinVss(m.vss, rest);
      }
    }
  }
  return best;
}

module.exports = { normalizeVssProject, joinVss, normalizeMappings, mapToVssPath };
