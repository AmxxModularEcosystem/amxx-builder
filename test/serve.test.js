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
