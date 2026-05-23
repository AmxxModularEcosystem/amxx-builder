const fs   = require('fs');
const path = require('path');
const simpleGit = require('simple-git');
const logger = require('./logger');
const { getCacheDir } = require('./cache-dir');

function repoCacheKey(repo, ref) {
  // "owner/name" + ref → "owner__name__ref"
  return repo.replace('/', '__') + '__' + ref.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function getRepoCacheDir(repo, ref) {
  return path.join(getCacheDir(), 'repos', repoCacheKey(repo, ref));
}

/**
 * Ensure the repo is available locally.
 * Returns the path to the cloned directory.
 */
async function fetchRepo(repo, ref, token, noFetch) {
  const resolvedRef = ref || 'HEAD';
  const cacheDir    = getRepoCacheDir(repo, resolvedRef);

  if (fs.existsSync(path.join(cacheDir, '.git'))) {
    if (noFetch) {
      logger.dim(`  ${repo} @ ${resolvedRef} (cache hit, --no-fetch)`);
    } else {
      logger.dim(`  ${repo} @ ${resolvedRef} (cached)`);
    }
    return cacheDir;
  }

  if (noFetch) {
    throw new Error(
      `Repo cache missing for ${repo}@${resolvedRef} and --no-fetch is set.\n` +
      `Run without --no-fetch first to populate the cache.`
    );
  }

  logger.step(`Cloning ${repo} @ ${resolvedRef} ...`);

  const cloneUrl = buildCloneUrl(repo, token);
  fs.mkdirSync(cacheDir, { recursive: true });

  const git = simpleGit();

  const cloneArgs = ['--depth=1'];
  if (resolvedRef !== 'HEAD') {
    cloneArgs.push('--branch', resolvedRef);
  }

  try {
    await git.clone(cloneUrl, cacheDir, cloneArgs);
  } catch (err) {
    // Clean up partial clone
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_) {}
    throw new Error(`Failed to clone ${repo}@${resolvedRef}: ${err.message}`);
  }

  logger.info(`Cloning ${repo} @ ${resolvedRef} ... done`);
  return cacheDir;
}

function buildCloneUrl(repo, token) {
  if (token) {
    return `https://${token}@github.com/${repo}.git`;
  }
  return `https://github.com/${repo}.git`;
}

module.exports = { fetchRepo, getRepoCacheDir };
