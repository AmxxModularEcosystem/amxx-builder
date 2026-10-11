'use strict';

/**
 * Regression test for the Phase D / D1 extraction in src/build-service.js:
 * `cloneRepoLocalDirs` (clone + map only, refs resolved by the caller) and
 * `resolveBuildIncludeDirs` (dep include dirs, compiler stdlib last).
 *
 * Offline + deterministic: every fetching/compiling collaborator is stubbed by
 * mutating its module exports BEFORE requiring ../src/build-service — CommonJS
 * destructuring captures the reference at require time. The real
 * `repoKey`/`normalizeRepo` are kept (the dedup contract under test).
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

const CLONE_DIR = path.join(os.tmpdir(), 'amxb-repo-local-dirs-clone');

let ensureRepoDirCalls = [];
localSources.ensureRepoDir = async (repoConfig, opts) => {
  ensureRepoDirCalls.push({ repoConfig, opts });
  return CLONE_DIR;
};

let resolveRepoRefsImpl = async () => {};
repoFetcher.resolveRepoRefs = (...args) => resolveRepoRefsImpl(...args);

compilerFetcher.fetchCompiler = async () => ({ compilerPath: '/fake/amxxpc', includeDir: null });

let resolveDepsCalls = [];
const DEPS_INCLUDE_DIRS = ['/fake/dep/include'];
depsResolver.resolveDeps = async (manifest, repoLocalDirs, noFetch, buildDir) => {
  resolveDepsCalls.push({ manifest, repoLocalDirs, noFetch, buildDir });
  return DEPS_INCLUDE_DIRS;
};

// Must come AFTER the stubs above (destructuring captures at require time).
const {
  runBuild,
  cloneRepoLocalDirs,
  resolveBuildIncludeDirs,
} = require('../src/build-service');

function manifestWithRepos(repos) {
  return {
    name: 'RLDTest',
    version: '1.0.0',
    amxmodx: { version: '1.10.5428', dir: 'amxmodx', defines: [] },
    pluginIni: { enabled: false, defaultIni: false, defaultDebug: false },
    _deprecations: [],
    repos,
    github: { ssh: false, token_env: 'GITHUB_TOKEN', tokens: {} },
  };
}

test('cloneRepoLocalDirs dedupes case-variant repos and maps by raw repoKey', async () => {
  ensureRepoDirCalls = [];
  const manifest = manifestWithRepos([{ repo: 'Org/X' }, { repo: 'org/x' }]);

  const repoLocalDirs = await cloneRepoLocalDirs(manifest, { noFetch: false });

  assert.equal(ensureRepoDirCalls.length, 1, 'case-variant repos must share one clone job');

  const expectedKeys = [
    depsResolver.repoKey({ repo: 'Org/X' }),
    depsResolver.repoKey({ repo: 'org/x' }),
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

test('cloneRepoLocalDirs returns {} for empty repos and calls no collaborator', async () => {
  ensureRepoDirCalls = [];
  const result = await cloneRepoLocalDirs({ repos: [] });
  assert.deepEqual(result, {});
  assert.equal(ensureRepoDirCalls.length, 0);
});

test('cloneRepoLocalDirs forwards noFetch (and ssh) to ensureRepoDir', async () => {
  ensureRepoDirCalls = [];
  const manifest = manifestWithRepos([{ repo: 'Org/X' }]);
  manifest.github.ssh = true;

  await cloneRepoLocalDirs(manifest, { noFetch: true });

  assert.equal(ensureRepoDirCalls.length, 1);
  assert.equal(ensureRepoDirCalls[0].opts.noFetch, true);
  assert.equal(ensureRepoDirCalls[0].opts.ssh, true);
});

test('resolveBuildIncludeDirs returns dep dirs then compilerIncludeDir last', async () => {
  resolveDepsCalls = [];
  const manifest = manifestWithRepos([]);

  const includeDirs = await resolveBuildIncludeDirs(manifest, {}, {
    compilerIncludeDir: '/fake/compiler/include',
    noFetch: true,
    buildDir: '/some/build',
  });

  assert.deepEqual(includeDirs, [...DEPS_INCLUDE_DIRS, '/fake/compiler/include']);
  assert.equal(resolveDepsCalls.length, 1);
  assert.equal(resolveDepsCalls[0].noFetch, true);
  assert.equal(resolveDepsCalls[0].buildDir, '/some/build');
});

test('resolveBuildIncludeDirs omits compiler dir when null', async () => {
  resolveDepsCalls = [];
  const includeDirs = await resolveBuildIncludeDirs(manifestWithRepos([]), {}, {});
  assert.deepEqual(includeDirs, DEPS_INCLUDE_DIRS);
});

test('runBuild cancellation after refs aborts before any clone (R1 boundary)', async (t) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amxb-r1-'));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  ensureRepoDirCalls = [];
  let cancelled = false;
  resolveRepoRefsImpl = async () => { cancelled = true; };
  t.after(() => { resolveRepoRefsImpl = async () => {}; });

  const manifest = manifestWithRepos([{ repo: 'Org/X' }]);

  await assert.rejects(
    runBuild(manifest, {
      buildDir: path.join(workDir, 'build'),
      archive: false,
      isCancelled: () => cancelled,
    }),
    (err) => err.code === 'CANCELLED'
  );

  assert.equal(
    ensureRepoDirCalls.length,
    0,
    'cancellation between refs and clone must abort before cloneRepoLocalDirs runs'
  );
});
