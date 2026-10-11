'use strict';

const fs   = require('fs');
const path = require('path');

const logger              = require('../logger');
const { parseManifest }   = require('../manifest');
const { deployBuild, gatherPluginNames } = require('../deployer');
const { sendRconForPlugins } = require('../rcon');
const { resolveManifestPath, loadEnv } = require('./shared');
const { runBuild } = require('./build');

async function runDeploy(options) {
  const manifestPath = resolveManifestPath(options.manifest);
  const buildDir     = path.resolve(options.buildDir || './build');

  loadEnv(manifestPath);

  let manifest;
  if (options.build) {
    manifest = await runBuild({ ...options, manifest: manifestPath });
  } else if (!fs.existsSync(buildDir)) {
    throw new Error(`Build directory not found: ${buildDir}\n  → Run "amxb build" first, or use "amxb deploy --build"`);
  }
  if (!manifest) manifest = parseManifest(manifestPath);

  await deployBuild(manifest, buildDir, { incremental: options.incremental || false });

  const pluginNames = gatherPluginNames(buildDir);
  await sendRconForPlugins(manifest.deploy, pluginNames);
}

module.exports = { runDeploy };
