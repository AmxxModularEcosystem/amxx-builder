'use strict';

/**
 * Tests for src/agent-assets.js and findManifestInDir.
 *
 * Offline + deterministic: dep fetch is injected via `fetchRoot`, so no
 * network traffic ever happens here.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  resolveAssets,
  readAssets,
  readDepManifest,
  collectDepAssets,
  collectLocalAssets,
} = require('../src/agent-assets');
const { findManifestInDir } = require('../src/manifest-path');

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root, rel, content, encoding = 'utf8') {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, encoding);
  return abs;
}

// ─── resolveAssets ───────────────────────────────────────────────────────────

test('resolveAssets: doc name/description pass through; absent doc lands in missing', (t) => {
  const root = makeTmpDir('amxb-assets-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'docs/API.md', 'api');

  const { docs, skills, missing } = resolveAssets({
    docs: [
      { file: 'docs/API.md', name: 'API', description: 'public api' },
      { file: 'docs/NOPE.md', name: 'nope', description: null },
    ],
  }, root);

  assert.deepEqual(docs, [
    { name: 'API', description: 'public api', file: 'docs/API.md', abs: path.join(root, 'docs', 'API.md') },
  ]);
  assert.deepEqual(skills, []);
  assert.deepEqual(missing, ['docs/NOPE.md']);
});

test('resolveAssets: undefined docs/skills are treated as empty', (t) => {
  const root = makeTmpDir('amxb-empty-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.deepEqual(resolveAssets({}, root), { docs: [], skills: [], missing: [] });
  assert.deepEqual(resolveAssets({ docs: undefined, skills: undefined }, root), {
    docs: [], skills: [], missing: [],
  });
});

test('resolveAssets: file skill resolves with kind "file"', (t) => {
  const root = makeTmpDir('amxb-skillfile-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'skills/config.md', 'config');

  const { skills, missing } = resolveAssets({
    skills: [{ file: 'skills/config.md', dir: null, name: 'config', description: 'cfg' }],
  }, root);

  assert.deepEqual(skills, [{
    name: 'config', description: 'cfg', kind: 'file',
    file: 'skills/config.md', dir: null, abs: path.join(root, 'skills', 'config.md'),
  }]);
  assert.deepEqual(missing, []);
});

test('resolveAssets: dir skill enumerates files, SKILL.md first then alphabetical', (t) => {
  const root = makeTmpDir('amxb-skilldir-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'skills/deep/references/options.md', 'options');
  write(root, 'skills/deep/a.md', 'a');
  write(root, 'skills/deep/SKILL.md', 'skill');

  const { skills, missing } = resolveAssets({
    skills: [{ dir: 'skills/deep', file: null, name: 'deep', description: 'bundle' }],
  }, root);

  assert.equal(skills.length, 1);
  const skill = skills[0];
  assert.equal(skill.kind, 'dir');
  assert.equal(skill.file, null);
  assert.equal(skill.dir, 'skills/deep');
  assert.equal(skill.abs, path.join(root, 'skills', 'deep'));
  assert.deepEqual(skill.files.map((f) => f.rel), ['SKILL.md', 'a.md', 'references/options.md']);
  assert.equal(skill.files[0].abs, path.join(root, 'skills', 'deep', 'SKILL.md'));
  assert.deepEqual(missing, []);
});

test('resolveAssets: dir skill that is absent lands in missing', (t) => {
  const root = makeTmpDir('amxb-missdir-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { skills, missing } = resolveAssets({
    skills: [{ dir: 'skills/nope', file: null, name: 'nope', description: null }],
  }, root);

  assert.deepEqual(skills, []);
  assert.deepEqual(missing, ['skills/nope']);
});

test('resolveAssets: doc traversal escape throws', (t) => {
  const root = makeTmpDir('amxb-escape-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => resolveAssets({ docs: [{ file: '../evil.md', name: 'x', description: null }] }, root),
    /escapes the repo root/
  );
});

test('resolveAssets: skill dir traversal escape throws', (t) => {
  const root = makeTmpDir('amxb-escape2-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => resolveAssets({ skills: [{ dir: '../evil', file: null, name: 'x', description: null }] }, root),
    /escapes the repo root/
  );
});

// ─── readAssets ──────────────────────────────────────────────────────────────

test('readAssets: attaches doc and skill-dir file contents', (t) => {
  const root = makeTmpDir('amxb-read-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'docs/API.md', 'api content');
  write(root, 'skills/deep/SKILL.md', 'skill content');
  write(root, 'skills/deep/notes.md', 'notes content');

  const resolved = resolveAssets({
    docs: [{ file: 'docs/API.md', name: 'API', description: null }],
    skills: [{ dir: 'skills/deep', file: null, name: 'deep', description: null }],
  }, root);
  const read = readAssets(resolved);

  assert.equal(read.docs[0].content, 'api content');
  assert.equal(read.skills[0].kind, 'dir');
  assert.deepEqual(read.skills[0].files, [
    { rel: 'SKILL.md', content: 'skill content' },
    { rel: 'notes.md', content: 'notes content' },
  ]);
  assert.deepEqual(read.missing, []);
});

test('readAssets: file skill gets content', (t) => {
  const root = makeTmpDir('amxb-readfile-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'skills/config.md', 'config content');

  const read = readAssets(resolveAssets({
    skills: [{ file: 'skills/config.md', dir: null, name: 'config', description: null }],
  }, root));

  assert.equal(read.skills[0].content, 'config content');
  assert.equal(read.skills[0].kind, 'file');
});

test('readAssets: NUL-byte file becomes a binary placeholder with byte size', (t) => {
  const root = makeTmpDir('amxb-binary-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'docs/blob.dat', Buffer.from([0x00, 0x61, 0x62, 0x00]));

  const read = readAssets(resolveAssets({
    docs: [{ file: 'docs/blob.dat', name: 'blob', description: null }],
  }, root));

  assert.equal(read.docs[0].content, '[binary file, 4 bytes]');
});

// ─── readDepManifest (offline, injected fetchRoot) ───────────────────────────

test('readDepManifest: parses the dep manifest found in the fetched root', async (t) => {
  const root = makeTmpDir('amxb-depman-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'amxbuild.yml', 'name: DepName\n');

  const res = await readDepManifest(
    { repo: 'org/repo', ref: 'v1' },
    { fetchRoot: async () => ({ rootDir: root, label: 'org/repo@v1' }) }
  );

  assert.equal(res.label, 'org/repo@v1');
  assert.equal(res.rootDir, root);
  assert.equal(res.manifestPath, path.join(root, 'amxbuild.yml'));
  assert.equal(res.raw.name, 'DepName');
});

test('readDepManifest: no manifest → manifestPath null, raw null', async (t) => {
  const root = makeTmpDir('amxb-depnoman-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const res = await readDepManifest(
    { repo: 'org/repo', ref: 'v1' },
    { fetchRoot: async () => ({ rootDir: root, label: 'org/repo@v1' }) }
  );

  assert.equal(res.manifestPath, null);
  assert.equal(res.raw, null);
});

test('readDepManifest: malformed YAML → raw null, does not throw', async (t) => {
  const root = makeTmpDir('amxb-depbad-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'amxbuild.yml', 'name: [unclosed\n');

  const res = await readDepManifest(
    { repo: 'org/repo', ref: 'v1' },
    { fetchRoot: async () => ({ rootDir: root, label: 'org/repo@v1' }) }
  );

  assert.equal(res.raw, null);
  assert.equal(res.manifestPath, path.join(root, 'amxbuild.yml'));
});

// ─── collectDepAssets ────────────────────────────────────────────────────────

test('collectDepAssets: reads declared docs + file skill + dir skill with content', async (t) => {
  const root = makeTmpDir('amxb-collectdep-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'amxbuild.yml', [
    'name: DepName',
    'docs:',
    '  - file: docs/API.md',
    '    name: API',
    '    description: dep api',
    'skills:',
    '  - file: skills/config.md',
    '    name: config',
    '    description: single',
    '  - dir: skills/deep',
    '    name: deep',
    '    description: bundle',
    '',
  ].join('\n'));
  write(root, 'docs/API.md', 'api content');
  write(root, 'skills/config.md', 'config content');
  write(root, 'skills/deep/SKILL.md', 'deep skill');
  write(root, 'skills/deep/ref.md', 'ref content');

  const res = await collectDepAssets(
    { repo: 'org/repo', ref: 'v1' },
    { fetchRoot: async () => ({ rootDir: root, label: 'org/repo@v1' }) }
  );

  assert.equal(res.label, 'org/repo@v1');
  assert.equal(res.manifestPath, path.join(root, 'amxbuild.yml'));
  assert.equal(res.manifestName, 'DepName');

  assert.equal(res.docs.length, 1);
  assert.equal(res.docs[0].name, 'API');
  assert.equal(res.docs[0].content, 'api content');

  assert.equal(res.skills.length, 2);
  const fileSkill = res.skills.find((s) => s.kind === 'file');
  assert.equal(fileSkill.name, 'config');
  assert.equal(fileSkill.content, 'config content');
  const dirSkill = res.skills.find((s) => s.kind === 'dir');
  assert.equal(dirSkill.name, 'deep');
  assert.deepEqual(dirSkill.files, [
    { rel: 'SKILL.md', content: 'deep skill' },
    { rel: 'ref.md', content: 'ref content' },
  ]);
  assert.deepEqual(res.missing, []);
});

test('collectDepAssets: dep with no manifest → empty arrays', async (t) => {
  const root = makeTmpDir('amxb-collectnone-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const res = await collectDepAssets(
    { repo: 'org/repo', ref: 'v1' },
    { fetchRoot: async () => ({ rootDir: root, label: 'org/repo@v1' }) }
  );

  assert.deepEqual(res, {
    label: 'org/repo@v1',
    manifestPath: null,
    manifestName: null,
    docs: [],
    skills: [],
    missing: [],
  });
});

// ─── collectLocalAssets ──────────────────────────────────────────────────────

test('collectLocalAssets: resolves and reads the local manifest assets', (t) => {
  const root = makeTmpDir('amxb-local-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'docs/API.md', 'local api');
  write(root, 'skills/config.md', 'local config');

  const result = collectLocalAssets({
    _path: path.join(root, 'amxbuild.yml'),
    docs: [{ file: 'docs/API.md', name: 'API', description: null }],
    skills: [{ file: 'skills/config.md', dir: null, name: 'config', description: null }],
  });

  assert.equal(result.docs[0].content, 'local api');
  assert.equal(result.skills[0].content, 'local config');
  assert.deepEqual(result.missing, []);
});

// ─── findManifestInDir ───────────────────────────────────────────────────────

test('findManifestInDir: returns amxbuild.yml when present', (t) => {
  const root = makeTmpDir('amxb-find-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'amxbuild.yml', 'name: X\n');

  assert.equal(findManifestInDir(root), path.join(root, 'amxbuild.yml'));
});

test('findManifestInDir: prefers amxbuild.yml over manifest.yml', (t) => {
  const root = makeTmpDir('amxb-findpref-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'amxbuild.yml', 'name: A\n');
  write(root, 'manifest.yml', 'name: B\n');

  assert.equal(findManifestInDir(root), path.join(root, 'amxbuild.yml'));
});

test('findManifestInDir: null when no candidate exists', (t) => {
  const root = makeTmpDir('amxb-findnone-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(findManifestInDir(root), null);
});
