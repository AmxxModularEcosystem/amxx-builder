'use strict';

/**
 * Unit tests for the pure helper isExcludedLocalAmxmodx in src/watcher.js.
 *
 * Requiring the module is safe: chokidar is required lazily inside startWatch,
 * so importing here does not start a watcher.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { isExcludedLocalAmxmodx } = require('../src/watcher');

test('isExcludedLocalAmxmodx: empty or missing patterns → false', () => {
  assert.equal(isExcludedLocalAmxmodx('configs/server.cfg', []), false);
  assert.equal(isExcludedLocalAmxmodx('configs/server.cfg', undefined), false);
  assert.equal(isExcludedLocalAmxmodx('configs/server.cfg', null), false);
});

test('isExcludedLocalAmxmodx: direct match → true', () => {
  assert.equal(isExcludedLocalAmxmodx('configs/server.cfg', ['configs/*.cfg']), true);
});

test('isExcludedLocalAmxmodx: non-match → false', () => {
  assert.equal(isExcludedLocalAmxmodx('configs/keep.txt', ['configs/*.cfg']), false);
  assert.equal(isExcludedLocalAmxmodx('scripting/p.sma', ['configs/*.cfg', '**/*.ini']), false);
});

test('isExcludedLocalAmxmodx: nested glob matches deep paths', () => {
  assert.equal(isExcludedLocalAmxmodx('lang/ru/settings.ini', ['**/*.ini']), true);
});

test('isExcludedLocalAmxmodx: dotfiles match (dot: true)', () => {
  // A bare wildcard must still match a leading-dot file — only true with dot:true.
  assert.equal(isExcludedLocalAmxmodx('configs/.env', ['configs/*']), true);
});

test('isExcludedLocalAmxmodx: path.sep is normalized to forward slashes', () => {
  const relPath = ['nested', 'deep', 'file.cfg'].join(path.sep);
  assert.equal(isExcludedLocalAmxmodx(relPath, ['nested/**/*.cfg']), true);
});
