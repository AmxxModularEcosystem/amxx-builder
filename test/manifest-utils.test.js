'use strict';

/**
 * Tests for the pure helper functions in src/manifest.js:
 * deepMerge, loadDefaultsRaw, applyOverrides, parseOverrideValue,
 * resolveGithubToken, resolveManifest and parseManifest.
 *
 * NOTE: parseDepString / parseDepObject / parseDepsLines are covered by
 * helpers.test.js — they are intentionally not duplicated here.
 *
 * Offline + deterministic: no network, no git clones.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const manifest = require('../src/manifest');
const {
  deepMerge,
  loadDefaultsRaw,
  applyOverrides,
  parseOverrideValue,
  resolveGithubToken,
  resolveManifest,
  parseManifest,
  parseRefTtl,
  parseDepsLines,
  parseDepString,
} = manifest;

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeTmpYaml(content) {
  const dir = makeTmpDir('amxb-manifest-');
  const file = path.join(dir, 'amxbuild.yml');
  fs.writeFileSync(file, content, 'utf8');
  return { dir, file };
}

// ─── deepMerge ───────────────────────────────────────────────────────────────

test('deepMerge: overlay scalars win over base scalars', () => {
  assert.equal(deepMerge('a', 'b'), 'b');
  assert.equal(deepMerge(1, 2), 2);
  assert.equal(deepMerge(true, false), false);
});

test('deepMerge: nested objects are merged recursively', () => {
  const base = { a: 1, nested: { x: 1, y: 2 }, keep: 'me' };
  const overlay = { nested: { y: 20, z: 30 } };
  assert.deepEqual(deepMerge(base, overlay), {
    a: 1,
    nested: { x: 1, y: 20, z: 30 },
    keep: 'me',
  });
});

test('deepMerge: arrays are replaced entirely, never merged', () => {
  assert.deepEqual(deepMerge({ a: [1, 2, 3] }, { a: [4] }), { a: [4] });
  assert.deepEqual(deepMerge({ a: [1, 2, 3] }, { a: [] }), { a: [] });
  // scalar array element replacing a nested object
  assert.deepEqual(deepMerge({ a: { x: 1 } }, { a: [9] }), { a: [9] });
});

test('deepMerge: overlay null keeps the base value (null = "not specified")', () => {
  // Counterintuitive: first guard is `overlay === null → return base`, so a
  // null overlay never replaces — it means "use the default". Pinned here so
  // the behavior cannot silently flip.
  assert.deepEqual(deepMerge({ a: 1, b: 'x' }, { a: null }), { a: 1, b: 'x' });
  assert.deepEqual(deepMerge({ a: 1 }, null), { a: 1 });
});

test('deepMerge: overlay undefined returns base untouched', () => {
  const base = { a: 1 };
  assert.equal(deepMerge(base, undefined), base);
  assert.deepEqual(deepMerge({ a: 1 }, { a: undefined }), { a: 1 });
});

test('deepMerge: null/undefined base returns overlay', () => {
  assert.deepEqual(deepMerge(null, { a: 1 }), { a: 1 });
  assert.deepEqual(deepMerge(undefined, { a: 1 }), { a: 1 });
});

test('deepMerge: empty overlay object keeps a copy of base', () => {
  const base = { a: 1 };
  const out = deepMerge(base, {});
  assert.deepEqual(out, { a: 1 });
  assert.notEqual(out, base); // no mutation, fresh copy
});

test('deepMerge: does not mutate the base object', () => {
  const base = { nested: { x: 1 }, arr: [1, 2] };
  const snapshot = JSON.stringify(base);
  deepMerge(base, { nested: { x: 9 }, arr: [9] });
  assert.equal(JSON.stringify(base), snapshot);
});

test('deepMerge: scalar overlay replaces a base object', () => {
  assert.deepEqual(deepMerge({ a: { x: 1 } }, { a: 42 }), { a: 42 });
  assert.equal(deepMerge({ a: { x: 1 } }, { a: 42 }).a, 42);
});

// ─── loadDefaultsRaw ─────────────────────────────────────────────────────────

test('loadDefaultsRaw: returns a non-empty object with expected top-level keys', () => {
  const defaults = loadDefaultsRaw();
  assert.ok(defaults && typeof defaults === 'object' && !Array.isArray(defaults));
  for (const key of ['version', 'amxmodx', 'github', 'output', 'plugins', 'assets', 'deploy']) {
    assert.ok(key in defaults, `defaults missing top-level key "${key}"`);
  }
});

test('loadDefaultsRaw: known default values', () => {
  const defaults = loadDefaultsRaw();
  assert.equal(defaults.version, '1.0.0');
  assert.equal(defaults.amxmodx.dir, 'amxmodx');
  assert.deepEqual(defaults.amxmodx.defines, []);
  assert.deepEqual(defaults.docs, []);
  assert.deepEqual(defaults.skills, []);
  assert.equal(defaults.github.token_env, 'GITHUB_TOKEN');
  assert.equal(defaults.output.pack, true);
  assert.equal(defaults.output.archive_name, '{name}.zip');
  assert.equal(defaults.output.on_conflict, 'last_wins');
  assert.equal(defaults.assets.on_conflict, 'last_wins');
  assert.equal(defaults.deploy.watch_debounce_ms, 500);
  assert.equal(defaults.deploy.assets_path, '', 'deploy assets default to the server root, not output.assets_path');
});

// ─── parseOverrideValue ──────────────────────────────────────────────────────

test('parseOverrideValue: typed values', () => {
  assert.equal(parseOverrideValue('true'), true);
  assert.equal(parseOverrideValue('false'), false);
  assert.equal(parseOverrideValue('null'), null);
  assert.equal(parseOverrideValue('123'), 123);
  assert.equal(parseOverrideValue('0'), 0);
});

test('parseOverrideValue: non-numeric strings stay strings', () => {
  assert.equal(parseOverrideValue('abc'), 'abc');
  assert.equal(parseOverrideValue(''), '');
  assert.equal(parseOverrideValue('1.5'), '1.5');
  assert.equal(parseOverrideValue('v1.2.3'), 'v1.2.3');
  assert.equal(parseOverrideValue('True'), 'True');
  assert.equal(parseOverrideValue('12px'), '12px');
});

// ─── applyOverrides ──────────────────────────────────────────────────────────

test('applyOverrides: flat key=value', () => {
  const m = { name: 'x' };
  applyOverrides(m, ['name=y']);
  assert.equal(m.name, 'y');
});

test('applyOverrides: dot notation creates intermediate objects', () => {
  const m = {};
  applyOverrides(m, ['a.b.c=5', 'a.b.d=true']);
  assert.deepEqual(m, { a: { b: { c: 5, d: true } } });
});

test('applyOverrides: dot notation sets into existing nested objects', () => {
  const m = { output: { pack: true, dir: './' } };
  applyOverrides(m, ['output.pack=false', 'output.dir=./dist']);
  assert.equal(m.output.pack, false);
  assert.equal(m.output.dir, './dist');
});

test('applyOverrides: values are typed via parseOverrideValue', () => {
  const m = {};
  applyOverrides(m, ['num=42', 'flag=null', 'text=hello']);
  assert.equal(m.num, 42);
  assert.equal(m.flag, null);
  assert.equal(m.text, 'hello');
});

test('applyOverrides: throws on pair without "="', () => {
  assert.throws(() => applyOverrides({}, ['justakey']), /--set: invalid format "justakey" \(expected key=value\)/);
  assert.throws(() => applyOverrides({}, ['a.b=c', 'broken']), /--set: invalid format/);
});

// ─── resolveGithubToken ──────────────────────────────────────────────────────

test('resolveGithubToken: per-owner token wins over token_env', () => {
  const m = { github: { tokens: { orgA: 'TOKEN_A' }, token_env: 'GLOBAL_TOKEN' } };
  process.env.TOKEN_A = 'a-secret';
  process.env.GLOBAL_TOKEN = 'g-secret';
  try {
    assert.equal(resolveGithubToken(m, 'orgA/repo'), 'a-secret');
  } finally {
    delete process.env.TOKEN_A;
    delete process.env.GLOBAL_TOKEN;
  }
});

test('resolveGithubToken: falls back to token_env for unknown owners', () => {
  const m = { github: { tokens: { orgA: 'TOKEN_A' }, token_env: 'GLOBAL_TOKEN' } };
  process.env.GLOBAL_TOKEN = 'g-secret';
  try {
    assert.equal(resolveGithubToken(m, 'orgB/repo'), 'g-secret');
  } finally {
    delete process.env.GLOBAL_TOKEN;
  }
});

test('resolveGithubToken: defaults to GITHUB_TOKEN when nothing configured', () => {
  process.env.GITHUB_TOKEN = 'default-token';
  try {
    assert.equal(resolveGithubToken({ github: {} }, 'orgC/repo'), 'default-token');
    // manifest without github section at all
    assert.equal(resolveGithubToken({}, 'orgC/repo'), 'default-token');
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
});

test('resolveGithubToken: returns null when env var is unset', () => {
  delete process.env.GITHUB_TOKEN;
  const m = { github: { tokens: { orgA: 'TOKEN_A' }, token_env: 'GLOBAL_TOKEN' } };
  assert.equal(resolveGithubToken(m, 'orgA/repo'), null);
  assert.equal(resolveGithubToken(m, 'orgB/repo'), null);
  assert.equal(resolveGithubToken({ github: {} }, 'orgC/repo'), null);
});

test('resolveGithubToken: owner is the part before the first "/"', () => {
  const m = { github: { tokens: { deep: 'TOKEN_DEEP' }, token_env: 'GLOBAL_TOKEN' } };
  process.env.TOKEN_DEEP = 'deep-secret';
  try {
    assert.equal(resolveGithubToken(m, 'deep/nested/repo/path'), 'deep-secret');
  } finally {
    delete process.env.TOKEN_DEEP;
  }
});

// ─── parseManifest ───────────────────────────────────────────────────────────

test('parseManifest: happy path parses and deep-merges defaults', () => {
  const { file } = writeTmpYaml([
    'name: TestServer',
    'version: "2.5.0"',
    'repos:',
    '  - AmxxModularEcosystem/VipModular',
    '  - repo: AmxxModularEcosystem/ParamsController',
    '    ref: v1.2',
    'deps:',
    '  - org/util@1.0',
  ].join('\n'));
  const m = parseManifest(file);
  assert.equal(m.name, 'TestServer');
  assert.equal(m.version, '2.5.0');
  assert.equal(m.repos.length, 2);
  assert.equal(m.repos[0].repo, 'AmxxModularEcosystem/VipModular');
  assert.equal(m.repos[1].ref, 'v1.2');
  assert.equal(m.globalDeps[0].repo, 'org/util');
  // defaults merged in
  assert.equal(m.amxmodx.dir, 'amxmodx');
  assert.equal(m.output.pack, true);
  assert.equal(m.output.archive_name, '{name}.zip');
  assert.equal(m.github.token_env, 'GITHUB_TOKEN');
});

test('parseManifest: throws when the file does not exist', () => {
  const dir = makeTmpDir('amxb-missing-');
  assert.throws(
    () => parseManifest(path.join(dir, 'nope.yml')),
    /Manifest not found: [\s\S]*Run "amxb init" to create one/
  );
});

test('parseManifest: throws when version is a number (not quoted)', () => {
  const { file } = writeTmpYaml('name: NumServer\nversion: 1.0\n');
  assert.throws(() => parseManifest(file), /must be string/);
});

test('parseManifest: top-level docs normalized with default name', () => {
  const { file } = writeTmpYaml([
    'name: DocsServer',
    'version: "1.0.0"',
    'docs:',
    '  - file: docs/API.md',
    '    description: "  Public API  "',
  ].join('\n'));
  const m = parseManifest(file);
  assert.deepEqual(m.docs, [{ file: 'docs/API.md', name: 'API', description: 'Public API' }]);
});

test('parseManifest: top-level skills normalized (file and dir)', () => {
  const { file } = writeTmpYaml([
    'name: SkillsServer',
    'version: "1.0.0"',
    'skills:',
    '  - file: skills/config.md',
    '    name: config-skill',
    '  - dir: skills/deep-config',
  ].join('\n'));
  const m = parseManifest(file);
  assert.deepEqual(m.skills, [
    { file: 'skills/config.md', dir: null, name: 'config-skill', description: null },
    { file: null, dir: 'skills/deep-config', name: 'deep-config', description: null },
  ]);
});

test('parseManifest: absent docs/skills → empty arrays', () => {
  const { file } = writeTmpYaml('name: PlainServer\nversion: "1.0.0"\n');
  const m = parseManifest(file);
  assert.deepEqual(m.docs, []);
  assert.deepEqual(m.skills, []);
});

// ─── resolveManifest ─────────────────────────────────────────────────────────

test('resolveManifest: applies --set overrides', () => {
  const { file } = writeTmpYaml('name: SetServer\nversion: "1.0.0"\n');
  const m = resolveManifest(file, { set: ['output.pack=false', 'output.dir=./dist'] });
  assert.equal(m.output.pack, false);
  assert.equal(m.output.dir, './dist');
});

test('resolveManifest: pushes --define into amxmodx.defines', () => {
  const { file } = writeTmpYaml([
    'name: DefServer',
    'version: "1.0.0"',
    'amxmodx:',
    '  defines:',
    '    - EXISTING',
  ].join('\n'));
  const m = resolveManifest(file, { define: ['DEBUG', 'NEW_DEF'] });
  assert.deepEqual(m.amxmodx.defines, ['EXISTING', 'DEBUG', 'NEW_DEF']);
});

test('resolveManifest: combine set and define, defaults still merged', () => {
  const { file } = writeTmpYaml('name: ComboServer\nversion: "1.0.0"\n');
  const m = resolveManifest(file, {
    set: ['output.archive_name=combo.zip'],
    define: ['FLAG'],
  });
  assert.equal(m.output.archive_name, 'combo.zip');
  assert.deepEqual(m.amxmodx.defines, ['FLAG']);
  assert.equal(m.amxmodx.dir, 'amxmodx'); // from defaults
});

// ─── ref_ttl ─────────────────────────────────────────────────────────────────
//
// parseRefTtl is the single source of truth for the field format. The dep
// helpers appear here only to pin ref_ttl propagation/rejection; their full
// parse coverage stays in helpers.test.js.

test('parseRefTtl: valid values → milliseconds or "never"', () => {
  assert.equal(parseRefTtl(undefined), undefined);
  assert.equal(parseRefTtl(null), undefined);
  assert.equal(parseRefTtl('never'), 'never');
  assert.equal(parseRefTtl('  NEVER  '), 'never');
  assert.equal(parseRefTtl('45s'), 45000);
  assert.equal(parseRefTtl('30m'), 1800000);
  assert.equal(parseRefTtl('1h'), 3600000);
  assert.equal(parseRefTtl('7d'), 604800000);
  assert.equal(parseRefTtl('90'), 90000);
  assert.equal(parseRefTtl(3600), 3600000);
});

test('parseRefTtl: invalid values throw a directive error', () => {
  for (const bad of ['0', '0m', 'abc', '1y', 1.5, -1, 0, {}, Infinity]) {
    assert.throws(
      () => parseRefTtl(bad),
      /manifest: invalid ref_ttl .* use "never" or a duration like 30m\/1h\/7d/,
      `expected ref_ttl ${String(bad)} to be rejected`
    );
  }
});

test('parseRefTtl: results that overflow to a non-finite number are rejected', () => {
  // 1e308 * 1000 and a 400-digit string both overflow a double to Infinity;
  // a non-finite TTL must never enter the parsed manifest.
  assert.throws(() => parseRefTtl(1e308), /manifest: invalid ref_ttl/);
  assert.throws(() => parseRefTtl('9'.repeat(400)), /manifest: invalid ref_ttl/);
  assert.throws(() => parseRefTtl('9'.repeat(400) + 'd'), /manifest: invalid ref_ttl/);
});

test('parseManifest: repo ref_ttl is parsed', () => {
  const { file } = writeTmpYaml([
    'name: TtlServer',
    'version: "1.0.0"',
    'repos:',
    '  - repo: Org/Repo',
    '    ref: v1',
    '    ref_ttl: 30m',
  ].join('\n'));
  const m = parseManifest(file);
  assert.equal(m.repos[0].ref_ttl, 1800000);
});

test('parseManifest: repo without ref_ttl → undefined', () => {
  const { file } = writeTmpYaml([
    'name: TtlServer',
    'version: "1.0.0"',
    'repos:',
    '  - repo: Org/Repo',
    '    ref: v1',
  ].join('\n'));
  const m = parseManifest(file);
  assert.equal(m.repos[0].ref_ttl, undefined);
});

test('parseDepsLines: git dep object carries ref_ttl; string form yields undefined', () => {
  const fromObject = parseDepsLines([{ repo: 'org/a', ref: 'v1', ref_ttl: '7d' }])[0];
  assert.equal(fromObject.source, 'git');
  assert.equal(fromObject.ref_ttl, 604800000);

  assert.equal(parseDepsLines(['org/a@v1'])[0].ref_ttl, undefined);
  assert.equal(parseDepString('org/a@v1').ref_ttl, undefined);
});

test('parseDepsLines: ref_ttl is rejected for source local', () => {
  assert.throws(
    () => parseDepsLines([{ source: 'local', path: './vendor/a', ref_ttl: '1h' }]),
    /Dep entry source "local" does not support "ref_ttl"/
  );
});

test('parseManifest: ref_ttl is rejected for a local repo', () => {
  const { file } = writeTmpYaml([
    'name: TtlServer',
    'version: "1.0.0"',
    'repos:',
    '  - source: local',
    '    path: ./vendor/a',
    '    ref_ttl: 1h',
  ].join('\n'));
  // The JSON schema rejects it first (the local repoEntry variant has no
  // ref_ttl); makeRepo keeps a parser-level guard as defense in depth.
  assert.throws(() => parseManifest(file), /Manifest validation failed/);
});

test('parseDepsLines: ref_ttl is rejected for source fungun', () => {
  assert.throws(
    () => parseDepsLines([{ source: 'fungun', id: 106, ref_ttl: '1h' }]),
    /Dep entry source "fungun" does not support "ref_ttl"/
  );
});

test('parseDepsLines: ref_ttl is rejected for source release', () => {
  assert.throws(
    () => parseDepsLines([
      { repo: 'org/a', ref: 'v1', source: 'release', asset: 'a.zip', ref_ttl: 3600 },
    ]),
    /Dep entry source "release" does not support "ref_ttl"/
  );
});

// ─── ref_ttl via --set ────────────────────────────────────────────────────────
//
// --set writes raw string/int values onto the already-parsed manifest, so the
// ref_ttl leaf must be run through parseRefTtl — and only that leaf.

test('resolveManifest: --set ref_ttl is normalized via parseRefTtl', () => {
  const { file } = writeTmpYaml([
    'name: TtlSetServer',
    'version: "1.0.0"',
    'repos:',
    '  - repo: Org/Repo',
    '    ref: v1',
  ].join('\n'));

  const set = (v) => resolveManifest(file, { set: [`repos.0.ref_ttl=${v}`] }).repos[0].ref_ttl;
  assert.equal(set('30m'), 1800000);
  assert.equal(set('never'), 'never');
  assert.equal(set('3600'), 3600000);
});

test('resolveManifest: --set ref_ttl with an invalid value throws', () => {
  const { file } = writeTmpYaml([
    'name: TtlSetServer',
    'version: "1.0.0"',
    'repos:',
    '  - repo: Org/Repo',
    '    ref: v1',
  ].join('\n'));

  assert.throws(
    () => resolveManifest(file, { set: ['repos.0.ref_ttl=abc'] }),
    /manifest: invalid ref_ttl "abc" \(--set repos\.0\.ref_ttl\)/
  );
});

test('resolveManifest: --set never re-parses non-overridden ref_ttl values', () => {
  const { file } = writeTmpYaml([
    'name: TtlSetServer',
    'version: "1.0.0"',
    'repos:',
    '  - repo: Org/A',
    '    ref: v1',
    '    ref_ttl: 30m',
    '  - repo: Org/B',
    '    ref: v2',
    '    ref_ttl: never',
  ].join('\n'));

  // parseManifest already produced milliseconds for "30m" — no double parse.
  assert.equal(resolveManifest(file).repos[0].ref_ttl, 1800000);

  const m = resolveManifest(file, { set: ['repos.1.ref_ttl=1h'] });
  assert.equal(m.repos[0].ref_ttl, 1800000, 'untouched ref_ttl must stay in ms, not be re-parsed');
  assert.equal(m.repos[1].ref_ttl, 3600000);
});
