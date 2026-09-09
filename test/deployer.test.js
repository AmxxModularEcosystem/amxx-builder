'use strict';

/**
 * Regression test for src/deployer.js deployFile (regression B3): in watch mode
 * the edited file lives in the project tree (manifestDir/amxmodx or
 * manifestDir/assets), while build/ only mirrors it on full rebuilds — so
 * deployFile must deploy the *project* file when a srcRoot is given, and fall
 * back to the build copy otherwise (serve deploy.file semantics).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { deployFile } = require('../src/deployer');

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function manifestFor(deployPath, dir) {
  return {
    name: 'Srv',
    version: '1.0.0',
    _path: path.join(dir, 'amxbuild.yml'),
    amxmodx: { dir: 'amxmodx' },
    output: { assets_path: null },
    deploy: { path: deployPath, amxmodx_path: 'addons/amxmodx', assets_path: null, exclude: [] },
  };
}

test('deployFile with srcRoot deploys the fresh project file, not the stale build copy', () => {
  const dir       = makeTmpDir('amxb-dep-');
  const deployRoot = makeTmpDir('amxb-dep-server-');
  const manifest  = manifestFor(deployRoot, dir);

  const projectDir = path.join(dir, 'amxmodx');
  const buildDir   = path.join(dir, 'build');
  write(projectDir, 'configs/server.cfg', 'FRESH CONTENT');
  write(buildDir,   'amxmodx/configs/server.cfg', 'STALE BUILD COPY');

  const dest = deployFile(manifest, buildDir, 'configs/server.cfg', 'amxmodx', projectDir);
  assert.ok(dest, 'file must be deployed');
  const deployed = fs.readFileSync(path.join(deployRoot, 'addons/amxmodx', 'configs/server.cfg'), 'utf8');
  assert.equal(deployed, 'FRESH CONTENT', 'project content wins over the stale build snapshot');
});

test('deployFile with srcRoot deploys a file that only exists in the project tree', () => {
  const dir       = makeTmpDir('amxb-dep-');
  const deployRoot = makeTmpDir('amxb-dep-server-');
  const manifest  = manifestFor(deployRoot, dir);

  const projectDir = path.join(dir, 'amxmodx');
  const buildDir   = path.join(dir, 'build');
  write(projectDir, 'configs/new.cfg', 'NEW FILE');

  const dest = deployFile(manifest, buildDir, 'configs/new.cfg', 'amxmodx', projectDir);
  assert.ok(dest, 'new file is deployed despite missing from build/');
  assert.ok(fs.existsSync(path.join(deployRoot, 'addons/amxmodx', 'configs/new.cfg')));
});

test('deployFile without srcRoot falls back to the build copy (serve deploy.file semantics)', () => {
  const dir       = makeTmpDir('amxb-dep-');
  const deployRoot = makeTmpDir('amxb-dep-server-');
  const manifest  = manifestFor(deployRoot, dir);

  const buildDir = path.join(dir, 'build');
  write(buildDir, 'amxmodx/configs/from-build.cfg', 'BUILD CONTENT');

  const dest = deployFile(manifest, buildDir, 'configs/from-build.cfg', 'amxmodx');
  assert.ok(dest, 'build-only file is deployed when no srcRoot given');
  assert.equal(
    fs.readFileSync(path.join(deployRoot, 'addons/amxmodx', 'configs/from-build.cfg'), 'utf8'),
    'BUILD CONTENT'
  );
});

function write(base, rel, content) {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

test('deployFile rejects amxmodx_path/assets_path escaping the deploy root', () => {
  const dir       = makeTmpDir('amxb-dep-');
  const deployRoot = makeTmpDir('amxb-dep-server-');
  const buildDir  = path.join(dir, 'build');
  write(buildDir, 'amxmodx/configs/x.cfg', 'x');

  const evil = manifestFor(deployRoot, dir);
  evil.deploy.amxmodx_path = '../outside';
  assert.throws(() => deployFile(evil, buildDir, 'configs/x.cfg', 'amxmodx'), /outside the deploy path/);

  const abs = manifestFor(deployRoot, dir);
  abs.deploy.amxmodx_path = path.join(os.tmpdir(), 'elsewhere');
  assert.throws(() => deployFile(abs, buildDir, 'configs/x.cfg', 'amxmodx'), /outside the deploy path/);

  const assetEvil = manifestFor(deployRoot, dir);
  assetEvil.deploy.assets_path = '../../escape';
  assert.throws(() => deployFile(assetEvil, buildDir, 'm/x.mdl', 'assets'), /outside the deploy path/);
});
