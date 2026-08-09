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
    if (entry.isDirectory()) {
      copyDirContents(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
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
 * Throws on non-zero exit.
 */
function safeExtractTar(archivePath, destDir) {
  const flag = archivePath.endsWith('.tar.bz2') ? '-j' : '-z';
  const result = spawnSync('tar', ['-x', flag, '-f', archivePath, '-C', destDir], { stdio: 'pipe' });
  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || '').toString().trim();
    throw new Error(`tar extraction failed for ${path.basename(archivePath)}: ${msg || 'unknown error'}`);
  }
}

module.exports = { copyDirContents, countFiles, safeExtractTar };
