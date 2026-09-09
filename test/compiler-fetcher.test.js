'use strict';

/**
 * Unit tests for src/compiler-fetcher.js — resolveAmxmodxVersion
 * (latest sentinel + INVALID_AMXMODX_VERSION), fetchLatestVersion
 * (LATEST_NOT_CACHED) and findNewestCachedCompiler.
 *
 * Offline + deterministic: AMXX_BUILDER_CACHE is pointed at a temp dir for
 * each test and restored afterwards. No network, no real user cache.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { resolveAmxmodxVersion, findNewestCachedCompiler } = require('../src/compiler-fetcher');

const PLATFORM = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
const BIN      = PLATFORM === 'windows' ? 'amxxpc.exe' : 'amxxpc';

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

function mkdir(dir, rel) {
  const p = path.join(dir, rel);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

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

// <cache>/amxxpc/.latest-version-<platform> with a fresh timestamp (TTL 1h).
function seedLatestVersion(cache, version) {
  writeFile(cache, `amxxpc/.latest-version-${PLATFORM}`, JSON.stringify({ version, at: Date.now() }));
}

function seedCompiler(cache, version, { withInclude = false } = {}) {
  writeFile(cache, `amxxpc/${version}/${PLATFORM}/${BIN}`, 'binary');
  if (withInclude) mkdir(cache, `amxxpc/${version}/${PLATFORM}/include`);
}

// NOTE: the module keeps a process-lifetime latest-version memory. The
// LATEST_NOT_CACHED test below must run first (empty cache → nothing cached),
// before the cached-latest test populates that memory.

// ─── resolveAmxmodxVersion: explicit version option ─────────────────────────

test('resolveAmxmodxVersion: "latest" with empty cache + noFetch → LATEST_NOT_CACHED', async (t) => {
  useTempCache(t, 'amxb-cf-a-');
  await assert.rejects(
    resolveAmxmodxVersion(null, { version: 'latest', noFetch: true }),
    (err) => err instanceof Error && err.code === 'LATEST_NOT_CACHED'
  );
});

test('resolveAmxmodxVersion: "latest" resolves from cached .latest-version file', async (t) => {
  const cache = useTempCache(t, 'amxb-cf-b-');
  seedLatestVersion(cache, '1.10.5428');

  const version = await resolveAmxmodxVersion(null, { version: 'latest', noFetch: true });
  assert.equal(version, '1.10.5428');
});

test('resolveAmxmodxVersion: valid explicit version passes through', async (t) => {
  useTempCache(t, 'amxb-cf-c-');

  const version = await resolveAmxmodxVersion(null, { version: '1.10.5428' });
  assert.equal(version, '1.10.5428');
});

test('resolveAmxmodxVersion: invalid explicit version → INVALID_AMXMODX_VERSION', async (t) => {
  useTempCache(t, 'amxb-cf-d-');
  await assert.rejects(
    resolveAmxmodxVersion(null, { version: 'banana' }),
    (err) => err instanceof Error && err.code === 'INVALID_AMXMODX_VERSION'
  );
});

// ─── resolveAmxmodxVersion: manifest branch untouched ───────────────────────

test('resolveAmxmodxVersion: manifest amxmodx.version used verbatim', async (t) => {
  useTempCache(t, 'amxb-cf-e-');

  const version = await resolveAmxmodxVersion({ amxmodx: { version: '1.9.0.5299' } }, {});
  assert.equal(version, '1.9.0.5299');
});

test('resolveAmxmodxVersion: manifest "latest" is not a sentinel', async (t) => {
  useTempCache(t, 'amxb-cf-f-');

  const version = await resolveAmxmodxVersion({ amxmodx: { version: 'latest' } }, {});
  assert.equal(version, 'latest');
});

// ─── findNewestCachedCompiler ───────────────────────────────────────────────

test('findNewestCachedCompiler: include/ dir outranks newer include-less version', (t) => {
  const cache = useTempCache(t, 'amxb-cf-g-');
  seedCompiler(cache, '1.10.5428', { withInclude: true });
  seedCompiler(cache, '1.10.5430');                    // binary, no include/ → fallback only
  mkdir(cache, `amxxpc/1.10.5431/${PLATFORM}`);        // no binary → not usable
  mkdir(cache, 'amxxpc/garbage');                      // non-version dir → ignored
  writeFile(cache, `amxxpc/.latest-version-${PLATFORM}`, '{"version":"1.10.9999"}'); // file → ignored

  const result = findNewestCachedCompiler();
  assert.ok(result);
  assert.equal(result.version, '1.10.5428');
  assert.equal(result.compilerPath, path.join(cache, 'amxxpc', '1.10.5428', PLATFORM, BIN));
  assert.equal(result.includeDir, path.join(cache, 'amxxpc', '1.10.5428', PLATFORM, 'include'));
});

test('findNewestCachedCompiler: include-less candidate still returns includeDir path', (t) => {
  const cache = useTempCache(t, 'amxb-cf-h-');
  seedCompiler(cache, '1.10.5428'); // binary, no include/

  const result = findNewestCachedCompiler();
  assert.ok(result);
  assert.equal(result.version, '1.10.5428');
  assert.equal(result.compilerPath, path.join(cache, 'amxxpc', '1.10.5428', PLATFORM, BIN));
  assert.equal(result.includeDir, path.join(cache, 'amxxpc', '1.10.5428', PLATFORM, 'include'));
  assert.equal(fs.existsSync(result.includeDir), false);
});

test('findNewestCachedCompiler: newest wins among include-full candidates', (t) => {
  const cache = useTempCache(t, 'amxb-cf-j-');
  seedCompiler(cache, '1.9.0', { withInclude: true });
  seedCompiler(cache, '1.9.0.5299', { withInclude: true }); // longer tuple → newer on equal prefix
  seedCompiler(cache, '1.10.5428', { withInclude: true });

  const result = findNewestCachedCompiler();
  assert.ok(result);
  assert.equal(result.version, '1.10.5428');
});

test('findNewestCachedCompiler: empty amxxpc dir → null', (t) => {
  const cache = useTempCache(t, 'amxb-cf-i-');
  mkdir(cache, 'amxxpc');

  assert.equal(findNewestCachedCompiler(), null);
});
