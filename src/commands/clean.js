'use strict';

const fs   = require('fs');
const path = require('path');

const logger    = require('../logger');
const { getCacheDir } = require('../cache-dir');

async function runClean(options) {
  const buildDir     = path.resolve(options.buildDir || './build');
  const reposDir     = path.join(getCacheDir(), 'repos');
  const releasesDir  = path.join(getCacheDir(), 'release-deps');
  const compDir      = path.join(getCacheDir(), 'amxxpc');

  if (fs.existsSync(buildDir)) {
    fs.rmSync(buildDir, { recursive: true, force: true });
    logger.info(`Cleaned: ${buildDir}`);
  }
  if (fs.existsSync(reposDir)) {
    fs.rmSync(reposDir, { recursive: true, force: true });
    logger.info(`Cleaned: ${reposDir}`);
  }
  if (fs.existsSync(releasesDir)) {
    fs.rmSync(releasesDir, { recursive: true, force: true });
    logger.info(`Cleaned: ${releasesDir}`);
  }
  if (options.all && fs.existsSync(compDir)) {
    fs.rmSync(compDir, { recursive: true, force: true });
    logger.info(`Cleaned: ${compDir}`);
  }
}

module.exports = { runClean };
