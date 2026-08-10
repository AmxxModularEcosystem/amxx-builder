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

module.exports = { getCacheDir };
