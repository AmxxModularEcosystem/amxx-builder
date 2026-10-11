const path = require('path');
const os   = require('os');

function getCacheDir() {
  if (process.env.AMXX_BUILDER_CACHE) {
    return process.env.AMXX_BUILDER_CACHE;
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'amxx-builder');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'amxx-builder');
  }
  // Linux — follow the XDG spec when XDG_CACHE_HOME is set.
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg) return path.join(xdg, 'amxx-builder');
  return path.join(os.homedir(), '.cache', 'amxx-builder');
}

// Canonical cache subdirectory names — the reader-side layout for cache/clean/cache-info.
// READER-SIDE single source only: the producers (repo-fetcher, release-fetcher,
// compiler-fetcher) still compose getCacheDir()/<literal>/… directly; migrating them
// is out of scope (design M2 — this is not claimed as the sole source of the layout).
const CACHE_SUBDIRS = Object.freeze({
  compiler:    'amxxpc',
  repos:       'repos',
  releaseDeps: 'release-deps',
});

/**
 * Absolute path of a named cache subdirectory.
 * @param {'compiler'|'repos'|'releaseDeps'} name
 * @returns {string}
 */
function cacheSubdir(name) {
  const sub = CACHE_SUBDIRS[name];
  if (!sub) throw new Error(`Unknown cache subdir: ${name}`);
  return path.join(getCacheDir(), sub);
}

module.exports = { getCacheDir, CACHE_SUBDIRS, cacheSubdir };
