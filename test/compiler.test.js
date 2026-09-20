'use strict';

/**
 * Compiler tests against a FAKE amxxpc binary (fixtures/amxxpc-mock.js).
 *
 * The mock mirrors the real amxxpc CLI contract (verified against 1.10.0.5479):
 *  - accepts -o/-i/-d/-D-rejection etc. with attached values only
 *  - writes a dummy .amxx at the -o path on success, exit 0
 *  - `#error <msg>` in the source → compile error, exit 1, no .amxx
 *  - records the parsed invocation to <outPath>.args.json
 *
 * Offline + deterministic: no network, no real amxxpc, no git clones.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'amxxpc-mock.js');

// Windows: child_process.execFile cannot run .cmd/.bat files (needs shell:true,
// which src/compile-utils.js does not pass). Instead of spawning the mock as a
// binary, intercept require('./compile-utils') and wrap spawnCompiler so it
// invokes the mock through node.exe — a real child process, no shebang needed.
if (process.platform === 'win32') {
  const Module = require('module');
  const { execFile } = require('child_process');
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const loaded = origLoad.apply(this, arguments);
    if (request === './compile-utils') {
      const origSpawnCompiler = loaded.spawnCompiler;
      // Keep the missing-binary behavior (ENOENT → status 1 → null) intact:
      // only rewrite the command when the mock actually exists.
      loaded.spawnCompiler = (cmd, args, opts) =>
        fs.existsSync(cmd)
          ? origSpawnCompiler(process.execPath, [FIXTURE, ...args], opts)
          : origSpawnCompiler(cmd, args, opts);
    }
    return loaded;
  };
}

const { compilePlugins, compileSingle, applyPluginRule } = require('../src/compiler');
const { on, off, EVENTS } = require('../src/events');

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Copies the mock into a fresh temp dir and makes it executable.
// On Windows the file only needs to exist: the win32 spawnCompiler wrapper
// above redirects the invocation through node.exe + FIXTURE regardless.
// Returns { dir, compilerPath }.
function makeMockCompiler(dir) {
  const mockDir = path.join(dir, 'mock');
  fs.mkdirSync(mockDir, { recursive: true });
  const compilerPath = path.join(mockDir, 'amxxpc');
  fs.copyFileSync(FIXTURE, compilerPath);
  if (process.platform !== 'win32') fs.chmodSync(compilerPath, 0o755);
  return { compilerPath };
}

// Minimal manifest in the shape compilePlugins expects (resolved manifest).
function makeManifest(dir, overrides = {}) {
  return {
    _path: path.join(dir, 'amxbuild.yml'),
    amxmodx: { dir: 'amxmodx', defines: [] },
    plugins: { defaults: { ini: null, debug: null }, rules: [] },
    pluginIni: { enabled: false, defaultIni: false, defaultDebug: false },
    output: { on_conflict: 'last_wins' },
    repos: [],
    ...overrides,
  };
}

// Builds repoLocalDirs in the shape build-service produces (repoKey → dir).
function makeRepoLocalDirs(repo, ref, repoDir) {
  return { [`${repo}@${ref}`]: repoDir };
}

// ─── applyPluginRule (pure logic, no compiler needed) ────────────────────────

test('applyPluginRule: no rules → base ini and debug', () => {
  const r = applyPluginRule('VipM/core.sma', [], { ini: 'myserver', debug: true });
  assert.deepEqual(r, { postfix: 'myserver', skipIni: false, debug: true });
});

test('applyPluginRule: first matching rule wins', () => {
  const rules = [
    { match: 'VipM/*.sma', enabled: true, ini: 'vipm', debug: true },
    { match: '*.sma', enabled: true, ini: 'fallback', debug: null },
  ];
  assert.deepEqual(
    applyPluginRule('VipM/core.sma', rules, { ini: 'global', debug: false }),
    { postfix: 'vipm', skipIni: false, debug: true }
  );
});

test('applyPluginRule: ini: false → skipIni, empty postfix, inherited debug', () => {
  const rules = [{ match: 'utils/*.sma', enabled: true, ini: false, debug: null }];
  assert.deepEqual(
    applyPluginRule('utils/helpers.sma', rules, { ini: 'global', debug: true }),
    { postfix: '', skipIni: true, debug: true }
  );
});

test('applyPluginRule: enabled: false → null (skip)', () => {
  const rules = [{ match: 'wip/*.sma', enabled: false, ini: null, debug: null }];
  assert.equal(applyPluginRule('wip/scratch.sma', rules, { ini: 'global', debug: false }), null);
});

test('applyPluginRule: rule without ini/debug falls back to base', () => {
  const rules = [{ match: '*.sma', enabled: true, ini: null, debug: null }];
  assert.deepEqual(
    applyPluginRule('core.sma', rules, { ini: 'defaultp', debug: true }),
    { postfix: 'defaultp', skipIni: false, debug: true }
  );
});

test('applyPluginRule: rule debug:false overrides base debug:true', () => {
  const rules = [{ match: '*.sma', enabled: true, ini: 'x', debug: false }];
  assert.deepEqual(
    applyPluginRule('core.sma', rules, { ini: 'base', debug: true }),
    { postfix: 'x', skipIni: false, debug: false }
  );
});

test('applyPluginRule: base ini:false excludes an unmatched plugin', () => {
  const r = applyPluginRule('a.sma', [], { ini: false, debug: false });
  assert.deepEqual(r, { postfix: '', skipIni: true, debug: false });
});

test('applyPluginRule: matched rule ini overrides base ini:false', () => {
  const rules = [{ match: 'vip/*.sma', enabled: true, ini: 'vip', debug: null }];
  assert.deepEqual(
    applyPluginRule('vip/core.sma', rules, { ini: false, debug: false }),
    { postfix: 'vip', skipIni: false, debug: false }
  );
});

// ─── compileSingle (watch-mode single-file compile) ──────────────────────────

test('compileSingle: success writes .amxx and returns outName', async () => {
  const dir = makeTmpDir('amxb-cs-');
  const { compilerPath } = makeMockCompiler(dir);

  const buildDir   = path.join(dir, 'build');
  const scripting  = path.join(dir, 'scripting');
  fs.mkdirSync(scripting, { recursive: true });
  const sma = path.join(scripting, 'hello.sma');
  fs.writeFileSync(sma, '#include <amxmodx>\n');

  const manifest = makeManifest(dir);
  const outName = await compileSingle(manifest, sma, compilerPath, [], buildDir, scripting);

  assert.equal(outName, 'hello.amxx');
  assert.ok(fs.existsSync(path.join(buildDir, 'amxmodx', 'plugins', 'hello.amxx')));
});

test('compileSingle: subdirectory sma preserves relative path in outName', async () => {
  const dir = makeTmpDir('amxb-cs-sub-');
  const { compilerPath } = makeMockCompiler(dir);

  const buildDir  = path.join(dir, 'build');
  const scripting = path.join(dir, 'scripting');
  fs.mkdirSync(path.join(scripting, 'sub'), { recursive: true });
  const sma = path.join(scripting, 'sub', 'nested.sma');
  fs.writeFileSync(sma, 'main() { }\n');

  const manifest = makeManifest(dir);
  const outName = await compileSingle(manifest, sma, compilerPath, [], buildDir, scripting);

  assert.equal(outName, 'sub/nested.amxx');
  assert.ok(fs.existsSync(path.join(buildDir, 'amxmodx', 'plugins', 'sub', 'nested.amxx')));
});

test('compileSingle: compiler error (#error in source) → null, no .amxx', async () => {
  const dir = makeTmpDir('amxb-cs-err-');
  const { compilerPath } = makeMockCompiler(dir);

  const buildDir  = path.join(dir, 'build');
  const scripting = path.join(dir, 'scripting');
  fs.mkdirSync(scripting, { recursive: true });
  const sma = path.join(scripting, 'bad.sma');
  fs.writeFileSync(sma, '#error this plugin is broken\n');

  const manifest = makeManifest(dir);
  const outName = await compileSingle(manifest, sma, compilerPath, [], buildDir, scripting);

  assert.equal(outName, null);
  assert.ok(!fs.existsSync(path.join(buildDir, 'amxmodx', 'plugins', 'bad.amxx')));
});

test('compileSingle: missing compiler binary → null', async () => {
  const dir = makeTmpDir('amxb-cs-miss-');
  const buildDir  = path.join(dir, 'build');
  const scripting = path.join(dir, 'scripting');
  fs.mkdirSync(scripting, { recursive: true });
  const sma = path.join(scripting, 'x.sma');
  fs.writeFileSync(sma, 'main() { }\n');

  const manifest = makeManifest(dir);
  const outName = await compileSingle(manifest, sma, path.join(dir, 'nope-amxxpc'), [], buildDir, scripting);
  assert.equal(outName, null);
});

// ─── compilePlugins (full build) ─────────────────────────────────────────────

test('compilePlugins: compiles all .sma from a repo scripting dir', async () => {
  const dir = makeTmpDir('amxb-cp-');
  const { compilerPath } = makeMockCompiler(dir);

  const buildDir = path.join(dir, 'build');
  const repoDir  = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repoDir, 'amxmodx', 'scripting'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'amxmodx', 'scripting', 'a.sma'), 'main() { }\n');
  fs.writeFileSync(path.join(repoDir, 'amxmodx', 'scripting', 'b.sma'), 'main() { }\n');

  const repo = { repo: 'org/plugin', _resolvedRef: 'v1.0.0', amxmodx_dir: 'amxmodx', exclude: [], _pluginSettings: { ini: 'main', debug: null } };
  const manifest = makeManifest(dir, { repos: [repo] });
  const repoLocalDirs = makeRepoLocalDirs('org/plugin', 'v1.0.0', repoDir);

  const compiled = await compilePlugins(manifest, repoLocalDirs, compilerPath, [], buildDir);

  assert.equal(compiled.length, 2);
  assert.ok(compiled.some((c) => c.amxxName === 'a.amxx' && c.repo === 'org/plugin' && c.ref === 'v1.0.0'));
  assert.ok(compiled.some((c) => c.amxxName === 'b.amxx'));
  for (const c of compiled) {
    assert.equal(c.plugins_ini_postfix, 'main');
    assert.equal(c.skipIni, false);
    assert.equal(c.debug, false);
  }
  assert.ok(fs.existsSync(path.join(buildDir, 'amxmodx', 'plugins', 'a.amxx')));
  assert.ok(fs.existsSync(path.join(buildDir, 'amxmodx', 'plugins', 'b.amxx')));
});

test('compilePlugins: subdirectory .sma preserved in plugins/ subdir', async () => {
  const dir = makeTmpDir('amxb-cp-sub-');
  const { compilerPath } = makeMockCompiler(dir);

  const buildDir = path.join(dir, 'build');
  const repoDir  = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repoDir, 'amxmodx', 'scripting', 'SubDir'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'amxmodx', 'scripting', 'SubDir', 'deep.sma'), 'main() { }\n');

  const repo = { repo: 'org/p', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude: [], _pluginSettings: { ini: 'x', debug: null } };
  const manifest = makeManifest(dir, { repos: [repo] });
  const repoLocalDirs = makeRepoLocalDirs('org/p', 'HEAD', repoDir);

  const compiled = await compilePlugins(manifest, repoLocalDirs, compilerPath, [], buildDir);
  assert.equal(compiled[0].amxxName, 'SubDir/deep.amxx');
  assert.ok(fs.existsSync(path.join(buildDir, 'amxmodx', 'plugins', 'SubDir', 'deep.amxx')));
});

test('compilePlugins: local scripting dir (no repos) compiles too', async () => {
  const dir = makeTmpDir('amxb-cp-local-');
  const { compilerPath } = makeMockCompiler(dir);

  const buildDir = path.join(dir, 'build');
  const localDir = path.join(dir, 'local');
  fs.mkdirSync(path.join(localDir, 'amxmodx', 'scripting'), { recursive: true });
  fs.writeFileSync(path.join(localDir, 'amxmodx', 'scripting', 'local.sma'), 'main() { }\n');

  const manifest = makeManifest(localDir); // manifest _path lives in localDir
  const compiled = await compilePlugins(manifest, {}, compilerPath, [], buildDir);

  assert.equal(compiled.length, 1);
  assert.equal(compiled[0].repo, '(local)');
  assert.equal(compiled[0].amxxName, 'local.amxx');
});

test('compilePlugins: repo script is passed -o with abs path and -i include dirs', async () => {
  const dir = makeTmpDir('amxb-cp-args-');
  const { compilerPath } = makeMockCompiler(dir);

  const buildDir = path.join(dir, 'build');
  const repoDir  = path.join(dir, 'repo');
  const scriptingDir = path.join(repoDir, 'amxmodx', 'scripting');
  fs.mkdirSync(path.join(scriptingDir, 'include'), { recursive: true });
  fs.writeFileSync(path.join(scriptingDir, 'include', 'my.inc'), '');
  fs.writeFileSync(path.join(scriptingDir, 'plugin.sma'), 'main() { }\n');
  // collectedIncDir is only added to -i when it exists (collector creates it
  // during a real build) — simulate it for the argument-order assertion.
  fs.mkdirSync(path.join(buildDir, 'amxmodx', 'scripting', 'include'), { recursive: true });

  const repo = { repo: 'org/p', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude: [], _pluginSettings: { ini: 'x', debug: null } };
  const manifest = makeManifest(dir, { repos: [repo] });
  const repoLocalDirs = makeRepoLocalDirs('org/p', 'HEAD', repoDir);
  const extraInclude = path.join(dir, 'extra-inc');

  await compilePlugins(manifest, repoLocalDirs, compilerPath, [extraInclude], buildDir);

  const recorded = JSON.parse(fs.readFileSync(path.join(buildDir, 'amxmodx', 'plugins', 'plugin.amxx.args.json'), 'utf8'));
  assert.equal(recorded.source, path.join(scriptingDir, 'plugin.sma'));
  assert.equal(recorded.outPath, path.join(buildDir, 'amxmodx', 'plugins', 'plugin.amxx'));
  // -i order: scriptingDir, local include/, collected include/, extra includeDirs
  assert.deepEqual(recorded.includes, [
    scriptingDir,
    path.join(scriptingDir, 'include'),
    path.join(buildDir, 'amxmodx', 'scripting', 'include'),
    extraInclude,
  ]);
});

test('compilePlugins: value-less defines are normalized to NAME=1 and passed to the compiler', async () => {
  const dir = makeTmpDir('amxb-cp-def-');
  const { compilerPath } = makeMockCompiler(dir);

  const buildDir = path.join(dir, 'build');
  const repoDir  = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repoDir, 'amxmodx', 'scripting'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'amxmodx', 'scripting', 'p.sma'), 'main() { }\n');

  const repo = { repo: 'org/p', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude: [], _pluginSettings: { ini: 'x', debug: null } };
  const manifest = makeManifest(dir, {
    repos: [repo],
    amxmodx: { dir: 'amxmodx', defines: ['DEBUG', 'VERSION=2'] },
  });
  const repoLocalDirs = makeRepoLocalDirs('org/p', 'HEAD', repoDir);

  const compiled = await compilePlugins(manifest, repoLocalDirs, compilerPath, [], buildDir);
  assert.equal(compiled.length, 1);

  // The mock records the parsed invocation; value-less defines must arrive as
  // NAME=1 (amxxpc has no -DNAME syntax — see buildDefineArgs).
  const argsJson = JSON.parse(
    fs.readFileSync(path.join(buildDir, 'amxmodx', 'plugins', 'p.amxx.args.json'), 'utf8')
  );
  assert.deepEqual(argsJson.defines, ['DEBUG=1', 'VERSION=2']);
});

test('compilePlugins: repo plugins ignore plugins.rules (rules are local-only)', async () => {
  const dir = makeTmpDir('amxb-cp-skip-');
  const { compilerPath } = makeMockCompiler(dir);

  const buildDir = path.join(dir, 'build');
  const repoDir  = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repoDir, 'amxmodx', 'scripting'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'amxmodx', 'scripting', 'keep.sma'), 'main() { }\n');
  fs.writeFileSync(path.join(repoDir, 'amxmodx', 'scripting', 'wip.sma'), 'main() { }\n');

  const repo = { repo: 'org/p', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude: [], _pluginSettings: { ini: 'x', debug: null } };
  const manifest = makeManifest(dir, {
    repos: [repo],
    // A rule that would skip wip.sma if it applied to repo plugins.
    plugins: {
      defaults: { ini: null, debug: null },
      rules: [{ match: 'wip.sma', enabled: false, ini: null, debug: null }],
    },
  });
  const repoLocalDirs = makeRepoLocalDirs('org/p', 'HEAD', repoDir);

  const compiled = await compilePlugins(manifest, repoLocalDirs, compilerPath, [], buildDir);
  assert.equal(compiled.length, 2);
});

test('compilePlugins: repo ini:false compiles the plugin but skips the INI', async () => {
  const dir = makeTmpDir('amxb-cp-reposkip-');
  const { compilerPath } = makeMockCompiler(dir);

  const buildDir = path.join(dir, 'build');
  const repoDir  = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repoDir, 'amxmodx', 'scripting'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'amxmodx', 'scripting', 'hidden.sma'), 'main() { }\n');

  const repo = { repo: 'org/p', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude: [], _pluginSettings: { ini: false, debug: null } };
  const manifest = makeManifest(dir, {
    repos: [repo],
    pluginIni: { enabled: true, defaultIni: '', defaultDebug: false },
  });
  const repoLocalDirs = makeRepoLocalDirs('org/p', 'HEAD', repoDir);

  const compiled = await compilePlugins(manifest, repoLocalDirs, compilerPath, [], buildDir);
  assert.equal(compiled.length, 1);
  assert.equal(compiled[0].plugins_ini_postfix, '');
  assert.equal(compiled[0].skipIni, true);
  assert.equal(compiled[0].debug, false);
});

test('compilePlugins: defaults.ini:false + repo ini set → repo compiles into its own INI', async () => {
  const dir = makeTmpDir('amxb-cp-repoini-');
  const { compilerPath } = makeMockCompiler(dir);

  const buildDir = path.join(dir, 'build');
  const repoDir  = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repoDir, 'amxmodx', 'scripting'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'amxmodx', 'scripting', 'vip.sma'), 'main() { }\n');

  const repo = { repo: 'org/p', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude: [], _pluginSettings: { ini: 'vip', debug: null } };
  const manifest = makeManifest(dir, {
    repos: [repo],
    pluginIni: { enabled: true, defaultIni: false, defaultDebug: false },
  });
  const repoLocalDirs = makeRepoLocalDirs('org/p', 'HEAD', repoDir);

  const compiled = await compilePlugins(manifest, repoLocalDirs, compilerPath, [], buildDir);
  assert.equal(compiled.length, 1);
  assert.equal(compiled[0].plugins_ini_postfix, 'vip');
  assert.equal(compiled[0].skipIni, false);
});

test('compilePlugins: defaults.ini:false excludes an unmatched local plugin', async () => {
  const dir = makeTmpDir('amxb-cp-localexcl-');
  const { compilerPath } = makeMockCompiler(dir);

  const buildDir = path.join(dir, 'build');
  const localDir = path.join(dir, 'local');
  fs.mkdirSync(path.join(localDir, 'amxmodx', 'scripting'), { recursive: true });
  fs.writeFileSync(path.join(localDir, 'amxmodx', 'scripting', 'base.sma'), 'main() { }\n');

  const manifest = makeManifest(localDir, {
    pluginIni: { enabled: true, defaultIni: false, defaultDebug: false },
  });

  const compiled = await compilePlugins(manifest, {}, compilerPath, [], buildDir);
  assert.equal(compiled.length, 1);
  assert.equal(compiled[0].plugins_ini_postfix, '');
  assert.equal(compiled[0].skipIni, true);
  assert.equal(compiled[0].debug, false);
});

test('compilePlugins: repo _pluginSettings debug overrides pluginIni.defaultDebug', async () => {
  const dir = makeTmpDir('amxb-cp-repodebug-');
  const { compilerPath } = makeMockCompiler(dir);

  const buildDir = path.join(dir, 'build');
  const repoDir  = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repoDir, 'amxmodx', 'scripting'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'amxmodx', 'scripting', 'debugme.sma'), 'main() { }\n');

  const repo = { repo: 'org/p', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude: [], _pluginSettings: { ini: 'vip', debug: true } };
  const manifest = makeManifest(dir, {
    repos: [repo],
    pluginIni: { enabled: true, defaultIni: '', defaultDebug: false },
  });
  const repoLocalDirs = makeRepoLocalDirs('org/p', 'HEAD', repoDir);

  const compiled = await compilePlugins(manifest, repoLocalDirs, compilerPath, [], buildDir);
  assert.equal(compiled.length, 1);
  assert.equal(compiled[0].plugins_ini_postfix, 'vip');
  assert.equal(compiled[0].debug, true);
});

test('compilePlugins: local rules set postfix/skipIni/debug over pluginIni defaults', async () => {
  const dir = makeTmpDir('amxb-cp-rules-');
  const { compilerPath } = makeMockCompiler(dir);

  const buildDir = path.join(dir, 'build');
  const localDir = path.join(dir, 'local');
  const scriptingDir = path.join(localDir, 'amxmodx', 'scripting');
  fs.mkdirSync(path.join(scriptingDir, 'vip'), { recursive: true });
  fs.mkdirSync(path.join(scriptingDir, 'utils'), { recursive: true });
  fs.writeFileSync(path.join(scriptingDir, 'base.sma'), 'main() { }\n');
  fs.writeFileSync(path.join(scriptingDir, 'vip', 'core.sma'), 'main() { }\n');
  fs.writeFileSync(path.join(scriptingDir, 'utils', 'helpers.sma'), 'main() { }\n');

  const manifest = makeManifest(localDir, {
    pluginIni: { enabled: true, defaultIni: '', defaultDebug: true },
    plugins: {
      defaults: { ini: null, debug: null },
      rules: [
        { match: 'vip/core.sma', enabled: true, ini: 'vipm', debug: false },
        { match: 'utils/*.sma', enabled: true, ini: false, debug: null },
      ],
    },
  });

  const compiled = await compilePlugins(manifest, {}, compilerPath, [], buildDir);
  const byName = Object.fromEntries(compiled.map((c) => [c.amxxName, c]));

  assert.deepEqual(
    [byName['base.amxx'].plugins_ini_postfix, byName['base.amxx'].skipIni, byName['base.amxx'].debug],
    ['', false, true]
  );
  assert.deepEqual(
    [byName['vip/core.amxx'].plugins_ini_postfix, byName['vip/core.amxx'].skipIni, byName['vip/core.amxx'].debug],
    ['vipm', false, false]
  );
  assert.deepEqual(
    [byName['utils/helpers.amxx'].plugins_ini_postfix, byName['utils/helpers.amxx'].skipIni, byName['utils/helpers.amxx'].debug],
    ['', true, true]
  );
});

test('compilePlugins: local rule enabled:false skips the plugin', async () => {
  const dir = makeTmpDir('amxb-cp-lskip-');
  const { compilerPath } = makeMockCompiler(dir);

  const buildDir = path.join(dir, 'build');
  const localDir = path.join(dir, 'local');
  const scriptingDir = path.join(localDir, 'amxmodx', 'scripting');
  fs.mkdirSync(scriptingDir, { recursive: true });
  fs.writeFileSync(path.join(scriptingDir, 'keep.sma'), 'main() { }\n');
  fs.writeFileSync(path.join(scriptingDir, 'wip.sma'), 'main() { }\n');

  const manifest = makeManifest(localDir, {
    plugins: {
      defaults: { ini: null, debug: null },
      rules: [{ match: 'wip.sma', enabled: false, ini: null, debug: null }],
    },
  });

  const compiled = await compilePlugins(manifest, {}, compilerPath, [], buildDir);
  assert.equal(compiled.length, 1);
  assert.equal(compiled[0].amxxName, 'keep.amxx');
});

test('compilePlugins: repo exclude patterns skip matching .sma', async () => {
  const dir = makeTmpDir('amxb-cp-excl-');
  const { compilerPath } = makeMockCompiler(dir);

  const buildDir = path.join(dir, 'build');
  const repoDir  = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repoDir, 'amxmodx', 'scripting', 'wip'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'amxmodx', 'scripting', 'good.sma'), 'main() { }\n');
  fs.writeFileSync(path.join(repoDir, 'amxmodx', 'scripting', 'wip', 'scratch.sma'), 'main() { }\n');

  const repo = { repo: 'org/p', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude: ['wip/**'], _pluginSettings: { ini: 'x', debug: null } };
  const manifest = makeManifest(dir, { repos: [repo] });
  const repoLocalDirs = makeRepoLocalDirs('org/p', 'HEAD', repoDir);

  const compiled = await compilePlugins(manifest, repoLocalDirs, compilerPath, [], buildDir);
  assert.equal(compiled.length, 1);
  assert.equal(compiled[0].amxxName, 'good.amxx');
});

test('compilePlugins: compile error → throws with failed count and names', async () => {
  const dir = makeTmpDir('amxb-cp-err-');
  const { compilerPath } = makeMockCompiler(dir);

  const buildDir = path.join(dir, 'build');
  const repoDir  = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repoDir, 'amxmodx', 'scripting'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'amxmodx', 'scripting', 'ok.sma'), 'main() { }\n');
  fs.writeFileSync(path.join(repoDir, 'amxmodx', 'scripting', 'broken.sma'), '#error nope\n');

  const repo = { repo: 'org/p', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude: [], _pluginSettings: { ini: 'x', debug: null } };
  const manifest = makeManifest(dir, { repos: [repo] });
  const repoLocalDirs = makeRepoLocalDirs('org/p', 'HEAD', repoDir);

  await assert.rejects(
    () => compilePlugins(manifest, repoLocalDirs, compilerPath, [], buildDir),
    (err) => {
      assert.match(err.message, /Compilation failed \(1\/2\): broken\.sma/);
      return true;
    }
  );
});

test('compilePlugins: emits COMPILED ok:true and ok:false events', async () => {
  const dir = makeTmpDir('amxb-cp-ev-');
  const { compilerPath } = makeMockCompiler(dir);

  const buildDir = path.join(dir, 'build');
  const repoDir  = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repoDir, 'amxmodx', 'scripting'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'amxmodx', 'scripting', 'good.sma'), 'main() { }\n');
  fs.writeFileSync(path.join(repoDir, 'amxmodx', 'scripting', 'bad.sma'), '#error boom\n');

  const repo = { repo: 'org/p', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude: [], _pluginSettings: { ini: 'x', debug: null } };
  const manifest = makeManifest(dir, { repos: [repo] });
  const repoLocalDirs = makeRepoLocalDirs('org/p', 'HEAD', repoDir);

  const events = [];
  const handler = (e) => events.push(e);
  on(EVENTS.COMPILED, handler);
  try {
    await compilePlugins(manifest, repoLocalDirs, compilerPath, [], buildDir).catch(() => {});
  } finally {
    off(EVENTS.COMPILED, handler);
  }

  assert.equal(events.length, 2);
  assert.equal(events.find((e) => e.baseName === 'good.sma').ok, true);
  assert.equal(events.find((e) => e.baseName === 'bad.sma').ok, false);
});

test('compilePlugins: on_conflict=error throws on duplicate output names', async () => {
  const dir = makeTmpDir('amxb-cp-conf-');
  const { compilerPath } = makeMockCompiler(dir);

  const buildDir = path.join(dir, 'build');
  const repoDir  = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repoDir, 'amxmodx', 'scripting'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'amxmodx', 'scripting', 'same.sma'), 'main() { }\n');

  // Two repos both providing same.sma → conflict
  const repoA = { repo: 'org/a', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude: [], _pluginSettings: { ini: 'x', debug: null } };
  const repoB = { repo: 'org/b', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude: [], _pluginSettings: { ini: 'x', debug: null } };
  const manifest = makeManifest(dir, { repos: [repoA, repoB], output: { on_conflict: 'error' } });
  const repoLocalDirs = {
    ...makeRepoLocalDirs('org/a', 'HEAD', repoDir),
    ...makeRepoLocalDirs('org/b', 'HEAD', repoDir),
  };

  await assert.rejects(
    () => compilePlugins(manifest, repoLocalDirs, compilerPath, [], buildDir),
    /Plugin output conflict: "same\.amxx"/
  );
});

test('compilePlugins: on_conflict=first_wins keeps the first plugin', async () => {
  const dir = makeTmpDir('amxb-cp-fw-');
  const { compilerPath } = makeMockCompiler(dir);

  const buildDir = path.join(dir, 'build');
  const repoDirA = path.join(dir, 'repoA');
  const repoDirB = path.join(dir, 'repoB');
  for (const d of [repoDirA, repoDirB]) {
    fs.mkdirSync(path.join(d, 'amxmodx', 'scripting'), { recursive: true });
    fs.writeFileSync(path.join(d, 'amxmodx', 'scripting', 'same.sma'), 'main() { }\n');
  }

  const repoA = { repo: 'org/a', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude: [], _pluginSettings: { ini: 'x', debug: null } };
  const repoB = { repo: 'org/b', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude: [], _pluginSettings: { ini: 'x', debug: null } };
  const manifest = makeManifest(dir, { repos: [repoA, repoB], output: { on_conflict: 'first_wins' } });
  const repoLocalDirs = {
    ...makeRepoLocalDirs('org/a', 'HEAD', repoDirA),
    ...makeRepoLocalDirs('org/b', 'HEAD', repoDirB),
  };

  const compiled = await compilePlugins(manifest, repoLocalDirs, compilerPath, [], buildDir);
  assert.equal(compiled.length, 1);
  assert.equal(compiled[0].repo, 'org/a');
});
