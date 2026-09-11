'use strict';

/**
 * Tests for src/opencode-skills.js.
 *
 * Fully offline + deterministic: dependency fetching is injected via
 * `fetchRoot`, so no network traffic happens here.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');

const {
  slugify,
  skillSlug,
  synthesizeSkillMd,
  materializeSkills,
  collectProjectSkills,
  collectDepRepoSkills,
  buildOpencodeSkills,
  containerRoot,
} = require('../src/opencode-skills');

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

// ─── slugify / skillSlug ─────────────────────────────────────────────────────

test('slugify: lowercases and collapses non-alphanumeric runs', () => {
  assert.equal(slugify('Hello World!'), 'hello-world');
  assert.equal(slugify('  A__B--C  '), 'a-b-c');
  assert.equal(slugify('org/My Plugin'), 'org-my-plugin');
  assert.equal(slugify('already-slug'), 'already-slug');
  assert.equal(slugify(''), '');
  assert.equal(slugify(null), '');
});

test('skillSlug: namespaces builder, project and dep/repo sources', () => {
  assert.equal(skillSlug({ source: 'builder', name: 'amxb-migration' }), 'amxb-migration');
  assert.equal(skillSlug({ source: 'project', name: 'Config' }), 'project-config');
  assert.equal(skillSlug({ source: 'dep', owner: 'Acme', repo: 'Plug', name: 'Config' }), 'acme-plug-config');
  assert.equal(skillSlug({ source: 'repo', owner: 'Acme', repo: 'Plug', name: 'Config' }), 'acme-plug-config');
});

// ─── synthesizeSkillMd ───────────────────────────────────────────────────────

test('synthesizeSkillMd: frontmatter name + single-line description, content preserved', () => {
  const md = synthesizeSkillMd({
    name: 'project-cfg',
    description: 'line one\nline two',
    content: '# Body\n\ntext',
  });

  assert.ok(md.startsWith('---\nname: project-cfg\ndescription: line one line two\n---\n\n'));
  assert.ok(md.includes('# Body\n\ntext'));
});

test('synthesizeSkillMd: blank description falls back to "<name> skill"', () => {
  const md = synthesizeSkillMd({ name: 'x', description: '   ', content: 'body' });
  assert.ok(md.includes('name: x'));
  assert.ok(md.includes('description: x skill'));
});

// ─── materializeSkills ───────────────────────────────────────────────────────

test('materializeSkills: file skill → synthesized SKILL.md', (t) => {
  const container = makeTmpDir('amxb-oc-file-');
  t.after(() => fs.rmSync(container, { recursive: true, force: true }));

  const written = materializeSkills([
    {
      name: 'cfg', description: 'config skill', kind: 'file',
      file: 'skills/cfg.md', dir: null, abs: '/nonexistent', content: '# Config',
    },
  ], container, { source: 'project' });

  assert.deepEqual(written, [{ slug: 'project-cfg', origin: 'project' }]);

  const md = fs.readFileSync(path.join(container, 'project-cfg', 'SKILL.md'), 'utf8');
  assert.ok(md.includes('name: project-cfg'));
  assert.ok(md.includes('description: config skill'));
  assert.ok(md.includes('# Config'));
});

test('materializeSkills: dir skill copied recursively + SKILL.md synthesized when missing', (t) => {
  const src = makeTmpDir('amxb-oc-src-');
  const container = makeTmpDir('amxb-oc-dir-');
  t.after(() => {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(container, { recursive: true, force: true });
  });
  write(src, 'references/options.md', 'options');

  materializeSkills([
    {
      name: 'bundle', description: 'bundle skill', kind: 'dir', file: null,
      dir: 'skills/deep', abs: src, files: [{ rel: 'references/options.md', content: 'options' }],
    },
  ], container, { source: 'project' });

  assert.equal(
    fs.readFileSync(path.join(container, 'project-bundle', 'references', 'options.md'), 'utf8'),
    'options'
  );
  const md = fs.readFileSync(path.join(container, 'project-bundle', 'SKILL.md'), 'utf8');
  assert.ok(md.includes('name: project-bundle'));
  assert.ok(md.includes('references: references/options.md'));
});

test('materializeSkills: dir skill with authored SKILL.md keeps it verbatim', (t) => {
  const src = makeTmpDir('amxb-oc-authored-');
  const container = makeTmpDir('amxb-oc-authored-c-');
  t.after(() => {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(container, { recursive: true, force: true });
  });
  write(src, 'SKILL.md', 'authored verbatim');

  materializeSkills([
    {
      name: 'bundle', description: null, kind: 'dir', file: null,
      dir: 'skills/deep', abs: src, files: [{ rel: 'SKILL.md', content: 'authored verbatim' }],
    },
  ], container, { source: 'project' });

  assert.equal(
    fs.readFileSync(path.join(container, 'project-bundle', 'SKILL.md'), 'utf8'),
    'authored verbatim'
  );
});

test('materializeSkills: skips a slug that is already materialized', (t) => {
  const container = makeTmpDir('amxb-oc-dedup-');
  t.after(() => fs.rmSync(container, { recursive: true, force: true }));

  const skill = {
    name: 'cfg', description: null, kind: 'file',
    file: 'skills/cfg.md', dir: null, abs: '/nonexistent', content: 'one',
  };
  const written = materializeSkills([skill, { ...skill, content: 'two' }], container, { source: 'project' });

  assert.equal(written.length, 1);
  assert.ok(fs.readFileSync(path.join(container, 'project-cfg', 'SKILL.md'), 'utf8').includes('one'));
});

// ─── collectProjectSkills ────────────────────────────────────────────────────

test('collectProjectSkills: resolves local manifest skills with content', (t) => {
  const root = makeTmpDir('amxb-oc-local-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'skills/config.md', 'local cfg');

  const skills = collectProjectSkills({
    _path: path.join(root, 'amxbuild.yml'),
    skills: [{ file: 'skills/config.md', dir: null, name: 'config', description: 'c' }],
  });

  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, 'config');
  assert.equal(skills[0].content, 'local cfg');
});

// ─── collectDepRepoSkills ────────────────────────────────────────────────────

test('collectDepRepoSkills: tags dep/repo sources, records per-source failures', async (t) => {
  const depRoot  = makeTmpDir('amxb-oc-dep-');
  const repoRoot = makeTmpDir('amxb-oc-repo-');
  t.after(() => {
    fs.rmSync(depRoot, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  write(depRoot, 'amxbuild.yml', [
    'name: DepName',
    'skills:',
    '  - file: skills/a.md',
    '    name: a',
    '    description: dep a',
    '',
  ].join('\n'));
  write(depRoot, 'skills/a.md', 'dep a content');
  write(repoRoot, 'amxbuild.yml', [
    'name: RepoName',
    'skills:',
    '  - file: skills/b.md',
    '    name: b',
    '    description: repo b',
    '',
  ].join('\n'));
  write(repoRoot, 'skills/b.md', 'repo b content');

  const manifest = {
    _path: path.join(depRoot, 'amxbuild.yml'),
    globalDeps: [
      { repo: 'acme/dep', ref: 'v1', source: 'git', include_path: null, asset: null },
      { repo: 'acme/bad', ref: 'v1', source: 'git', include_path: null, asset: null },
    ],
    repos: [{ repo: 'acme/rep', ref: 'v2' }],
    github: { ssh: false },
  };

  const fetchRoot = async (dep) => {
    if (dep.repo === 'acme/dep') return { rootDir: depRoot,  label: 'acme/dep@v1' };
    if (dep.repo === 'acme/rep') return { rootDir: repoRoot, label: 'acme/rep@v2' };
    throw new Error('boom');
  };

  const sources = await collectDepRepoSkills(manifest, { fetchRoot, tokenFor: () => null });

  assert.ok(Array.isArray(sources));
  assert.equal(sources.length, 2);
  assert.equal(sources.errors.length, 1);
  assert.match(sources.errors[0], /acme\/bad: boom/);

  const dep = sources.find((s) => s.source === 'dep');
  assert.equal(dep.owner, 'acme');
  assert.equal(dep.repo, 'dep');
  assert.equal(dep.skills[0].name, 'a');
  assert.equal(dep.skills[0].content, 'dep a content');

  const repo = sources.find((s) => s.source === 'repo');
  assert.equal(repo.owner, 'acme');
  assert.equal(repo.repo, 'rep');
  assert.equal(repo.skills[0].name, 'b');
  assert.equal(repo.skills[0].content, 'repo b content');
});

// ─── buildOpencodeSkills ─────────────────────────────────────────────────────

test('buildOpencodeSkills: project + dep materialized, stale container wiped', async (t) => {
  const projRoot  = makeTmpDir('amxb-oc-proj-');
  const depRoot   = makeTmpDir('amxb-oc-bdep-');
  const cacheRoot = makeTmpDir('amxb-oc-cache-');
  t.after(() => {
    fs.rmSync(projRoot,  { recursive: true, force: true });
    fs.rmSync(depRoot,   { recursive: true, force: true });
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  });

  write(projRoot, 'skills/config.md', 'cfg content');
  write(projRoot, 'skills/deep/SKILL.md', 'deep authored');
  write(projRoot, 'skills/deep/ref.md', 'deep ref');
  write(depRoot, 'amxbuild.yml', [
    'name: DepName',
    'skills:',
    '  - file: skills/x.md',
    '    name: x',
    '    description: dep x',
    '',
  ].join('\n'));
  write(depRoot, 'skills/x.md', 'x content');

  const manifest = {
    _path: path.join(projRoot, 'amxbuild.yml'),
    skills: [
      { file: 'skills/config.md', dir: null, name: 'config', description: 'cfg' },
      { file: null, dir: 'skills/deep', name: 'deep', description: 'bundle' },
    ],
    globalDeps: [{ repo: 'acme/plug', ref: 'v1', source: 'git', include_path: null, asset: null }],
    repos: [],
    github: { ssh: false },
  };

  const key = crypto.createHash('sha1').update(manifest._path).digest('hex').slice(0, 12);
  const containerDir = path.join(cacheRoot, key);
  write(containerDir, 'stale/SKILL.md', 'stale');

  const result = await buildOpencodeSkills(manifest, {
    fetchRoot: async () => ({ rootDir: depRoot, label: 'acme/plug@v1' }),
    tokenFor: () => null,
    containerRoot: cacheRoot,
  });

  assert.equal(result.containerDir, containerDir);
  assert.equal(result.count, 3);
  assert.deepEqual(result.errors, []);

  assert.equal(fs.existsSync(path.join(containerDir, 'stale')), false);
  assert.ok(fs.existsSync(path.join(containerDir, 'project-config', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(containerDir, 'project-deep', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(containerDir, 'project-deep', 'ref.md')));
  assert.equal(
    fs.readFileSync(path.join(containerDir, 'project-deep', 'SKILL.md'), 'utf8'),
    'deep authored'
  );
  assert.ok(fs.existsSync(path.join(containerDir, 'acme-plug-x', 'SKILL.md')));
});

// ─── containerRoot ───────────────────────────────────────────────────────────

test('containerRoot: <cache dir>/opencode-skills', (t) => {
  const cache = makeTmpDir('amxb-oc-root-');
  const prev = process.env.AMXX_BUILDER_CACHE;
  process.env.AMXX_BUILDER_CACHE = cache;
  t.after(() => {
    if (prev === undefined) delete process.env.AMXX_BUILDER_CACHE;
    else process.env.AMXX_BUILDER_CACHE = prev;
    fs.rmSync(cache, { recursive: true, force: true });
  });

  assert.equal(containerRoot(), path.join(cache, 'opencode-skills'));
  assert.ok(containerRoot().endsWith('opencode-skills'));
});
