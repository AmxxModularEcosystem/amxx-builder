'use strict';

/**
 * Tests for src/deps-resolver.js pure logic: readDepsListFile and the
 * early-exit path of resolveDeps.
 *
 * NOTE: normalize / repoKey are covered by helpers.test.js — not duplicated
 * here. The network path of resolveDeps (git clones, release fetches) is
 * deliberately NOT exercised: this suite is offline + deterministic.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { resolveDeps, readDepsListFile } = require('../src/deps-resolver');

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ─── readDepsListFile ────────────────────────────────────────────────────────

test('readDepsListFile: parses DEPS_LIST with comments and empty lines', () => {
  const dir = makeTmpDir('amxb-deps-');
  fs.writeFileSync(
    path.join(dir, 'DEPS_LIST'),
    [
      '# runtime deps',
      '',
      'org/pkg@v1',
      '  ',                    // whitespace-only line
      'org/other@v2:scripting/include',
      '# trailing comment',
    ].join('\n'),
    'utf8'
  );
  const deps = readDepsListFile(dir, 'MyPlugin');
  assert.equal(deps.length, 2);
  assert.equal(deps[0].repo, 'org/pkg');
  assert.equal(deps[0].ref, 'v1');
  assert.equal(deps[0].include_path, null);
  assert.equal(deps[1].repo, 'org/other');
  assert.equal(deps[1].ref, 'v2');
  assert.equal(deps[1].include_path, 'scripting/include');
  assert.equal(deps[1].source, 'git');
});

test('readDepsListFile: returns [] when repoDir has no DEPS_LIST', () => {
  const dir = makeTmpDir('amxb-nodeps-');
  const deps = readDepsListFile(dir, 'MyPlugin');
  assert.deepEqual(deps, []);
});

test('readDepsListFile: returns [] for a DEPS_LIST with only comments', () => {
  const dir = makeTmpDir('amxb-emptydeps-');
  fs.writeFileSync(path.join(dir, 'DEPS_LIST'), '# nothing here\n\n', 'utf8');
  assert.deepEqual(readDepsListFile(dir, 'MyPlugin'), []);
});

test('readDepsListFile: CRLF line endings are handled', () => {
  const dir = makeTmpDir('amxb-crlf-');
  fs.writeFileSync(path.join(dir, 'DEPS_LIST'), 'org/pkg@v1\r\norg/next@v2\r\n', 'utf8');
  const deps = readDepsListFile(dir, 'MyPlugin');
  assert.equal(deps.length, 2);
  assert.equal(deps[0].repo, 'org/pkg');
  assert.equal(deps[1].repo, 'org/next');
});

test('readDepsListFile: invalid line throws', () => {
  const dir = makeTmpDir('amxb-baddeps-');
  fs.writeFileSync(path.join(dir, 'DEPS_LIST'), 'org/pkg@v1\nnot-a-valid-dep-line\n', 'utf8');
  assert.throws(() => readDepsListFile(dir, 'MyPlugin'), /Invalid dep entry/);
});

// ─── resolveDeps (early-exit paths only, no network) ─────────────────────────

test('resolveDeps: empty repos + empty globalDeps returns [] without touching network', () => {
  const manifest = { repos: [], globalDeps: [], github: { ssh: false } };
  return resolveDeps(manifest, {}, false, path.join(makeTmpDir('amxb-rd-'), 'build')).then((dirs) => {
    assert.deepEqual(dirs, []);
  });
});

test('resolveDeps: repos with empty deps_override still returns []', () => {
  const manifest = {
    repos: [{ repo: 'org/repo', ref: null, deps_override: [] }],
    globalDeps: [],
    github: { ssh: false },
  };
  return resolveDeps(manifest, {}, false, path.join(makeTmpDir('amxb-rd2-'), 'build')).then((dirs) => {
    assert.deepEqual(dirs, []);
  });
});

test('resolveDeps: async, resolves even when buildDir is not created (early exit)', () => {
  const manifest = { repos: [], globalDeps: [], github: { ssh: false } };
  const buildDir = path.join(makeTmpDir('amxb-rd3-'), 'never-created');
  return resolveDeps(manifest, {}, false, buildDir).then((dirs) => {
    assert.deepEqual(dirs, []);
    assert.equal(fs.existsSync(buildDir), false);
  });
});
