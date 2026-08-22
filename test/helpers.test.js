'use strict';

/**
 * Regression tests for the consolidated core helpers (single-source-of-truth).
 *
 * These lock the behavior produced by the "single core + thin interfaces"
 * refactor: if someone reintroduces a duplicated implementation in an
 * interface layer, these tests keep the canonical behavior pinned to the
 * core module exports below.
 *
 * Offline + deterministic: no network, no amxxpc binary, no git clones.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const manifest = require('../src/manifest');
const { parseDepsLines, parseDepString, parseDepObject } = manifest;
const { resolveManifestPath } = require('../src/manifest-path');
const { formatBytes } = require('../src/format');
const { normalize, repoKey } = require('../src/deps-resolver');
const { resolveRefIfLatest } = require('../src/repo-fetcher');
const { findCaseInsensitive } = require('../src/include-tree');
const { buildIncludeArgs, buildDefineArgs } = require('../src/compile-utils');
const { buildPlanData } = require('../src/build-plan');
const { loadEnv } = require('../src/env');

const ORIG_CWD = process.cwd();

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ─── parseDepString ──────────────────────────────────────────────────────────

test('parseDepString: valid "owner/repo@ref"', () => {
  assert.deepEqual(parseDepString('AmxxModularEcosystem/ParamsController@1.4.2'), {
    repo: 'AmxxModularEcosystem/ParamsController',
    ref: '1.4.2',
    include_path: null,
    source: 'git',
    asset: null,
  });
});

test('parseDepString: valid "owner/repo@ref:include_path"', () => {
  const parsed = parseDepString('org/pkg@v2:scripting/include');
  assert.equal(parsed.repo, 'org/pkg');
  assert.equal(parsed.ref, 'v2');
  assert.equal(parsed.include_path, 'scripting/include');
  assert.equal(parsed.source, 'git');
});

test('parseDepString: rejects empty string', () => {
  assert.throws(() => parseDepString(''), /Invalid dep string/);
  assert.throws(() => parseDepString('   '), /Invalid dep string/);
});

test('parseDepString: rejects whitespace inside the repo part', () => {
  assert.throws(() => parseDepString('owner /repo@v1'), /Invalid dep string/);
  assert.throws(() => parseDepString('owner/repo with space@v1'), /Invalid dep string/);
});

test('parseDepString: rejects missing @ref', () => {
  assert.throws(() => parseDepString('owner/repo'), /Invalid dep string/);
  assert.throws(() => parseDepString('owner/repo@'), /Invalid dep string/);
});

test('parseDepString: rejects whitespace inside the ref part', () => {
  assert.throws(() => parseDepString('owner/repo@v 1'), /Invalid dep string/);
});

// ─── parseDepObject ──────────────────────────────────────────────────────────

test('parseDepObject: valid long-form object', () => {
  assert.deepEqual(parseDepObject({
    repo: 'org/plug',
    ref: 'v1.0.0',
    include_path: 'inc',
    source: 'release',
    asset: 'plug.zip',
  }), {
    repo: 'org/plug',
    ref: 'v1.0.0',
    include_path: 'inc',
    source: 'release',
    asset: 'plug.zip',
  });
});

test('parseDepObject: missing repo throws', () => {
  assert.throws(() => parseDepObject({ ref: 'v1' }), /Dep entry missing "repo"/);
});

test('parseDepObject: missing ref throws', () => {
  assert.throws(() => parseDepObject({ repo: 'a/b' }), /Dep entry missing "ref"/);
});

test('parseDepObject: bad source throws', () => {
  assert.throws(
    () => parseDepObject({ repo: 'a/b', ref: 'v1', source: 'npm' }),
    /"source" must be "git" or "release"/
  );
});

test('parseDepObject: defaults source to git', () => {
  assert.equal(parseDepObject({ repo: 'a/b', ref: 'v1' }).source, 'git');
});

// ─── parseDepsLines ──────────────────────────────────────────────────────────

test('parseDepsLines: skips empty lines and # comments', () => {
  const parsed = parseDepsLines(['', '   ', '# a comment', 'org/a@v1', '# another']);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].repo, 'org/a');
});

test('parseDepsLines: parses mixed strings and objects', () => {
  const parsed = parseDepsLines([
    'org/a@v1',
    { repo: 'org/b', ref: 'v2', source: 'release', asset: 'b.zip' },
  ]);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].repo, 'org/a');
  assert.equal(parsed[0].ref, 'v1');
  assert.equal(parsed[0].source, 'git');
  assert.equal(parsed[1].repo, 'org/b');
  assert.equal(parsed[1].source, 'release');
  assert.equal(parsed[1].asset, 'b.zip');
});

test('parseDepsLines: strict regex rejects whitespace in repo/ref', () => {
  assert.throws(() => parseDepsLines(['a /b@v1']), /Invalid dep entry/);
  assert.throws(() => parseDepsLines(['a/b@v 1']), /Invalid dep entry/);
});

test('parseDepsLines: object missing repo propagates parseDepObject error', () => {
  assert.throws(() => parseDepsLines([{ ref: 'v1' }]), /Dep entry missing "repo"/);
});

// ─── resolveManifestPath ─────────────────────────────────────────────────────

test('resolveManifestPath: explicit path → absolute, usedDefault false', () => {
  const abs = path.resolve('example/amxbuild.local.yml');
  assert.deepEqual(resolveManifestPath('example/amxbuild.local.yml'), {
    path: abs,
    usedDefault: false,
  });
});

test('resolveManifestPath: absolute explicit path passes through', () => {
  const p = path.join(os.tmpdir(), 'custom.yml');
  assert.deepEqual(resolveManifestPath(p), { path: p, usedDefault: false });
});

test('resolveManifestPath: auto-detect candidates', async (t) => {
  // Each subtest uses its own fresh dir so earlier candidates never leak into
  // later subtests.
  await t.test('amxbuild.yml present → usedDefault false', () => {
    const tmp = makeTmpDir('manpath-yml-');
    fs.writeFileSync(path.join(tmp, 'amxbuild.yml'), 'name: x\n');
    process.chdir(tmp);
    try {
      assert.deepEqual(resolveManifestPath(), { path: path.join(tmp, 'amxbuild.yml'), usedDefault: false });
    } finally {
      process.chdir(ORIG_CWD);
    }
  });

  await t.test('amxbuild.yaml present → usedDefault false', () => {
    const tmp = makeTmpDir('manpath-yaml-');
    fs.writeFileSync(path.join(tmp, 'amxbuild.yaml'), 'name: x\n');
    process.chdir(tmp);
    try {
      assert.deepEqual(resolveManifestPath(), { path: path.join(tmp, 'amxbuild.yaml'), usedDefault: false });
    } finally {
      process.chdir(ORIG_CWD);
    }
  });

  await t.test('only manifest.yml → usedDefault true', () => {
    const tmp = makeTmpDir('manpath-myml-');
    fs.writeFileSync(path.join(tmp, 'manifest.yml'), 'name: x\n');
    process.chdir(tmp);
    try {
      assert.deepEqual(resolveManifestPath(), { path: path.join(tmp, 'manifest.yml'), usedDefault: true });
    } finally {
      process.chdir(ORIG_CWD);
    }
  });

  await t.test('nothing found → cwd/amxbuild.yml, usedDefault true', () => {
    const tmp = makeTmpDir('manpath-none-');
    process.chdir(tmp);
    try {
      assert.deepEqual(resolveManifestPath(), { path: path.join(tmp, 'amxbuild.yml'), usedDefault: true });
    } finally {
      process.chdir(ORIG_CWD);
    }
  });

  await t.test('candidates prefer amxbuild.yml over manifest.yml', () => {
    const tmp = makeTmpDir('manpath-pref-');
    fs.writeFileSync(path.join(tmp, 'amxbuild.yml'), 'name: x\n');
    fs.writeFileSync(path.join(tmp, 'manifest.yml'), 'name: y\n');
    process.chdir(tmp);
    try {
      assert.deepEqual(resolveManifestPath(), { path: path.join(tmp, 'amxbuild.yml'), usedDefault: false });
    } finally {
      process.chdir(ORIG_CWD);
    }
  });
});

// ─── formatBytes ─────────────────────────────────────────────────────────────

test('formatBytes: B tier (exact, no precision)', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1023), '1023 B');
});

test('formatBytes: KB tier default precision 1', () => {
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
});

test('formatBytes: MB tier default precision 1', () => {
  assert.equal(formatBytes(1024 ** 2), '1.0 MB');
  assert.equal(formatBytes(3 * 1024 ** 2), '3.0 MB');
});

test('formatBytes: GB tier default precision 2', () => {
  assert.equal(formatBytes(1024 ** 3), '1.00 GB');
});

test('formatBytes: explicit precision override', () => {
  assert.equal(formatBytes(1024, { precision: 2 }), '1.00 KB');
  assert.equal(formatBytes(1024 ** 2, { precision: 0 }), '1 MB');
  assert.equal(formatBytes(1024 ** 3, { precision: 3 }), '1.000 GB');
  assert.equal(formatBytes(1024, { precision: 0 }), '1 KB');
});

// ─── normalize / repoKey ─────────────────────────────────────────────────────

test('normalize: lowercases the repo path', () => {
  assert.equal(normalize('AmxxModularEcosystem/VipModular'), 'amxxmodularecosystem/vipmodular');
});

test('repoKey: `${repo}@${_resolvedRef || ref || HEAD}`', () => {
  assert.equal(repoKey({ repo: 'a/b', ref: 'v1' }), 'a/b@v1');
  assert.equal(repoKey({ repo: 'a/b', ref: 'v1', _resolvedRef: 'abc123' }), 'a/b@abc123');
  assert.equal(repoKey({ repo: 'a/b' }), 'a/b@HEAD');
  assert.equal(repoKey({ repo: 'a/b', ref: null }), 'a/b@HEAD');
});

// ─── resolveRefIfLatest ──────────────────────────────────────────────────────

test('resolveRefIfLatest: non-latest ref passes through without network', async () => {
  // v1.2.3 and null must return immediately — no GitHub API call.
  assert.equal(await resolveRefIfLatest('v1.2.3', 'org/repo', null), 'v1.2.3');
  assert.equal(await resolveRefIfLatest('master', 'org/repo', 'token'), 'master');
  assert.equal(await resolveRefIfLatest(null, 'org/repo', null), null);
  // 'latest' would call resolveRef (network) — deliberately NOT tested here.
});

// ─── findCaseInsensitive ─────────────────────────────────────────────────────

test('findCaseInsensitive: exact match', () => {
  const tmp = makeTmpDir('ci-exact-');
  fs.writeFileSync(path.join(tmp, 'File.inc'), '');
  assert.equal(findCaseInsensitive(tmp, 'File.inc'), path.join(tmp, 'File.inc'));
});

test('findCaseInsensitive: case-insensitive single segment', () => {
  const tmp = makeTmpDir('ci-single-');
  fs.writeFileSync(path.join(tmp, 'File.inc'), '');
  assert.equal(findCaseInsensitive(tmp, 'FILE.inc'), path.join(tmp, 'File.inc'));
  assert.equal(findCaseInsensitive(tmp, 'file.inc'), path.join(tmp, 'File.inc'));
});

test('findCaseInsensitive: multi-segment path', () => {
  const tmp = makeTmpDir('ci-multi-');
  fs.mkdirSync(path.join(tmp, 'SubDir'));
  fs.writeFileSync(path.join(tmp, 'SubDir', 'File.inc'), '');
  assert.equal(
    findCaseInsensitive(tmp, 'subdir/file.inc'),
    path.join(tmp, 'SubDir', 'File.inc')
  );
  assert.equal(
    findCaseInsensitive(tmp, 'SUBdir/FILE.INC'),
    path.join(tmp, 'SubDir', 'File.inc')
  );
});

test('findCaseInsensitive: missing file → null', () => {
  const tmp = makeTmpDir('ci-miss-');
  fs.writeFileSync(path.join(tmp, 'File.inc'), '');
  assert.equal(findCaseInsensitive(tmp, 'nope.inc'), null);
  assert.equal(findCaseInsensitive(path.join(tmp, 'missing-dir'), 'File.inc'), null);
});

// ─── buildIncludeArgs ────────────────────────────────────────────────────────

test('buildIncludeArgs: canonical order scripting → local → collected → includeDirs', () => {
  const tmp = makeTmpDir('incargs-');
  const localInc = path.join(tmp, 'local');
  const collectedInc = path.join(tmp, 'collected');
  fs.mkdirSync(localInc);
  fs.mkdirSync(collectedInc);

  assert.deepEqual(buildIncludeArgs({
    scriptingDir: '/scripting',
    localIncDir: localInc,
    collectedIncDir: collectedInc,
    includeDirs: ['/dep1', '/dep2'],
  }), ['-i/scripting', `-i${localInc}`, `-i${collectedInc}`, '-i/dep1', '-i/dep2']);
});

test('buildIncludeArgs: non-existent local/collected dirs are skipped', () => {
  const tmp = makeTmpDir('incargs-miss-');
  const missing = path.join(tmp, 'does-not-exist');

  assert.deepEqual(buildIncludeArgs({
    scriptingDir: '/scripting',
    localIncDir: missing,
    collectedIncDir: missing,
    includeDirs: [],
  }), ['-i/scripting']);

  // Undefined local/collected dirs are skipped too; includeDirs still appended.
  assert.deepEqual(buildIncludeArgs({
    scriptingDir: '/scripting',
    includeDirs: ['/x'],
  }), ['-i/scripting', '-i/x']);
});

// ─── buildDefineArgs ─────────────────────────────────────────────────────────

test('buildDefineArgs: maps defines to -D flags', () => {
  assert.deepEqual(buildDefineArgs(['DEBUG', 'X']), ['-DDEBUG', '-DX']);
});

test('buildDefineArgs: empty/undefined input → empty array', () => {
  assert.deepEqual(buildDefineArgs([]), []);
  assert.deepEqual(buildDefineArgs(undefined), []);
  assert.deepEqual(buildDefineArgs(null), []);
});

// ─── buildPlanData ───────────────────────────────────────────────────────────

function fakeManifest(overrides = {}) {
  return {
    name: 'TestServer',
    version: '1.0.0',
    platform: 'linux',
    _path: path.join(ORIG_CWD, 'amxbuild.yml'),
    amxmodx: { version: '1.10.5428', dir: 'amxmodx', defines: ['DEBUG'] },
    repos: [{ repo: 'org/a', ref: 'v1', amxmodx_dir: 'amxmodx', deps_override: null }],
    globalDeps: [{ source: 'git', repo: 'org/dep', ref: 'v2', include_path: null, asset: null }],
    assets: {
      sources: [
        { type: 'local', map: [{ from: null, to: null }] },
        { type: 'url', url: 'https://cdn/x.zip', cache: 'none', map: [{ from: null, to: null }] },
        { type: 'amxmodx', map: [{ from: null, to: null }] },
        { type: 'release', repo: 'org/pack', ref: 'v3', asset: null, cache: 'global', map: [{ from: null, to: null }] },
      ],
    },
    output: {
      pack: true,
      dir: 'build',
      archive_name: '{name}-{version}.zip',
      amxmodx_path: 'addons/amxmodx',
      assets_path: null,
      generate_ini: true,
      on_conflict: 'last_wins',
    },
    ...overrides,
  };
}

test('buildPlanData: compact shape has name, output and typed assets', () => {
  const plan = buildPlanData(fakeManifest());

  assert.equal(plan.name, 'TestServer');
  assert.equal(plan.version, '1.0.0');

  // output.target expands {name}/{version} templates
  assert.equal(plan.output.pack, true);
  assert.equal(plan.output.target, path.join(path.resolve('build'), 'TestServer-1.0.0.zip'));
  assert.equal(plan.output.amxmodx_path, 'addons/amxmodx/');
  assert.equal(plan.output.generate_ini, true);

  // assets keep the compact per-type shape
  assert.deepEqual(plan.assets[0], { type: 'local', source: 'assets/' });
  assert.deepEqual(plan.assets[1], { type: 'url', url: 'https://cdn/x.zip', cache: 'none' });
  assert.deepEqual(plan.assets[2], { type: 'amxmodx', version: '1.10.5428', platform: 'linux' });
  assert.deepEqual(plan.assets[3], { type: 'release', repo: 'org/pack', ref: 'v3', asset: null, cache: 'global' });
});

test('buildPlanData: detailedAssets adds map/source/cache (+files for local)', () => {
  const tmp = makeTmpDir('plan-detail-');
  fs.mkdirSync(path.join(tmp, 'assets', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'assets', 'a.txt'), 'a');
  fs.writeFileSync(path.join(tmp, 'assets', 'sub', 'b.txt'), 'b');
  const manifest = fakeManifest({ _path: path.join(tmp, 'amxbuild.yml') });

  const plan = buildPlanData(manifest, { detailedAssets: true });

  assert.deepEqual(plan.assets[0].type, 'local');
  assert.equal(plan.assets[0].source, 'assets/ (next to manifest)');
  assert.ok(Array.isArray(plan.assets[0].map));
  assert.ok(plan.assets[0].files.includes('a.txt'), 'files lists asset files');
  assert.ok(plan.assets[0].files.includes('sub/b.txt'), 'files lists nested asset files');

  assert.deepEqual(plan.assets[1], {
    type: 'url', map: [{ from: null, to: null }], source: 'https://cdn/x.zip', cache: 'none',
  });
  assert.equal(plan.assets[2].type, 'amxmodx');
  assert.equal(plan.assets[2].source, 'amxmodx 1.10.5428 (linux)');
  assert.equal(plan.assets[3].type, 'release');
  assert.equal(plan.assets[3].source, 'org/pack@v3');
  assert.equal(plan.assets[3].cache, 'global');
});

test('buildPlanData: listLocal=false omits local files', () => {
  const tmp = makeTmpDir('plan-nofiles-');
  fs.mkdirSync(path.join(tmp, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'assets', 'a.txt'), 'a');
  const plan = buildPlanData(
    fakeManifest({ _path: path.join(tmp, 'amxbuild.yml') }),
    { detailedAssets: true, listLocal: false }
  );
  assert.equal(plan.assets[0].files, undefined);
});

// ─── loadEnv ─────────────────────────────────────────────────────────────────

test('loadEnv: loads .env next to the manifest into process.env', () => {
  const tmp = makeTmpDir('envtest-');
  fs.writeFileSync(path.join(tmp, '.env'), 'AMXB_TEST_VAR=hello\nAMXB_TEST_NUM=42\n');
  const prev = process.env.AMXB_TEST_VAR;
  try {
    loadEnv(path.join(tmp, 'amxbuild.yml'));
    assert.equal(process.env.AMXB_TEST_VAR, 'hello');
    assert.equal(process.env.AMXB_TEST_NUM, '42');
  } finally {
    if (prev === undefined) delete process.env.AMXB_TEST_VAR;
    else process.env.AMXB_TEST_VAR = prev;
    delete process.env.AMXB_TEST_NUM;
  }
});

// ─── single-source-of-truth locks ────────────────────────────────────────────

test('single-source: consolidated helpers are exported from their core module', () => {
  // These would fail if someone moved/duplicated the implementation into an
  // interface layer (CLI/MCP/serve) and the core stopped being the source.
  const checks = [
    [require('../src/manifest').parseDepString, 'manifest.parseDepString'],
    [require('../src/manifest').parseDepObject, 'manifest.parseDepObject'],
    [require('../src/manifest-path').resolveManifestPath, 'manifest-path.resolveManifestPath'],
    [require('../src/format').formatBytes, 'format.formatBytes'],
    [require('../src/deps-resolver').normalize, 'deps-resolver.normalize'],
    [require('../src/deps-resolver').repoKey, 'deps-resolver.repoKey'],
    [require('../src/deps-resolver').resolveDeps, 'deps-resolver.resolveDeps'],
    [require('../src/repo-fetcher').resolveRefIfLatest, 'repo-fetcher.resolveRefIfLatest'],
    [require('../src/repo-fetcher').resolveRepoRefs, 'repo-fetcher.resolveRepoRefs'],
    [require('../src/include-tree').findCaseInsensitive, 'include-tree.findCaseInsensitive'],
    [require('../src/include-tree').fetchDepIncludeDir, 'include-tree.fetchDepIncludeDir'],
    [require('../src/include-tree').collectIncFiles, 'include-tree.collectIncFiles'],
    [require('../src/include-tree').parseIncludeDirective, 'include-tree.parseIncludeDirective'],
    [require('../src/include-tree').searchIncludeFile, 'include-tree.searchIncludeFile'],
    [require('../src/compile-utils').buildIncludeArgs, 'compile-utils.buildIncludeArgs'],
    [require('../src/compile-utils').buildDefineArgs, 'compile-utils.buildDefineArgs'],
    [require('../src/compile-utils').spawnCompiler, 'compile-utils.spawnCompiler'],
    [require('../src/build-plan').buildPlanData, 'build-plan.buildPlanData'],
    [require('../src/build-service').runBuild, 'build-service.runBuild'],
    [require('../src/jsonrpc-transport').JsonRpcServer, 'jsonrpc-transport.JsonRpcServer'],
    [require('../src/events').emit, 'events.emit'],
    [require('../src/logger').raw, 'logger.raw'],
    [require('../src/logger').rawError, 'logger.rawError'],
    [require('../src/env').loadEnv, 'env.loadEnv'],
  ];
  for (const [fn, label] of checks) {
    assert.equal(typeof fn, 'function', `${label} must be exported from core`);
  }
  assert.equal(typeof require('../src/events').EVENTS.LOG, 'string', 'events.EVENTS must define event names');
});
