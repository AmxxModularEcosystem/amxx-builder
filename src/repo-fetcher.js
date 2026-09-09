/**
 * Repo fetching with commit-pinned cache semantics.
 *
 * A ref that "moves" — the default branch (null ref) or a branch name — must
 * not be cached forever under the ref name: fetchRepo resolves it to the commit
 * SHA it points at right now and keys the clone cache on that SHA, so an
 * upstream push never serves a stale tree and two branch states never share a
 * dir. Tags cannot be told apart from branches by shape alone, so they resolve
 * through the same machinery: a stable tag yields the same SHA every hour and
 * the TTL-extension rule keeps its existing cache warm with zero re-download,
 * while a force-pushed tag behaves correctly too. Pinned SHA refs (7-40 hex)
 * skip resolution and keep the old ref-keyed fast path. `latest` is resolved to
 * a concrete tag by resolveRef() before any fetch and is otherwise untouched.
 *
 * Resolutions are cached in <cache>/.ref-heads.json with a 1h TTL (same cadence
 * as the latest-tag cache) so repeated builds do not hit the GitHub API for
 * every repo.
 */

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

// Ref→SHA resolutions are cheap to refresh and share the 1h cadence.
const REF_HEAD_TTL_MS = 60 * 60 * 1000;

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

function refHeadsIndexPath() {
  return path.join(getCacheDir(), '.ref-heads.json');
}

function readRefHeadsIndex() {
  try { return JSON.parse(fs.readFileSync(refHeadsIndexPath(), 'utf8')); } catch { return {}; }
}

function writeRefHeadsIndex(index) {
  try {
    fs.mkdirSync(path.dirname(refHeadsIndexPath()), { recursive: true });
    const tmp = refHeadsIndexPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(index));
    fs.renameSync(tmp, refHeadsIndexPath());
  } catch (_) { /* best-effort */ }
}

