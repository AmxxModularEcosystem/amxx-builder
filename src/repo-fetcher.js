const fs   = require('fs');
const path = require('path');
const axios = require('axios');
// Default for API calls; download sites pass their own longer timeout.
axios.defaults.timeout = 30000;
const simpleGit = require('simple-git');
const logger = require('./logger');
const { getCacheDir } = require('./cache-dir');

function getRepoCacheDir(repo, ref) {
  // Lowercased key: GitHub repo names are case-insensitive, but filesystems
  // (NTFS/APFS) and the repo/ref dedup may not be — normalize to avoid
  // duplicate clones on Linux and dir collisions on Windows/macOS.
  const key = repo.toLowerCase().replace('/', '__') + '__' + String(ref).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(getCacheDir(), 'repos', key);
}

// Matches full or abbreviated commit SHAs (7-40 hex chars).
const SHA_REF_RE = /^[0-9a-f]{7,40}$/i;

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
    logger.verbose(`  ${repo}: resolved via GET /repos/${repo}/releases/latest`);
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
  const isShaRef  = SHA_REF_RE.test(resolvedRef || '');
  // Windows: allow >260-char paths and keep file contents identical across OSes
  // (core.autocrlf would rewrite .sma/.inc/.cfg to CRLF and break hashing/output).
  const cloneArgs = ['--depth=1', '-c', 'core.longpaths=true', '-c', 'core.autocrlf=false'];
  // Shallow clones cannot fetch arbitrary SHAs via --branch; clone the default
  // branch and fetch/checkout the SHA explicitly afterwards.
  if (resolvedRef && !isShaRef) cloneArgs.push('--branch', resolvedRef);

  fs.mkdirSync(cacheDir, { recursive: true });

  try {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' };
    const git = simpleGit({ env });
    await git.clone(cloneUrl, cacheDir, cloneArgs);
    if (isShaRef) {
      const shaGit = simpleGit({ baseDir: cacheDir, env });
      await shaGit.fetch(['--depth=1', 'origin', resolvedRef]);
      await shaGit.checkout(resolvedRef);
    }
  } catch (err) {
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_) {}
    const msg = err.message || '';
    let hint = '';
    if (/repository not found|does not exist/i.test(msg)) {
      hint = '\n  → Check the repo name, or set github.token_env if the repo is private';
    } else if (/authentication failed|could not read/i.test(msg)) {
      hint = '\n  → Check your GitHub token (github.token_env / GITHUB_TOKEN)';
    } else if (/could not resolve host/i.test(msg)) {
      hint = '\n  → Check your internet connection';
    }
    throw new Error(`Failed to clone ${repo}@${cacheKey}: ${msg}${hint}`);
  }

  logger.info(`Cloning ${repo} @ ${cacheKey} ... done`);
  return cacheDir;
}

function buildCloneUrl(repo, token, ssh) {
  if (ssh || !token) return `git@github.com:${repo}.git`;
  return `https://oauth2:${token}@github.com/${repo}.git`;
}

module.exports = { fetchRepo, resolveRef, getRepoCacheDir };
