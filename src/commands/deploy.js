'use strict';

const fs   = require('fs');
const path = require('path');

const logger              = require('../logger');
const { parseManifest }   = require('../manifest');
const { deployBuild }     = require('../deployer');
const { sendRconForPlugins } = require('../rcon');
const { resolveManifestPath, loadEnv } = require('./shared');
const { runBuild } = require('./build');

function gatherPluginNames(buildDir) {
  const pluginsDir = path.join(buildDir, 'amxmodx', 'plugins');
  if (!fs.existsSync(pluginsDir)) return [];
  return fs.readdirSync(pluginsDir)
    .filter(f => f.endsWith('.amxx'))
    .map(f => f.replace(/\.amxx$/, ''));
}

async function runDeploy(options) {
  const manifestPath = resolveManifestPath(options.manifest);
  const buildDir     = path.resolve(options.buildDir || './build');

  loadEnv(manifestPath);

  if (options.build) {
    await runBuild({ ...options, manifest: manifestPath });
  } else if (!fs.existsSync(buildDir)) {
    throw new Error(`Build directory not found: ${buildDir}\n  → Run "amxb build" first, or use "amxb deploy --build"`);
  }

  const manifest = parseManifest(manifestPath);
  await deployBuild(manifest, buildDir, { incremental: options.incremental || false });

  const pluginNames = gatherPluginNames(buildDir);
  await sendRconForPlugins(manifest.deploy, pluginNames);
}

module.exports = { runDeploy };
