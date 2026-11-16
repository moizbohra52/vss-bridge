'use strict';
const assert = require('assert');
const { diffLines, blame, splitLines } = require('../lib/blame');

const v = (version, text) => ({ version, lines: splitLines(text) });

assert.deepStrictEqual(diffLines(['a', 'b', 'c'], ['a', 'b', 'c']), [0, 1, 2], 'identical');
assert.deepStrictEqual(diffLines(['a', 'b', 'c'], ['a', 'x', 'b', 'c']), [0, -1, 1, 2], 'insert in middle');
assert.deepStrictEqual(diffLines(['a', 'b', 'c'], ['a', 'c']), [0, 2], 'delete');
assert.deepStrictEqual(diffLines(['a', 'b', 'c'], ['a', 'B', 'c']), [0, -1, 2], 'change');
assert.deepStrictEqual(diffLines([], ['a']), [-1], 'first version: everything new');
assert.deepStrictEqual(diffLines(['a', 'b'], ['b', 'a', 'b']), [-1, 0, 1], 'LCS over the middle');

const owners = blame([
  v('1', 'one\ntwo\nthree'),
  v('2', 'one\ntwo changed\nthree\nfour'),
  v('3', 'zero\none\ntwo changed\nthree\nfour')
]);
assert.deepStrictEqual(owners.map(o => o.version), ['3', '1', '2', '1', '2'], 'blame attributes each line to the version that last changed it');

console.log('blame: all assertions passed');
