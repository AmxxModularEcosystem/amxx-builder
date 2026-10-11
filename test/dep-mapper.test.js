'use strict';

/**
 * Tests for the canonical dep mapper exported by src/manifest.js:
 * parseDepInput, depFromParams, parseDepList.
 *
 * Offline + deterministic: no network, no git clones. The only filesystem use
 * is a throwaway dir under `os.tmpdir()` for `source: local` cases, removed in
 * `t.after` — nothing is written under test/.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { parseDepInput, depFromParams, parseDepList } = require('../src/manifest');

function useTmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ─── parseDepInput ───────────────────────────────────────────────────────────

test('parseDepInput: string shorthand parses to a git dep', () => {
  const dep = parseDepInput('o/r@v1');
  assert.equal(dep.repo, 'o/r');
  assert.equal(dep.ref, 'v1');
  assert.equal(dep.source, 'git');
  assert.equal(dep.include_path, null);
});

test('parseDepInput: long-form object parses', () => {
  const dep = parseDepInput({ repo: 'o/r', ref: 'v2', include_path: 'scripting/include' });
  assert.equal(dep.repo, 'o/r');
  assert.equal(dep.ref, 'v2');
  assert.equal(dep.include_path, 'scripting/include');
});

test('parseDepInput: a non-string/non-object value throws', () => {
  assert.throws(() => parseDepInput(42), /Dep must be a string or an object/);
  assert.throws(() => parseDepInput(null), /Dep must be a string or an object/);
});

test('parseDepInput: a local object materializes _localDir against baseDir', (t) => {
  const base = useTmpDir(t, 'amxb-dep-');
  const vendor = path.join(base, 'vendor');
  fs.mkdirSync(vendor);

  const dep = parseDepInput({ source: 'local', path: 'vendor' }, { baseDir: base });
  assert.equal(dep.repo, 'local/vendor');
  assert.equal(dep._localDir, vendor);
  assert.equal(dep._resolvedRef, 'local');
});

// ─── depFromParams: dep-authoritative + reject mixing ────────────────────────

test('depFromParams: a string `dep` parses', () => {
  const dep = depFromParams({ dep: 'o/r@v1' });
  assert.equal(dep.repo, 'o/r');
  assert.equal(dep.ref, 'v1');
  assert.equal(dep.source, 'git');
});

test('depFromParams: an object `dep` parses', () => {
  const dep = depFromParams({ dep: { repo: 'o/r', ref: 'v1' } });
  assert.equal(dep.repo, 'o/r');
  assert.equal(dep.ref, 'v1');
});

test('depFromParams: a supplied `dep` is authoritative — mixing with explicit fields throws', () => {
  for (const extra of [{ source: 'bogus' }, { include_path: 'inc' }, { asset: 'a.zip' }]) {
    assert.throws(
      () => depFromParams({ dep: { repo: 'o/r', ref: 'v1' }, ...extra }),
      /Provide either "dep" or the explicit source\/include_path\/asset fields, not both/
    );
  }
});

// ─── depFromParams: explicit fields ──────────────────────────────────────────

test('depFromParams: explicit git fields default ref to null and source to git', () => {
  assert.deepEqual(depFromParams({ repo: 'o/r' }), {
    repo: 'o/r',
    ref: null,
    source: 'git',
    include_path: null,
    asset: null,
  });
});

test('depFromParams: explicit release fields default ref to "latest"', () => {
  const dep = depFromParams({ repo: 'o/r', source: 'release' });
  assert.equal(dep.ref, 'latest');
  assert.equal(dep.source, 'release');
});

test('depFromParams: explicit fields carry ref/include_path/asset through', () => {
  const dep = depFromParams({
    repo: 'o/r',
    ref: 'v9',
    include_path: 'scripting/include',
    asset: 'pack.zip',
  });
  assert.equal(dep.ref, 'v9');
  assert.equal(dep.include_path, 'scripting/include');
  assert.equal(dep.asset, 'pack.zip');
});

test('depFromParams: explicit ref_ttl propagates (duration → ms)', () => {
  const dep = depFromParams({ repo: 'o/r', ref: 'v1', ref_ttl: '30m' });
  assert.equal(dep.ref_ttl, 1800000);
});

test('depFromParams: explicit ref_ttl "never" is preserved', () => {
  const dep = depFromParams({ repo: 'o/r', ref: 'v1', ref_ttl: 'never' });
  assert.equal(dep.ref_ttl, 'never');
});

test('depFromParams: neither dep nor repo throws', () => {
  assert.throws(() => depFromParams({}), /Provide either "dep" or "repo"/);
});

// ─── depFromParams: R3 whole-dep-object arg bag ──────────────────────────────

test('depFromParams: R3 — {source:"local", path} arg bag resolves locally', (t) => {
  const base = useTmpDir(t, 'amxb-dep-');
  const vendor = path.join(base, 'vendor');
  fs.mkdirSync(vendor);

  const dep = depFromParams({ source: 'local', path: 'vendor' }, { baseDir: base });
  assert.equal(dep.repo, 'local/vendor');
  assert.equal(dep._localDir, vendor);
  assert.equal(dep._resolvedRef, 'local');
});

test('depFromParams: R3 — {source:"fungun", id} arg bag parses', () => {
  const dep = depFromParams({ source: 'fungun', id: 106 });
  assert.equal(dep.repo, 'fungun.net/106');
  assert.equal(dep.source, 'fungun');
});

test('depFromParams: object-dep local resolves _localDir', (t) => {
  const base = useTmpDir(t, 'amxb-dep-');
  const vendor = path.join(base, 'vendor');
  fs.mkdirSync(vendor);

  const dep = depFromParams({ dep: { source: 'local', path: 'vendor' } }, { baseDir: base });
  assert.equal(dep._localDir, vendor);
  assert.equal(dep._resolvedRef, 'local');
});

// ─── parseDepList ────────────────────────────────────────────────────────────

test('parseDepList: string entries parse to git deps', () => {
  const deps = parseDepList(['o/r@v1']);
  assert.equal(deps.length, 1);
  assert.equal(deps[0].repo, 'o/r');
  assert.equal(deps[0].ref, 'v1');
  assert.equal(deps[0].source, 'git');
});

test('parseDepList: object entries are lenient (no ref required) and default source to git', () => {
  const [dep] = parseDepList([{ repo: 'o/r' }]);
  assert.equal(dep.repo, 'o/r');
  assert.equal(dep.ref, undefined);
  assert.equal(dep.source, 'git');
  assert.equal(dep.include_path, null);
});

test('parseDepList: object ref_ttl is honoured', () => {
  const [dep] = parseDepList([{ repo: 'o/r', ref: 'v2', ref_ttl: '7d' }]);
  assert.equal(dep.ref_ttl, 604800000);
});

test('parseDepList: a pre-resolved _localDir is preserved', (t) => {
  const dir = useTmpDir(t, 'amxb-dep-');
  const [dep] = parseDepList([{ repo: 'local/x', ref: null, _localDir: dir }]);
  assert.equal(dep._localDir, dir);
  assert.equal(dep._resolvedRef, 'local');
});

test('parseDepList: a non-object/non-string entry throws', () => {
  assert.throws(() => parseDepList([42]), /Dep must be a string or an object/);
});

test('parseDepList: empty/undefined input yields []', () => {
  assert.deepEqual(parseDepList([]), []);
  assert.deepEqual(parseDepList(undefined), []);
});
