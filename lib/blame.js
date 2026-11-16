'use strict';

/**
 * Line-by-line "who changed this" built from successive versions of a file.
 * VSS has no blame command, so each version is diffed against the previous one:
 * a line that survives keeps its owner, a new or changed line belongs to the
 * version that introduced it.
 */

/**
 * For every line of `b`, the index of the matching line in `a`, or -1 when the
 * line is new/changed (longest common subsequence, after trimming the common
 * head and tail so ordinary edits cost almost nothing).
 */
function diffLines(a, b) {
  const map = new Array(b.length).fill(-1);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) { map[head] = head; head++; }
  let tail = 0;
  while (head + tail < a.length && head + tail < b.length && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    map[b.length - 1 - tail] = a.length - 1 - tail; tail++;
  }
  const n = a.length - head - tail, m = b.length - head - tail;
  if (!n || !m) { return map; }
  // shortcut: a rewrite of >5000x5000 lines is attributed wholesale to the newer version, upgrade to Myers diff if that is ever hit
  if (n * m > 25e6) { return map; }
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w); // dp[i*w+j] = LCS length of a[head+i..] and b[head+j..]
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[head + i] === b[head + j]
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[head + i] === b[head + j]) { map[head + j] = head + i; i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { i++; }
    else { j++; }
  }
  return map;
}

/**
 * @param {Array<{lines: string[]}>} versions oldest first, each with its text split into lines
 * @returns {Array} for every line of the newest version, the version record that last changed it
 */
function blame(versions) {
  let owners = [];
  let prev = [];
  for (const v of versions) {
    const map = diffLines(prev, v.lines);
    owners = map.map((i, j) => (i >= 0 ? owners[i] : v));
    prev = v.lines;
  }
  return owners;
}

function splitLines(text) {
  return String(text).split(/\r?\n/);
}

module.exports = { diffLines, blame, splitLines };
