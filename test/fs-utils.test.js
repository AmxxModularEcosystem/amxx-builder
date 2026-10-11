'use strict';

/**
 * Unit tests for src/fs-utils.js — copyDirContents, countFiles, safeExtractTar,
 * writeFileSyncAtomic, hasZipMagic, extractArchive, resolveConflict.
 *
 * Offline + deterministic: real temp dirs, real tar binary when available
 * (skipped otherwise), no network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');

const logger = require('../src/logger');
const {
  copyDirContents, countFiles, safeExtractTar,
  writeFileSyncAtomic, hasZipMagic, extractArchive, resolveConflict,
} = require('../src/fs-utils');

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(dir, rel, content = '') {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// Windows: fs.symlinkSync needs admin privileges or Developer Mode — probe at
// load time so symlink tests skip cleanly instead of failing with EPERM.
const HAS_SYMLINK = (() => {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amxb-lnk-'));
    fs.symlinkSync('probe', path.join(dir, 'probe'));
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch { return false; }
})();

// ─── copyDirContents ────────────────────────────────────────────────────────

test('copyDirContents: copies nested dirs and files, creates dest dir', (t) => {
  const src  = makeTmpDir('amxb-copy-src-');
  const dest = path.join(makeTmpDir('amxb-copy-dest-'), 'nested', 'dest');
  t.after(() => { fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(dest, { recursive: true, force: true }); });

  writeFile(src, 'top.txt', 'top');
  writeFile(src, 'sub/inner.txt', 'inner');
  writeFile(src, 'sub/deeper/deep.txt', 'deep');

  copyDirContents(src, dest);

  assert.equal(fs.readFileSync(path.join(dest, 'top.txt'), 'utf8'), 'top');
  assert.equal(fs.readFileSync(path.join(dest, 'sub', 'inner.txt'), 'utf8'), 'inner');
  assert.equal(fs.readFileSync(path.join(dest, 'sub', 'deeper', 'deep.txt'), 'utf8'), 'deep');
});

test('copyDirContents: preserves source mode (exec bit survives copy)', (t) => {
  if (process.platform === 'win32') return t.skip('exec bit is not meaningful on Windows');
  const src  = makeTmpDir('amxb-mode-src-');
  const dest = path.join(makeTmpDir('amxb-mode-dest-'), 'dest');
  t.after(() => { fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(dest, { recursive: true, force: true }); });

  const file = writeFile(src, 'run.sh', '#!/bin/sh\n');
  fs.chmodSync(file, 0o755);

  copyDirContents(src, dest);

  const mode = fs.statSync(path.join(dest, 'run.sh')).mode & 0o777;
  assert.equal(mode, 0o755);
});

test('copyDirContents: recreates symlinks as symlinks', (t) => {
  if (!HAS_SYMLINK) return t.skip('symlinks not supported (Windows without Dev Mode)');
  const src  = makeTmpDir('amxb-link-src-');
  const dest = path.join(makeTmpDir('amxb-link-dest-'), 'dest');
  t.after(() => { fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(dest, { recursive: true, force: true }); });

  writeFile(src, 'target.txt', 'linked content');
  fs.symlinkSync('target.txt', path.join(src, 'link.txt'));

  copyDirContents(src, dest);

  const destLink = path.join(dest, 'link.txt');
  assert.equal(fs.lstatSync(destLink).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(destLink), 'target.txt');
  // Content reachable through the recreated link.
  assert.equal(fs.readFileSync(destLink, 'utf8'), 'linked content');
});

test('copyDirContents: falls back to file copy when symlink cannot be created (dest exists)', (t) => {
  if (!HAS_SYMLINK) return t.skip('symlinks not supported (Windows without Dev Mode)');
  const src  = makeTmpDir('amxb-linkfb-src-');
  const dest = makeTmpDir('amxb-linkfb-dest-');
  t.after(() => { fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(dest, { recursive: true, force: true }); });

  // A file occupying the dest path makes fs.symlinkSync throw EEXIST, so the
  // fallback copies the link target's content instead.
  writeFile(src, 'target.txt', 'fallback content');
  fs.symlinkSync('target.txt', path.join(src, 'link.txt'));
  fs.writeFileSync(path.join(dest, 'link.txt'), 'old dest content');

  copyDirContents(src, dest);

  const destLink = path.join(dest, 'link.txt');
  assert.equal(fs.lstatSync(destLink).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(destLink, 'utf8'), 'fallback content');
});

test('copyDirContents: dangling symlink is recreated as a dangling symlink', (t) => {
  if (!HAS_SYMLINK) return t.skip('symlinks not supported (Windows without Dev Mode)');
  const src  = makeTmpDir('amxb-dangle-src-');
  const dest = path.join(makeTmpDir('amxb-dangle-dest-'), 'dest');
  t.after(() => { fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(dest, { recursive: true, force: true }); });

  fs.symlinkSync('no-such-target', path.join(src, 'broken'));

  copyDirContents(src, dest);

  const destBroken = path.join(dest, 'broken');
  assert.equal(fs.lstatSync(destBroken).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(destBroken), 'no-such-target');
});

// ─── countFiles ─────────────────────────────────────────────────────────────

test('countFiles: counts files recursively, excludes directories', (t) => {
  const dir = makeTmpDir('amxb-count-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  writeFile(dir, 'a.txt');
  writeFile(dir, 'sub/b.txt');
  writeFile(dir, 'sub/deeper/c.txt');
  fs.mkdirSync(path.join(dir, 'empty'), { recursive: true });

  assert.equal(countFiles(dir), 3);
});

test('countFiles: empty dir is 0', (t) => {
  const dir = makeTmpDir('amxb-count-empty-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(countFiles(dir), 0);
});

// ─── safeExtractTar ─────────────────────────────────────────────────────────

const TAR_OK = !spawnSync('tar', ['--version']).error;function makeTar(workDir, outName, fileNames, flags = ['-czf']) {
  return spawnSync('tar', [...flags, outName, ...fileNames], { cwd: workDir, stdio: 'pipe' });
}

test('safeExtractTar: extracts a real .tar.gz archive', (t) => {
  if (!TAR_OK) t.skip('tar binary not available');
  const srcDir = makeTmpDir('amxb-tar-src-');
  const dest   = makeTmpDir('amxb-tar-dest-');
  t.after(() => { fs.rmSync(srcDir, { recursive: true, force: true }); fs.rmSync(dest, { recursive: true, force: true }); });

  writeFile(srcDir, 'payload.txt', 'hello from tar');
  const archive = path.join(srcDir, 'pack.tar.gz');
  const res = makeTar(srcDir, 'pack.tar.gz', ['payload.txt']);
  assert.equal(res.status, 0, 'test setup: tar creation failed');

  safeExtractTar(archive, dest);

  assert.equal(fs.readFileSync(path.join(dest, 'payload.txt'), 'utf8'), 'hello from tar');
});

test('safeExtractTar: extracts a .tar.bz2 archive', (t) => {
  if (!TAR_OK) t.skip('tar binary not available');
  const srcDir = makeTmpDir('amxb-tar-bz2-src-');
  const dest   = makeTmpDir('amxb-tar-bz2-dest-');
  t.after(() => { fs.rmSync(srcDir, { recursive: true, force: true }); fs.rmSync(dest, { recursive: true, force: true }); });

  writeFile(srcDir, 'bz.txt', 'bz2 content');
  const archive = path.join(srcDir, 'pack.tar.bz2');
  const res = makeTar(srcDir, 'pack.tar.bz2', ['bz.txt'], ['-cjf']);
  // Windows' built-in bsdtar is compiled without bzip2 — skip, don't fail.
  if (res.status !== 0) return t.skip('tar bzip2 not supported by this tar build');

  safeExtractTar(archive, dest);

  assert.equal(fs.readFileSync(path.join(dest, 'bz.txt'), 'utf8'), 'bz2 content');
});

test('safeExtractTar: stripComponents removes the top-level wrapper dir', (t) => {
  if (!TAR_OK) t.skip('tar binary not available');
  const srcDir = makeTmpDir('amxb-tar-strip-src-');
  const dest   = makeTmpDir('amxb-tar-strip-dest-');
  t.after(() => { fs.rmSync(srcDir, { recursive: true, force: true }); fs.rmSync(dest, { recursive: true, force: true }); });

  // GitHub tarballs wrap everything in a single {repo}-{sha}/ dir — archive
  // contains only "wrapper", with inner.txt inside it.
  writeFile(srcDir, 'wrapper/inner.txt', 'inner content');
  const archive = path.join(srcDir, 'pack.tar.gz');
  const res = makeTar(srcDir, 'pack.tar.gz', ['wrapper']);
  assert.equal(res.status, 0, 'test setup: tar creation failed');

  safeExtractTar(archive, dest, { stripComponents: 1 });

  assert.equal(fs.readFileSync(path.join(dest, 'inner.txt'), 'utf8'), 'inner content');
  assert.equal(fs.existsSync(path.join(dest, 'wrapper')), false);
});

test('safeExtractTar: missing archive throws', (t) => {
  if (!TAR_OK) t.skip('tar binary not available');
  const dest = makeTmpDir('amxb-tar-missing-');
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));

  assert.throws(
    () => safeExtractTar(path.join(dest, 'nope.tar.gz'), dest),
    /tar extraction failed/
  );
});

test('safeExtractTar: corrupt archive throws (non-zero tar exit)', (t) => {
  if (!TAR_OK) t.skip('tar binary not available');
  const dest = makeTmpDir('amxb-tar-corrupt-');
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));

  const bad = path.join(dest, 'bad.tar.gz');
  fs.writeFileSync(bad, Buffer.from('this is definitely not a tar archive'));

  assert.throws(
    () => safeExtractTar(bad, dest),
    /tar extraction failed/
  );
});

// ─── writeFileSyncAtomic ─────────────────────────────────────────────────────

test('writeFileSyncAtomic: writes content atomically and leaves no .tmp behind', (t) => {
  const dir = makeTmpDir('amxb-atomic-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const file = path.join(dir, 'sentinel');
  writeFileSyncAtomic(file, '1.10.5428');

  assert.equal(fs.readFileSync(file, 'utf8'), '1.10.5428');
  assert.equal(fs.existsSync(file + '.tmp'), false);
  assert.deepEqual(fs.readdirSync(dir), ['sentinel']);
});

test('writeFileSyncAtomic: overwrites an existing file in place', (t) => {
  const dir = makeTmpDir('amxb-atomic-over-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const file = path.join(dir, 'sentinel');
  fs.writeFileSync(file, 'old');
  writeFileSyncAtomic(file, 'new');

  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.equal(fs.existsSync(file + '.tmp'), false);
});

// ─── hasZipMagic ─────────────────────────────────────────────────────────────

test('hasZipMagic: true for a PK-prefixed file', (t) => {
  const dir = makeTmpDir('amxb-magic-yes-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const file = path.join(dir, 'blob.bin');
  fs.writeFileSync(file, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));

  assert.equal(hasZipMagic(file), true);
});

test('hasZipMagic: false for a non-zip file and for a missing file', (t) => {
  const dir = makeTmpDir('amxb-magic-no-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const file = path.join(dir, 'plain.txt');
  fs.writeFileSync(file, 'not a zip');

  assert.equal(hasZipMagic(file), false);
  assert.equal(hasZipMagic(path.join(dir, 'nope.bin')), false);
});

// ─── extractArchive ──────────────────────────────────────────────────────────

function makeZip(dir, name, files) {
  const zip = new AdmZip();
  for (const [rel, content] of Object.entries(files)) {
    zip.addFile(rel, Buffer.from(content));
  }
  const p = path.join(dir, name);
  zip.writeZip(p);
  return p;
}

test('extractArchive: extracts a .zip via AdmZip and does not delete the archive', (t) => {
  const dir  = makeTmpDir('amxb-extract-zip-');
  const dest = path.join(dir, 'out');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const zip = makeZip(dir, 'pack.zip', { 'model.mdl': 'zip payload' });

  extractArchive(zip, dest);

  assert.equal(fs.readFileSync(path.join(dest, 'model.mdl'), 'utf8'), 'zip payload');
  assert.equal(fs.existsSync(zip), true);
});

test('extractArchive: a .ZIP-named zip is extracted (case-insensitive .zip test)', (t) => {
  const dir  = makeTmpDir('amxb-extract-upper-');
  const dest = path.join(dir, 'out');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const zip = makeZip(dir, 'pack.ZIP', { 'upper.mdl': 'upper payload' });

  extractArchive(zip, dest);

  assert.equal(fs.readFileSync(path.join(dest, 'upper.mdl'), 'utf8'), 'upper payload');
});

test('extractArchive: a .ZIP-named non-zip is routed to the zip branch, not the tar branch', (t) => {
  if (!TAR_OK) return t.skip('tar binary not available');
  const dir  = makeTmpDir('amxb-extract-upperbad-');
  const dest = path.join(dir, 'out');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  writeFile(dir, 'payload.txt', 'tar under a .ZIP name');
  const res = makeTar(dir, 'pack.ZIP', ['payload.txt']);
  assert.equal(res.status, 0, 'test setup: tar creation failed');

  // The case-insensitive extension matches, so AdmZip is attempted and fails:
  // the tar branch is NOT taken (payload.txt would exist otherwise). This locks
  // the superset — a revert to case-sensitive .endsWith('.zip') would extract.
  assert.throws(() => extractArchive(path.join(dir, 'pack.ZIP'), dest));
  assert.equal(fs.existsSync(path.join(dest, 'payload.txt')), false);
});

test('extractArchive: extracts a .tar.gz via safeExtractTar and keeps the archive', (t) => {
  if (!TAR_OK) t.skip('tar binary not available');
  const dir  = makeTmpDir('amxb-extract-tar-');
  const dest = path.join(dir, 'out');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  writeFile(dir, 'payload.txt', 'tar payload');
  const res = makeTar(dir, 'pack.tar.gz', ['payload.txt']);
  assert.equal(res.status, 0, 'test setup: tar creation failed');

  fs.mkdirSync(dest, { recursive: true });
  extractArchive(path.join(dir, 'pack.tar.gz'), dest);

  assert.equal(fs.readFileSync(path.join(dest, 'payload.txt'), 'utf8'), 'tar payload');
  assert.equal(fs.existsSync(path.join(dir, 'pack.tar.gz')), true);
});

// ─── resolveConflict ─────────────────────────────────────────────────────────

function captureWarn(t) {
  const original = logger.warn;
  const messages = [];
  logger.warn = (msg) => { messages.push(msg); };
  t.after(() => { logger.warn = original; });
  return messages;
}

test('resolveConflict: no prior origin returns write without logging', (t) => {
  const messages = captureWarn(t);

  const result = resolveConflict(new Map(), 'a.txt', 'repoB', 'error', { errorPrefix: 'File conflict', warnPrefix: 'Conflict' });

  assert.equal(result, 'write');
  assert.deepEqual(messages, []);
});

test('resolveConflict: error throws the exact collector message', () => {
  const origins = new Map([['a.txt', 'repoA']]);

  assert.throws(
    () => resolveConflict(origins, 'a.txt', 'repoB', 'error', { errorPrefix: 'File conflict', warnPrefix: 'Conflict' }),
    (err) => err.message === 'File conflict: "a.txt" — provided by both "repoA" and "repoB"'
  );
});

test('resolveConflict: error throws the exact asset message', () => {
  const origins = new Map([['models/x.mdl', 'srcA']]);

  assert.throws(
    () => resolveConflict(origins, 'models/x.mdl', 'srcB', 'error', { errorPrefix: 'Asset conflict', warnPrefix: 'Asset conflict' }),
    (err) => err.message === 'Asset conflict: "models/x.mdl" — provided by both "srcA" and "srcB"'
  );
});

test('resolveConflict: first_wins warns with the kept message and skips', (t) => {
  const messages = captureWarn(t);
  const origins  = new Map([['a.txt', 'repoA']]);

  const result = resolveConflict(origins, 'a.txt', 'repoB', 'first_wins', { errorPrefix: 'File conflict', warnPrefix: 'Conflict' });

  assert.equal(result, 'skip');
  assert.deepEqual(messages, ['Conflict (kept "repoA"): a.txt']);
});

test('resolveConflict: last_wins warns with the overwrite message and writes', (t) => {
  const messages = captureWarn(t);
  const origins  = new Map([['a.txt', 'repoA']]);

  const result = resolveConflict(origins, 'a.txt', 'repoB', 'last_wins', { errorPrefix: 'File conflict', warnPrefix: 'Conflict' });

  assert.equal(result, 'write');
  assert.deepEqual(messages, ['Conflict (overwriting "repoA"): a.txt']);
});

test('resolveConflict: asset first_wins uses the asset wording and skips', (t) => {
  const messages = captureWarn(t);
  const origins  = new Map([['models/x.mdl', 'srcA']]);

  const result = resolveConflict(origins, 'models/x.mdl', 'srcB', 'first_wins', { errorPrefix: 'Asset conflict', warnPrefix: 'Asset conflict' });

  assert.equal(result, 'skip');
  assert.deepEqual(messages, ['Asset conflict (kept "srcA"): models/x.mdl']);
});
