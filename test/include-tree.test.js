'use strict';

/**
 * Offline tests for src/include-tree.js buildIncludeTree.
 *
 * buildIncludeTree fetches each manifest repo through repo-fetcher.fetchRepo
 * for two purposes — reading its DEPS_LIST (3a) and scanning its scripting/
 * dir (4b). The per-run fetch cache must collapse those into ONE fetch per
 * repo. The test counts fetchRepo calls via a monkeypatched repo-fetcher export
 * (include-tree calls it through the module namespace) and returns a local fake
 * repo dir, so no network or git is involved.
 *
 * Offline + deterministic: a compiler for the pinned manifest version is seeded
 * in the temp AMXX_BUILDER_CACHE so fetchCompiler never downloads.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { buildIncludeTree } = require('../src/include-tree');
const repoFetcher = require('../src/repo-fetcher');

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

test('buildIncludeTree: each manifest repo is fetched at most once (DEPS_LIST read + scripting scan)', async (t) => {
  useTempCache(t, 'amxb-it-');

  // Seed a cached compiler for the manifest's pinned version so fetchCompiler
  // never hits the network.
  writeFile(process.env.AMXX_BUILDER_CACHE, `amxxpc/1.10.5428/${PLATFORM}/${BIN}`, 'binary');

  // Project with one pinned-SHA repo (ref resolution is offline-safe).
  const project = makeTmpDir('amxb-it-proj-');
  const manifestPath = writeFile(project, 'amxbuild.yml', [
    'name: TreeTest',
    'amxmodx:',
    '  version: "1.10.5428"',
    'repos:',
    '  - repo: Org/One',
    '    ref: abc1234',
    '',
  ].join('\n'));

  // Fake repo dir: has a DEPS_LIST (read in 3a) and a scripting/ root (4b).
  const repoDir = makeTmpDir('amxb-it-repo-');
  const targetSma = writeFile(repoDir, 'amxmodx/scripting/foo.sma', '// no includes\n');
  writeFile(repoDir, 'DEPS_LIST', '# comment only\n');

  const calls = [];
  const origFetch = repoFetcher.fetchRepo;
  repoFetcher.fetchRepo = async (repo, ref, token, noFetch, ssh) => {
    calls.push({ repo, ref, noFetch, ssh });
    return repoDir;
  };
  t.after(() => { repoFetcher.fetchRepo = origFetch; });

  const result = await buildIncludeTree(manifestPath, targetSma, { noFetch: true });

  assert.equal(calls.length, 1, 'repo must be fetched once for DEPS_LIST + scripting scan');
  assert.equal(calls[0].repo, 'Org/One');
  assert.equal(calls[0].noFetch, true);
  assert.ok(result.text.includes('foo.sma'), 'tree renders the repo scripting root');
});
