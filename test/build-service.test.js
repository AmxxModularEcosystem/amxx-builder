'use strict';

/**
 * Regression test for src/build-service.js: `--no-archive` (options.archive ===
 * false) must still emit EVENTS.DONE, which is what the CLI success line and
 * the serve `build.done` notification resolve on (regression B2).
 *
 * Offline + deterministic: AMXX_BUILDER_CACHE points at a fresh temp dir with a
 * pre-seeded amxxpc binary, and the manifest is empty (no repos, no deps, no
 * local amxmodx/, no assets) — so runBuild never touches the network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { runBuild } = require('../src/build-service');
const { on, off, EVENTS } = require('../src/events');

const PLATFORM = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
const BIN      = PLATFORM === 'windows' ? 'amxxpc.exe' : 'amxxpc';

const ORIG_CACHE_ENV = process.env.AMXX_BUILDER_CACHE;

function useTempCache() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amxb-b2-'));
  process.env.AMXX_BUILDER_CACHE = dir;
  return dir;
}

function withTempCache(t) {
  const dir = useTempCache();
  t.after(() => {
    if (ORIG_CACHE_ENV === undefined) delete process.env.AMXX_BUILDER_CACHE;
    else process.env.AMXX_BUILDER_CACHE = ORIG_CACHE_ENV;
  });
  return dir;
}

function seedCompiler(cache) {
  writeFile(cache, `amxxpc/1.10.5428/${PLATFORM}/${BIN}`, 'mock-binary');
  if (PLATFORM !== 'windows') {
    fs.chmodSync(path.join(cache, 'amxxpc', '1.10.5428', PLATFORM, BIN), 0o755);
  }
}

function writeFile(dir, rel, content = '') {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function emptyManifest(manifestDir, overrides = {}) {
  return {
    name: 'B2Test',
    version: '1.0.0',
    platform: process.platform,
    _path: path.join(manifestDir, 'amxbuild.yml'),
    amxmodx: { dir: 'amxmodx', version: '1.10.5428', defines: [] },
    globalDeps: [],
    plugins: { defaults: { ini: null, debug: null }, rules: [] },
    pluginIni: { enabled: false, defaultIni: false, defaultDebug: false, forceDebug: null },
    _deprecations: [],
    repos: [],
    github: { ssh: false, token_env: 'GITHUB_TOKEN', tokens: {} },
    output: {
      dir: manifestDir,
      archive_name: '{name}.zip',
      amxmodx_path: '{name}/addons/amxmodx',
      assets_path: '{name}',
      readme: false,
      pack: true,
      on_conflict: 'last_wins',
    },
    assets: { sources: [], on_conflict: 'last_wins' },
    deploy: { path: null, amxmodx_path: 'addons/amxmodx', watch_debounce_ms: 500, exclude: [], rcon: { port: 27015 } },
    ...overrides,
  };
}

test('runBuild with archive:false emits EVENTS.DONE (noArchive)', async (t) => {
  const cache    = withTempCache(t);
  const workDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'amxb-b2-work-'));
  const buildDir = path.join(workDir, 'build');

  // Seed a cached compiler so fetchCompiler returns offline.
  seedCompiler(cache);

  const manifest = emptyManifest(workDir);

  let donePayload = null;
  const listener = (p) => { donePayload = p; };
  on(EVENTS.DONE, listener);

  try {
    const result = await runBuild(manifest, { buildDir, archive: false });
    assert.equal(result.ok, true);
    assert.equal(result.noArchive, true);
    assert.ok(donePayload, 'EVENTS.DONE must be emitted on the noArchive path');
    assert.equal(donePayload.ok, true);
    assert.equal(donePayload.noArchive, true);
    assert.equal(typeof donePayload.elapsed, 'string');
  } finally {
    off(EVENTS.DONE, listener);
  }
});

test('runBuild: INI stage runs only when manifest.pluginIni.enabled', async (t) => {
  const cache    = withTempCache(t);
  const workDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'amxb-b2-ini-'));
  const buildDir = path.join(workDir, 'build');
  seedCompiler(cache);

  const logger = require('../src/logger');
  const warnings = [];
  const origWarn = logger.warn;
  logger.warn = (msg) => warnings.push(msg);
  t.after(() => { logger.warn = origWarn; });

  async function stagesFor(pluginIni) {
    const stages = [];
    const listener = (p) => stages.push(p.stage);
    on(EVENTS.STAGE, listener);
    try {
      await runBuild(emptyManifest(workDir, { pluginIni }), { buildDir, archive: false });
    } finally {
      off(EVENTS.STAGE, listener);
    }
    return stages;
  }

  const disabled = await stagesFor({ enabled: false, defaultIni: false, defaultDebug: false });
  assert.equal(disabled.includes('ini'), false);
  assert.equal(warnings.length, 0, 'new-shape manifest must not emit deprecation warnings');

  const enabled = await stagesFor({ enabled: true, defaultIni: '', defaultDebug: false });
  assert.equal(enabled.includes('ini'), true);
});

test('runBuild: logs each manifest._deprecations entry once per process', async (t) => {
  const cache    = withTempCache(t);
  const workDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'amxb-b2-dep-'));
  const buildDir = path.join(workDir, 'build');
  seedCompiler(cache);

  const deprecation = 'DEPRECATED: output.generate_ini — use plugins.defaults.ini';

  const logger = require('../src/logger');
  const warnings = [];
  const origWarn = logger.warn;
  logger.warn = (msg) => warnings.push(msg);
  t.after(() => { logger.warn = origWarn; });

  const manifest = emptyManifest(workDir, { _deprecations: [deprecation] });

  await runBuild(manifest, { buildDir, archive: false });
  await runBuild(manifest, { buildDir, archive: false });

  assert.equal(warnings.filter((m) => m === deprecation).length, 1);
});

test('runBuild: logs the AMXB_PLUGINS_DEBUG forced-debug line once per process', async (t) => {
  const cache    = withTempCache(t);
  const workDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'amxb-b2-force-'));
  const buildDir = path.join(workDir, 'build');
  seedCompiler(cache);

  const logger = require('../src/logger');
  const dimmed = [];
  const origDim = logger.dim;
  logger.dim = (msg) => dimmed.push(msg);
  t.after(() => { logger.dim = origDim; });

  const manifest = emptyManifest(workDir, {
    pluginIni: { enabled: false, defaultIni: false, defaultDebug: false, forceDebug: true },
  });

  await runBuild(manifest, { buildDir, archive: false });
  await runBuild(manifest, { buildDir, archive: false });

  const forced = dimmed.filter((m) => /AMXB_PLUGINS_DEBUG/.test(m));
  assert.equal(forced.length, 1);
  assert.match(forced[0], /plugin debug forced on for this build/);
});
