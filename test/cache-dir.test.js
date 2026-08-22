'use strict';

/**
 * Unit tests for src/cache-dir.js (getCacheDir).
 *
 * Mocks process.platform (via Object.defineProperty) and the relevant env
 * vars, restoring all originals after each test. Offline + deterministic.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const os   = require('os');
const path = require('path');

const { getCacheDir } = require('../src/cache-dir');

const ORIG_PLATFORM = process.platform;
const ENV_KEYS = ['AMXX_BUILDER_CACHE', 'LOCALAPPDATA', 'XDG_CACHE_HOME'];
const ORIG_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function setPlatform(platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function restorePlatform() {
  Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true });
}

function setEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function restoreEnv() {
  for (const k of ENV_KEYS) {
    setEnv(k, ORIG_ENV[k]);
  }
}

// Runs `fn` with `platform` mocked and env vars snapshotted from `env`,
// restoring everything afterwards.
async function withEnv(platform, env, fn) {
  setPlatform(platform);
  for (const k of ENV_KEYS) {
    setEnv(k, env[k]);
  }
  try {
    await fn();
  } finally {
    restoreEnv();
    restorePlatform();
  }
}

// ─── AMXX_BUILDER_CACHE wins ────────────────────────────────────────────────

test('getCacheDir: AMXX_BUILDER_CACHE env is returned verbatim', async () => {
  await withEnv('linux', { AMXX_BUILDER_CACHE: '/custom/cache' }, () => {
    assert.equal(getCacheDir(), '/custom/cache');
  });
  // wins on win32 too, regardless of LOCALAPPDATA
  await withEnv('win32', { AMXX_BUILDER_CACHE: 'C:\\custom\\cache', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, () => {
    assert.equal(getCacheDir(), 'C:\\custom\\cache');
  });
});

test('getCacheDir: empty AMXX_BUILDER_CACHE is falsy → falls through to platform branch', async () => {
  await withEnv('linux', { AMXX_BUILDER_CACHE: '' }, () => {
    assert.equal(getCacheDir(), path.join(os.homedir(), '.cache', 'amxx-builder'));
  });
});

// ─── win32 ──────────────────────────────────────────────────────────────────

test('getCacheDir: win32 + LOCALAPPDATA → path.join(LOCALAPPDATA, "amxx-builder")', async () => {
  await withEnv('win32', { LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' }, () => {
    assert.equal(getCacheDir(), path.join('C:\\Users\\Test\\AppData\\Local', 'amxx-builder'));
  });
});

test('getCacheDir: win32 without LOCALAPPDATA → homedir/AppData/Local/amxx-builder', async () => {
  await withEnv('win32', {}, () => {
    assert.equal(getCacheDir(), path.join(os.homedir(), 'AppData', 'Local', 'amxx-builder'));
  });
});

// ─── darwin ─────────────────────────────────────────────────────────────────

test('getCacheDir: darwin → homedir/Library/Caches/amxx-builder', async () => {
  await withEnv('darwin', {}, () => {
    assert.equal(getCacheDir(), path.join(os.homedir(), 'Library', 'Caches', 'amxx-builder'));
  });
});

// ─── linux / XDG ────────────────────────────────────────────────────────────

test('getCacheDir: linux + XDG_CACHE_HOME → path.join(XDG_CACHE_HOME, "amxx-builder")', async () => {
  await withEnv('linux', { XDG_CACHE_HOME: '/tmp/xdg-cache' }, () => {
    assert.equal(getCacheDir(), path.join('/tmp/xdg-cache', 'amxx-builder'));
  });
});

test('getCacheDir: linux without XDG_CACHE_HOME → homedir/.cache/amxx-builder', async () => {
  await withEnv('linux', {}, () => {
    assert.equal(getCacheDir(), path.join(os.homedir(), '.cache', 'amxx-builder'));
  });
});

// ─── restore guard ──────────────────────────────────────────────────────────

test('getCacheDir: process.platform and env vars are restored after mocking', () => {
  assert.equal(process.platform, ORIG_PLATFORM);
  for (const k of ENV_KEYS) {
    assert.equal(process.env[k], ORIG_ENV[k], `${k} must be restored`);
  }
});
