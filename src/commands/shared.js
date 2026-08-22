'use strict';

const path = require('path');

const { loadEnv } = require('../env');
const { resolveManifestPath: resolveManifestPathCore } = require('../manifest-path');

/**
 * Resolve manifest file path from explicit arg or auto-detection.
 *
 * CLI wrapper around the core src/manifest-path.js: returns a plain string
 * (absolute path) and renders the CLI-only 'manifest.yml is deprecated'
 * warning. All discovery logic lives in the core.
 */
function resolveManifestPath(explicit) {
  const { path: manifestPath, usedDefault } = resolveManifestPathCore(explicit);
  if (usedDefault && path.basename(manifestPath) === 'manifest.yml') {
    const logger = require('../logger');
    logger.warn('manifest.yml is deprecated — rename it to amxbuild.yml');
  }
  return manifestPath;
}

module.exports = { resolveManifestPath, loadEnv };
