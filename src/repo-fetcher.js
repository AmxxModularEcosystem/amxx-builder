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
  // Lazy require: deps-resolver imports us, so a top-level import would cycle.
  const { normalize } = require('./deps-resolver');
  const key = normalize(repo).replace('/', '__') + '__' + String(ref).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(getCacheDir(), 'repos', key);
}

// Matches full or abbreviated commit SHAs (7-40 hex chars).
const SHA_REF_RE = /^[0-9a-f]{7,40}$/i;

const LATEST_TAG_TTL_MS = 60 * 60 * 1000; // releases update rarely

function latestTagIndexPath() {
  return path.join(getCacheDir(), '.latest-tags.json');
}

function readLatestTagIndex() {
  try { return JSON.parse(fs.readFileSync(latestTagIndexPath(), 'utf8')); } catch { return {}; }
}

function writeLatestTagIndex(index) {
  try {
    fs.mkdirSync(path.dirname(latestTagIndexPath()), { recursive: true });
    const tmp = latestTagIndexPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(index));
    fs.renameSync(tmp, latestTagIndexPath());
  } catch (_) { /* best-effort */ }
}

/**
 * Resolves "latest" ref to the actual release tag via GitHub API.
 * Cached per-repo (1h TTL) so repeated builds don't burn the rate limit.
 */
async function resolveRef(repo, ref, token) {
  if (ref !== 'latest') return ref;

  // Lazy require: deps-resolver imports us, so a top-level import would cycle.
  const { normalize } = require('./deps-resolver');
  const key = normalize(repo);
  const index = readLatestTagIndex();
  const cached = index[key];
  if (cached && Date.now() - cached.at < LATEST_TAG_TTL_MS) {
    logger.dim(`  ${repo}: latest = ${cached.tag} (cached)`);
    return cached.tag;
  }

  logger.dim(`  ${repo}: resolving latest release tag...`);
  const headers = token ? { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } : {};
  try {
    const { data } = await axios.get(
      `https://api.github.com/repos/${repo}/releases/latest`,
      { headers }
    );
    logger.dim(`  ${repo}: latest = ${data.tag_name}`);
    logger.verbose(`  ${repo}: resolved via GET /repos/${repo}/releases/latest`);
    index[key] = { tag: data.tag_name, at: Date.now() };
    writeLatestTagIndex(index);
    return data.tag_name;
  } catch (err) {
    throw new Error(`Failed to resolve latest release for ${repo}: ${err.message}`);
  }
}

/**
 * Resolve a ref to a concrete tag only when it is 'latest'.
 * Single-source-of-truth for the `ref === 'latest' ? resolveRef(...) : ref`
 * pattern shared by the build pipeline, include-tree and MCP.
 */
async function resolveRefIfLatest(ref, repo, token) {
  return ref !== 'latest' ? ref : resolveRef(repo, ref, token);
}

/**
 * Resolve the ref for every manifest repo and record it as `_resolvedRef`.
 * Single source of the "for each repo: ref === 'latest' → resolve tag" loop
 * shared by the build pipeline, deps-tree and include-tree. Repos with a
 * concrete ref get `_resolvedRef = repoConfig.ref`; `latest` refs are resolved
 * via the GitHub API (cached 1h). Rejects if any resolution fails.
 *
 * @param {Object[]} repos - manifest.repos entries ({ repo, ref, ... })
 * @param {(repo: string) => string|null} tokenFor - per-repo token resolver,
 *   e.g. (repo) => resolveGithubToken(manifest, repo)
 */
async function resolveRepoRefs(repos, tokenFor) {
  await Promise.all(repos.map(async (repoConfig) => {
    repoConfig._resolvedRef = await resolveRefIfLatest(
      repoConfig.ref,
      repoConfig.repo,
      tokenFor(repoConfig.repo)
    );
  }));
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

  if (await isCacheValid(cacheDir, resolvedRef)) {
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

  // Clone into a temp dir and atomically rename into place: a concurrent build
  // cloning the same repo never sees — or deletes — a half-written clone.
  const tmpDir = `${cacheDir}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.mkdirSync(path.dirname(tmpDir), { recursive: true });

  try {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' };
    const git = simpleGit({ env });
    await git.clone(cloneUrl, tmpDir, cloneArgs);
    if (isShaRef) {
      const shaGit = simpleGit({ baseDir: tmpDir, env });
      await shaGit.fetch(['--depth=1', 'origin', resolvedRef]);
      await shaGit.checkout(resolvedRef);
    }
    if (token && !ssh) await stripTokenFromRemote(tmpDir, repo);

    try {
      fs.renameSync(tmpDir, cacheDir);
    } catch {
      // cacheDir already exists — a concurrent clone (valid) or stale junk.
      if (await isCacheValid(cacheDir, resolvedRef)) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
      } else {
        try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_) {}
        fs.renameSync(tmpDir, cacheDir);
      }
    }
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    const msg = redactToken(err.message || '', token);
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

/**
 * True when the clone at cacheDir exists and actually contains the requested ref
 * (guards against partial clones left by a crashed process).
 */
async function isCacheValid(cacheDir, ref) {
  if (!fs.existsSync(path.join(cacheDir, '.git'))) return false;
  try {
    const verifyRef = ref && ref !== 'HEAD' ? `${ref}^{commit}` : 'HEAD';
    await simpleGit({ baseDir: cacheDir }).revparse(['--verify', verifyRef]);
    return true;
  } catch {
    return false;
  }
}

// The token is only needed during the clone; drop it from .git/config so it is
// not persisted on disk.
async function stripTokenFromRemote(cloneDir, repo) {
  await simpleGit({ baseDir: cloneDir }).remote(['set-url', 'origin', `https://github.com/${repo}.git`]);
}

function redactToken(msg, token) {
  return token ? String(msg).split(token).join('***') : String(msg);
}

function buildCloneUrl(repo, token, ssh) {
  if (ssh || !token) return `git@github.com:${repo}.git`;
  return `https://oauth2:${token}@github.com/${repo}.git`;
}

module.exports = { fetchRepo, resolveRef, resolveRefIfLatest, resolveRepoRefs, getRepoCacheDir };
