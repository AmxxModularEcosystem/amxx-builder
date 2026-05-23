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
  return path.join(os.homedir(), '.cache', 'amxx-builder');
}

module.exports = { getCacheDir };
