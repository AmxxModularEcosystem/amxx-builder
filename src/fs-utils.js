'use strict';

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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

module.exports = { copyDirContents, countFiles, safeExtractTar };
