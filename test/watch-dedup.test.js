'use strict';

/**
 * Regression test for phase A / A1: watch's clone dedup must use the
 * case-insensitive `normalizeRepo` identity (mirroring src/build-service.js),
 * while `repoLocalDirs` stays keyed by the raw-spelling `repoKey` for every
 * manifest entry.
 *
 * Offline + deterministic: every watch collaborator that would fetch, compile,
 * build or start a watcher is stubbed by mutating its module exports BEFORE
 * requiring ../src/commands/watch — CommonJS destructuring captures the
 * reference at require time, so stubs must be installed first.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// ── Stub collaborators before requiring the module under test ───────────────
const localSources    = require('../src/local-sources');
const repoFetcher     = require('../src/repo-fetcher');
const compilerFetcher = require('../src/compiler-fetcher');
const depsResolver    = require('../src/deps-resolver');

const CLONE_DIR = path.join(os.tmpdir(), 'amxb-watch-dedup-clone');

const ensureRepoDirCalls = [];
localSources.ensureRepoDir = async (repoConfig) => {
  ensureRepoDirCalls.push(repoConfig);
  return CLONE_DIR;
};

repoFetcher.resolveRepoRefs = async () => {}; // no network, no _resolvedRef stamping
compilerFetcher.fetchCompiler = async () => ({ compilerPath: '/fake/amxxpc', includeDir: null });

const resolveDepsCalls = [];
depsResolver.resolveDeps = async (manifest, repoLocalDirs) => {
  resolveDepsCalls.push({ manifest, repoLocalDirs });
  return [];
};

// Requiring build loads src/build-service.js, which captures the collaborators
// above by destructuring — the stubs must already be installed.
const buildCommand    = require('../src/commands/build');
const watcher         = require('../src/watcher');
buildCommand.runBuild = async () => ({ ok: true });
watcher.startWatch = () => {};

// Must come AFTER the stubs above (destructuring captures at require time).
const { runWatch } = require('../src/commands/watch');

function writeManifest(dir) {
  const manifestPath = path.join(dir, 'amxbuild.yml');
  fs.writeFileSync(manifestPath, [
    'name: WatchDedup',
    'repos:',
    '  - Org/X',
    '  - org/x',
    '',
  ].join('\n'));
  return manifestPath;
}

test('watch dedupes case-variant repos by normalizeRepo but keys repoLocalDirs by repoKey', async (t) => {
  const prevLocalSources = process.env.AMXB_LOCAL_SOURCES;
  delete process.env.AMXB_LOCAL_SOURCES; // keep manifest parsing pure
  t.after(() => {
    if (prevLocalSources === undefined) delete process.env.AMXB_LOCAL_SOURCES;
    else process.env.AMXB_LOCAL_SOURCES = prevLocalSources;
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amxb-watch-dedup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifestPath = writeManifest(dir);

  await runWatch({ manifest: manifestPath, deploy: false });

  assert.equal(ensureRepoDirCalls.length, 1, 'case-variant repos must share one clone job');

  assert.equal(resolveDepsCalls.length, 1, 'resolveDeps must run once');
  const { repoLocalDirs } = resolveDepsCalls[0];

  // Keys are the raw-spelling repoKeys (resolveRepoRefs is stubbed, so no ref
  // is resolved and the key suffix is HEAD). Computed via the real helper so
  // the test pins the dedup contract, not the key formatting.
  const expectedKeys = [
    depsResolver.repoKey({ repo: 'Org/X', ref: null }),
    depsResolver.repoKey({ repo: 'org/x', ref: null }),
  ].sort();
  assert.deepEqual(Object.keys(repoLocalDirs).sort(), expectedKeys);

  assert.equal(repoLocalDirs[expectedKeys[0]], CLONE_DIR);
  assert.equal(repoLocalDirs[expectedKeys[1]], CLONE_DIR);
  assert.equal(
    repoLocalDirs[expectedKeys[0]],
    repoLocalDirs[expectedKeys[1]],
    'both spellings must map to the same clone dir'
  );
});
