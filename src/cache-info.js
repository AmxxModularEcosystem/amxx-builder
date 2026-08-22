'use strict';

const fs   = require('fs');
const path = require('path');
const { getCacheDir } = require('./cache-dir');
const { formatBytes } = require('./format');

// ─── Helpers ────────────────────────────────────────────────────────────────────

function dirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue; // avoid loops and broken links
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSize(p);
    } else {
      try { total += fs.statSync(p).size; } catch { /* unreadable file */ }
    }
  }
  return total;
}

function fmtSize(bytes) {
  return formatBytes(bytes);
}

function parseCacheKey(key) {
  // owner__repo__ref  →  owner/repo @ ref
  const parts = key.split('__');
  if (parts.length < 3) return key;
  return `${parts.slice(0, -1).join('/')} @ ${parts[parts.length - 1]}`;
}

// ─── Cache info ─────────────────────────────────────────────────────────────────

function getCacheInfo(manifestPath) {
  const cacheRoot = getCacheDir();
  const totalSize = dirSize(cacheRoot);

  const info = {
    cacheDir: cacheRoot,
    totalSize,
    totalSizeHuman: fmtSize(totalSize),
    compiler: scanCompilerCache(path.join(cacheRoot, 'amxxpc')),
    repos: scanDirEntries(path.join(cacheRoot, 'repos'), parseCacheKey),
    releaseDeps: scanDirEntries(path.join(cacheRoot, 'release-deps'), parseCacheKey),
    localAssetCache: null,
  };

  // Local .amxb-cache/ next to manifest
  if (manifestPath) {
    const localDir = path.join(path.dirname(path.resolve(manifestPath)), '.amxb-cache', 'assets');
    if (fs.existsSync(localDir)) {
      const entries = fs.readdirSync(localDir, { withFileTypes: true }).filter(e => e.isDirectory());
      info.localAssetCache = {
        path: localDir,
        count: entries.length,
        totalSize: dirSize(localDir),
        totalSizeHuman: fmtSize(dirSize(localDir)),
      };
    }
  }

  return info;
}

function scanCompilerCache(compDir) {
  if (!fs.existsSync(compDir)) return { versions: [] };

  const versions = fs.readdirSync(compDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const verDir = path.join(compDir, e.name);
      const platforms = {};
      for (const plat of fs.readdirSync(verDir, { withFileTypes: true }).filter(e => e.isDirectory())) {
        platforms[plat.name] = dirSize(path.join(verDir, plat.name));
      }
      return { version: e.name, platforms };
    });

  return { versions };
}

function scanDirEntries(dir, labelFn) {
  if (!fs.existsSync(dir)) return { count: 0, totalSize: 0, totalSizeHuman: '0 B', entries: [] };

  const dirs = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory());
  const entries = dirs.map(e => {
    const full = path.join(dir, e.name);
    const size = dirSize(full);
    return { key: e.name, label: labelFn(e.name), size };
  });

  return {
    count: entries.length,
    totalSize: dirSize(dir),
    totalSizeHuman: fmtSize(dirSize(dir)),
    entries,
  };
}

module.exports = { getCacheInfo, dirSize, fmtSize, parseCacheKey };
