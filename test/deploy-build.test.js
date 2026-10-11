'use strict';

/**
 * Regression test for Phase D / D8: `runBuildCLI` (src/commands/build.js)
 * returns the resolved manifest on both the normal build and `--dry-run`
 * paths, and `deploy --build` (src/commands/deploy.js) reuses that returned
 * manifest instead of reading+parsing the file a second time.
 *
 * Offline + deterministic: every collaborator is stubbed by mutating its module
 * exports BEFORE requiring the modules under test — CommonJS destructuring
 * captures the reference at require time. `parseManifest` is stubbed only on
 * the module exports (deploy destructures it); `resolveManifest`'s internal
 * `parseManifest` is a module-local closure, so runBuildCLI still parses the
 * real temp manifest.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// ── Shared stub state ────────────────────────────────────────────────────────
let buildServiceCalls = [];
let dryRunCalls       = [];
let deployCalls       = [];
let parseCalls        = [];
let runBuildCalls     = [];
let parseResult       = null;
let runBuildResult    = null;

// ── Stub collaborators before requiring the modules that capture them ────────
const buildService = require('../src/build-service');
buildService.runBuild = async (manifest, options) => {
  buildServiceCalls.push({ manifest, options });
  return { ok: true };
};

const dryRunMod = require('../src/commands/dry-run');
dryRunMod.printDryRun = (manifest) => { dryRunCalls.push(manifest); };

// build.js captures build-service.runBuild + dry-run.printDryRun above.
const buildCommand = require('../src/commands/build');
// Capture the real CLI runBuildCLI before deploy overrides its `runBuild` export.
const runBuildCLI = buildCommand.runBuild;

const deployer = require('../src/deployer');
deployer.deployBuild = async (manifest, buildDir, options) => {
  deployCalls.push({ manifest, buildDir, options });
  return 0;
};

const manifestMod = require('../src/manifest');
manifestMod.parseManifest = (p) => {
  parseCalls.push(p);
  return parseResult;
};

const rcon = require('../src/rcon');
rcon.sendRconForPlugins = async () => {}; // no network RCON attempt

// deploy destructures `runBuild` from ./build at require time — stub it now.
buildCommand.runBuild = async (options) => {
  runBuildCalls.push(options);
  return runBuildResult;
};

// Must come AFTER the stubs above (destructuring captures at require time).
const { runDeploy } = require('../src/commands/deploy');

function resetState() {
  buildServiceCalls = [];
  dryRunCalls       = [];
  deployCalls       = [];
  parseCalls        = [];
  runBuildCalls     = [];
  parseResult       = null;
  runBuildResult    = null;
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amxb-deploy-build-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeManifest(dir, name, version) {
  const manifestPath = path.join(dir, 'amxbuild.yml');
  fs.writeFileSync(manifestPath, `name: ${name}\nversion: "${version}"\n`);
  return manifestPath;
}

test('deploy --build reuses runBuild\'s returned manifest without re-parsing', async (t) => {
  resetState();
  const dir          = tmpDir(t);
  const manifestPath = writeManifest(dir, 'DeployBuild', '1.0.0');
  const buildDir     = path.join(dir, 'build');

  runBuildResult = { name: 'Sentinel', version: '9.9.9', deploy: {}, __fromRunBuild: true };

  await runDeploy({ build: true, manifest: manifestPath, buildDir });

  assert.equal(runBuildCalls.length, 1, 'deploy --build must call runBuild exactly once');
  assert.equal(runBuildCalls[0].manifest, path.resolve(manifestPath), 'runBuild receives the resolved manifest path');
  assert.equal(parseCalls.length, 0, 'deploy --build must not re-parse the manifest');
  assert.equal(deployCalls.length, 1, 'deployBuild must run');
  assert.equal(deployCalls[0].manifest, runBuildResult, 'deployBuild receives the manifest runBuild returned');
});

test('deploy without --build parses the manifest (no runBuild call)', async (t) => {
  resetState();
  const dir          = tmpDir(t);
  const manifestPath = writeManifest(dir, 'DeployParse', '1.0.0');
  const buildDir     = path.join(dir, 'build');
  fs.mkdirSync(buildDir, { recursive: true });

  parseResult = { name: 'Parsed', version: '0.0.0', deploy: {}, __fromParse: true };

  await runDeploy({ manifest: manifestPath, buildDir });

  assert.equal(runBuildCalls.length, 0, 'runBuild must not be called without --build');
  assert.equal(parseCalls.length, 1, 'deploy must parse the manifest when not building');
  assert.equal(parseCalls[0], path.resolve(manifestPath));
  assert.equal(deployCalls[0].manifest, parseResult, 'deployBuild receives the parsed manifest');
});

test('runBuildCLI returns the resolved manifest on the normal build path', async (t) => {
  resetState();
  const dir          = tmpDir(t);
  const manifestPath = writeManifest(dir, 'ReturnMe', '2.5.1');

  const manifest = await runBuildCLI({ manifest: manifestPath, buildDir: path.join(dir, 'build') });

  assert.ok(manifest, 'runBuildCLI must return the manifest');
  assert.equal(manifest.name, 'ReturnMe');
  assert.equal(manifest.version, '2.5.1');
  assert.equal(buildServiceCalls.length, 1, 'the core build must run exactly once');
  assert.equal(buildServiceCalls[0].manifest, manifest, 'the core build receives the same resolved manifest');
});

test('runBuildCLI returns the resolved manifest on the --dry-run path', async (t) => {
  resetState();
  const dir          = tmpDir(t);
  const manifestPath = writeManifest(dir, 'DryRunMe', '3.0.0');

  const manifest = await runBuildCLI({ manifest: manifestPath, dryRun: true });

  assert.ok(manifest, 'runBuildCLI must return the manifest on --dry-run');
  assert.equal(manifest.name, 'DryRunMe');
  assert.equal(manifest.version, '3.0.0');
  assert.equal(dryRunCalls.length, 1, 'printDryRun must run');
  assert.equal(buildServiceCalls.length, 0, '--dry-run must not invoke the core build');
});
