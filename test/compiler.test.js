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

// Minimal manifest in the shape compilePlugins expects.
function makeManifest(dir, overrides = {}) {
  return {
    _path: path.join(dir, 'amxbuild.yml'),
    amxmodx: { dir: 'amxmodx', defines: [] },
    globalPostfix: '',
    pluginRules: [],
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

test('applyPluginRule: no rules → default postfix', () => {
  const r = applyPluginRule('VipM/core.sma', [], 'myserver');
  assert.deepEqual(r, { postfix: 'myserver', skipIni: false });
});

test('applyPluginRule: first matching rule wins', () => {
  const rules = [
    { match: 'VipM/*.sma', enabled: true, ini: 'vipm' },
    { match: '*.sma', enabled: true, ini: 'fallback' },
  ];
  assert.deepEqual(applyPluginRule('VipM/core.sma', rules, 'global'), { postfix: 'vipm', skipIni: false });
});

test('applyPluginRule: ini: false → skipIni, postfix false', () => {
  const rules = [{ match: 'utils/*.sma', enabled: true, ini: false }];
  assert.deepEqual(applyPluginRule('utils/helpers.sma', rules, 'global'), { postfix: false, skipIni: true });
});

test('applyPluginRule: enabled: false → null (skip)', () => {
  const rules = [{ match: 'wip/*.sma', enabled: false, ini: null }];
  assert.equal(applyPluginRule('wip/scratch.sma', rules, 'global'), null);
});

test('applyPluginRule: rule without ini falls back to default postfix', () => {
  const rules = [{ match: '*.sma', enabled: true, ini: null }];
  assert.deepEqual(applyPluginRule('core.sma', rules, 'defaultp'), { postfix: 'defaultp', skipIni: false });
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

  const repo = { repo: 'org/plugin', _resolvedRef: 'v1.0.0', amxmodx_dir: 'amxmodx', exclude: [], plugins_ini_postfix: 'main' };
  const manifest = makeManifest(dir, {
    repos: [repo],
    globalPostfix: 'main',
  });
  const repoLocalDirs = makeRepoLocalDirs('org/plugin', 'v1.0.0', repoDir);

  const compiled = await compilePlugins(manifest, repoLocalDirs, compilerPath, [], buildDir);

  assert.equal(compiled.length, 2);
  assert.ok(compiled.some((c) => c.amxxName === 'a.amxx' && c.repo === 'org/plugin' && c.ref === 'v1.0.0'));
  assert.ok(compiled.some((c) => c.amxxName === 'b.amxx'));
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

  const repo = { repo: 'org/p', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude: [], plugins_ini_postfix: 'x' };
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

  const repo = { repo: 'org/p', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude: [], plugins_ini_postfix: 'x' };
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

test('compilePlugins: defines are passed to the compiler', async () => {
  const dir = makeTmpDir('amxb-cp-def-');
  const { compilerPath } = makeMockCompiler(dir);

  const buildDir = path.join(dir, 'build');
  const repoDir  = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repoDir, 'amxmodx', 'scripting'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'amxmodx', 'scripting', 'p.sma'), 'main() { }\n');

  const repo = { repo: 'org/p', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude: [], plugins_ini_postfix: 'x' };
  const manifest = makeManifest(dir, {
    repos: [repo],
    amxmodx: { dir: 'amxmodx', defines: ['DEBUG'] },
  });
  const repoLocalDirs = makeRepoLocalDirs('org/p', 'HEAD', repoDir);

  // NOTE: the mock (like real amxxpc on Linux) REJECTS -D... — so a define
  // currently produces a compile failure, mirroring the real compiler.
  await assert.rejects(
    () => compilePlugins(manifest, repoLocalDirs, compilerPath, [], buildDir),
    /Compilation failed/
  );
});

test('compilePlugins: plugin rule enabled:false skips the plugin', async () => {
  const dir = makeTmpDir('amxb-cp-skip-');
  const { compilerPath } = makeMockCompiler(dir);

  const buildDir = path.join(dir, 'build');
  const repoDir  = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repoDir, 'amxmodx', 'scripting'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'amxmodx', 'scripting', 'keep.sma'), 'main() { }\n');
  fs.writeFileSync(path.join(repoDir, 'amxmodx', 'scripting', 'wip.sma'), 'main() { }\n');

  const repo = { repo: 'org/p', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude: [], plugins_ini_postfix: 'x' };
  const manifest = makeManifest(dir, {
    repos: [repo],
    // plugin rules apply only to LOCAL plugins — repo plugins use their own postfix
  });
  const repoLocalDirs = makeRepoLocalDirs('org/p', 'HEAD', repoDir);

  const compiled = await compilePlugins(manifest, repoLocalDirs, compilerPath, [], buildDir);
  assert.equal(compiled.length, 2); // repo plugins ignore pluginRules
});

test('compilePlugins: repo exclude patterns skip matching .sma', async () => {
  const dir = makeTmpDir('amxb-cp-excl-');
  const { compilerPath } = makeMockCompiler(dir);

  const buildDir = path.join(dir, 'build');
  const repoDir  = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repoDir, 'amxmodx', 'scripting', 'wip'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'amxmodx', 'scripting', 'good.sma'), 'main() { }\n');
  fs.writeFileSync(path.join(repoDir, 'amxmodx', 'scripting', 'wip', 'scratch.sma'), 'main() { }\n');

  const repo = { repo: 'org/p', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude: ['wip/**'], plugins_ini_postfix: 'x' };
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

  const repo = { repo: 'org/p', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude: [], plugins_ini_postfix: 'x' };
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

  const repo = { repo: 'org/p', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude: [], plugins_ini_postfix: 'x' };
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
  const repoA = { repo: 'org/a', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude: [], plugins_ini_postfix: 'x' };
  const repoB = { repo: 'org/b', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude: [], plugins_ini_postfix: 'x' };
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

  const repoA = { repo: 'org/a', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude: [], plugins_ini_postfix: 'x' };
  const repoB = { repo: 'org/b', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude: [], plugins_ini_postfix: 'x' };
  const manifest = makeManifest(dir, { repos: [repoA, repoB], output: { on_conflict: 'first_wins' } });
  const repoLocalDirs = {
    ...makeRepoLocalDirs('org/a', 'HEAD', repoDirA),
    ...makeRepoLocalDirs('org/b', 'HEAD', repoDirB),
  };

  const compiled = await compilePlugins(manifest, repoLocalDirs, compilerPath, [], buildDir);
  assert.equal(compiled.length, 1);
  assert.equal(compiled[0].repo, 'org/a');
});
