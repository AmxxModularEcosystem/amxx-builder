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
const { Readable } = require('node:stream');
const { spawnSync } = require('child_process');

const axios = require('axios');
const AdmZip = require('adm-zip');

const { resolveAmxmodxVersion, findNewestCachedCompiler, fetchCompiler, getAmxmodxFullDir, resolveStdlibVersion } = require('../src/compiler-fetcher');
const { setEnabled } = require('../src/progress');

setEnabled(false); // keep test output clean — no \r progress bars

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

// ─── resolveStdlibVersion: offline degradation matrix ────────────────────────
// NOTE: must run BEFORE the resolveAmxmodxVersion "latest" tests below seed the
// module-level latest-version memory — the graceful-empty case depends on
// fetchLatestVersion actually throwing LATEST_NOT_CACHED.

test('resolveStdlibVersion: noFetch + empty cache + no manifest → graceful empty (version null)', async (t) => {
  useTempCache(t, 'amxb-rsv-a-');
  const result = await resolveStdlibVersion({ noFetch: true });
  assert.deepEqual(result, { version: null, degraded: false, error: null });
});

test('resolveStdlibVersion: noFetch + empty cache + explicit "latest" → graceful empty', async (t) => {
  useTempCache(t, 'amxb-rsv-b-');
  const result = await resolveStdlibVersion({ version: 'latest', noFetch: true });
  assert.deepEqual(result, { version: null, degraded: false, error: null });
});

test('resolveStdlibVersion: noFetch + cached compiler + no latest metadata → newest cached + degraded', async (t) => {
  const cache = useTempCache(t, 'amxb-rsv-c-');
  seedCompiler(cache, '1.10.5428', { withInclude: true });
  seedCompiler(cache, '1.9.0', { withInclude: true });
  const result = await resolveStdlibVersion({ noFetch: true });
  assert.equal(result.version, '1.10.5428');
  assert.equal(result.degraded, true);
  assert.equal(result.error, null);
});

test('resolveStdlibVersion: explicit version passes through verbatim (no network)', async (t) => {
  useTempCache(t, 'amxb-rsv-d-');
  const result = await resolveStdlibVersion({ version: '1.10.9999', noFetch: true });
  assert.deepEqual(result, { version: '1.10.9999', degraded: false, error: null });
});

test('resolveStdlibVersion: manifest amxmodx.version used verbatim (no network)', async (t) => {
  useTempCache(t, 'amxb-rsv-e-');
  const result = await resolveStdlibVersion({ manifest: { amxmodx: { version: '1.9.0.5299' } }, noFetch: true });
  assert.deepEqual(result, { version: '1.9.0.5299', degraded: false, error: null });
});

test('resolveStdlibVersion: invalid explicit version → error carrying INVALID_AMXMODX_VERSION', async (t) => {
  useTempCache(t, 'amxb-rsv-f-');
  const result = await resolveStdlibVersion({ version: 'banana' });
  assert.equal(result.version, null);
  assert.equal(result.degraded, false);
  assert.ok(result.error instanceof Error);
  assert.equal(result.error.code, 'INVALID_AMXMODX_VERSION');
});

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

// ─── fetchCompiler: completion marker / atomic cache ─────────────────────────

const HAVE_TAR = !spawnSync('tar', ['--version']).error;

// The real amxxdrop package wraps everything in addons/amxmodx/scripting/.
const SCRIPTING_PREFIX = 'addons/amxmodx/scripting/';
const INC_CONTENT = '// amxmodx include\n';

// Builds a synthetic base archive (zip on Windows, tar.gz elsewhere) whose
// scripting/ subtree carries amxxpc[.exe] and include/amxmodx.inc.
function makeCompilerArchive() {
  if (PLATFORM === 'windows') {
    const zip = new AdmZip();
    zip.addFile(SCRIPTING_PREFIX + BIN, Buffer.from('mock-amxxpc'));
    zip.addFile(SCRIPTING_PREFIX + 'include/amxmodx.inc', Buffer.from(INC_CONTENT));
    return zip.toBuffer();
  }
  const src = makeTmpDir('amxb-cf-src-');
  writeFile(src, SCRIPTING_PREFIX + BIN, 'mock-amxxpc');
  writeFile(src, SCRIPTING_PREFIX + 'include/amxmodx.inc', INC_CONTENT);
  const out = path.join(src, 'pack.tar.gz');
  const res = spawnSync('tar', ['-czf', out, 'addons'], { cwd: src, stdio: 'pipe' });
  if (res.status !== 0) {
    fs.rmSync(src, { recursive: true, force: true });
    throw new Error('test setup: tar creation failed');
  }
  const buf = fs.readFileSync(out);
  fs.rmSync(src, { recursive: true, force: true });
  return buf;
}

function stubCompilerDownload(bytes) {
  const calls = [];
  const orig = axios.get;
  axios.get = async () => {
    calls.push(1);
    const s = new Readable();
    s.push(bytes);
    s.push(null);
    return {
      data: s,
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) },
    };
  };
  return { calls, restore() { axios.get = orig; } };
}

