'use strict';

/**
 * Unit tests for src/download.js `downloadProgressLabel`.
 *
 * Offline + deterministic: chalk colour is forced on (`chalk.level = 1`) so the
 * label text is identical regardless of TTY / FORCE_COLOR / environment.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const chalk = require('chalk');

const { downloadProgressLabel } = require('../src/download');

chalk.level = 1;

const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');

test('downloadProgressLabel builds the exact label for a filename', () => {
  const label = downloadProgressLabel('plugin.amxx');
  assert.equal(label, `  ${chalk.cyan('Downloading')} ${'plugin.amxx'.padEnd(30)}`);
});

test('downloadProgressLabel falls back to "file" when filename is undefined', () => {
  const label = downloadProgressLabel(undefined);
  assert.equal(label, `  ${chalk.cyan('Downloading')} ${'file'.padEnd(30)}`);
});

test('downloadProgressLabel preserves the 2-space indent and pads the name to 30', () => {
  const label = downloadProgressLabel('a.zip');
  assert.ok(label.startsWith('  '), 'label starts with two spaces');
  assert.equal(stripAnsi(label), `  Downloading ${'a.zip'.padEnd(30)}`);
  assert.equal(label.slice(-30), 'a.zip'.padEnd(30));
});
