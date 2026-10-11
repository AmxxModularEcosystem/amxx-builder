'use strict';

/**
 * Regression test for the serve interface (src/commands/serve.js): the
 * createServeServer() adapter must wire every documented JSON-RPC method to a
 * core-backed handler. This only asserts the method table — it performs no
 * network calls and never connects to stdio.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// Downstream collaborators are stubbed BEFORE serve is required, because serve
// destructures them at require time (CommonJS captures the reference then). The
// stubs record their arguments so the A5/A6 cases below can assert exactly what
// the adapter forwards downstream, with no network access.
const agentAssets   = require('../src/agent-assets');
const releaseLister = require('../src/release-lister');

const downstream = { readDepManifest: [], collectDepAssets: [], listReleases: [] };

agentAssets.readDepManifest = async (dep, opts = {}) => {
  downstream.readDepManifest.push({ dep, opts });
  return { label: 'stub', rootDir: '/tmp/amxb-stub', manifestPath: null, raw: null };
};
agentAssets.collectDepAssets = async (dep, opts = {}) => {
  downstream.collectDepAssets.push({ dep, opts });
  return { label: 'stub', manifestPath: null, manifestName: null, docs: [], skills: [], missing: [] };
};
releaseLister.listReleases = async (repo, opts = {}) => {
  downstream.listReleases.push({ repo, opts });
  return [];
};
releaseLister.listTags = async (repo, opts = {}) => {
  downstream.listReleases.push({ repo, opts, tags: true });
  return [];
};

const { createServeServer } = require('../src/commands/serve');

const EXPECTED_METHODS = [
  // read-only
  'manifest.validate',
  'manifest.resolve',
  'include.resolve',
  'include.list',
  'amxmodx.includes.list',
  'amxmodx.include.get',
  'deps.tree',
  'releases.list',
  'repos.info',
  'repos.branches',
  'repos.structure',
  'cache.info',
  'compiler.info',
  'dep-graph.get',
  'build.plan',
  // mutation
  'build.start',
  'build.cancel',
  'compile.single',
  'deploy.start',
  'deploy.file',
  'deploy.remove',
  'rcon.send',
  'watch.start',
  'watch.stop',
  // health
  'serve.ping',
];

test('createServeServer wires all documented request methods', () => {
  const server = createServeServer();
  for (const method of EXPECTED_METHODS) {
    const handler = server._requests.get(method);
    assert.equal(typeof handler, 'function', `method "${method}" must be wired`);
  }
});

test('createServeServer: every method table handler is a thin wrapper', () => {
  const server = createServeServer();
  for (const method of EXPECTED_METHODS) {
    assert.equal(typeof server._requests.get(method), 'function');
  }
});

test('createServeServer returns a JsonRpcServer (has connect/sendResult)', () => {
  const server = createServeServer();
  assert.equal(typeof server.connect, 'function');
  assert.equal(typeof server.sendResult, 'function');
  assert.equal(typeof server.notify, 'function');
  assert.equal(typeof server.onRequest, 'function');
});

test('serve.ping returns ok with process info (no network)', async () => {
  const server = createServeServer();
  const result = await server._requests.get('serve.ping')();
  assert.equal(result.ok, true);
  assert.equal(typeof result.pid, 'number');
  assert.equal(typeof result.version, 'string');
  assert.equal(typeof result.node, 'string');
});

test('build.start with a missing manifest does not wedge the server (regression B4)', async () => {
  const server = createServeServer();
  const buildStart = server._requests.get('build.start');
  const missingManifest = path.join(os.tmpdir(), `amxb-serve-no-manifest-${Date.now()}.yml`);

  const first = await buildStart({ manifest: missingManifest }).catch((e) => e);
  assert.ok(first instanceof Error, 'first call rejects (manifest not found)');
  assert.ok(!/Build already running/.test(first.message), 'first failure is the manifest error');
  assert.ok(!/already running/i.test(first.message));

  const second = await buildStart({ manifest: missingManifest }).catch((e) => e);
  assert.ok(second instanceof Error, 'second call also rejects');
  assert.ok(!/Build already running/.test(second.message),
    'second call must NOT die with "Build already running" (activeBuild was released)');
});

// ─── include.resolve: dep include-dir collection over core (no hang) ────────

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(dir, rel, content = '') {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

const ORIG_CACHE_ENV = process.env.AMXX_BUILDER_CACHE;

test('include.resolve: github.ssh manifest + unresolvable dep + noFetch → dep error captured, no hang', async (t) => {
  const cache = makeTmpDir('amxb-serve-deperr-');
  process.env.AMXX_BUILDER_CACHE = cache;
  t.after(() => {
    fs.rmSync(cache, { recursive: true, force: true });
    if (ORIG_CACHE_ENV === undefined) delete process.env.AMXX_BUILDER_CACHE;
    else process.env.AMXX_BUILDER_CACHE = ORIG_CACHE_ENV;
  });

  const project = makeTmpDir('amxb-serve-proj-');
  const manifest = writeFile(project, 'amxbuild.yml', [
    'name: T',
    'github:',
    '  ssh: true',
    'deps:',
    '  - nowhere/missing@abc9999',
    '',
  ].join('\n'));

  const server = createServeServer();
  const result = await server._requests.get('include.resolve')({
    manifest,
    directive: '#include <amxmodx.inc>',
    noFetch: true,
  });

  assert.equal(result.found, false);
  assert.ok(Array.isArray(result.errors) && result.errors.length === 1,
    'unresolvable dep is reported in errors, not thrown');
  assert.match(result.errors[0], /^nowhere\/missing@abc9999: /);
});

// ─── A6: dep objects validated by core + uniform -32602 ─────────────────────
// One shared server: every JsonRpcServer instance adds a process.stdout error
// listener, so a server per test would trip MaxListenersExceeded.
const SERVER = createServeServer();
const serveCall = (method) => SERVER._requests.get(method);

const NO_MANIFEST = path.join(os.tmpdir(), `amxb-serve-no-manifest-${Date.now()}.yml`);

function isParamError(err) {
  return err instanceof Error && err.code === -32602;
}

test('A6 (a): object dep without ref → -32602', async () => {
  await assert.rejects(
    serveCall('manifest.dep')({ dep: { repo: 'o/r' }, manifest: NO_MANIFEST, noFetch: true }),
    isParamError
  );
});

test('A6 (b): top-level override alongside a supplied dep → -32602', async () => {
  await assert.rejects(
    serveCall('manifest.dep')({ dep: { repo: 'o/r', ref: 'v1' }, source: 'bogus', manifest: NO_MANIFEST, noFetch: true }),
    isParamError
  );
});

test('A6 (c): object dep with unknown source → -32602', async () => {
  await assert.rejects(
    serveCall('manifest.dep')({ dep: { repo: 'o/r', ref: 'v1', source: 'bogus' }, manifest: NO_MANIFEST, noFetch: true }),
    isParamError
  );
});

test('A6 (d): local dep without path → -32602', async () => {
  await assert.rejects(
    serveCall('manifest.dep')({ dep: { source: 'local' }, manifest: NO_MANIFEST, noFetch: true }),
    isParamError
  );
});

test('A6 (e): valid object dep reaches the downstream manifest reader', async () => {
  downstream.readDepManifest.length = 0;
  const result = await serveCall('manifest.dep')({ dep: { repo: 'o/r', ref: 'v1' }, manifest: NO_MANIFEST, noFetch: true });
  assert.equal(result.label, 'stub');
  assert.equal(downstream.readDepManifest.length, 1);
  assert.equal(downstream.readDepManifest[0].dep.repo, 'o/r');
  assert.equal(downstream.readDepManifest[0].dep.ref, 'v1');
  assert.equal(downstream.readDepManifest[0].dep.source, 'git');
});

test('A6 (f): explicit { repo } (no dep) still resolves to the default branch', async () => {
  downstream.readDepManifest.length = 0;
  const result = await serveCall('manifest.dep')({ repo: 'o/r', manifest: NO_MANIFEST, noFetch: true });
  assert.equal(result.label, 'stub');
  assert.equal(downstream.readDepManifest.length, 1);
  assert.equal(downstream.readDepManifest[0].dep.repo, 'o/r');
  assert.equal(downstream.readDepManifest[0].dep.ref, null);
  assert.equal(downstream.readDepManifest[0].dep.source, 'git');
});

test('A6 (g): docs.list with an invalid dep → -32602 (uniform remap)', async () => {
  await assert.rejects(
    serveCall('docs.list')({ dep: { repo: 'o/r' }, manifest: NO_MANIFEST, noFetch: true }),
    isParamError
  );
});

// ─── A5: manifest token policy is authoritative ─────────────────────────────

test('A5: custom token_env manifest policy wins over a bare GITHUB_TOKEN', async (t) => {
  const project = makeTmpDir('amxb-serve-token-');
  const manifest = writeFile(project, 'amxbuild.yml', [
    'name: T',
    'github:',
    '  token_env: AMXB_TEST_MYTOKEN',
    '',
  ].join('\n'));

  const prevMy = process.env.AMXB_TEST_MYTOKEN;
  const prevGh = process.env.GITHUB_TOKEN;
  delete process.env.AMXB_TEST_MYTOKEN;
  process.env.GITHUB_TOKEN = 'sentinel-github-token';
  t.after(() => {
    fs.rmSync(project, { recursive: true, force: true });
    if (prevMy === undefined) delete process.env.AMXB_TEST_MYTOKEN;
    else process.env.AMXB_TEST_MYTOKEN = prevMy;
    if (prevGh === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prevGh;
  });

  downstream.listReleases.length = 0;
  const result = await serveCall('releases.list')({ manifest, repo: 'o/r' });
  assert.deepEqual(result, []);
  assert.equal(downstream.listReleases.length, 1);
  assert.equal(downstream.listReleases[0].opts.token, null);
});
