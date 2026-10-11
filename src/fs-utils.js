'use strict';

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');
const logger = require('./logger');

/**
 * Recursively copy all contents from srcDir to destDir.
 * Creates destDir if it does not exist.
 */
function copyDirContents(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath  = path.join(src,  entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      // Recreate the link; fall back to copying the file content when the
      // target cannot be recreated (e.g. no symlink privilege on Windows).
      let target;
      try { target = fs.readlinkSync(srcPath); } catch { continue; }
      try {
        fs.symlinkSync(target, destPath);
      } catch {
        const st = fs.statSync(srcPath);
        if (st.isFile()) {
          fs.copyFileSync(srcPath, destPath);
          copyMode(srcPath, destPath);
        }
      }
      continue;
    }
    if (entry.isDirectory()) {
      copyDirContents(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      copyMode(srcPath, destPath);
    }
  }
}

// copyFileSync creates files with 0666 & ~umask — restore the source mode
// so executable bits survive (needed for binaries shipped via assets/).
function copyMode(src, dest) {
  try {
    const mode = fs.statSync(src).mode & 0o777;
    fs.chmodSync(dest, mode);
  } catch (_) {}
}

/**
 * Recursively count files inside a directory (excludes directories themselves).
 */
function countFiles(dir) {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countFiles(p);
    } else {
      count++;
    }
  }
  return count;
}

/**
 * Atomically write string `content` to `file` via `<file>.tmp` + rename.
 * Parent directory must exist (callers own their mkdirSync). String-typed on
 * purpose — no caller passes a Buffer, and writeFileSync defaults to utf8.
 */
function writeFileSyncAtomic(file, content) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/**
 * Safe tar extraction — uses spawnSync to avoid shell injection.
 * Supports .tar.gz / .tgz and .tar.bz2 archives.
 * stripComponents > 0 drops that many leading path segments (GitHub tarballs
 * wrap everything in a single {repo}-{sha}/ top-level dir → strip 1).
 * Throws on non-zero exit.
 */
function safeExtractTar(archivePath, destDir, { stripComponents = 0 } = {}) {
  const flag = archivePath.endsWith('.tar.bz2') ? 'j' : 'z';
  const args = ['-x' + flag, '-f', archivePath, '-C', destDir];
  if (stripComponents > 0) args.push(`--strip-components=${stripComponents}`);
  const result = spawnSync('tar', args, { stdio: 'pipe' });
  if (result.error) {
    throw new Error(`tar extraction failed for ${path.basename(archivePath)}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || '').toString().trim();
    throw new Error(`tar extraction failed for ${path.basename(archivePath)}: ${msg || 'unknown error'}`);
  }
}

/**
 * Extracts an archive into destDir: a zip (by `.zip` extension — case-insensitive,
 * the superset of the former call sites — or by PK magic sniff) via AdmZip,
 * otherwise a `.tar.*` archive via safeExtractTar. Does NOT delete the archive —
 * callers own cleanup.
 */
function extractArchive(archivePath, destDir) {
  if (/\.zip$/i.test(archivePath) || hasZipMagic(archivePath)) {
    new AdmZip(archivePath).extractAllTo(destDir, true);
  } else {
    safeExtractTar(archivePath, destDir);
  }
}

// ZIP archives start with "PK" — sniff the bytes so an asset named without
// the .zip extension (redirects, CDNs) is still extracted correctly.
function hasZipMagic(filePath) {
  try {
    const fd  = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    return buf[0] === 0x50 && buf[1] === 0x4b;
  } catch { return false; }
}

/**
 * Creates a unique sibling temp dir for an atomic publish into finalDir.
 * Mirrors the repo-fetcher pattern: <final>.tmp-<pid>-<rand>. The parent of
 * finalDir is created as needed, so the temp dir is always on the same
 * filesystem and a later renameSync into place is atomic.
 */
function makeSiblingTmpDir(finalDir) {
  const tmpDir = `${finalDir}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.mkdirSync(path.dirname(tmpDir), { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

/**
 * Publishes a fully-populated temp dir as finalDir (rename-or-adopt, mirroring
 * repo-fetcher). If a concurrent run already produced a valid finalDir,
 * tmpDir is discarded and finalDir kept; if finalDir holds stale junk
 * (isValid false), it is replaced atomically. Callers gate validity on a
 * sentinel, so an in-progress temp dir can never be mistaken for a cache.
 */
function publishDir(tmpDir, finalDir, isValid) {
  try {
    fs.renameSync(tmpDir, finalDir);
  } catch {
    if (isValid()) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    } else {
      try { fs.rmSync(finalDir, { recursive: true, force: true }); } catch (_) {}
      fs.renameSync(tmpDir, finalDir);
    }
  }
  return finalDir;
}

/**
 * Resolve a destination-path conflict recorded in `origins` (relPath → origin label).
 * Returns 'skip' when onConflict==='first_wins' and a prior origin exists; throws when
 * onConflict==='error' and a prior origin exists; otherwise returns 'write' (emitting the
 * last_wins overwrite warning). The caller performs the copy + `origins.set` on 'write'.
 */
function resolveConflict(origins, relKey, label, onConflict, { errorPrefix, warnPrefix }) {
  if (!origins.has(relKey)) return 'write';
  const prev = origins.get(relKey);
  if (onConflict === 'error') {
    throw new Error(`${errorPrefix}: "${relKey}" — provided by both "${prev}" and "${label}"`);
  }
  if (onConflict === 'first_wins') {
    logger.warn(`${warnPrefix} (kept "${prev}"): ${relKey}`);
    return 'skip';
  }
  logger.warn(`${warnPrefix} (overwriting "${prev}"): ${relKey}`);
  return 'write';
}

module.exports = {
  copyDirContents,
  countFiles,
  safeExtractTar,
  makeSiblingTmpDir,
  publishDir,
  writeFileSyncAtomic,
  hasZipMagic,
  extractArchive,
  resolveConflict,
};
