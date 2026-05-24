const fs   = require('fs');
const path = require('path');
const axios = require('axios');
const simpleGit = require('simple-git');
const logger = require('./logger');
const { getCacheDir } = require('./cache-dir');

function getRepoCacheDir(repo, ref) {
  const key = repo.replace('/', '__') + '__' + String(ref).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(getCacheDir(), 'repos', key);
}

/**
 * Resolves "latest" ref to the actual release tag via GitHub API.
 */
async function resolveRef(repo, ref, token) {
  if (ref !== 'latest') return ref;

  logger.dim(`  ${repo}: resolving latest release tag...`);
  const headers = token ? { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } : {};
  try {
    const { data } = await axios.get(
      `https://api.github.com/repos/${repo}/releases/latest`,
      { headers }
    );
    logger.dim(`  ${repo}: latest = ${data.tag_name}`);
    return data.tag_name;
  } catch (err) {
    throw new Error(`Failed to resolve latest release for ${repo}: ${err.message}`);
  }
}

/**
 * Ensures the repo is cloned locally. Returns the local path.
 *
 * Clone URL priority:
 *   ssh=true           → git@github.com:owner/repo.git  (explicit flag)
 *   token set          → https://<token>@github.com/...  (HTTPS + auth)
 *   neither            → git@github.com:owner/repo.git  (SSH default — no token, use key)
 */
async function fetchRepo(repo, ref, token, noFetch, ssh = false) {
  const resolvedRef = ref || null;  // null = clone default branch
  const cacheKey    = resolvedRef || 'HEAD';
  const cacheDir    = getRepoCacheDir(repo, cacheKey);

  if (fs.existsSync(path.join(cacheDir, '.git'))) {
    logger.dim(`  ${repo} @ ${cacheKey} (cached)`);
    return cacheDir;
  }

  if (noFetch) {
    throw new Error(
      `Repo cache missing for ${repo}@${cacheKey} and --no-fetch is set.\n` +
      `Run without --no-fetch to populate the cache.`
    );
  }

  logger.step(`Cloning ${repo} @ ${cacheKey} ...`);

  const cloneUrl  = buildCloneUrl(repo, token, ssh);
  const cloneArgs = ['--depth=1'];
  if (resolvedRef) cloneArgs.push('--branch', resolvedRef);

  fs.mkdirSync(cacheDir, { recursive: true });

  try {
    await simpleGit().clone(cloneUrl, cacheDir, cloneArgs);
  } catch (err) {
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_) {}
    throw new Error(`Failed to clone ${repo}@${cacheKey}: ${err.message}`);
  }

  logger.info(`Cloning ${repo} @ ${cacheKey} ... done`);
  return cacheDir;
}

function buildCloneUrl(repo, token, ssh) {
  if (ssh || !token) return `git@github.com:${repo}.git`;
  return `https://${token}@github.com/${repo}.git`;
}

module.exports = { fetchRepo, resolveRef, getRepoCacheDir };
