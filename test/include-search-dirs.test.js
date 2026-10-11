'use strict';

/**
 * Offline tests for src/include-tree.js buildIncludeSearchDirs.
 *
 * The helper is a pure assembler over an already-resolved manifest/stdlib: it
 * must reproduce the exact deps → stdlib → extraDirs ordering (and labels) the
 * serve/MCP interfaces used to hand-roll. Local-source deps keep it offline; a
 * pinned-SHA git dep with an empty --no-fetch cache exercises dep-error
 * propagation without network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { buildIncludeSearchDirs } = require('../src/include-tree');
const { parseManifest } = require('../src/manifest');
const { ENV_VAR, STRICT_VAR } = require('../src/local-sources');

function useTmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function useTempCache(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const prev = process.env.AMXX_BUILDER_CACHE;
  process.env.AMXX_BUILDER_CACHE = dir;
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.AMXX_BUILDER_CACHE;
    else process.env.AMXX_BUILDER_CACHE = prev;
  });
  return dir;
}

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

function withLocalEnv(t) {
  const saved = { sources: process.env[ENV_VAR], strict: process.env[STRICT_VAR] };
  delete process.env[ENV_VAR];
  delete process.env[STRICT_VAR];
  t.after(() => {
    if (saved.sources === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = saved.sources;
    if (saved.strict === undefined) delete process.env[STRICT_VAR];
    else process.env[STRICT_VAR] = saved.strict;
  });
}

// A manifest with one local dep (resolves from disk); optionally a pinned-SHA
// git dep that fails offline on an empty cache (dep-error case).
function writeManifest(root, { withMissingDep = false } = {}) {
  const lines = [
    'name: LocalServer',
    'version: "2.0.0"',
    'deps:',
    '  - source: local',
    '    path: ./vendor/lib',
    '    include_path: scripting/include',
  ];
  if (withMissingDep) lines.push('  - Org/Missing@abcdef1');
  lines.push('');
  return write(root, 'amxbuild.yml', lines.join('\n'));
}

test('buildIncludeSearchDirs: assembles deps → stdlib → extraDirs in order with labels', async (t) => {
  useTempCache(t, 'amxb-isd-cache-');
  useTmpDir(t, 'amxb-isd-');
  withLocalEnv(t);
  const root = useTmpDir(t, 'amxb-isd-proj-');
  const depIncDir = path.dirname(write(root, 'vendor/lib/scripting/include/api.inc', 'api'));
  const manifestPath = writeManifest(root);
  const manifest = parseManifest(manifestPath);

  const stdlib = { includeDir: path.join(root, 'stdlib', 'include'), version: '1.10.5428' };
  const extras = ['sub/inc', path.join(root, 'abs', 'inc')];

  const { entries, errors } = await buildIncludeSearchDirs({
    manifest, stdlib, noFetch: true, extraDirs: extras,
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(entries, [
    { path: depIncDir, label: 'local/lib (local)' },
    { path: stdlib.includeDir, label: 'AMXX stdlib 1.10.5428' },
    { path: path.resolve('sub/inc'), label: 'sub/inc' },
    { path: path.resolve(extras[1]), label: extras[1] },
  ]);
});

test('buildIncludeSearchDirs: a failing dep is reported once and contributes no entry', async (t) => {
  useTempCache(t, 'amxb-isd-err-cache-');
  withLocalEnv(t);
  const root = useTmpDir(t, 'amxb-isd-err-proj-');
  write(root, 'vendor/lib/scripting/include/api.inc', 'api');
  const manifest = parseManifest(writeManifest(root, { withMissingDep: true }));

  const { entries, errors } = await buildIncludeSearchDirs({ manifest, noFetch: true });

  // Only the local dep resolved → one entry, one error for the git dep.
  assert.equal(entries.length, 1);
  assert.equal(entries[0].label, 'local/lib (local)');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^Org\/Missing@abcdef1: /);
  assert.match(errors[0], /Org\/Missing/);
});

test('buildIncludeSearchDirs: manifest null → only stdlib + extras', async () => {
  const extra = path.join(os.tmpdir(), 'amxb-isd-null-extra');
  const { entries, errors } = await buildIncludeSearchDirs({
    manifest: null,
    stdlib: { includeDir: '/stdlib/inc', version: '1.10.5428' },
    extraDirs: [extra],
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(entries, [
    { path: '/stdlib/inc', label: 'AMXX stdlib 1.10.5428' },
    { path: path.resolve(extra), label: extra },
  ]);
});

test('buildIncludeSearchDirs: stdlib without an includeDir adds no entry', async () => {
  const { entries, errors } = await buildIncludeSearchDirs({
    manifest: null,
    stdlib: { includeDir: null, version: '1.10.5428' },
    extraDirs: ['only'],
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(entries, [{ path: path.resolve('only'), label: 'only' }]);
});

test('buildIncludeSearchDirs: manifest with no deps yields stdlib + extras only', async () => {
  const manifest = { globalDeps: [], github: { ssh: false } };

  const { entries, errors } = await buildIncludeSearchDirs({
    manifest,
    stdlib: { includeDir: '/stdlib/inc', version: '1.11.0' },
    noFetch: true,
    extraDirs: ['x'],
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(entries, [
    { path: '/stdlib/inc', label: 'AMXX stdlib 1.11.0' },
    { path: path.resolve('x'), label: 'x' },
  ]);
});
