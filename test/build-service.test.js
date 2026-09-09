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

function writeFile(dir, rel, content = '') {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function emptyManifest(manifestDir) {
  return {
    name: 'B2Test',
    version: '1.0.0',
    platform: process.platform,
    _path: path.join(manifestDir, 'amxbuild.yml'),
    amxmodx: { dir: 'amxmodx', version: '1.10.5428', defines: [] },
    globalDeps: [],
    globalPostfix: '',
    pluginRules: [],
    repos: [],
    github: { ssh: false, token_env: 'GITHUB_TOKEN', tokens: {} },
    output: {
      dir: manifestDir,
      archive_name: '{name}.zip',
      amxmodx_path: '{name}/addons/amxmodx',
      assets_path: '{name}',
      readme: false,
      generate_ini: false,
      pack: true,
      on_conflict: 'last_wins',
    },
    assets: { sources: [], on_conflict: 'last_wins' },
    deploy: { path: null, amxmodx_path: 'addons/amxmodx', watch_debounce_ms: 500, exclude: [], rcon: { port: 27015 } },
  };
}

test('runBuild with archive:false emits EVENTS.DONE (noArchive)', async (t) => {
  const cache    = useTempCache();
  const workDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'amxb-b2-work-'));
  const buildDir = path.join(workDir, 'build');

  // Seed a cached compiler so fetchCompiler returns offline.
  writeFile(cache, `amxxpc/1.10.5428/${PLATFORM}/${BIN}`, 'mock-binary');
  if (PLATFORM !== 'windows') {
    fs.chmodSync(path.join(cache, 'amxxpc', '1.10.5428', PLATFORM, BIN), 0o755);
  }

  const manifest = emptyManifest(workDir);

  t.after(() => {
    if (ORIG_CACHE_ENV === undefined) delete process.env.AMXX_BUILDER_CACHE;
    else process.env.AMXX_BUILDER_CACHE = ORIG_CACHE_ENV;
  });

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
