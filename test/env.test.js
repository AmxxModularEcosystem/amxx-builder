'use strict';

/**
 * Tests for src/env.js — env boolean parsing and the cwd `.env` loader.
 *
 * Offline + deterministic: the loader test runs in a private temp cwd and
 * restores process.cwd()/process.env before the temp dir is removed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { parseEnvBool, loadCwdEnv } = require('../src/env');

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ─── parseEnvBool ────────────────────────────────────────────────────────────

test('parseEnvBool: truthy spellings (case-insensitive)', () => {
  for (const value of ['1', 'true', 'TRUE', 'True', 'yes', 'Yes', 'on', ' ON ', ' 1 ']) {
    assert.equal(parseEnvBool(value), true, `${value} -> true`);
  }
});

test('parseEnvBool: falsy spellings (case-insensitive)', () => {
  for (const value of ['0', 'false', 'FALSE', 'False', 'no', 'No', 'off', ' Off ', ' 0 ']) {
    assert.equal(parseEnvBool(value), false, `${value} -> false`);
  }
});

test('parseEnvBool: anything else is null', () => {
  for (const value of [null, undefined, '', '  ', 'maybe', '2', 'enabled', 'truthy']) {
    assert.equal(parseEnvBool(value), null, `${String(value)} -> null`);
  }
});

// ─── loadCwdEnv ──────────────────────────────────────────────────────────────

test('loadCwdEnv: loads <cwd>/.env without overriding existing process.env vars', (t) => {
  const dir = makeTmpDir('amxb-env-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const LOADED = 'AMXB_ENV_TEST_LOADED';
  const EXISTING = 'AMXB_ENV_TEST_EXISTING';
  delete process.env[LOADED];
  process.env[EXISTING] = 'from-process';
  t.after(() => {
    delete process.env[LOADED];
    delete process.env[EXISTING];
  });

  fs.writeFileSync(path.join(dir, '.env'), `${LOADED}=from-file\n${EXISTING}=from-file\n`);

  const prevCwd = process.cwd();
  try {
    process.chdir(dir);
    loadCwdEnv({ quiet: true });
  } finally {
    process.chdir(prevCwd);
  }

  assert.equal(process.env[LOADED], 'from-file', 'new var is loaded from <cwd>/.env');
  assert.equal(process.env[EXISTING], 'from-process', 'existing process.env var is not overridden');
});
