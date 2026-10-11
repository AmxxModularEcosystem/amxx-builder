'use strict';

/**
 * Unit tests for src/format.js — expandNameVersion + formatBytes.
 *
 * Offline + deterministic: no network, no filesystem.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { formatBytes, expandNameVersion } = require('../src/format');

// ─── expandNameVersion ──────────────────────────────────────────────────────

test('expandNameVersion: replaces both {name} and {version} tokens', () => {
  const manifest = { name: 'MyServer', version: '1.2.3' };
  assert.equal(expandNameVersion(manifest, '{name}/addons/amxmodx'), 'MyServer/addons/amxmodx');
  assert.equal(expandNameVersion(manifest, '{name}-{version}.zip'), 'MyServer-1.2.3.zip');
});

test('expandNameVersion: replaces every occurrence of a token', () => {
  const manifest = { name: 'MyServer', version: '1.2.3' };
  assert.equal(expandNameVersion(manifest, '{name}-{version}-{name}'), 'MyServer-1.2.3-MyServer');
});

test('expandNameVersion: leaves unknown tokens untouched', () => {
  const manifest = { name: 'MyServer', version: '1.2.3' };
  assert.equal(expandNameVersion(manifest, '{name}/{other}/{version}'), 'MyServer/{other}/1.2.3');
});

test('expandNameVersion: coerces a non-string tpl via String()', () => {
  const manifest = { name: 'MyServer', version: '1.2.3' };
  assert.equal(expandNameVersion(manifest, 123), '123');
  assert.equal(expandNameVersion(manifest, null), 'null');
});

// ─── formatBytes ────────────────────────────────────────────────────────────

test('formatBytes: precision 0 renders exact tiers', () => {
  assert.equal(formatBytes(1048576, { precision: 0 }), '1 MB');
  assert.equal(formatBytes(0, { precision: 0 }), '0 B');
});

test('formatBytes: default per-tier precision is unchanged', () => {
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1048576), '1.0 MB');
  assert.equal(formatBytes(1073741824), '1.00 GB');
});