function compilerCachePaths(cache, version) {
  return {
    dir:      path.join(cache, 'amxxpc', version, PLATFORM),
    binary:   path.join(cache, 'amxxpc', version, PLATFORM, BIN),
    include:  path.join(cache, 'amxxpc', version, PLATFORM, 'include'),
    complete: path.join(cache, 'amxxpc', version, PLATFORM, '.complete'),
  };
}

function fetchCompilerTests() {
  const bytes = makeCompilerArchive();
  return {
    bytes,
    stub: stubCompilerDownload(bytes),
  };
}

test('fetchCompiler: legacy binary cache without .complete is used as-is and backfills the marker', async (t) => {
  const cache = useTempCache(t, 'amxb-cf-k-');
  seedCompiler(cache, '1.10.5428', { withInclude: true });
  const paths = compilerCachePaths(cache, '1.10.5428');

  const stub = stubCompilerDownload(Buffer.from('should-not-download'));
  t.after(stub.restore);

  const result = await fetchCompiler('1.10.5428');
  assert.equal(result.compilerPath, paths.binary);
  assert.equal(result.includeDir, paths.include);
  assert.equal(stub.calls.length, 0, 'legacy cache must not trigger a download');
  assert.equal(fs.readFileSync(paths.complete, 'utf8'), '1.10.5428');
});

test('fetchCompiler: marker-less partial cache is re-downloaded and a leftover temp dir is ignored', async (t) => {
  if (PLATFORM !== 'windows' && !HAVE_TAR) return t.skip('tar binary not available');
  const cache = useTempCache(t, 'amxb-cf-l-');
  const paths = compilerCachePaths(cache, '1.10.5428');

  // A killed extraction left marker-less junk (old include, no binary, no
  // .complete) plus an orphaned sibling temp dir with a fake binary.
  writeFile(cache, `amxxpc/1.10.5428/${PLATFORM}/include/amxmodx.inc`, 'old partial');
  writeFile(cache, `amxxpc/1.10.5428/${PLATFORM}.tmp-999-beef/${BIN}`, 'fake');

  const fx = fetchCompilerTests();
  t.after(fx.stub.restore);

  const result = await fetchCompiler('1.10.5428');
  assert.equal(result.compilerPath, paths.binary);
  assert.equal(result.includeDir, paths.include);
  assert.equal(fs.readFileSync(path.join(paths.include, 'amxmodx.inc'), 'utf8'), INC_CONTENT, 'stale include overwritten');
  assert.equal(fs.readFileSync(paths.complete, 'utf8'), '1.10.5428');
  assert.equal(fx.stub.calls.length, 1);
  assert.equal(fs.existsSync(path.join(cache, 'amxxpc', '1.10.5428', `${PLATFORM}.tmp-999-beef`)), true,
    'other process temp dir left alone');
  // The whole amxxpc/<version> tree only contains the platform dir (plus the stray).
  const leftovers = fs.readdirSync(path.join(cache, 'amxxpc', '1.10.5428')).filter((n) => !n.includes('.tmp-'));
  assert.deepEqual(leftovers, [PLATFORM]);
});

test('fetchCompiler: .complete present but binary deleted → re-downloaded (self-heal)', async (t) => {
  if (PLATFORM !== 'windows' && !HAVE_TAR) return t.skip('tar binary not available');
  const cache = useTempCache(t, 'amxb-cf-m-');
  const paths = compilerCachePaths(cache, '1.10.5428');
  writeFile(cache, `amxxpc/1.10.5428/${PLATFORM}/.complete`, '1.10.5428');
  mkdir(cache, `amxxpc/1.10.5428/${PLATFORM}/include`);

  const fx = fetchCompilerTests();
  t.after(fx.stub.restore);

  const result = await fetchCompiler('1.10.5428');
  assert.equal(result.compilerPath, paths.binary);
  assert.equal(fx.stub.calls.length, 1, 'sentinel without a binary must re-download');
  assert.equal(fs.readFileSync(paths.complete, 'utf8'), '1.10.5428');
});

test('getAmxmodxFullDir: missing sentinel is re-downloaded without clobbering an existing compiler cache', async (t) => {
  if (PLATFORM !== 'windows' && !HAVE_TAR) return t.skip('tar binary not available');
  const cache = useTempCache(t, 'amxb-cf-n-');
  seedCompiler(cache, '1.10.5428'); // compiler scripting/ already cached in the shared dir

  const fx = fetchCompilerTests();
  t.after(fx.stub.restore);

  const dir = await getAmxmodxFullDir('1.10.5428', PLATFORM);
  assert.equal(fx.stub.calls.length, 1, 'missing .addons-extracted must trigger a download');
  assert.equal(fs.existsSync(path.join(dir, 'addons', 'amxmodx', 'scripting', 'include', 'amxmodx.inc')), true);
  assert.equal(fs.existsSync(path.join(dir, '.addons-extracted')), true);
  assert.equal(fs.existsSync(path.join(dir, BIN)), true, 'existing compiler kept after merge');

  // Second call hits the sentinel — no download.
  await getAmxmodxFullDir('1.10.5428', PLATFORM);
  assert.equal(fx.stub.calls.length, 1, 'sentinel-marked cache must not re-download');
});
