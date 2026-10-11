'use strict';

const logger = require('../logger');
const { resolveManifest } = require('../manifest');
const { resolveManifestPath, loadEnv } = require('./shared');

async function runResolveManifest(options) {
  const manifestPath = resolveManifestPath(options.manifest);
  loadEnv(manifestPath);

  const manifest = resolveManifest(manifestPath, {
    set:    options.set,
    define: options.define,
  });

  if (options.json) {
    process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
    return;
  }

  logger.info('Resolved manifest:');
  logger.dim(JSON.stringify(manifest, null, 2));
}

module.exports = { runResolveManifest };
