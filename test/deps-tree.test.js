'use strict';

/**
 * Regression tests for src/deps-tree.js assembleRootDeps (single-source dep
 * tree root assembly). getDepsOverride must match manifest repos
 * case-insensitively: a transitive dep read from a DEPS_LIST may spell the repo
 * differently from the manifest entry (SomeOrg/Dep vs someorg/dep) and still
 * find the deps_override config.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { assembleRootDeps } = require('../src/deps-tree');

test('getDepsOverride matches manifest repos case-insensitively', () => {
  const manifest = {
    repos: [
      { repo: 'AmxxModularEcosystem/VipModular', ref: null, deps_override: ['override/a@1'] },
      { repo: 'Next21Team/Module', ref: 'v2', deps_override: ['override/b@1'] },
      { repo: 'Org/NoOverride', ref: null, deps_override: null },
    ],
    globalDeps: [],
  };

  const { getDepsOverride } = assembleRootDeps(manifest);

  assert.deepEqual(
    getDepsOverride('amxxmodularecosystem/vipmodular'),
    ['override/a@1'],
    'exact case match works'
  );
  assert.deepEqual(
    getDepsOverride('next21team/module'),
    ['override/b@1'],
    'transitive dep with different case finds the config'
  );
  assert.equal(getDepsOverride('Org/NoOverride'), null, 'config with null override returns null');
  assert.equal(getDepsOverride('unknown/org'), null, 'unknown repo returns null');
});

test('assembleRootDeps keeps repos and global deps in order with _from markers', () => {
  const manifest = {
    repos: [{ repo: 'a/b', ref: null, deps_override: null }],
    globalDeps: [{ repo: 'c/d', ref: 'v1', source: 'git', include_path: null, asset: null }],
  };
  const { rootDeps } = assembleRootDeps(manifest);
  assert.equal(rootDeps.length, 2);
  assert.equal(rootDeps[0].repo, 'a/b');
  assert.equal(rootDeps[0]._from, 'repo');
  assert.equal(rootDeps[1].repo, 'c/d');
  assert.equal(rootDeps[1]._from, 'manifest');
});
