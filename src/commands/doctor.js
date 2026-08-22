'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const logger = require('../logger');
const { getCacheDir } = require('../cache-dir');
const { dirSize, fmtSize } = require('../cache-info');

async function runDoctor(options) {
  const ok = [];
  const warn = [];
  const note = [];

  const nodeMajor = parseInt(process.version.slice(1).split('.')[0], 10);
  (nodeMajor >= 16 ? ok : warn).push(`Node.js: ${process.version.slice(1)}${nodeMajor >= 16 ? '' : ' (minimum 16 required)'}`);

  try {
    const gitVer = execSync('git --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    ok.push(`Git: ${gitVer.replace('git version ', '')} (optional — only for github.ssh: true)`);
  } catch {
    note.push('Git: not found (optional — only needed for github.ssh: true)');
  }

  try {
    const npmVer = execSync('npm --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    ok.push(`npm: ${npmVer}`);
  } catch {
    warn.push('npm: not found in PATH');
  }

  try {
    const axios = require('axios');
    const resp = await axios.get('https://api.github.com', { timeout: 5000 });
    if (resp.status === 200 || resp.status === 403) {
      ok.push('GitHub API: reachable');
    } else {
      warn.push(`GitHub API: returned ${resp.status}`);
    }
  } catch {
    warn.push('GitHub API: unreachable (check internet)');
  }

  const manifestPath = options.manifest
    ? path.resolve(options.manifest)
    : fs.existsSync('./amxbuild.yml') ? './amxbuild.yml'
    : fs.existsSync('./amxbuild.yaml') ? './amxbuild.yaml'
    : null;

  if (manifestPath && fs.existsSync(manifestPath)) {
    try {
      const { parseManifest } = require('../manifest');
      parseManifest(manifestPath);
      ok.push(`Manifest: valid (${path.basename(manifestPath)})`);
    } catch (err) {
      warn.push(`Manifest: invalid — ${err.message}`);
    }
  } else {
    ok.push('Manifest: not found (run amxb init)');
  }

  const cacheDir = getCacheDir();
  const cacheSize = fmtSize(dirSize(cacheDir));
  ok.push(`Cache: ${cacheDir} (${cacheSize})`);

  logger.info('=== System Check ===');
  for (const msg of ok) logger.success(`  ✓ ${msg}`);
  for (const msg of note) logger.info(`  · ${msg}`);
  for (const msg of warn) logger.warn(`  ⚠ ${msg}`);

  if (warn.length) {
    process.exitCode = 1;
  }
}

module.exports = { runDoctor };
