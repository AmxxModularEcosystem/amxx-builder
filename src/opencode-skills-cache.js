'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { getCacheDir } = require('./cache-dir');

const CONTAINER_TTL_MS = 60 * 60 * 1000;
const CACHE_MARKER = '.amxb-skills-cache.json';

/**
 * Absolute root directory that holds all per-manifest skill containers.
 *
 * @returns {string}
 */
function containerRoot() {
  return path.join(getCacheDir(), 'opencode-skills');
}

function containerDirFor(manifestPath, root = containerRoot()) {
  const key = crypto.createHash('sha1').update(String(manifestPath)).digest('hex').slice(0, 12);
  return path.join(root, key);
}

/**
 * Return the materialized container for a manifest when it is still fresh.
 *
 * A container is fresh when its marker exists, matches this manifest path and
 * mtime, and was built within CONTAINER_TTL_MS. Reads only light modules so the
 * CLI fast path can skip manifest parsing, dep resolution and the network.
 *
 * @param {string} manifestPath - absolute manifest path
 * @returns {{ containerDir: string, count: number }|null}
 */
function readFreshContainer(manifestPath) {
  const containerDir = containerDirFor(manifestPath);

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(path.join(containerDir, CACHE_MARKER), 'utf8'));
  } catch {
    return null;
  }
  if (!marker || marker.manifestPath !== manifestPath) return null;

  let manifestMtimeMs;
  try {
    manifestMtimeMs = fs.statSync(manifestPath).mtimeMs;
  } catch {
    return null;
  }
  if (manifestMtimeMs !== marker.manifestMtimeMs) return null;
  if (Date.now() - marker.builtAt > CONTAINER_TTL_MS) return null;

  return { containerDir, count: marker.count };
}

module.exports = { CONTAINER_TTL_MS, CACHE_MARKER, containerRoot, containerDirFor, readFreshContainer };
