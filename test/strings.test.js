'use strict';

/**
 * Tests for the src/strings.js leaf and the deps-resolver cache-key helpers
 * (C6/C7): `normalizeRepoName` is the single normalization implementation, and
 * `repoSlug`/`sanitizeRefPart`/`repoRefKey` reproduce the historical inline
 * cache-key composition byte-for-byte.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeRepoName } = require('../src/strings');
const {
  normalize,
  repoSlug,
  sanitizeRefPart,
  repoRefKey,
} = require('../src/deps-resolver');

test('normalizeRepoName: lowercases and coerces to string', () => {
  assert.equal(normalizeRepoName('Org/Repo'), 'org/repo');
  assert.equal(normalizeRepoName('AmxxModularEcosystem/VipModular'), 'amxxmodularecosystem/vipmodular');
  assert.equal(normalizeRepoName('local/Tool'), 'local/tool');
  assert.equal(normalizeRepoName('fungun.net/106'), 'fungun.net/106');

  // String() coercion keeps the old normalizeId null/undefined tolerance.
  assert.equal(normalizeRepoName(null), 'null');
  assert.equal(normalizeRepoName(undefined), 'undefined');
  assert.equal(normalizeRepoName(123), '123');
});

test('deps-resolver.normalize is the strings.normalizeRepoName re-export', () => {
  assert.equal(normalize, normalizeRepoName);
});

test('repoSlug: equals the historical inline normalize(repo).replace("/", "__")', () => {
  const repos = ['Org/Repo', 'AmxxModularEcosystem/VipModular', 'local/MyPlugin', 'fungun.net/106'];
  for (const repo of repos) {
    assert.equal(repoSlug(repo), normalize(repo).replace('/', '__'));
  }
  assert.equal(repoSlug('Org/Repo'), 'org__repo');
});

test('sanitizeRefPart: keeps [a-zA-Z0-9._-], maps every other char to "_"', () => {
  assert.equal(sanitizeRefPart('v1.2.3'), 'v1.2.3');
  assert.equal(sanitizeRefPart('ABC-._123'), 'ABC-._123');
  assert.equal(sanitizeRefPart('feature/foo bar'), 'feature_foo_bar');
  assert.equal(sanitizeRefPart('a@b#c$d'), 'a_b_c_d');
  assert.equal(sanitizeRefPart(null), 'null');
  assert.equal(sanitizeRefPart(106), '106');
});

test('repoRefKey: equals the historical inline slug + "__" + sanitized ref', () => {
  const cases = [
    ['Org/Repo', 'v1.2.3'],
    ['AmxxModularEcosystem/VipModular', 'feature/foo bar'],
    ['org/repo', null],
  ];
  for (const [repo, ref] of cases) {
    const old = normalize(repo).replace('/', '__') + '__' + String(ref).replace(/[^a-zA-Z0-9._-]/g, '_');
    assert.equal(repoRefKey(repo, ref), old);
  }
  assert.equal(repoRefKey('Org/Repo', 'v1'), 'org__repo__v1');
});
