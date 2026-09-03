'use strict';

/**
 * Tests for src/dep-docs.js: resolveDepDocs (pure, sync), collectDepDocs
 * (offline via an injected fake fetchRoot) and normalizeDep.
 *
 * No network traffic: fetchRoot is injected, so repo-fetcher / release-fetcher
 * are never exercised here.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  DOCS_CONVENTIONS,
  resolveDepDocs,
  collectDepDocs,
  normalizeDep,
} = require('../src/dep-docs');

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ─── resolveDepDocs ─────────────────────────────────────────────────────────

test('resolveDepDocs: declared docs resolve with origin "declared", missing land in missing', (t) => {
  const root = makeTmpDir('amxb-docs-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'API.md'), 'api content', 'utf8');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'agents content', 'utf8');

  const dep = { repo: 'org/repo', ref: 'v1', docs: ['docs/API.md', 'AGENTS.md', 'missing.md'] };
  const { files, missing } = resolveDepDocs(dep, root);

  assert.equal(files.length, 2);
  assert.deepEqual(
    files.map((f) => ({ rel: f.rel, origin: f.origin })),
    [
      { rel: 'docs/API.md', origin: 'declared' },
      { rel: 'AGENTS.md',   origin: 'declared' },
    ]
  );
  assert.equal(files[0].abs, path.join(root, 'docs', 'API.md'));
  assert.deepEqual(missing, ['missing.md']);
});

test('resolveDepDocs: no declared docs → convention files found in order, root AGENTS.md excluded', (t) => {
  const root = makeTmpDir('amxb-conv-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'contributor instructions', 'utf8');
  fs.writeFileSync(path.join(root, 'docs', 'API.md'), 'b', 'utf8');
  fs.writeFileSync(path.join(root, 'API.md'), 'c', 'utf8');

  const dep = { repo: 'org/repo', ref: 'v1', docs: null };
  const { files, missing } = resolveDepDocs(dep, root);

  // AGENTS.md is deliberately NOT a convention (contributor-facing, not API docs).
  assert.deepEqual(
    files.map((f) => ({ rel: f.rel, origin: f.origin })),
    [
      { rel: 'docs/API.md', origin: 'convention' },
      { rel: 'API.md',      origin: 'convention' },
    ]
  );
  assert.deepEqual(files.map((f) => f.rel), DOCS_CONVENTIONS);
  assert.deepEqual(missing, []);
});

test('resolveDepDocs: declared path wins over the same convention candidate (dedup)', (t) => {
  const root = makeTmpDir('amxb-dedup-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'API.md'), 'convention docs', 'utf8');
  fs.writeFileSync(path.join(root, 'API.md'), 'declared docs', 'utf8');

  // API.md is BOTH declared and a convention candidate — declared wins, no dup.
  const dep = { repo: 'org/repo', ref: 'v1', docs: ['API.md'] };
  const { files } = resolveDepDocs(dep, root);

  assert.equal(files.length, 2);
  assert.deepEqual(
    files.map((f) => ({ rel: f.rel, origin: f.origin })),
    [
      { rel: 'API.md',      origin: 'declared' },
      { rel: 'docs/API.md', origin: 'convention' },
    ]
  );
});

test('resolveDepDocs: traversal escape throws', (t) => {
  const root = makeTmpDir('amxb-escape-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const dep = { repo: 'org/repo', ref: 'v1', docs: ['../evil.md'] };
  assert.throws(() => resolveDepDocs(dep, root), /escapes the repo root/);
});

test('resolveDepDocs: duplicate declared paths are deduped', (t) => {
  const root = makeTmpDir('amxb-dupe-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'API.md'), 'api', 'utf8');

  const dep = { repo: 'org/repo', ref: 'v1', docs: ['API.md', 'API.md'] };
  const { files, missing } = resolveDepDocs(dep, root);

  assert.equal(files.length, 1);
  assert.deepEqual(missing, []);
});

// ─── collectDepDocs (offline, injected fetchRoot) ────────────────────────────

test('collectDepDocs: returns { label, files: [{ rel, content, origin }], missing } via injected fetchRoot', async (t) => {
  const root = makeTmpDir('amxb-collect-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'API.md'), 'hello world\n', 'utf8');

  const dep = { repo: 'org/repo', ref: 'v1', docs: ['docs/API.md', 'nope.md'] };
  const result = await collectDepDocs(dep, {
    fetchRoot: async () => ({ rootDir: root, label: 'org/repo@v1' }),
  });

  assert.equal(result.label, 'org/repo@v1');
  assert.equal(result.files.length, 1);
  assert.deepEqual(result.files[0], { rel: 'docs/API.md', content: 'hello world\n', origin: 'declared' });
  assert.deepEqual(result.missing, ['nope.md']);
});

test('collectDepDocs: binary (NUL-byte) file becomes a placeholder with its byte size', async (t) => {
  const root = makeTmpDir('amxb-bin-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'blob.dat'), Buffer.from([0x00, 0x61, 0x62, 0x00]));

  const dep = { repo: 'org/repo', ref: 'v1', docs: ['blob.dat'] };
  const result = await collectDepDocs(dep, {
    fetchRoot: async () => ({ rootDir: root, label: 'org/repo@v1' }),
  });

  assert.equal(result.files[0].content, '[binary file, 4 bytes]');
});

test('collectDepDocs: read error becomes a placeholder, does not throw', async (t) => {
  if (process.getuid && process.getuid() === 0) {
    t.skip('root ignores file permissions — read cannot be forced to fail');
    return;
  }
  const root = makeTmpDir('amxb-unreadable-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const brokenPath = path.join(root, 'broken.md');
  fs.writeFileSync(brokenPath, 'x', 'utf8');
  fs.chmodSync(brokenPath, 0);

  const dep = { repo: 'org/repo', ref: 'v1', docs: ['broken.md'] };
  const result = await collectDepDocs(dep, {
    fetchRoot: async () => ({ rootDir: root, label: 'org/repo@v1' }),
  });

  assert.match(result.files[0].content, /^\[error reading file: /);
});

// ─── normalizeDep ────────────────────────────────────────────────────────────

test('normalizeDep: string and object both parse', () => {
  const fromString = normalizeDep('org/repo@v1');
  assert.equal(fromString.repo, 'org/repo');
  assert.equal(fromString.ref, 'v1');
  assert.equal(fromString.source, 'git');

  const fromObject = normalizeDep({ repo: 'org/repo', ref: 'v1' });
  assert.equal(fromObject.repo, 'org/repo');
  assert.equal(fromObject.ref, 'v1');
  assert.equal(fromObject.source, 'git');
});

test('normalizeDep: invalid input throws', () => {
  assert.throws(() => normalizeDep(42), /Dep must be a string or an object/);
  assert.throws(() => normalizeDep(null), /Dep must be a string or an object/);
  assert.throws(() => normalizeDep(true), /Dep must be a string or an object/);
});
