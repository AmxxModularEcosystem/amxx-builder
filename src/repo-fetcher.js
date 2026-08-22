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
 * Ensures the repo is available locally. Returns the local path.
 *
 * Two paths:
 *   ssh=true  → clone via system git (simple-git): URL is always
 *               git@github.com:owner/repo.git, no token handling.
 *   otherwise → download the GitHub tarball (codeload) over plain HTTP and
 *               extract it — no system git needed. A 404 with a token present
 *               retries once through the API tarball endpoint (private repos).
 */
async function fetchRepo(repo, ref, token, noFetch, ssh = false) {
  const resolvedRef = ref || null;  // null = default branch
  const cacheKey    = resolvedRef || 'HEAD';
  const cacheDir    = getRepoCacheDir(repo, cacheKey);

  if (await isCacheValid(cacheDir, resolvedRef, ssh)) {
    logger.dim(`  ${repo} @ ${cacheKey} (cached)`);
    return cacheDir;
  }

  if (noFetch) {
    throw new Error(
      `Repo cache missing for ${repo}@${cacheKey} and --no-fetch is set.\n` +
      `Run without --no-fetch to populate the cache.`
    );
  }

  logger.step(`Fetching ${repo} @ ${cacheKey} ...`);

  // Fetch into a temp dir and atomically rename into place: a concurrent build
  // fetching the same repo never sees — or deletes — a half-written cache.
  const tmpDir = `${cacheDir}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.mkdirSync(path.dirname(tmpDir), { recursive: true });

  try {
    if (ssh) {
      await cloneViaGit(repo, resolvedRef, tmpDir);
    } else {
      await fetchTarball(repo, resolvedRef, token, tmpDir);
    }

    try {
      fs.renameSync(tmpDir, cacheDir);
    } catch {
      // cacheDir already exists — a concurrent fetch (valid) or stale junk.
      if (await isCacheValid(cacheDir, resolvedRef, ssh)) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
      } else {
        try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_) {}
        fs.renameSync(tmpDir, cacheDir);
      }
    }
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    throw wrapFetchError(err, repo, cacheKey, token);
  }

  logger.info(`Fetching ${repo} @ ${cacheKey} ... done`);
  return cacheDir;
}

/**
 * SSH path (github.ssh: true): clone via system git — kept verbatim.
 * Shallow clone of the default branch (--branch for tags/branches); SHA refs
 * are fetched + checked out explicitly because shallow clones cannot fetch
 * arbitrary SHAs via --branch.
 */
async function cloneViaGit(repo, resolvedRef, tmpDir) {
  const isShaRef  = SHA_REF_RE.test(resolvedRef || '');
  // Windows: allow >260-char paths and keep file contents identical across OSes
  // (core.autocrlf would rewrite .sma/.inc/.cfg to CRLF and break hashing/output).
  const cloneArgs = ['--depth=1', '-c', 'core.longpaths=true', '-c', 'core.autocrlf=false'];
  if (resolvedRef && !isShaRef) cloneArgs.push('--branch', resolvedRef);

  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' };
  const git = simpleGit({ env });
  await git.clone(`git@github.com:${repo}.git`, tmpDir, cloneArgs);
  if (isShaRef) {
    const shaGit = simpleGit({ baseDir: tmpDir, env });
    await shaGit.fetch(['--depth=1', 'origin', resolvedRef]);
    await shaGit.checkout(resolvedRef);
  }
}

/**
 * Non-ssh path: download the repo tarball as a plain HTTP GET and extract it
 * into tmpDir. downloadRef is passed straight to codeload — it accepts
 * branches, tags, short/full SHAs and HEAD, so no SHA-resolution calls.
 * A 404 with a token present means the repo is private (or the ref needs
 * auth): retry once via the API tarball endpoint, which 302-redirects to a
 * signed codeload URL (axios follows the redirect). The token only ever
 * travels in request headers — never in a URL or on disk.
 */
async function fetchTarball(repo, resolvedRef, token, tmpDir) {
  const downloadRef = resolvedRef || 'HEAD';
  // Lazy require: release-fetcher imports repo-fetcher at top level.
  const { downloadAsset } = require('./release-fetcher');
  const { safeExtractTar } = require('./fs-utils');

  // downloadAsset writes <archivePath>.part — the parent dir must exist.
  fs.mkdirSync(tmpDir, { recursive: true });

  const archivePath = path.join(tmpDir, 'repo.tar.gz');
  try {
    await downloadAsset(`https://codeload.github.com/${repo}/tar.gz/${downloadRef}`, archivePath, {});
  } catch (err) {
    if (!(err.response && err.response.status === 404 && token)) throw err;
    await downloadAsset(
      `https://api.github.com/repos/${repo}/tarball/${downloadRef}`,
      archivePath,
      { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` }
    );
  }

  safeExtractTar(archivePath, tmpDir, { stripComponents: 1 });
  fs.rmSync(archivePath, { force: true });
  // Sentinel written inside tmpDir BEFORE the rename: only complete dirs
  // ever become the cache.
  const sentinelTmp = path.join(tmpDir, '.extracted.tmp');
  fs.writeFileSync(sentinelTmp, downloadRef, 'utf8');
  fs.renameSync(sentinelTmp, path.join(tmpDir, '.extracted'));
}

/**
 * True when the fetch cache at cacheDir exists and is usable.
 * gitBased (github.ssh: true) → a real git clone whose ref resolves
 * (guards against partial clones left by a crashed process).
 * Non-git → an extracted tarball (sentinel) or a legacy git clone — old
 * caches stay valid so no mass re-download after upgrading.
 */
async function isCacheValid(cacheDir, ref, gitBased = false) {
  if (!gitBased) {
    return fs.existsSync(path.join(cacheDir, '.extracted')) ||
           fs.existsSync(path.join(cacheDir, '.git'));
  }
  if (!fs.existsSync(path.join(cacheDir, '.git'))) return false;
  try {
    const verifyRef = ref && ref !== 'HEAD' ? `${ref}^{commit}` : 'HEAD';
    await simpleGit({ baseDir: cacheDir }).revparse(['--verify', verifyRef]);
    return true;
  } catch {
    return false;
  }
}

function redactToken(msg, token) {
  return token ? String(msg).split(token).join('***') : String(msg);
}

/**
 * Maps failures to the established hints: HTTP status when available
 * (axios errors), otherwise treat as a network problem.
 */
function wrapFetchError(err, repo, cacheKey, token) {
  const msg    = redactToken(err.message || '', token);
  const status = err.response && err.response.status;
  let hint;
  if (status === 404) {
    hint = '\n  → Check the repo name/ref, or set github.token_env if the repo is private';
  } else if (status === 401 || status === 403) {
    hint = '\n  → Check your GitHub token (github.token_env / GITHUB_TOKEN)';
  } else {
    hint = '\n  → Check your internet connection';
  }
  return new Error(`Failed to fetch ${repo}@${cacheKey}: ${msg}${hint}`);
}

module.exports = { fetchRepo, resolveRef, resolveRefIfLatest, resolveRepoRefs, getRepoCacheDir, isCacheValid };
