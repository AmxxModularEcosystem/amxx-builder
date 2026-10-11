'use strict';

/**
 * Phase D / D5 — manifest-path routing in the CLI commands.
 *
 * Pins the contract after validate.js, resolve-manifest.js and deps-tree.js
 * switched from the hand-rolled
 *   `options.manifest ? path.resolve(options.manifest) : resolveManifestPath(undefined)`
 * to the CLI wrapper `shared.resolveManifestPath(options.manifest)`:
 *
 *  - an explicit path is returned as an absolute path, with no discovery and
 *    no deprecation warning;
 *  - with no explicit path, discovery finds `manifest.yml` in cwd and the
 *    CLI-only deprecation warning is emitted;
 *  - all three commands accept an explicit manifest and process that file.
 *
 * Offline + deterministic: real temp dirs, no network. Command runs use a
 * minimal manifest (no repos/deps) so no fetcher is reached; logger output,
 * process.cwd() and process.exitCode are restored after each test.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const logger = require('../src/logger');
const { resolveManifestPath } = require('../src/commands/shared');
const { runValidate } = require('../src/commands/validate');
const { runResolveManifest } = require('../src/commands/resolve-manifest');
const { runDepsTree } = require('../src/commands/deps-tree');

const MINIMAL_MANIFEST = 'name: PathTest\nversion: "1.0"\n';

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeManifest(dir, name = 'amxbuild.yml') {
  const manifestPath = path.join(dir, name);
  fs.writeFileSync(manifestPath, MINIMAL_MANIFEST, 'utf8');
  return manifestPath;
}

// Replaces the listed logger methods with collectors; restores them after the
// test so the runner's own output stays intact.
function captureLogger(t, methods) {
  const logs = {};
  const originals = {};
  for (const m of methods) {
    logs[m] = [];
    originals[m] = logger[m];
    logger[m] = (...args) => { logs[m].push(args.join(' ')); };
  }
  t.after(() => {
    for (const m of methods) logger[m] = originals[m];
  });
  return logs;
}

// Keeps a test's process.exitCode side effects from polluting the runner.
function protectExitCode(t) {
  const origExitCode = process.exitCode;
  t.after(() => { process.exitCode = origExitCode; });
}

// Runs fn() with process.cwd() pointed at dir; always restores the cwd.
// Returns { cwd, result } where cwd is the canonical cwd after chdir (the OS
// may resolve symlinks in dir), so path assertions stay portable.
function inDir(dir, fn) {
  const origCwd = process.cwd();
  process.chdir(dir);
  try {
    const cwd = process.cwd();
    return { cwd, result: fn(cwd) };
  } finally {
    process.chdir(origCwd);
  }
}

// ─── shared.resolveManifestPath contract ────────────────────────────────────

test('shared.resolveManifestPath: explicit path → resolved absolute path, no warning', (t) => {
  const dir = makeTmpDir('amxb-mpath-explicit-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'sub'));
  writeManifest(path.join(dir, 'sub'), 'custom.yml');

  const logs = captureLogger(t, ['warn']);

  const { cwd, result: resolved } = inDir(dir, () => resolveManifestPath(path.join('sub', 'custom.yml')));

  assert.equal(resolved, path.join(cwd, 'sub', 'custom.yml'));
  assert.equal(path.isAbsolute(resolved), true);
  assert.deepEqual(logs.warn, [], 'an explicit path must not emit the discovery warning');
});

test('shared.resolveManifestPath: discovers manifest.yml in cwd and warns', (t) => {
  const dir = makeTmpDir('amxb-mpath-discover-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeManifest(dir, 'manifest.yml');

  const logs = captureLogger(t, ['warn']);

  const { cwd, result: resolved } = inDir(dir, () => resolveManifestPath(undefined));

  assert.equal(resolved, path.join(cwd, 'manifest.yml'));
  assert.ok(
    logs.warn.some((m) => m.includes('manifest.yml is deprecated — rename it to amxbuild.yml')),
    `expected the ./shared deprecation warning; warn=${JSON.stringify(logs.warn)}`
  );
});

// ─── commands accept an explicit --manifest ─────────────────────────────────

test('runValidate: explicit manifest path validates that file', async (t) => {
  const dir = makeTmpDir('amxb-mpath-validate-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifestPath = writeManifest(dir);
  protectExitCode(t);

  const logs = captureLogger(t, ['success', 'error', 'warn', 'dim', 'info']);

  await runValidate({ manifest: manifestPath });

  assert.ok(
    logs.success.some((m) => m.includes('Manifest is valid')),
    `expected the explicit manifest to validate; success=${JSON.stringify(logs.success)} error=${JSON.stringify(logs.error)}`
  );
  assert.notEqual(process.exitCode, 1, 'a valid manifest must not set a failing exit code');
});

test('runResolveManifest: explicit manifest path resolves that file', async (t) => {
  const dir = makeTmpDir('amxb-mpath-resolve-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifestPath = writeManifest(dir);
  protectExitCode(t);

  const logs = captureLogger(t, ['info', 'dim', 'warn', 'error']);

  await runResolveManifest({ manifest: manifestPath });

  assert.ok(
    logs.info.some((m) => m.includes('Resolved manifest')),
    `expected the explicit manifest to resolve; info=${JSON.stringify(logs.info)} error=${JSON.stringify(logs.error)}`
  );
  const manifestJson = logs.dim.find((m) => m.trim().startsWith('{'));
  assert.ok(manifestJson, `expected the resolved manifest JSON; dim=${JSON.stringify(logs.dim)}`);
  assert.equal(JSON.parse(manifestJson).name, 'PathTest');
});

test('runDepsTree: explicit manifest path is used (no dependencies)', async (t) => {
  const dir = makeTmpDir('amxb-mpath-deps-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifestPath = writeManifest(dir);
  protectExitCode(t);

  const logs = captureLogger(t, ['info', 'dim', 'warn', 'error']);

  await runDepsTree({ manifest: manifestPath, fetch: false });

  assert.ok(
    logs.info.some((m) => m.includes('No dependencies')),
    `expected the explicit manifest to be read (empty tree); info=${JSON.stringify(logs.info)} error=${JSON.stringify(logs.error)}`
  );
});
