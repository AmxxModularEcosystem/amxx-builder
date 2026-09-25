'use strict';

/**
 * Regression tests for src/collector.js collectAll (regression T6): duplicate
 * manifest repo entries (same repo listed twice, or differing only in case)
 * must not produce per-file self-conflicts or on_conflict:'error' failures —
 * the second occurrence is skipped as a duplicate.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { collectAll } = require('../src/collector');

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(base, rel, content = '') {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function repoDirs(key, dir) {
  return { [key]: dir };
}

test('collectAll skips duplicate repo entries (no self-conflict)', async () => {
  const manifestDir = makeTmpDir('amxb-col-');
  const repoDir     = makeTmpDir('amxb-col-repo-');
  const buildDir    = path.join(manifestDir, 'build');

  // Two entries for the same physical repo: exact duplicate + case variant.
  const repos = [
    { repo: 'Org/Plugin', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude_files: [] },
    { repo: 'Org/Plugin', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude_files: [] },
    { repo: 'org/plugin', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude_files: [] },
  ];
  write(repoDir, 'amxmodx/scripting/p.sma', 'main(){}');
  write(repoDir, 'amxmodx/configs/plugin.cfg', 'cfg');

  const repoLocalDirs = {
    'Org/Plugin@HEAD': repoDir,
    'org/plugin@HEAD': repoDir,
  };
  const manifest = {
    _path: path.join(manifestDir, 'amxbuild.yml'),
    repos,
    amxmodx: { dir: 'amxmodx' },
    output: { on_conflict: 'error' }, // duplicates must not trip the error mode
  };

  await collectAll(manifest, repoLocalDirs, buildDir);

  assert.ok(fs.existsSync(path.join(buildDir, 'amxmodx', 'scripting', 'p.sma')), 'file copied once');
  assert.ok(fs.existsSync(path.join(buildDir, 'amxmodx', 'configs', 'plugin.cfg')), 'config copied once');
});

test('collectAll: distinct repos with same file conflict under on_conflict:error', async () => {
  const manifestDir = makeTmpDir('amxb-col-');
  const repoA       = makeTmpDir('amxb-col-a-');
  const repoB       = makeTmpDir('amxb-col-b-');
  const buildDir    = path.join(manifestDir, 'build');

  write(repoA, 'amxmodx/configs/x.cfg', 'A');
  write(repoB, 'amxmodx/configs/x.cfg', 'B');

  const manifest = {
    _path: path.join(manifestDir, 'amxbuild.yml'),
    repos: [
      { repo: 'Org/A', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude_files: [] },
      { repo: 'Org/B', _resolvedRef: 'HEAD', amxmodx_dir: 'amxmodx', exclude_files: [] },
    ],
    amxmodx: { dir: 'amxmodx' },
    output: { on_conflict: 'error' },
  };
  const repoLocalDirs = { 'Org/A@HEAD': repoA, 'Org/B@HEAD': repoB };

  await assert.rejects(() => collectAll(manifest, repoLocalDirs, buildDir), /File conflict/);
});

test('collectAll: local amxmodx files matching exclude_files are not copied', async () => {
  const manifestDir = makeTmpDir('amxb-col-');
  const buildDir    = path.join(manifestDir, 'build');

  write(manifestDir, 'amxmodx/configs/server.cfg', 'excluded');
  write(manifestDir, 'amxmodx/configs/keep.txt', 'kept');
  write(manifestDir, 'amxmodx/lang/ru/settings.ini', 'excluded');
  write(manifestDir, 'amxmodx/scripting/p.sma', 'main(){}');

  const manifest = {
    _path: path.join(manifestDir, 'amxbuild.yml'),
    repos: [],
    amxmodx: { dir: 'amxmodx', exclude_files: ['configs/*.cfg', '**/*.ini'] },
    output: { on_conflict: 'last_wins' },
  };

  await collectAll(manifest, {}, buildDir);

  assert.ok(
    !fs.existsSync(path.join(buildDir, 'amxmodx', 'configs', 'server.cfg')),
    'root-glob excluded file must not be copied'
  );
  assert.ok(
    !fs.existsSync(path.join(buildDir, 'amxmodx', 'lang', 'ru', 'settings.ini')),
    'nested-glob excluded file must not be copied'
  );
  assert.ok(
    fs.existsSync(path.join(buildDir, 'amxmodx', 'configs', 'keep.txt')),
    'non-matching sibling must be copied'
  );
  assert.ok(
    fs.existsSync(path.join(buildDir, 'amxmodx', 'scripting', 'p.sma')),
    'exclude_files must not stop .sma from being copied'
  );
});

test('collectAll: missing amxmodx.exclude_files copies every local file (default)', async () => {
  const manifestDir = makeTmpDir('amxb-col-');
  const buildDir    = path.join(manifestDir, 'build');

  write(manifestDir, 'amxmodx/configs/server.cfg', 'cfg');
  write(manifestDir, 'amxmodx/lang/ru/settings.ini', 'ini');

  const manifest = {
    _path: path.join(manifestDir, 'amxbuild.yml'),
    repos: [],
    amxmodx: { dir: 'amxmodx' },
    output: { on_conflict: 'last_wins' },
  };

  await collectAll(manifest, {}, buildDir);

  assert.ok(
    fs.existsSync(path.join(buildDir, 'amxmodx', 'configs', 'server.cfg')),
    'cfg copied when exclude_files is absent'
  );
  assert.ok(
    fs.existsSync(path.join(buildDir, 'amxmodx', 'lang', 'ru', 'settings.ini')),
    'ini copied when exclude_files is absent'
  );
});
