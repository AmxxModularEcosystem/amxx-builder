'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * Resolve manifest file path from explicit arg or auto-detection.
 */
function resolveManifestPath(explicit) {
  if (explicit) return explicit;
  if (fs.existsSync('./amxbuild.yml'))  return './amxbuild.yml';
  if (fs.existsSync('./amxbuild.yaml')) return './amxbuild.yaml';
  if (fs.existsSync('./manifest.yml')) {
    const logger = require('../logger');
    logger.warn('manifest.yml is deprecated — rename it to amxbuild.yml');
    return './manifest.yml';
  }
  return './amxbuild.yml';
}

/**
 * Load .env from the manifest's directory.
 */
function loadEnv(manifestPath) {
  const manifestDir = path.dirname(path.resolve(manifestPath));
  require('dotenv').config({ path: path.join(manifestDir, '.env'), override: true });
}

module.exports = { resolveManifestPath, loadEnv };
