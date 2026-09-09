'use strict';

/**
 * Manifest-less stdlib resolution over the serve interface (src/commands/serve.js):
 * compiler.info / amxmodx.includes.list / amxmodx.include.get / include.resolve
 * called with NO manifest context must work offline under noFetch:
 *   - nothing cached            → graceful empty state (version: null), NOT an error
 *   - some compiler cached      → newest cached compiler + `degraded: true`
 *   - latest known but not downloaded → truthful not-cached state (no stale swap)
 *   - invalid explicit version  → JSON-RPC -32602
 *
 * Offline + deterministic: AMXX_BUILDER_CACHE points at a fresh temp dir and
 * every request passes an explicit `manifest` path that does not exist, so the
 * handlers never autodetect a manifest from cwd and never touch the network.
 *
 * Order matters: tests that rely on "latest not cached" (LATEST_NOT_CACHED)
 * must run before the last test seeds the module-level latest-version memory.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { createServeServer } = require('../src/commands/serve');

const PLATFORM = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
const BIN      = PLATFORM === 'windows' ? 'amxxpc.exe' : 'amxxpc';
const NO_MANIFEST = path.join(os.tmpdir(), 'amxb-no-such-manifest.yml');

const ORIG_CACHE_ENV = process.env.AMXX_BUILDER_CACHE;

// One server for the whole file: every JsonRpcServer instance adds an error
// listener to process.stdout, so creating one per test trips
// MaxListenersExceeded warnings. Handlers read params + env per call.
const server = createServeServer();
const call = (method) => (params) => server._requests.get(method)(params);

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

function seedCompiler(cache, version, { withInclude = false } = {}) {
  writeFile(cache, `amxxpc/${version}/${PLATFORM}/${BIN}`, 'binary');
  if (withInclude) mkdir(cache, `amxxpc/${version}/${PLATFORM}/include`);
}

function seedLatestVersion(cache, version) {
  writeFile(cache, `amxxpc/.latest-version-${PLATFORM}`, JSON.stringify({ version, at: Date.now() }));
}

// ─── graceful empty state (empty compiler cache) ────────────────────────────

test('compiler.info: noFetch + empty cache → graceful null state, not an error', async (t) => {
  useTempCache(t, 'amxb-sm-a-');

  const result = await call('compiler.info')({ manifest: NO_MANIFEST, version: 'latest', noFetch: true });
  assert.equal(result.version, null);
  assert.equal(result.includeDir, null);
  assert.equal(result.compilerPath, null);
  assert.equal(result.cached, false);
  assert.equal(typeof result.platform, 'string');
  assert.equal(result.degraded, undefined); // nothing cached → no degradation marker
});

test('amxmodx.includes.list: noFetch + empty cache → graceful empty files, not an error', async (t) => {
  useTempCache(t, 'amxb-sm-b-');

  const result = await call('amxmodx.includes.list')({ manifest: NO_MANIFEST, noFetch: true });
  assert.equal(result.version, null);
  assert.equal(result.includeDir, null);
  assert.equal(result.pattern, '*.inc');
  assert.equal(result.count, 0);
  assert.deepEqual(result.files, []);
});

test('amxmodx.include.get: noFetch + empty cache → graceful empty files, not an error', async (t) => {
  useTempCache(t, 'amxb-sm-c-');

  const result = await call('amxmodx.include.get')({ manifest: NO_MANIFEST, noFetch: true });
  assert.equal(result.version, null);
  assert.equal(result.includeDir, null);
  assert.equal(result.count, 0);
  assert.deepEqual(result.files, []);
});

test('include.resolve: noFetch + empty cache → found:false without stdlib, no throw', async (t) => {
  useTempCache(t, 'amxb-sm-d-');

  const result = await call('include.resolve')({ manifest: NO_MANIFEST, directive: '#include <amxmodx.inc>', noFetch: true });
  assert.equal(result.found, false);
  assert.equal(result.filename, 'amxmodx.inc');
  assert.ok(!result.searched.some((s) => s.includes('stdlib')));
});

// ─── invalid explicit version → -32602 ──────────────────────────────────────

test('compiler.info: invalid explicit version → -32602', async (t) => {
  useTempCache(t, 'amxb-sm-e-');

  await assert.rejects(
    call('compiler.info')({ manifest: NO_MANIFEST, version: 'banana', noFetch: true }),
    (err) => err instanceof Error && err.code === -32602
  );
});

// ─── degraded fallback (cached compiler, latest unknown) ────────────────────

test('compiler.info: noFetch + latest unknown + cached compiler → newest cached + degraded', async (t) => {
  const cache = useTempCache(t, 'amxb-sm-f-');
  seedCompiler(cache, '1.10.5428', { withInclude: true });

  const result = await call('compiler.info')({ manifest: NO_MANIFEST, noFetch: true });
  assert.equal(result.version, '1.10.5428');
  assert.equal(result.degraded, true);
  assert.equal(result.cached, true);
  assert.equal(result.includeDir, path.join(cache, 'amxxpc', '1.10.5428', PLATFORM, 'include'));
});

test('amxmodx.includes.list: noFetch fallback lists files from newest cached compiler', async (t) => {
  const cache = useTempCache(t, 'amxb-sm-g-');
  seedCompiler(cache, '1.10.5428', { withInclude: true });
  writeFile(cache, 'amxxpc/1.10.5428/' + PLATFORM + '/include/amxmodx.inc', '// amxmodx');
  writeFile(cache, 'amxxpc/1.10.5428/' + PLATFORM + '/include/core.inc', '// core');

  const result = await call('amxmodx.includes.list')({ manifest: NO_MANIFEST, noFetch: true });
  assert.equal(result.version, '1.10.5428');
  assert.equal(result.degraded, true);
  assert.equal(result.count, 2);
  assert.deepEqual(result.files, ['amxmodx.inc', 'core.inc']);
});

// ─── pinned-but-uncached under noFetch → truthful state, no download ────────

test('compiler.info: pinned uncached version + noFetch → not cached, no error, no stale swap', async (t) => {
  const cache = useTempCache(t, 'amxb-sm-h-');
  seedCompiler(cache, '1.10.5428', { withInclude: true }); // some other compiler cached

  const result = await call('compiler.info')({ manifest: NO_MANIFEST, version: '1.10.9999', noFetch: true });
  assert.equal(result.version, '1.10.9999'); // requested version, not a silent substitute
  assert.equal(result.degraded, undefined);
  assert.equal(result.cached, false);
  assert.equal(result.includeDir, null);
});

test('amxmodx.includes.list: pinned uncached version + noFetch → graceful empty, no download', async (t) => {
  useTempCache(t, 'amxb-sm-i-');

  const result = await call('amxmodx.includes.list')({ manifest: NO_MANIFEST, version: '1.10.9999', noFetch: true });
  assert.equal(result.version, '1.10.9999');
  assert.equal(result.includeDir, null);
  assert.equal(result.count, 0);
  assert.deepEqual(result.files, []);
});

// ─── latest known but not downloaded → strict null (runs LAST: seeds memory) ─

test('compiler.info: latest known but not downloaded + noFetch → truthful not-cached, no stale swap', async (t) => {
  const cache = useTempCache(t, 'amxb-sm-j-');
  seedCompiler(cache, '1.10.5428', { withInclude: true }); // older, fully cached
  seedLatestVersion(cache, '1.10.5430');                   // latest metadata, NOT downloaded

  const result = await call('compiler.info')({ manifest: NO_MANIFEST, noFetch: true });
  assert.equal(result.version, '1.10.5430');
  assert.equal(result.degraded, undefined); // strict: do NOT silently serve the older cached stdlib
  assert.equal(result.cached, false);
  assert.equal(result.includeDir, null);
});
