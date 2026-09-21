'use strict';

/**
 * Regression tests for the "local source" feature: repos/deps satisfied by a
 * local directory instead of GitHub, plus the `AMXB_LOCAL_SOURCES` env redirect.
 *
 * Offline + deterministic: every fetch-capable call is exercised only through
 * its local short-circuit (`_localDir`). Non-local contrasts use concrete
 * non-`latest` refs (which resolve without network) or a pinned-SHA + an
 * `--no-fetch` cache miss (which fails without network). Fixtures live in
 * `os.tmpdir()` and are removed in `t.after` — nothing is written under test/.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  ENV_VAR,
  STRICT_VAR,
  LOCAL_ID_PREFIX,
  normalizeId,
  isLocal,
  localDirOf,
  synthesizeLocalId,
  resolveLocalPath,
  resolveLocalEntry,
  parseLocalSourcesEnv,
  applyLocalOverrides,
  ensureRepoDir,
} = require('../src/local-sources');
const { parseManifest, parseDepObject } = require('../src/manifest');
const { validateManifest } = require('../src/schema');
const { resolveRepoRefs } = require('../src/repo-fetcher');
const {
  resolveDeps,
  fetchDepRoot,
  fetchDepIncludeDir,
  collectDepIncludeDirs,
  depLabel,
} = require('../src/deps-resolver');
const { buildDepTree } = require('../src/deps-tree');
const { collectDepRepoSkills } = require('../src/opencode-skills');
const { buildPlanData } = require('../src/build-plan');
const { HANDLERS } = require('../mcp/handlers');

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Dedicated fixture dir, removed after the test.
function useTmpDir(t, prefix) {
  const dir = makeTmpDir(prefix);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Sandboxed fetch cache so an accidental fetch cannot touch the real cache.
function useTempCache(t, prefix) {
  const dir = makeTmpDir(prefix);
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

// Save/restore the local-source env vars around a test. `undefined` leaves the
// var unset for the duration; `parseManifest` reads process.env directly.
function withLocalEnv(t, { sources, strict } = {}) {
  const saved = { sources: process.env[ENV_VAR], strict: process.env[STRICT_VAR] };
  if (sources === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = sources;
  if (strict === undefined) delete process.env[STRICT_VAR];
  else process.env[STRICT_VAR] = strict;
  t.after(() => {
    if (saved.sources === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = saved.sources;
    if (saved.strict === undefined) delete process.env[STRICT_VAR];
    else process.env[STRICT_VAR] = saved.strict;
  });
}

function localDep(repo, dir, overrides = {}) {
  return {
    repo,
    ref: null,
    source: 'local',
    include_path: null,
    asset: null,
    _localDir: dir,
    _resolvedRef: 'local',
    ...overrides,
  };
}

// ─── Module contract: constants + exports ────────────────────────────────────

test('local-sources: exports the contract constants and helpers', () => {
  assert.equal(ENV_VAR, 'AMXB_LOCAL_SOURCES');
  assert.equal(STRICT_VAR, 'AMXB_LOCAL_STRICT');
  assert.equal(LOCAL_ID_PREFIX, 'local/');

  for (const fn of [
    normalizeId,
    isLocal,
    localDirOf,
    synthesizeLocalId,
    resolveLocalPath,
    resolveLocalEntry,
    parseLocalSourcesEnv,
    applyLocalOverrides,
    ensureRepoDir,
  ]) {
    assert.equal(typeof fn, 'function');
  }
});

test('normalizeId: lowercases the logical id', () => {
  assert.equal(normalizeId('Org/Repo'), 'org/repo');
  assert.equal(normalizeId('LOCAL/Tool'), 'local/tool');
});

test('isLocal / localDirOf: keyed on a non-empty _localDir string, not on "source"', () => {
  assert.equal(isLocal(null), false);
  assert.equal(isLocal({}), false);
  assert.equal(isLocal({ source: 'local' }), false);
  assert.equal(isLocal({ _localDir: '' }), false);
  assert.equal(isLocal({ _localDir: '/x' }), true);

  assert.equal(localDirOf({ _localDir: '/x' }), '/x');
  assert.equal(localDirOf({ source: 'local' }), null);
  assert.equal(localDirOf(null), null);
});

test('synthesizeLocalId: explicit trimmed name wins, basename fallback otherwise', () => {
  assert.equal(synthesizeLocalId(' MyPlugin ', '/a/b/plugin-dir'), 'local/MyPlugin');
  assert.equal(synthesizeLocalId(undefined, '/a/b/plugin-dir'), 'local/plugin-dir');
  assert.equal(synthesizeLocalId('   ', '/a/b/plugin-dir'), 'local/plugin-dir');
  assert.equal(synthesizeLocalId(null, 'relative/dir/'), 'local/dir');
  assert.ok(synthesizeLocalId('x', '/y').startsWith(LOCAL_ID_PREFIX));
});

test('resolveLocalPath: relative resolves against manifestDir, absolute is normalized', () => {
  const manifestDir = path.join(os.tmpdir(), 'amxb-proj');
  assert.equal(
    resolveLocalPath(manifestDir, 'vendor/plugin'),
    path.join(manifestDir, 'vendor', 'plugin')
  );
  const abs = path.join(os.tmpdir(), 'elsewhere', 'dir');
  assert.equal(resolveLocalPath(manifestDir, abs), path.normalize(abs));
});

test('resolveLocalEntry: materializes _localPathRaw against baseDir and is idempotent', (t) => {
  const base = useTmpDir(t, 'amxb-ls-rle-');
  const dir = path.join(base, 'vendor', 'x');
  fs.mkdirSync(dir, { recursive: true });

  const entry = { repo: 'local/x', _localPathRaw: 'vendor/x' };
  assert.equal(resolveLocalEntry(entry, base), entry, 'returns the same entry');
  assert.equal(entry._localDir, dir);
  assert.equal(entry._resolvedRef, 'local');

  // Idempotent: an already-local entry is returned untouched.
  assert.equal(resolveLocalEntry(entry, path.join(base, 'other')), entry);
  assert.equal(entry._localDir, dir);

  // No declared path → no-op (non-local git entries stay non-local).
  const git = { repo: 'Org/Repo', ref: 'v1' };
  assert.equal(resolveLocalEntry(git, base), git);
  assert.equal(isLocal(git), false);

  // A declared path that does not exist is a hard error.
  assert.throws(
    () => resolveLocalEntry({ repo: 'local/ghost', _localPathRaw: 'nope' }, base),
    /Local source for "local\/ghost" not found or not a directory/
  );
});

test('mcp list_dep_incs: ad-hoc local dep object resolves locally (no GitHub fallthrough)', async (t) => {
  const root = useTmpDir(t, 'amxb-ls-mcp-');
  write(root, 'scripting/include/api.inc', 'api');

  const result = await HANDLERS.list_dep_incs({ dep: { source: 'local', path: root } }, null, true);

  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  assert.match(text, /api\.inc/, 'the local .inc is listed');
  assert.doesNotMatch(text, /Error:/, 'no fetch error — the local branch was taken');
});

// ─── parseLocalSourcesEnv ────────────────────────────────────────────────────

test('parseLocalSourcesEnv: unset/blank value → empty map, no errors, non-strict', () => {
  for (const env of [{}, { [ENV_VAR]: '' }, { [ENV_VAR]: '   ' }]) {
    const result = parseLocalSourcesEnv(env);
    assert.deepEqual([...result.map], []);
    assert.deepEqual(result.errors, []);
    assert.equal(result.strict, false);
  }
});

test('parseLocalSourcesEnv: JSON object form (trimmed value starts with "{")', () => {
  const result = parseLocalSourcesEnv({
    [ENV_VAR]: '  {"Org/Repo": "/src/one", "local/tool": "rel/two"}  ',
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.map.get('org/repo'), '/src/one');
  assert.equal(result.map.get('local/tool'), 'rel/two');
});

test('parseLocalSourcesEnv: invalid JSON is reported in errors, never thrown', () => {
  let result;
  assert.doesNotThrow(() => {
    result = parseLocalSourcesEnv({ [ENV_VAR]: '{not json' });
  });
  assert.deepEqual([...result.map], []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Invalid JSON in AMXB_LOCAL_SOURCES/);
});

test('parseLocalSourcesEnv: a non-"{" value uses id=path parsing, not JSON', () => {
  const result = parseLocalSourcesEnv({ [ENV_VAR]: '["a"]' });
  assert.deepEqual([...result.map], []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /expected id=path/);
});

test('parseLocalSourcesEnv: JSON entry with an empty id is reported', () => {
  const result = parseLocalSourcesEnv({ [ENV_VAR]: '{"": "/x"}' });
  assert.deepEqual([...result.map], []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /empty id/);
});

test('parseLocalSourcesEnv: JSON entry values must be non-empty strings', () => {
  const result = parseLocalSourcesEnv({ [ENV_VAR]: '{"a/b": "", "c/d": 5}' });
  assert.deepEqual([...result.map], []);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /"a\/b"/);
  assert.match(result.errors[1], /"c\/d"/);
});

test('parseLocalSourcesEnv: id=path pairs split on ";" and newlines, comments/blank skipped', () => {
  const result = parseLocalSourcesEnv({
    [ENV_VAR]: [
      'Org/One=/src/one; local/two=rel/two ;# trailing segment',
      '',
      '# whole-line comment',
      '  ',
      'Org/Three=/src/three',
    ].join('\n'),
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.map.get('org/one'), '/src/one');
  assert.equal(result.map.get('local/two'), 'rel/two');
  assert.equal(result.map.get('org/three'), '/src/three');
  assert.equal(result.map.size, 3);
});

test('parseLocalSourcesEnv: invalid entries land in errors; valid ones still parse', () => {
  const result = parseLocalSourcesEnv({
    [ENV_VAR]: 'noequals\n=/missing-id\nmissing-path=\nok/id=/src',
  });
  assert.equal(result.map.get('ok/id'), '/src');
  assert.equal(result.map.size, 1);
  assert.equal(result.errors.length, 3);
  assert.match(result.errors[0], /expected id=path/);
});

test('parseLocalSourcesEnv: duplicate ids — last wins', () => {
  const result = parseLocalSourcesEnv({ [ENV_VAR]: 'Org/Repo=/first\norg/repo=/second' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.map.get('org/repo'), '/second');
  assert.equal(result.map.size, 1);
});

test('parseLocalSourcesEnv: strict is on for "1"/"true" (case-insensitive) only', () => {
  assert.equal(parseLocalSourcesEnv({ [STRICT_VAR]: '1' }).strict, true);
  assert.equal(parseLocalSourcesEnv({ [STRICT_VAR]: 'TRUE' }).strict, true);
  assert.equal(parseLocalSourcesEnv({ [STRICT_VAR]: 'yes' }).strict, false);
  assert.equal(parseLocalSourcesEnv({ [STRICT_VAR]: '0' }).strict, false);
});

// ─── applyLocalOverrides ─────────────────────────────────────────────────────

test('applyLocalOverrides: declared local path → absolute _localDir + _resolvedRef=local', (t) => {
  const root = useTmpDir(t, 'amxb-ls-decl-');
  const dir = path.join(root, 'vendor', 'plug');
  fs.mkdirSync(dir, { recursive: true });

  const manifest = {
    _path: path.join(root, 'amxbuild.yml'),
    repos: [{ repo: 'local/plug', _localPathRaw: 'vendor/plug' }],
    globalDeps: [],
  };

  const out = applyLocalOverrides(manifest, {});

  assert.equal(out, manifest, 'mutates and returns the same manifest');
  assert.equal(manifest.repos[0]._localDir, dir);
  assert.equal(manifest.repos[0]._resolvedRef, 'local');
});

test('applyLocalOverrides: a declared path that is missing or a file is a hard error', (t) => {
  const root = useTmpDir(t, 'amxb-ls-decl-bad-');
  fs.writeFileSync(path.join(root, 'not-a-dir'), 'x', 'utf8');

  const base = { _path: path.join(root, 'amxbuild.yml'), repos: [], globalDeps: [] };

  assert.throws(
    () => applyLocalOverrides({
      ...base,
      repos: [{ repo: 'local/ghost', _localPathRaw: 'nope' }],
    }, {}),
    /Local source for "local\/ghost" not found or not a directory/
  );

  assert.throws(
    () => applyLocalOverrides({
      ...base,
      globalDeps: [{ repo: 'local/file', _localPathRaw: 'not-a-dir' }],
    }, {}),
    /not a directory/
  );
});

test('applyLocalOverrides: env redirect wins over a manifest-declared path for the same id', (t) => {
  const root = useTmpDir(t, 'amxb-ls-prec-');
  const declaredDir = path.join(root, 'declared');
  const envDir = path.join(root, 'redirected');
  fs.mkdirSync(declaredDir, { recursive: true });
  fs.mkdirSync(envDir, { recursive: true });

  const manifest = {
    _path: path.join(root, 'amxbuild.yml'),
    repos: [{ repo: 'local/plug', _localPathRaw: declaredDir }],
    globalDeps: [],
  };

  // Lowercase key via normalizeId must still match the mixed-case id.
  applyLocalOverrides(manifest, { [ENV_VAR]: `Local/Plug=${envDir}` });

  assert.equal(manifest.repos[0]._localDir, envDir);
  assert.equal(manifest.repos[0]._resolvedRef, 'local');
});

test('applyLocalOverrides: env redirects a normal git entry (runtime discriminator is _localDir)', (t) => {
  const root = useTmpDir(t, 'amxb-ls-git-');
  const envDir = path.join(root, 'local-copy');
  fs.mkdirSync(envDir, { recursive: true });

  const entry = { repo: 'Org/Repo', ref: 'v1' };
  const manifest = {
    _path: path.join(root, 'amxbuild.yml'),
    repos: [entry],
    globalDeps: [],
  };

  applyLocalOverrides(manifest, { [ENV_VAR]: 'org/repo=' + envDir });

  assert.equal(entry.source, undefined, 'parser does not rewrite "source"');
  assert.equal(entry.ref, 'v1', 'declared ref is preserved on the config');
  assert.equal(isLocal(entry), true);
  assert.equal(entry._localDir, envDir);
  assert.equal(entry._resolvedRef, 'local');
});

test('applyLocalOverrides: env id absent from the manifest is ignored (non-strict)', (t) => {
  const root = useTmpDir(t, 'amxb-ls-unknown-');
  const realDir = path.join(root, 'real');
  fs.mkdirSync(realDir, { recursive: true });

  const manifest = {
    _path: path.join(root, 'amxbuild.yml'),
    repos: [{ repo: 'Org/Repo', ref: 'v1' }],
    globalDeps: [],
  };

  assert.doesNotThrow(() => {
    applyLocalOverrides(manifest, { [ENV_VAR]: `ghost/id=${realDir}` });
  });

  assert.equal(manifest.repos[0]._localDir, undefined, 'nothing invented or redirected');
  assert.equal(isLocal(manifest.repos[0]), false);
  assert.equal(manifest.repos.length, 1);
});

test('applyLocalOverrides: strict mode throws for an env id absent from the manifest', (t) => {
  const root = useTmpDir(t, 'amxb-ls-strict-');
  const realDir = path.join(root, 'real');
  fs.mkdirSync(realDir, { recursive: true });

  const manifest = {
    _path: path.join(root, 'amxbuild.yml'),
    repos: [{ repo: 'Org/Repo', ref: 'v1' }],
    globalDeps: [],
  };

  assert.throws(
    () => applyLocalOverrides(manifest, {
      [ENV_VAR]: `ghost/id=${realDir}`,
      [STRICT_VAR]: '1',
    }),
    /No repo\/dep with id "ghost\/id" in this manifest/
  );
});

test('applyLocalOverrides: an env path that does not exist is a hard error', (t) => {
  const root = useTmpDir(t, 'amxb-ls-envmissing-');
  const manifest = {
    _path: path.join(root, 'amxbuild.yml'),
    repos: [{ repo: 'Org/Repo', ref: 'v1' }],
    globalDeps: [],
  };

  assert.throws(
    () => applyLocalOverrides(manifest, { [ENV_VAR]: 'org/repo=does-not-exist' }),
    /not found or not a directory.*AMXB_LOCAL_SOURCES/
  );
});

test('applyLocalOverrides: env redirect rescues a declared path that no longer exists', (t) => {
  const root = useTmpDir(t, 'amxb-ls-rescue-');
  const realDir = path.join(root, 'real');
  fs.mkdirSync(realDir, { recursive: true });

  const make = () => ({
    _path: path.join(root, 'amxbuild.yml'),
    repos: [{ repo: 'local/plug', _localPathRaw: 'stale-missing' }],
    globalDeps: [],
  });

  // No env redirect → the stale declared path is a hard error (unchanged).
  assert.throws(
    () => applyLocalOverrides(make(), {}),
    /Local source for "local\/plug" not found or not a directory/
  );

  // Env redirect wins over (and never asserts) the stale declared path.
  const rescued = make();
  applyLocalOverrides(rescued, { [ENV_VAR]: `local/plug=${realDir}` });
  assert.equal(rescued.repos[0]._localDir, realDir);
  assert.equal(rescued.repos[0]._resolvedRef, 'local');
});

test('applyLocalOverrides: duplicate local ids → error for different dirs, dedup for the same dir', (t) => {
  const root = useTmpDir(t, 'amxb-ls-dup-');
  const dirA = path.join(root, 'a');
  const dirB = path.join(root, 'b');
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });

  const build = (dirs) => ({
    _path: path.join(root, 'amxbuild.yml'),
    repos: dirs.map((d) => ({ repo: 'local/plugin', _localPathRaw: d })),
    globalDeps: [],
  });

  // Two DISTINCT dirs under one synthetic id: name both paths AND the fix.
  assert.throws(
    () => applyLocalOverrides(build([dirA, dirB]), {}),
    (err) => {
      assert.match(err.message, /Duplicate local source id "local\/plugin"/);
      assert.ok(err.message.includes(dirA), 'names the first dir');
      assert.ok(err.message.includes(dirB), 'names the second dir');
      assert.match(err.message, /set a unique "name"/);
      return true;
    }
  );

  // The same dir twice is a harmless dedup (no throw).
  const deduped = build([dirA, dirA]);
  assert.doesNotThrow(() => applyLocalOverrides(deduped, {}));
  assert.equal(deduped.repos[0]._localDir, dirA);
  assert.equal(deduped.repos[1]._localDir, dirA);
});

// ─── parseDepObject: local shape ─────────────────────────────────────────────

test('parseDepObject: local dep → synthetic id + _localPathRaw', () => {
  assert.deepEqual(parseDepObject({ source: 'local', path: './vendor/params' }), {
    repo: 'local/params',
    ref: null,
    source: 'local',
    include_path: null,
    asset: null,
    _localPathRaw: './vendor/params',
  });
});

test('parseDepObject: local dep honours a trimmed explicit name', () => {
  const dep = parseDepObject({ source: 'local', path: '/x/y', name: ' Params ' });
  assert.equal(dep.repo, 'local/Params');
  assert.equal(dep._localPathRaw, '/x/y');
});

test('parseDepObject: local dep rejects repo/ref/id/url/asset', () => {
  for (const field of ['repo', 'ref', 'id', 'url', 'asset']) {
    assert.throws(
      () => parseDepObject({ source: 'local', path: '/x', [field]: 'boom' }),
      new RegExp(`does not support "${field}"`),
      `field ${field} must be rejected`
    );
  }
});

test('parseDepObject: local dep requires a non-empty path', () => {
  assert.throws(() => parseDepObject({ source: 'local' }), /requires "path"/);
  assert.throws(() => parseDepObject({ source: 'local', path: '   ' }), /requires "path"/);
});

test('parseDepObject: the unknown-source error lists "local" among the valid sources', () => {
  assert.throws(
    () => parseDepObject({ repo: 'a/b', ref: 'v1', source: 'npm' }),
    /"source" must be "git", "release", "fungun" or "local"/
  );
});

// ─── Schema: local repo/dep shapes ───────────────────────────────────────────

test('schema: valid local repo/dep shapes pass, malformed ones fail', () => {
  const base = { name: 'X', version: '1.0.0' };

  assert.equal(validateManifest({
    ...base,
    repos: [{ source: 'local', path: './r', name: 'r' }],
    deps: [{ source: 'local', path: './d', include_path: 'inc' }],
  }).valid, true);

  const badDeps = [
    { source: 'local', path: './d', repo: 'a/b' },
    { source: 'local', path: './d', ref: 'v1' },
    { source: 'local', path: './d', id: 1 },
    { source: 'local', path: './d', url: 'https://example.com' },
    { source: 'local', path: './d', asset: 'a.zip' },
    { source: 'local' }, // missing path
  ];
  for (const dep of badDeps) {
    assert.equal(validateManifest({ ...base, deps: [dep] }).valid, false, JSON.stringify(dep));
  }

  const badRepos = [
    { source: 'local', path: './r', repo: 'a/b' },
    { source: 'local', path: './r', ref: 'v1' },
    { source: 'local' }, // missing path
  ];
  for (const repo of badRepos) {
    assert.equal(validateManifest({ ...base, repos: [repo] }).valid, false, JSON.stringify(repo));
  }
});

test('schema: path/name are rejected on git, release and fungun dep objects', () => {
  const base = { name: 'X', version: '1.0.0' };

  const bad = [
    { repo: 'a/b', ref: 'v1', path: './x' },
    { repo: 'a/b', ref: 'v1', name: 'x' },
    { source: 'release', repo: 'a/b', ref: 'v1', path: './x' },
    { source: 'release', repo: 'a/b', ref: 'v1', name: 'x' },
    { source: 'fungun', id: 106, path: './x' },
    { source: 'fungun', id: 106, name: 'x' },
  ];
  for (const dep of bad) {
    assert.equal(validateManifest({ ...base, deps: [dep] }).valid, false, JSON.stringify(dep));
  }

  const good = [
    { repo: 'a/b', ref: 'v1' },
    { repo: 'a/b', ref: 'v1', include_path: 'inc' },
    { source: 'release', repo: 'a/b', ref: 'v1', asset: 'x.zip' },
    { source: 'fungun', id: 106 },
    { source: 'fungun', url: 'https://fungun.net/shop/?p=show&id=106' },
    { source: 'local', path: './d', name: 'n', include_path: 'inc' },
  ];
  for (const dep of good) {
    assert.equal(validateManifest({ ...base, deps: [dep] }).valid, true, JSON.stringify(dep));
  }

  assert.equal(validateManifest({
    ...base,
    repos: [{ source: 'local', path: './r', name: 'r' }],
  }).valid, true);
});

// ─── parseManifest end-to-end ────────────────────────────────────────────────

test('parseManifest: declared local repo/dep → synthetic ids, absolute _localDir, _resolvedRef local', (t) => {
  const root = useTmpDir(t, 'amxb-ls-e2e-');
  withLocalEnv(t); // ambient AMXB_LOCAL_* must not influence the test

  fs.mkdirSync(path.join(root, 'vendor', 'plugin', 'amxmodx', 'scripting'), { recursive: true });
  fs.mkdirSync(path.join(root, 'vendor', 'params', 'scripting', 'include'), { recursive: true });
  write(root, 'amxbuild.yml', [
    'name: LocalServer',
    'version: "2.0.0"',
    'repos:',
    '  - source: local',
    '    path: ./vendor/plugin',
    '    name: MyPlugin',
    'deps:',
    '  - source: local',
    '    path: ./vendor/params',
    '    include_path: scripting/include',
    '',
  ].join('\n'));

  const manifest = parseManifest(path.join(root, 'amxbuild.yml'));

  const repo = manifest.repos[0];
  assert.equal(repo.repo, 'local/MyPlugin');
  assert.equal(repo.source, 'local');
  assert.equal(repo.ref, null);
  assert.equal(repo._localPathRaw, './vendor/plugin');
  assert.equal(repo._localDir, path.join(root, 'vendor', 'plugin'));
  assert.equal(repo._resolvedRef, 'local');

  const dep = manifest.globalDeps[0];
  assert.equal(dep.repo, 'local/params');
  assert.equal(dep.source, 'local');
  assert.equal(dep.ref, null);
  assert.equal(dep.include_path, 'scripting/include');
  assert.equal(dep._localDir, path.join(root, 'vendor', 'params'));
  assert.equal(dep._resolvedRef, 'local');
});

test('parseManifest: local dep inside a repo deps_override gets _localDir and resolves locally', async (t) => {
  const root = useTmpDir(t, 'amxb-ls-depov-');
  withLocalEnv(t);
  write(root, 'vendor/child/scripting/include/child.inc', 'child');
  write(root, 'amxbuild.yml', [
    'name: LocalServer',
    'version: "2.0.0"',
    'repos:',
    '  - repo: Org/Remote',
    '    ref: v1',
    '    deps_override:',
    '      - source: local',
    '        path: ./vendor/child',
    '        include_path: scripting/include',
    '',
  ].join('\n'));

  const manifest = parseManifest(path.join(root, 'amxbuild.yml'));
  const dep = manifest.repos[0].deps_override[0];
  assert.equal(dep.source, 'local');
  assert.equal(dep._localDir, path.join(root, 'vendor', 'child'));
  assert.equal(dep._resolvedRef, 'local');
  assert.equal(isLocal(dep), true);

  // include-tree reads deps_override through fetchDepIncludeDir → local branch.
  const incDir = path.join(root, 'vendor', 'child', 'scripting', 'include');
  assert.equal(await fetchDepIncludeDir(dep, null, true), incDir);

  // resolveDeps copies the local dep's .inc without touching git/network.
  const buildDir = path.join(root, 'build');
  const dirs = await resolveDeps(manifest, {}, false, buildDir);
  assert.equal(dirs.length, 1);
  assert.equal(dirs[0], path.join(buildDir, '_includes', 'local__child'));
  assert.equal(fs.readFileSync(path.join(dirs[0], 'child.inc'), 'utf8'), 'child');
});

test('parseManifest: AMXB_LOCAL_SOURCES rescues a declared path that no longer exists', (t) => {
  const root = useTmpDir(t, 'amxb-ls-e2e-rescue-');
  const realDir = path.join(root, 'real');
  fs.mkdirSync(realDir, { recursive: true });
  write(root, 'amxbuild.yml', [
    'name: LocalServer',
    'version: "2.0.0"',
    'repos:',
    '  - source: local',
    '    path: ./stale-missing',
    '    name: Plug',
    '',
  ].join('\n'));

  withLocalEnv(t, { sources: `local/Plug=${realDir}` });
  const manifest = parseManifest(path.join(root, 'amxbuild.yml'));
  assert.equal(manifest.repos[0]._localDir, realDir);
  assert.equal(manifest.repos[0]._resolvedRef, 'local');
});

test('parseManifest: AMXB_LOCAL_SOURCES redirects existing ids (env wins, never invents)', (t) => {
  const root = useTmpDir(t, 'amxb-ls-e2e-env-');

  const remoteDir = path.join(root, 'remote-copy');
  const declaredDir = path.join(root, 'declared');
  const redirectedDir = path.join(root, 'redirected');
  for (const d of [remoteDir, declaredDir, redirectedDir]) fs.mkdirSync(d, { recursive: true });

  write(root, 'amxbuild.yml', [
    'name: LocalServer',
    'version: "2.0.0"',
    'repos:',
    '  - Org/Remote@v1',
    '  - source: local',
    '    path: ./declared',
    '    name: Declared',
    '',
  ].join('\n'));

  withLocalEnv(t, {
    sources: `org/remote=${remoteDir};local/declared=${redirectedDir}`,
    strict: undefined,
  });

  const manifest = parseManifest(path.join(root, 'amxbuild.yml'));

  const remote = manifest.repos[0];
  assert.equal(remote.repo, 'Org/Remote');
  assert.equal(remote.ref, 'v1');
  assert.equal(isLocal(remote), true, 'env redirect turns a git entry local at runtime');
  assert.equal(remote._localDir, remoteDir);
  assert.equal(remote._resolvedRef, 'local');

  const declared = manifest.repos[1];
  assert.equal(declared._localDir, redirectedDir, 'env redirect wins over the declared path');
  assert.equal(declared._resolvedRef, 'local');
});

test('parseManifest: declared local path that does not exist is a hard error', (t) => {
  const root = useTmpDir(t, 'amxb-ls-e2e-missing-');
  withLocalEnv(t);

  write(root, 'amxbuild.yml', [
    'name: LocalServer',
    'version: "2.0.0"',
    'repos:',
    '  - source: local',
    '    path: ./missing',
    '',
  ].join('\n'));

  assert.throws(
    () => parseManifest(path.join(root, 'amxbuild.yml')),
    /not found or not a directory: .*missing/
  );
});

test('parseManifest: AMXB_LOCAL_STRICT makes an unknown env id fatal; non-strict ignores it', (t) => {
  const root = useTmpDir(t, 'amxb-ls-e2e-strict-');
  const realDir = path.join(root, 'real');
  fs.mkdirSync(realDir, { recursive: true });
  write(root, 'amxbuild.yml', [
    'name: LocalServer',
    'version: "2.0.0"',
    'repos:',
    '  - Org/Remote@v1',
    '',
  ].join('\n'));

  withLocalEnv(t, { sources: `ghost/id=${realDir}`, strict: '1' });
  assert.throws(
    () => parseManifest(path.join(root, 'amxbuild.yml')),
    /No repo\/dep with id "ghost\/id"/
  );

  // Same env, non-strict: ignored, manifest parses untouched.
  process.env[STRICT_VAR] = '0';
  const manifest = parseManifest(path.join(root, 'amxbuild.yml'));
  assert.equal(isLocal(manifest.repos[0]), false);
  assert.equal(manifest.repos[0]._resolvedRef, undefined);
});

test('parseManifest: malformed local entries are rejected by validation', (t) => {
  const root = useTmpDir(t, 'amxb-ls-e2e-bad-');
  withLocalEnv(t);
  const manifestPath = path.join(root, 'amxbuild.yml');
  const rewrite = (body) => fs.writeFileSync(manifestPath, body, 'utf8');
  const head = 'name: LocalServer\nversion: "2.0.0"\n';

  rewrite(head + 'repos:\n  - source: local\n');
  assert.throws(() => parseManifest(manifestPath), /Manifest validation failed/);

  rewrite(head + 'repos:\n  - source: local\n    path: ./r\n    ref: v1\n');
  assert.throws(() => parseManifest(manifestPath), /Manifest validation failed/);

  rewrite(head + 'repos:\n  - source: local\n    path: ./r\n    repo: a/b\n');
  assert.throws(() => parseManifest(manifestPath), /Manifest validation failed/);

  rewrite(head + 'deps:\n  - source: local\n    path: ./d\n    repo: a/b\n');
  assert.throws(() => parseManifest(manifestPath), /Manifest validation failed/);

  rewrite(head + 'deps:\n  - source: local\n');
  assert.throws(() => parseManifest(manifestPath), /Manifest validation failed/);
});

// ─── ensureRepoDir ───────────────────────────────────────────────────────────

test('ensureRepoDir: local entry returns _localDir regardless of noFetch, no fetch attempted', async (t) => {
  const cache = useTempCache(t, 'amxb-ls-endir-');
  const dir = useTmpDir(t, 'amxb-ls-endir-local-');
  const entry = localDep('local/tool', dir);

  assert.equal(await ensureRepoDir(entry), dir);
  assert.equal(await ensureRepoDir(entry, { noFetch: true }), dir);
  assert.equal(await ensureRepoDir(entry, { noFetch: false, ssh: true, token: 'x' }), dir);

  assert.deepEqual(fs.readdirSync(cache), [], 'fetch cache must stay untouched');
});

test('ensureRepoDir: forwards applicable ref_ttl, drops it for latest/SHA refs', async (t) => {
  const repoFetcher = require('../src/repo-fetcher');
  const calls = [];
  const origFetch = repoFetcher.fetchRepo;
  repoFetcher.fetchRepo = async (repo, ref, token, noFetch, ssh, refTtl) => {
    calls.push({ repo, ref, refTtl });
    return '/fake/dir';
  };
  t.after(() => { repoFetcher.fetchRepo = origFetch; });

  assert.equal(await ensureRepoDir({ repo: 'Org/Repo', ref: 'v1', _resolvedRef: 'v1', ref_ttl: 'never' }), '/fake/dir');
  assert.equal(await ensureRepoDir({ repo: 'Org/Repo', ref: 'latest', _resolvedRef: 'v1.2.3', ref_ttl: 60000 }), '/fake/dir');
  assert.equal(await ensureRepoDir({ repo: 'Org/Repo', ref: 'abc1234', _resolvedRef: 'abc1234', ref_ttl: 60000 }), '/fake/dir');
  assert.equal(await ensureRepoDir({ repo: 'Org/Repo', ref: 'main', _resolvedRef: 'main' }), '/fake/dir');

  assert.deepEqual(calls, [
    { repo: 'Org/Repo', ref: 'v1', refTtl: 'never' },
    { repo: 'Org/Repo', ref: 'v1.2.3', refTtl: undefined },
    { repo: 'Org/Repo', ref: 'abc1234', refTtl: undefined },
    { repo: 'Org/Repo', ref: 'main', refTtl: undefined },
  ]);
});

// ─── resolveRepoRefs ─────────────────────────────────────────────────────────

test('resolveRepoRefs: local entry gets the "local" sentinel without ref/token resolution', async () => {
  const repos = [
    { repo: 'Org/Remote', ref: 'v1.2.3' }, // concrete ref → resolves offline
    { repo: 'local/tool', ref: null, _localDir: path.join(os.tmpdir(), 'whatever') },
  ];
  let tokenCalls = 0;

  await resolveRepoRefs(repos, () => { tokenCalls++; return null; });

  assert.equal(repos[0]._resolvedRef, 'v1.2.3');
  assert.equal(repos[1]._resolvedRef, 'local', 'no GitHub API call for local entries');
  assert.equal(tokenCalls, 1, 'token resolved for the remote repo only');
});

// ─── deps-resolver: local short-circuits ─────────────────────────────────────

test('fetchDepIncludeDir: local dep short-circuits to _localDir (noFetch irrelevant)', async (t) => {
  const root = useTmpDir(t, 'amxb-ls-fdid-');
  const incDir = write(root, 'scripting/include/api.inc', '');

  const dep = localDep('local/tool', root);

  assert.equal(
    await fetchDepIncludeDir(dep, null, true),
    path.dirname(incDir),
    'canonical candidate search inside the local dir'
  );
  assert.equal(await fetchDepIncludeDir(dep, null, false), path.dirname(incDir));

  const explicit = localDep('local/tool', root, { include_path: 'scripting/include' });
  assert.equal(await fetchDepIncludeDir(explicit, null, true), path.dirname(incDir));

  // Interface policy: an explicit include_path that is missing falls back to root.
  const missing = localDep('local/tool', root, { include_path: 'nope' });
  assert.equal(await fetchDepIncludeDir(missing, null, false), root);
});

test('fetchDepRoot: local dep returns _localDir (or include_path subdir) with "(local)" label', async (t) => {
  const root = useTmpDir(t, 'amxb-ls-froot-');
  const incDir = path.dirname(write(root, 'scripting/include/api.inc', ''));
  const dep = localDep('local/tool', root);

  assert.deepEqual(await fetchDepRoot(dep, { noFetch: true }), {
    rootDir: root,
    label: 'local/tool (local)',
  });

  const named = localDep('local/tool', root, { include_path: 'scripting/include' });
  assert.deepEqual(await fetchDepRoot(named, { noFetch: false }), {
    rootDir: incDir,
    label: 'local/tool (local)',
  });

  // Build-pipeline policy: a missing explicit include_path is an error.
  const bad = localDep('local/tool', root, { include_path: 'missing' });
  await assert.rejects(
    fetchDepRoot(bad, {}),
    /include_path "missing" not found in local\/tool/
  );
});

test('collectDepIncludeDirs: local dep resolves from disk, remote failure stays per-dep', async (t) => {
  useTempCache(t, 'amxb-ls-cdi-');
  const root = useTmpDir(t, 'amxb-ls-cdi-local-');
  const incDir = path.dirname(write(root, 'scripting/include/api.inc', ''));

  const manifest = {
    globalDeps: [
      localDep('local/tool', root),
      { repo: 'nowhere/missing', ref: 'abcdef1', source: 'git', include_path: null, asset: null },
    ],
    github: { ssh: false },
  };

  const { dirs, errors } = await collectDepIncludeDirs(manifest, { noFetch: true });

  assert.equal(dirs[0], incDir);
  assert.equal(errors[0], null);
  assert.equal(dirs[1], null);
  assert.match(errors[1], /nowhere\/missing/);
});

test('depLabel: local deps read "<repo> (local)"; git/fungun labels unchanged', () => {
  assert.equal(depLabel(localDep('local/tool', '/x')), 'local/tool (local)');
  assert.equal(depLabel({ repo: 'org/dep', ref: 'v1', source: 'git' }), 'org/dep@v1');
  assert.equal(depLabel({ repo: 'org/dep', ref: null, source: 'git' }), 'org/dep@default branch');
  assert.equal(
    depLabel({ repo: 'fungun.net/106', ref: null, source: 'fungun', id: '106' }),
    'fungun.net plugin #106'
  );
});

test('resolveDeps: local global dep copies .inc files into build/_includes, no network', async (t) => {
  const root = useTmpDir(t, 'amxb-ls-rdeps-');
  const src = path.join(root, 'params');
  write(src, 'scripting/include/api.inc', 'api');
  write(src, 'scripting/include/nested/more.inc', 'more');
  write(src, 'notes.txt', 'not an include');

  const buildDir = path.join(root, 'build');
  const dep = localDep('local/params', src, { include_path: 'scripting/include' });
  const manifest = { repos: [], globalDeps: [dep], github: { ssh: false } };

  const dirs = await resolveDeps(manifest, {}, false, buildDir);

  assert.equal(dirs.length, 1);
  assert.equal(dirs[0], path.join(buildDir, '_includes', 'local__params'));
  assert.equal(fs.readFileSync(path.join(dirs[0], 'api.inc'), 'utf8'), 'api');
  assert.equal(fs.readFileSync(path.join(dirs[0], 'nested', 'more.inc'), 'utf8'), 'more');
  assert.equal(fs.existsSync(path.join(dirs[0], 'notes.txt')), false);

  // Build-pipeline policy for an explicit-but-missing include_path.
  await assert.rejects(
    resolveDeps({
      repos: [],
      globalDeps: [localDep('local/params', src, { include_path: 'nope' })],
      github: { ssh: false },
    }, {}, false, buildDir),
    /Include path "nope" not found in local\/params/
  );
});

// ─── deps-tree (walkDep through buildDepTree) ────────────────────────────────

test('buildDepTree: local dep reports source/localDir and expands its DEPS_LIST', async (t) => {
  useTempCache(t, 'amxb-ls-tree-cache-');
  const root = useTmpDir(t, 'amxb-ls-tree-');
  write(root, 'DEPS_LIST', '# child deps\nOrg/Child@abcdef1\n');

  const dep = localDep('local/lib', root);
  const { dependencies } = await buildDepTree([dep], { noFetch: true });

  const node = dependencies[0];
  assert.equal(node.source, 'local');
  assert.equal(node.localDir, root);
  assert.equal(node.resolvedRef, 'local');
  assert.equal(node.ref, null);
  assert.equal(node.include_path, null);
  assert.equal(node.error, null);

  // 'local' is truthy — the recursion gate must not skip a local DEPS_LIST.
  assert.equal(node.dependencies.length, 1, 'local DEPS_LIST must expand');

  // The child (a git dep with a pinned SHA) resolves offline; its fetch then
  // fails on the empty --no-fetch cache — proving no network was attempted.
  const child = node.dependencies[0];
  assert.equal(child.repo, 'Org/Child');
  assert.equal(child.resolvedRef, 'abcdef1');
  assert.match(child.error, /Repo cache missing|--no-fetch/);
});

// ─── opencode-skills ─────────────────────────────────────────────────────────

test('collectDepRepoSkills: preserves _localDir in the synthetic repo dep', async (t) => {
  const root = useTmpDir(t, 'amxb-ls-oc-');
  write(root, 'amxbuild.yml', [
    'name: LocalPlug',
    'skills:',
    '  - file: skills/a.md',
    '    name: a',
    '    description: local a',
    '',
  ].join('\n'));
  write(root, 'skills/a.md', 'local a content');

  const manifest = {
    _path: path.join(root, 'amxbuild.yml'),
    globalDeps: [],
    repos: [{ repo: 'local/myplug', ref: null, source: 'local', _localDir: root }],
    github: { ssh: false },
  };

  let captured = null;
  // Stub fetchRoot: no network. It relies on the synthetic dep carrying
  // _localDir — if that were dropped, rootDir would be undefined and the
  // source would land in `errors` instead of `sources`.
  const fetchRoot = async (dep) => {
    captured = dep;
    return { rootDir: dep._localDir, label: `${dep.repo} (local)` };
  };

  const sources = await collectDepRepoSkills(manifest, { fetchRoot, tokenFor: () => null });

  assert.ok(captured, 'fetchRoot must be called for the local repo');
  assert.equal(captured._localDir, root);
  assert.equal(captured.source, 'local');
  assert.equal(captured.repo, 'local/myplug');

  assert.deepEqual(sources.errors, []);
  const repo = sources.find((s) => s.source === 'repo');
  assert.ok(repo, 'local repo skills must be collected');
  assert.equal(repo.owner, 'local');
  assert.equal(repo.repo, 'myplug');
  assert.equal(repo.skills[0].content, 'local a content');
});

// ─── build-plan ──────────────────────────────────────────────────────────────

test('buildPlanData: local repos/deps → source local, ref null, local_dir set', () => {
  const manifest = {
    name: 'TestServer',
    version: '1.0.0',
    platform: null,
    _path: path.join(os.tmpdir(), 'amxb-plan.yml'),
    amxmodx: { version: null, dir: 'amxmodx', defines: [] },
    repos: [
      {
        repo: 'local/plug', source: 'local', ref: null,
        amxmodx_dir: 'amxmodx', deps_override: null, _localDir: '/abs/plug',
      },
      {
        repo: 'Org/Remote', ref: 'v1',
        amxmodx_dir: 'amxmodx', deps_override: null,
      },
    ],
    globalDeps: [
      {
        repo: 'local/params', source: 'local', ref: null,
        include_path: 'inc', asset: null, _localDir: '/abs/params',
      },
      { repo: 'Org/Dep', source: 'git', ref: 'v2', include_path: null, asset: null },
    ],
    assets: { sources: [{ type: 'local', map: [{ from: null, to: null }] }] },
    output: {
      pack: true,
      dir: 'build',
      archive_name: '{name}.zip',
      amxmodx_path: 'addons/amxmodx',
      assets_path: null,
      generate_ini: false,
      on_conflict: 'last_wins',
    },
  };

  const plan = buildPlanData(manifest);

  assert.deepEqual(plan.repos[0], {
    repo: 'local/plug',
    source: 'local',
    ref: null,
    amxmodx_dir: 'amxmodx',
    deps_override: null,
    local_dir: '/abs/plug',
  });
  assert.equal(plan.repos[1].source, 'git');
  assert.equal(plan.repos[1].ref, 'v1');
  assert.equal(plan.repos[1].local_dir, null);

  assert.equal(plan.globalDeps[0].source, 'local');
  assert.equal(plan.globalDeps[0].repo, 'local/params');
  assert.equal(plan.globalDeps[0].ref, null);
  assert.equal(plan.globalDeps[0].include_path, 'inc');
  assert.equal(plan.globalDeps[0].local_dir, '/abs/params');

  assert.equal(plan.globalDeps[1].source, 'git');
  assert.equal(plan.globalDeps[1].ref, 'v2');
  assert.equal(plan.globalDeps[1].local_dir, null);
});

test('buildPlanData: fungun dep redirected to local reports local (repo not nulled)', () => {
  const fungun = {
    repo: 'fungun.net/106', ref: null, source: 'fungun', id: '106',
    url: 'https://fungun.net/shop/?p=show&id=106', include_path: null, asset: null,
  };
  const base = {
    name: 'S', version: '1.0.0', platform: null,
    _path: path.join(os.tmpdir(), 'amxb-plan-fungun.yml'),
    amxmodx: { version: null, dir: 'amxmodx', defines: [] },
    repos: [],
    assets: { sources: [] },
    output: {
      pack: true, dir: 'build', archive_name: '{name}.zip',
      amxmodx_path: 'addons/amxmodx', assets_path: null,
      generate_ini: false, on_conflict: 'last_wins',
    },
  };

  const redirected = buildPlanData({
    ...base,
    globalDeps: [{ ...fungun, _localDir: '/abs/fungun' }],
  });
  assert.equal(redirected.globalDeps[0].source, 'local');
  assert.equal(redirected.globalDeps[0].repo, 'fungun.net/106');
  assert.equal(redirected.globalDeps[0].local_dir, '/abs/fungun');

  // A real fungun dep keeps its existing shape (repo nulled, source fungun).
  const plain = buildPlanData({ ...base, globalDeps: [fungun] });
  assert.equal(plain.globalDeps[0].source, 'fungun');
  assert.equal(plain.globalDeps[0].repo, null);
});
