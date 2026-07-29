'use strict';

const fs   = require('fs');
const path = require('path');

const logger    = require('../logger');
const { getCacheInfo, dirSize, fmtSize, parseCacheKey } = require('../cache-info');
const { getCacheDir } = require('../cache-dir');

function runCacheInfo(options = {}) {
  const manifestPath = options.manifest ? path.resolve(options.manifest) : undefined;
  const info = getCacheInfo(manifestPath);

  logger.info(`Cache: ${info.cacheDir} (${info.totalSizeHuman} total)`);

  if (info.totalSize === 0) {
    logger.dim('  (empty)');
    return;
  }

  if (info.compiler.versions.length) {
    logger.info('\nCompiler (amxxpc):');
    for (const ver of info.compiler.versions) {
      for (const [platform, size] of Object.entries(ver.platforms)) {
        logger.dim(`  ${ver.version.padEnd(14)} ${platform.padEnd(10)} ${fmtSize(size)}`);
      }
    }
  }

  if (info.repos.count) {
    logger.info(`\nRepos (${info.repos.count}, ${info.repos.totalSizeHuman} total):`);
    for (const e of info.repos.entries) {
      const label = parseCacheKey(e.key);
      logger.dim(`  ${label.padEnd(52)} ${fmtSize(e.size)}`);
    }
  }

  if (info.releaseDeps.count) {
    logger.info(`\nRelease deps (${info.releaseDeps.count}, ${info.releaseDeps.totalSizeHuman} total):`);
    for (const e of info.releaseDeps.entries) {
      const label = parseCacheKey(e.key);
      logger.dim(`  ${label.padEnd(52)} ${fmtSize(e.size)}`);
    }
  }

  if (info.localAssetCache) {
    logger.info(`\nLocal asset cache (${info.localAssetCache.count}, ${info.localAssetCache.totalSizeHuman}):`);
    logger.dim(`  ${info.localAssetCache.path}`);
  }
}

function runCacheClean(options) {
  const { all, compiler, repos, deps } = options;

  if (!all && !compiler && !repos && !deps) {
    logger.error('Specify what to clean: --compiler, --repos, --deps, or --all');
    process.exit(1);
  }

  const cacheRoot = getCacheDir();
  const targets = [];
  if (all || compiler) targets.push({ dir: path.join(cacheRoot, 'amxxpc'),       label: 'compiler' });
  if (all || repos)    targets.push({ dir: path.join(cacheRoot, 'repos'),         label: 'repos' });
  if (all || deps)     targets.push({ dir: path.join(cacheRoot, 'release-deps'),  label: 'release deps' });

  for (const { dir, label } of targets) {
    if (!fs.existsSync(dir)) {
      logger.dim(`  ${label}: already empty`);
      continue;
    }
    const freed = dirSize(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    logger.success(`Cleaned ${label} (${fmtSize(freed)} freed)`);
  }
}

module.exports = { runCacheInfo, runCacheClean };
