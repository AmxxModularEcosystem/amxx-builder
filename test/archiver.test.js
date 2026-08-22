'use strict';

/**
 * Tests for the output packaging logic: copyOutput (deterministic FS copy,
 * used when output.pack = false) and createArchive (real .zip via `archiver`).
 *
 * Offline + deterministic: no network, no amxxpc, no git clones. Progress
 * bars are disabled via src/progress setEnabled() so test output stays clean.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { createArchive, copyOutput } = require('../src/archiver');
const { setEnabled } = require('../src/progress');

// Progress bars write \r/control chars to stdout — keep test output clean.
setEnabled(false);

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Recursively write a flat map of relpath → content under root.
function writeTree(root, tree) {
  for (const [rel, content] of Object.entries(tree)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

function makeManifest(opts) {
  return {
    name: opts.name || 'TestServer',
    version: opts.version || '1.0.0',
    _path: opts.manifestPath,
    output: {
      dir: opts.outDir,
      archive_name: opts.archiveName !== undefined ? opts.archiveName : 'test.zip',
      amxmodx_path: opts.amxmodxPath !== undefined ? opts.amxmodxPath : 'addons/amxmodx',
      assets_path: opts.assetsPath !== undefined ? opts.assetsPath : '',
      readme: opts.readme === true,
    },
  };
}

// ─── copyOutput ──────────────────────────────────────────────────────────────

test('copyOutput: copies amxmodx/ and assets/ trees with {name}/{version} expansion', (t) => {
  const tmp = makeTmpDir('amxb-copy-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const buildDir = path.join(tmp, 'build');
  writeTree(buildDir, {
    'amxmodx/configs/server.cfg': 'hostname "Test"',
    'amxmodx/plugins/plugin.amxx': 'BIN',
    'amxmodx/lang/en.txt': 'hello',
    'assets/models/weapon.mdl': 'MDL',
    'assets/sound/weapon.wav': 'WAV',
  });

  const manifestPath = path.join(tmp, 'amxbuild.yml');
  fs.writeFileSync(manifestPath, '');
  const outDir = path.join(tmp, 'out');

  const manifest = makeManifest({
    manifestPath,
    outDir,
    amxmodxPath: 'addons/amxmodx',
    assetsPath: '{name}',
  });

  copyOutput(manifest, buildDir);

  // amxmodx → outDir/addons/amxmodx/**
  assert.ok(fs.existsSync(path.join(outDir, 'addons/amxmodx/configs/server.cfg')));
  assert.ok(fs.existsSync(path.join(outDir, 'addons/amxmodx/plugins/plugin.amxx')));
  assert.equal(fs.readFileSync(path.join(outDir, 'addons/amxmodx/lang/en.txt'), 'utf8'), 'hello');
  // assets → outDir/{name}/**
  assert.ok(fs.existsSync(path.join(outDir, 'TestServer/models/weapon.mdl')));
  assert.equal(fs.readFileSync(path.join(outDir, 'TestServer/sound/weapon.wav'), 'utf8'), 'WAV');
  // nothing leaked to outDir root
  assert.ok(!fs.existsSync(path.join(outDir, 'configs')));
  assert.ok(!fs.existsSync(path.join(outDir, 'models')));
});

test('copyOutput: empty assets_path puts assets at outDir root; {version} expands', (t) => {
  const tmp = makeTmpDir('amxb-copy-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const buildDir = path.join(tmp, 'build');
  writeTree(buildDir, {
    'amxmodx/plugins/plugin.amxx': 'BIN',
    'assets/logo.png': 'PNG',
  });

  const manifestPath = path.join(tmp, 'amxbuild.yml');
  fs.writeFileSync(manifestPath, '');
  const outDir = path.join(tmp, 'out');

  const manifest = makeManifest({
    manifestPath,
    outDir,
    amxmodxPath: 'addons/{version}/amxmodx',
    assetsPath: '',
  });

  copyOutput(manifest, buildDir);

  assert.ok(fs.existsSync(path.join(outDir, 'addons/1.0.0/amxmodx/plugins/plugin.amxx')));
  assert.equal(fs.readFileSync(path.join(outDir, 'logo.png'), 'utf8'), 'PNG');
});

test('copyOutput: readme true copies README.md next to manifest into outDir', (t) => {
  const tmp = makeTmpDir('amxb-copy-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const buildDir = path.join(tmp, 'build');
  writeTree(buildDir, { 'amxmodx/plugins/plugin.amxx': 'BIN' });

  const manifestPath = path.join(tmp, 'amxbuild.yml');
  fs.writeFileSync(manifestPath, '');
  fs.writeFileSync(path.join(tmp, 'README.md'), '# My Server\n');
  const outDir = path.join(tmp, 'out');

  const manifest = makeManifest({ manifestPath, outDir, readme: true });

  copyOutput(manifest, buildDir);

  assert.equal(fs.readFileSync(path.join(outDir, 'README.md'), 'utf8'), '# My Server\n');
});

test('copyOutput: readme true without README.md warns and copies no readme', (t) => {
  const tmp = makeTmpDir('amxb-copy-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const buildDir = path.join(tmp, 'build');
  writeTree(buildDir, { 'amxmodx/plugins/plugin.amxx': 'BIN' });

  const manifestPath = path.join(tmp, 'amxbuild.yml');
  fs.writeFileSync(manifestPath, '');
  const outDir = path.join(tmp, 'out');

  const manifest = makeManifest({ manifestPath, outDir, readme: true });

  // Must not throw — the missing README is only a warning.
  copyOutput(manifest, buildDir);

  assert.ok(!fs.existsSync(path.join(outDir, 'README.md')));
});

test('copyOutput: missing amxmodx/ and assets/ dirs is a no-op', (t) => {
  const tmp = makeTmpDir('amxb-copy-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const buildDir = path.join(tmp, 'build');
  fs.mkdirSync(buildDir, { recursive: true });

  const manifestPath = path.join(tmp, 'amxbuild.yml');
  fs.writeFileSync(manifestPath, '');
  const outDir = path.join(tmp, 'out');

  const manifest = makeManifest({ manifestPath, outDir, readme: false });

  copyOutput(manifest, buildDir); // no throw

  // Nothing to copy → outDir is never created.
  assert.ok(!fs.existsSync(outDir));
});

// ─── createArchive ───────────────────────────────────────────────────────────

test('createArchive: writes non-empty zip with sanitized archive_name', async (t) => {
  const tmp = makeTmpDir('amxb-zip-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const buildDir = path.join(tmp, 'build');
  writeTree(buildDir, {
    'amxmodx/plugins/a.amxx': 'AAA',
    'amxmodx/plugins/b.amxx': 'BBB',
    'amxmodx/configs/server.cfg': 'cfg',
    'amxmodx/lang/en.txt': 'en',
  });

  const manifestPath = path.join(tmp, 'amxbuild.yml');
  fs.writeFileSync(manifestPath, '');
  const outDir = path.join(tmp, 'out');

  const manifest = makeManifest({
    manifestPath,
    outDir,
    archiveName: 'my:file?.zip',
    amxmodxPath: 'addons/amxmodx',
    assetsPath: '',
  });

  await createArchive(manifest, buildDir);

  const archivePath = path.join(outDir, 'my_file_.zip');
  assert.ok(fs.existsSync(archivePath), 'expected sanitized zip filename');
  assert.ok(fs.statSync(archivePath).size > 0, 'zip should be non-empty');
  // illegal characters must not survive into the written filename
  assert.ok(!fs.existsSync(path.join(outDir, 'my:file?.zip')));
});

test('createArchive: expands {name}/{version} in archive_name and zips assets at root', async (t) => {
  const tmp = makeTmpDir('amxb-zip-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const buildDir = path.join(tmp, 'build');
  writeTree(buildDir, {
    'amxmodx/plugins/plugin.amxx': 'BIN',
    'assets/maps/de.bsp': 'BSP',
    'assets/logo.png': 'PNG',
  });

  const manifestPath = path.join(tmp, 'amxbuild.yml');
  fs.writeFileSync(manifestPath, '');
  const outDir = path.join(tmp, 'out');

  const manifest = makeManifest({
    manifestPath,
    outDir,
    archiveName: '{name}-v{version}.zip',
    amxmodxPath: 'addons/amxmodx',
    assetsPath: '',
  });

  await createArchive(manifest, buildDir);

  const archivePath = path.join(outDir, 'TestServer-v1.0.0.zip');
  assert.ok(fs.existsSync(archivePath));
  assert.ok(fs.statSync(archivePath).size > 0);
});

test('createArchive: strips path components from archive_name; falls back to archive.zip', async (t) => {
  const tmp = makeTmpDir('amxb-zip-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const buildDir = path.join(tmp, 'build');
  writeTree(buildDir, { 'amxmodx/plugins/plugin.amxx': 'BIN' });
  const manifestPath = path.join(tmp, 'amxbuild.yml');
  fs.writeFileSync(manifestPath, '');

  // (archive_name, expected written filename)
  const cases = [
    ['sub/dir\\x.zip', 'x.zip'],     // both / and \ stripped to basename
    ['..', 'archive.zip'],           // dangerous name → fallback
    ['', 'archive.zip'],             // empty → fallback
  ];

  for (let i = 0; i < cases.length; i++) {
    const [archiveName, expected] = cases[i];
    const outDir = path.join(tmp, `out-${i}`);
    const manifest = makeManifest({ manifestPath, outDir, archiveName });
    await createArchive(manifest, buildDir);
    assert.ok(fs.existsSync(path.join(outDir, expected)), `expected ${expected} for ${JSON.stringify(archiveName)}`);
  }
});

test('createArchive: readme true includes README.md next to manifest', async (t) => {
  const tmp = makeTmpDir('amxb-zip-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const buildDir = path.join(tmp, 'build');
  writeTree(buildDir, { 'amxmodx/plugins/plugin.amxx': 'BIN' });

  const manifestPath = path.join(tmp, 'amxbuild.yml');
  fs.writeFileSync(manifestPath, '');
  fs.writeFileSync(path.join(tmp, 'README.md'), '# My Server\n');
  const outDir = path.join(tmp, 'out');

  const manifest = makeManifest({ manifestPath, outDir, readme: true });

  await createArchive(manifest, buildDir);

  assert.ok(fs.existsSync(path.join(outDir, 'test.zip')));
  assert.ok(fs.statSync(path.join(outDir, 'test.zip')).size > 0);
});

test('createArchive: readme true without README.md warns but still writes the zip', async (t) => {
  const tmp = makeTmpDir('amxb-zip-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const buildDir = path.join(tmp, 'build');
  writeTree(buildDir, { 'amxmodx/plugins/plugin.amxx': 'BIN' });

  const manifestPath = path.join(tmp, 'amxbuild.yml');
  fs.writeFileSync(manifestPath, '');
  const outDir = path.join(tmp, 'out');

  const manifest = makeManifest({ manifestPath, outDir, readme: true });

  await createArchive(manifest, buildDir); // must not throw

  assert.ok(fs.existsSync(path.join(outDir, 'test.zip')));
});

test('createArchive: empty buildDir still produces a (valid, empty) zip', async (t) => {
  const tmp = makeTmpDir('amxb-zip-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const buildDir = path.join(tmp, 'build');
  fs.mkdirSync(buildDir, { recursive: true });

  const manifestPath = path.join(tmp, 'amxbuild.yml');
  fs.writeFileSync(manifestPath, '');
  const outDir = path.join(tmp, 'out');

  const manifest = makeManifest({ manifestPath, outDir, readme: false });

  await createArchive(manifest, buildDir);

  assert.ok(fs.existsSync(path.join(outDir, 'test.zip')));
  assert.ok(fs.statSync(path.join(outDir, 'test.zip')).size > 0);
});
