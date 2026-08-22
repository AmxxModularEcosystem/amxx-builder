'use strict';

/**
 * Unit tests for src/cache-info.js — getCacheInfo, dirSize, fmtSize, parseCacheKey.
 *
 * Offline + deterministic: AMXX_BUILDER_CACHE is pointed at a temp dir for
 * each test and restored afterwards. No network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { getCacheInfo, dirSize, fmtSize, parseCacheKey } = require('../src/cache-info');

const ORIG_CACHE_ENV = process.env.AMXX_BUILDER_CACHE;

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(dir, rel, content = '') {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// Windows: fs.symlinkSync needs admin privileges or Developer Mode — probe at
// load time so symlink tests skip cleanly instead of failing with EPERM.
const HAS_SYMLINK = (() => {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amxb-lnk-'));
    fs.symlinkSync('probe', path.join(dir, 'probe'));
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch { return false; }
})();

// Point AMXX_BUILDER_CACHE at a fresh temp dir; restore the original value
// (or unset it) when the test finishes.
function useTempCache(t, prefix) {
  const dir = makeTmpDir(prefix);
  process.env.AMXX_BUILDER_CACHE = dir;
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (ORIG_CACHE_ENV === undefined) delete process.env.AMXX_BUILDER_CACHE;
    else process.env.AMXX_BUILDER_CACHE = ORIG_CACHE_ENV;
  });
  return dir;
}

// ─── parseCacheKey ──────────────────────────────────────────────────────────

test('parseCacheKey: owner__repo__ref → "owner/repo @ ref"', () => {
  assert.equal(parseCacheKey('AmxxModularEcosystem__VipModular__HEAD'), 'AmxxModularEcosystem/VipModular @ HEAD');
});

test('parseCacheKey: extra parts are joined into the owner path', () => {
  assert.equal(parseCacheKey('a__b__c__v1'), 'a/b/c @ v1');
});

test('parseCacheKey: fewer than 3 parts returned unchanged', () => {
  assert.equal(parseCacheKey('owner__repo'), 'owner__repo');
  assert.equal(parseCacheKey('single'), 'single');
  assert.equal(parseCacheKey(''), '');
});

// ─── dirSize ────────────────────────────────────────────────────────────────

test('dirSize: missing dir is 0', () => {
  assert.equal(dirSize(path.join(os.tmpdir(), 'amxb-definitely-missing-' + Date.now())), 0);
});

test('dirSize: sums nested file sizes, skips symlinks', (t) => {
  if (!HAS_SYMLINK) return t.skip('symlinks not supported (Windows without Dev Mode)');
  const dir = makeTmpDir('amxb-dirsize-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  writeFile(dir, 'a.bin', Buffer.alloc(100));
  writeFile(dir, 'sub/b.bin', Buffer.alloc(50));
  writeFile(dir, 'sub/deeper/c.bin', Buffer.alloc(25));

  // Symlink to a file inside the tree + a dangling symlink: neither may be counted.
  fs.symlinkSync('a.bin', path.join(dir, 'link.bin'));
  fs.symlinkSync('gone.bin', path.join(dir, 'broken.bin'));
  // Symlink to a directory: must not recurse (would loop or double-count).
  fs.symlinkSync('sub', path.join(dir, 'sub-link'));

  assert.equal(dirSize(dir), 175);
});

// ─── fmtSize ────────────────────────────────────────────────────────────────

test('fmtSize: delegates to formatBytes', () => {
  assert.equal(fmtSize(0), '0 B');
  assert.equal(fmtSize(1536), '1.5 KB');
});

// ─── getCacheInfo ───────────────────────────────────────────────────────────

test('getCacheInfo: scans compiler, repos and release-deps from cache dir', (t) => {
  const cache = useTempCache(t, 'amxb-info-');

  writeFile(cache, 'amxxpc/1.10.0/linux/amxxpc', 'binary');
  writeFile(cache, 'repos/AmxxModularEcosystem__VipModular__HEAD/amxmodx/scripting/p.sma', 'plugin');
  writeFile(cache, 'release-deps/org__pkg__v1/scripting/include/api.inc', 'include');

  const info = getCacheInfo();

  assert.equal(info.cacheDir, cache);
  assert.equal(info.localAssetCache, null);
  assert.ok(info.totalSize > 0);
  assert.equal(info.totalSizeHuman, fmtSize(info.totalSize));

  // compiler
  assert.equal(info.compiler.versions.length, 1);
  assert.equal(info.compiler.versions[0].version, '1.10.0');
  assert.ok(info.compiler.versions[0].platforms.linux > 0);

  // repos
  assert.equal(info.repos.count, 1);
  assert.equal(info.repos.totalSize > 0, true);
  assert.equal(info.repos.entries[0].key, 'AmxxModularEcosystem__VipModular__HEAD');
  assert.equal(info.repos.entries[0].label, 'AmxxModularEcosystem/VipModular @ HEAD');

  // release-deps
  assert.equal(info.releaseDeps.count, 1);
  assert.equal(info.releaseDeps.entries[0].label, 'org/pkg @ v1');
});

test('getCacheInfo: no manifestPath → localAssetCache null', (t) => {
  const cache = useTempCache(t, 'amxb-info-null-');
  writeFile(cache, 'amxxpc/1.10.0/linux/amxxpc', 'x');

  const info = getCacheInfo();

  assert.equal(info.localAssetCache, null);
  assert.equal(info.compiler.versions[0].version, '1.10.0');
});

test('getCacheInfo: with manifestPath, populates localAssetCache from .amxb-cache/assets', (t) => {
  const cache = useTempCache(t, 'amxb-info-local-');
  writeFile(cache, 'repos/r__x__HEAD/f', '1');

  const projDir = makeTmpDir('amxb-proj-');
  t.after(() => fs.rmSync(projDir, { recursive: true, force: true }));

  const manifestPath = path.join(projDir, 'amxbuild.yml');
  writeFile(projDir, '.amxb-cache/assets/models/gun.mdl', Buffer.alloc(64));
  writeFile(projDir, '.amxb-cache/assets/models/gun2.mdl', Buffer.alloc(64));
  fs.writeFileSync(manifestPath, 'name: test\n');

  const info = getCacheInfo(manifestPath);

  assert.ok(info.localAssetCache, 'localAssetCache should be populated');
  assert.equal(info.localAssetCache.count, 1, 'one top-level dir (models)');
  assert.ok(info.localAssetCache.totalSize > 0);
  assert.equal(info.localAssetCache.totalSizeHuman, fmtSize(info.localAssetCache.totalSize));
  assert.ok(info.localAssetCache.path.endsWith('.amxb-cache' + path.sep + 'assets'));
  // Global cache still scanned normally.
  assert.equal(info.repos.count, 1);
});

test('getCacheInfo: empty cache dir → empty scans', (t) => {
  const cache = useTempCache(t, 'amxb-info-empty-');

  const info = getCacheInfo();

  assert.deepEqual(info.compiler.versions, []);
  assert.deepEqual(info.repos, { count: 0, totalSize: 0, totalSizeHuman: '0 B', entries: [] });
  assert.deepEqual(info.releaseDeps, { count: 0, totalSize: 0, totalSizeHuman: '0 B', entries: [] });
  assert.equal(info.totalSize, 0);
  assert.equal(info.totalSizeHuman, '0 B');
});