// All writers go through this chain so concurrent read-modify-write cycles for
// different repos never drop each other's entries.
let refHeadsWriteChain = Promise.resolve();
function updateRefHeadIndex(key, entry) {
  refHeadsWriteChain = refHeadsWriteChain.then(() => {
    const index = readRefHeadsIndex();
    index[key] = entry;
    writeRefHeadsIndex(index);
  });
  return refHeadsWriteChain;
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

// ─── Moving-ref head resolution ─────────────────────────────────────────────

// A ref that moves under the repo: the default branch (null) or a name that is
// not already a pinned SHA (SHA_REF_RE). Tags count as moving too — see the
// module docstring. 'latest' is a meta-ref resolved to a tag before fetchRepo,
// never a branch — excluding it keeps a stray direct call on the old path.
function isMovingRef(ref) {
  return ref !== 'latest' && !SHA_REF_RE.test(ref || '');
}

function refHeadKey(repo, ref) {
  // Lazy require: deps-resolver imports us, so a top-level import would cycle.
  const { normalize } = require('./deps-resolver');
  return `${normalize(repo)}@${ref || 'HEAD'}`;
}

function apiHeaders(token) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// Resolve a branch/tag name to the commit SHA its head points at right now.
// Slashes in the ref (feature/foo) stay path separators; the rest is encoded.
async function fetchCommitSha(repo, refName, headers) {
  const encoded = refName.split('/').map(encodeURIComponent).join('/');
  const { data } = await axios.get(
    `https://api.github.com/repos/${repo}/commits/${encoded}`,
    { headers }
  );
  return data.sha;
}

// Reuse the last-known default-branch name so the hourly refresh of a null ref
// costs one API call; only a fresh repo pays an extra call to learn it.
async function resolveDefaultBranch(repo, cachedBranch, headers) {
  if (cachedBranch) return cachedBranch;
  const { data } = await axios.get(`https://api.github.com/repos/${repo}`, { headers });
  if (!data || !data.default_branch) throw new Error('repo metadata has no default_branch');
  return data.default_branch;
}

function isNotFound(err) {
  return err.response && err.response.status === 404;
}

// In-process dedup: parallel fetches of the same repo@ref resolve once.
const inflightRefHeads = new Map();

async function resolveRefHeadFromNetwork(repo, ref, key, cached, token) {
  const headers = apiHeaders(token);
  const label   = ref || 'HEAD';
  try {
    let branch = ref || (cached && cached.branch) || null;
    if (!branch) branch = await resolveDefaultBranch(repo, null, headers);
    let sha;
    try {
      sha = await fetchCommitSha(repo, branch, headers);
    } catch (err) {
      // A null ref whose recorded default branch is gone (renamed/deleted):
      // re-ask the repo endpoint once before giving up.
      if (ref === null && cached && cached.branch && isNotFound(err)) {
        branch = await resolveDefaultBranch(repo, null, headers);
        sha = await fetchCommitSha(repo, branch, headers);
      } else {
        throw err;
      }
    }
    logger.dim(`  ${repo} @ ${label} = ${sha} (resolved)`);
    await updateRefHeadIndex(key, { sha, branch: ref ? null : branch, at: Date.now() });
    return { sha };
  } catch (err) {
    if (cached) {
      logger.warn(
        `  ${repo} @ ${label}: head re-resolution failed (${err.message}); reusing cached ${cached.sha}`
      );
      return { sha: cached.sha, resolveError: wrapResolveError(err, repo, label, token) };
    }
    throw wrapResolveError(err, repo, label, token);
  }
}

/**
 * Resolve a moving ref to the commit SHA to fetch. Results are cached in
 * .ref-heads.json for 1h; a cached resolution is also reused when it is stale
 * (--no-fetch never hits the network) or when a refresh fails but a previous
 * resolution exists — both keep the build on the last-known good head.
 * Returns null when --no-fetch has nothing cached to go on.
 */
async function resolveRefHead(repo, ref, token, noFetch) {
  const key    = refHeadKey(repo, ref);
  const label  = ref || 'HEAD';
  const cached = readRefHeadsIndex()[key];

  if (cached && Date.now() - cached.at < REF_HEAD_TTL_MS) {
    logger.dim(`  ${repo} @ ${label} = ${cached.sha} (cached)`);
    return { sha: cached.sha };
  }

  if (noFetch) {
    if (cached) {
      logger.dim(`  ${repo} @ ${label}: using cached head ${cached.sha} (--no-fetch)`);
      return { sha: cached.sha };
    }
    return null;
  }

  logger.dim(`  ${repo} @ ${label}: resolving head...`);
  if (!inflightRefHeads.has(key)) {
    inflightRefHeads.set(key, resolveRefHeadFromNetwork(repo, ref, key, cached, token));
  }
  try {
    return await inflightRefHeads.get(key);
  } finally {
    inflightRefHeads.delete(key);
  }
}

// --no-fetch with no recorded head: adopt the most recent valid clone of this
// repo whose dir is keyed on a full SHA (any earlier branch state). Mirrors how
// --no-fetch tolerates a stale cache — the ref simply cannot be re-resolved.
function findCachedRepoHeadDir(repo, ssh) {
  const { normalize } = require('./deps-resolver');
  const prefix = normalize(repo).replace('/', '__') + '__';
  const reposDir = path.join(getCacheDir(), 'repos');
  if (!fs.existsSync(reposDir)) return null;

  let best = null;
  let bestTime = 0;
  for (const name of fs.readdirSync(reposDir)) {
    if (!name.startsWith(prefix)) continue;
    const sha = name.slice(prefix.length);
    if (!/^[0-9a-f]{40}$/i.test(sha)) continue; // only SHA-keyed clone dirs
    const dir = path.join(reposDir, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    if (!isCacheValidSync(dir, sha, ssh)) continue;
    const mtime = fs.statSync(dir).mtimeMs;
    if (mtime > bestTime) { best = { sha, dir }; bestTime = mtime; }
  }
  return best;
}

// Sync twin of isCacheValid for the dir scan above (it is already async-shaped
// only because of simple-git; the non-git branch is pure fs).
function isCacheValidSync(cacheDir, ref, gitBased) {
  if (!gitBased) {
    return fs.existsSync(path.join(cacheDir, '.extracted')) ||
           fs.existsSync(path.join(cacheDir, '.git'));
  }
  return fs.existsSync(path.join(cacheDir, '.git'));
}

/**
 * Ensures the repo is available locally. Returns the local path.
 *
 * Moving refs (default branch, branch names, tags) are resolved to the commit
 * SHA they currently point at and the clone cache is keyed on that SHA, so a
 * branch that moved upstream is re-downloaded into a fresh dir while the old
 * dir stays untouched. Pinned SHA refs skip resolution entirely.
 *
 * Two fetch paths:
 *   ssh=true  → clone via system git (simple-git): URL is always
 *               git@github.com:owner/repo.git, no token handling.
 *   otherwise → download the GitHub tarball (codeload) over plain HTTP and
 *               extract it — no system git needed. A 404 with a token present
 *               retries once through the API tarball endpoint (private repos).
 */
async function fetchRepo(repo, ref, token, noFetch, ssh = false) {
  const resolvedRef = ref || null;  // null = default branch
  const refLabel    = resolvedRef || 'HEAD';
  let fetchRef      = resolvedRef;
  let resolveError  = null;

  if (isMovingRef(resolvedRef)) {
    // null (no recorded head) only happens under --no-fetch.
    const head = await resolveRefHead(repo, resolvedRef, token, noFetch);
    if (head) {
      fetchRef     = head.sha;
      resolveError = head.resolveError || null;
    }
  }

  const cacheDir = fetchRef ? getRepoCacheDir(repo, fetchRef) : null;

  if (cacheDir && await isCacheValid(cacheDir, fetchRef, ssh)) {
    logger.dim(`  ${repo} @ ${refLabel} (cached)`);
    return cacheDir;
  }

  if (noFetch) {
    // The recorded head's dir is gone (or was never recorded): fall back to the
    // most recent valid SHA-keyed clone of this repo — the same stale-cache
    // tolerance --no-fetch already had when a branch-name dir stayed valid.
    if (isMovingRef(resolvedRef)) {
      const found = findCachedRepoHeadDir(repo, ssh);
      if (found) {
        if (await isCacheValid(found.dir, found.sha, ssh)) {
          logger.dim(`  ${repo} @ ${refLabel}: using cached ${found.sha} (--no-fetch)`);
          return found.dir;
        }
      }
    }
    throw new Error(
      `Repo cache missing for ${repo}@${refLabel} and --no-fetch is set.\n` +
      `Run without --no-fetch to populate the cache.`
    );
  }

  // Offline head resolution with nothing usable on disk: surface the resolve
  // error (with its hint) instead of attempting a doomed download.
  if (resolveError) throw resolveError;

  logger.step(`Fetching ${repo} @ ${refLabel} ...`);

  // Fetch into a temp dir and atomically rename into place: a concurrent build
  // fetching the same repo never sees — or deletes — a half-written cache.
  const tmpDir = `${cacheDir}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.mkdirSync(path.dirname(tmpDir), { recursive: true });

  try {
    if (ssh) {
      await cloneViaGit(repo, fetchRef, tmpDir);
    } else {
      await fetchTarball(repo, fetchRef, token, tmpDir);
    }

    try {
      fs.renameSync(tmpDir, cacheDir);
    } catch {
      // cacheDir already exists — a concurrent fetch (valid) or stale junk.
      if (await isCacheValid(cacheDir, fetchRef, ssh)) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
      } else {
        try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_) {}
        fs.renameSync(tmpDir, cacheDir);
      }
    }
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    throw wrapFetchError(err, repo, refLabel, token);
  }

  logger.info(`Fetching ${repo} @ ${refLabel} ... done`);
  return cacheDir;
}

/**
 * SSH path (github.ssh: true): clone via system git. Moving refs arrive here
 * already resolved to a commit SHA, which is fetched + checked out explicitly
 * because shallow clones cannot fetch arbitrary SHAs via --branch; a non-SHA
 * ref (stray direct call with a pinned branch/tag name) is shallow-cloned via
 * --branch as before.
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
 * into tmpDir. For moving refs the downloadRef is the resolved commit SHA (the
 * sentinel below records it); pinned SHA refs pass themselves through. codeload
 * accepts branches, tags, short/full SHAs and HEAD.
 * A 404 with a token present means the repo is private (or the ref needs
 * auth): retry once via the API tarball endpoint, which 302-redirects to a
 * signed codeload URL (axios follows the redirect). The token only ever
 * travels in request headers — never in a URL or on disk.
 */
async function fetchTarball(repo, downloadRef, token, tmpDir) {
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

// Maps an axios-style error to the established fetch hint set below.
function errorHint(err) {
  const status = err.response && err.response.status;
  if (status === 404) {
    return '\n  → Check the repo name/ref, or set github.token_env if the repo is private';
  }
  if (status === 401 || status === 403) {
    return '\n  → Check your GitHub token (github.token_env / GITHUB_TOKEN)';
  }
  return '\n  → Check your internet connection';
}

function wrapFetchError(err, repo, cacheKey, token) {
  const msg = redactToken(err.message || '', token);
  return new Error(`Failed to fetch ${repo}@${cacheKey}: ${msg}${errorHint(err)}`);
}

// Mirrors the "Failed to resolve latest release for …" phrasing used for the
// latest-tag API, so a moving-ref resolution failure reads the same way.
function wrapResolveError(err, repo, refLabel, token) {
  const msg = redactToken(err.message || '', token);
  return new Error(`Failed to resolve ref ${refLabel} of ${repo}: ${msg}${errorHint(err)}`);
}

module.exports = { fetchRepo, resolveRef, resolveRefIfLatest, resolveRepoRefs, getRepoCacheDir, isCacheValid };
