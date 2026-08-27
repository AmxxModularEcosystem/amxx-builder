'use strict';

/**
 * GitHub REST API helpers for repo-scope metadata (core, interface-agnostic).
 *
 * Used by the serve interface (`repos.info` / `repos.branches` /
 * `repos.structure`) and potentially other interfaces (MCP) — per AGENTS.md
 * the HTTP calls live here, not in the interface layer.
 *
 * Conventions:
 * - HTTP errors are normalized to `GithubError` with a numeric `status`
 *   (HTTP status when known, `null` for network/timeout errors).
 * - 404 from GitHub is deliberately NOT an error for the repo-scope methods:
 *   GitHub returns 404 both for nonexistent and for private/no-access repos,
 *   and the two cannot be distinguished even with a token. Callers get
 *   `{ exists: false, reason: 'not_found_or_no_access' }` instead.
 * - Tokens are never resolved here — callers pass the resolved token
 *   (see `resolveGithubToken` in src/manifest.js).
 */

const axios = require('axios');
// Same global default as release-lister; re-setting is idempotent and keeps
// this module's calls bounded even when loaded without release-lister.
axios.defaults.timeout = 30000;

/** "owner/repo" — no slashes inside the parts, no whitespace. */
const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

class GithubError extends Error {
  /**
   * @param {string} message - error text (GitHub's message when available)
   * @param {number|null} status - HTTP status, or null for network/timeout errors
   */
  constructor(message, status) {
    super(message);
    this.name = 'GithubError';
    this.status = status == null ? null : status;
  }
}

/**
 * @param {unknown} repo
 * @returns {boolean} true if `repo` looks like "owner/repo"
 */
function isValidRepo(repo) {
  return typeof repo === 'string' && REPO_RE.test(repo);
}

/**
 * Validate the filter/limit options of a repo-structure request.
 *
 * @param {{ depth?: unknown, dirsOnly?: unknown, ext?: unknown, maxEntries?: unknown }} options
 * @returns {string|null} error message, or null when the options are valid
 */
function validateRepoStructureOptions({ depth, dirsOnly, ext, maxEntries } = {}) {
  if (depth != null && (!Number.isInteger(depth) || depth < 1)) {
    return 'Invalid "depth": expected a positive integer';
  }
  if (maxEntries != null && (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 2000)) {
    return 'Invalid "maxEntries": expected an integer in 1..2000';
  }
  if (ext != null && (!Array.isArray(ext) || ext.some((e) => typeof e !== 'string' || e.length === 0))) {
    return 'Invalid "ext": expected an array of non-empty strings';
  }
  if (dirsOnly != null && typeof dirsOnly !== 'boolean') {
    return 'Invalid "dirsOnly": expected a boolean';
  }
  return null;
}

/**
 * GET a GitHub API URL with the same headers as release-lister
 * (`Accept: application/vnd.github+json`, Bearer token when present).
 * Non-2xx responses and network errors are normalized to `GithubError`.
 *
 * @param {string} url
 * @param {{ token?: string|null }} [options]
 * @returns {Promise<any>} parsed JSON body
 */
async function githubGet(url, { token } = {}) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const { data } = await axios.get(url, { headers });
    return data;
  } catch (err) {
    if (err.response) {
      const status = err.response.status;
      const message = (err.response.data && err.response.data.message) || err.message;
      throw new GithubError(message, status);
    }
    // No response: network error, DNS, timeout, ...
    throw new GithubError(err && err.message ? err.message : String(err), null);
  }
}

function notFoundResult(repo) {
  return { repo, exists: false, reason: 'not_found_or_no_access' };
}

/**
 * Repository existence + metadata.
 *
 * @param {string} repo - "owner/repo"
 * @param {{ token?: string|null }} [options]
 * @returns {Promise<object>} `{ exists: true, ...metadata }` or
 *   `{ exists: false, reason: 'not_found_or_no_access' }` on 404.
 *   Throws `GithubError` for non-404 errors (403/429/5xx/network).
 */
async function getRepoInfo(repo, { token } = {}) {
  let data;
  try {
    data = await githubGet(`https://api.github.com/repos/${repo}`, { token });
  } catch (err) {
    if (err instanceof GithubError && err.status === 404) return notFoundResult(repo);
    throw err;
  }

  return {
    repo,
    exists: true,
    private: data.private === true,
    archived: data.archived === true,
    disabled: data.disabled === true,
    defaultBranch: data.default_branch || null,
    description: data.description ?? null,
    pushedAt: data.pushed_at || null,
  };
}

/**
 * Branch list with the commit SHA of each branch head.
 *
 * @param {string} repo - "owner/repo"
 * @param {{ token?: string|null, limit?: number, page?: number }} [options]
 * @returns {Promise<object>} `{ repo, branches: [{ name, commitSha }] }`,
 *   `{ repo, branches: [] }` for an empty repo (409), or
 *   `{ exists: false, reason: 'not_found_or_no_access' }` on 404.
 *   Throws `GithubError` for non-404/409 errors.
 */
async function listBranches(repo, { token, limit = 10, page = 1 } = {}) {
  const perPage = Math.min(100, Math.max(1, limit));
  const pageNum = Math.max(1, page);

  let data;
  try {
    data = await githubGet(
      `https://api.github.com/repos/${repo}/branches?per_page=${perPage}&page=${pageNum}`,
      { token }
    );
  } catch (err) {
    if (err instanceof GithubError && err.status === 404) return notFoundResult(repo);
    if (err instanceof GithubError && err.status === 409) {
      // Empty repository (no commits yet) — no branches, not an error.
      return { repo, branches: [] };
    }
    throw err;
  }

  return {
    repo,
    branches: data.map((b) => ({
      name: b.name,
      commitSha: (b.commit && b.commit.sha) || null,
    })),
  };
}

/**
 * Filter a GitHub tree (from the Git Trees API) into the structure response.
 * Pure function — exported for tests.
 *
 * @param {Array<{ path: string, type: string, mode?: string }>} tree
 * @param {{ depth?: number, dirsOnly?: boolean, ext?: string[], maxEntries?: number }} [options]
 * @returns {{ entries: Array<{ path: string, type: 'dir'|'file' }>, truncated: boolean }}
 */
function filterTreeEntries(tree, { depth, dirsOnly = false, ext, maxEntries = 500 } = {}) {
  const cap = Math.max(1, Math.min(2000, maxEntries));
  const suffixes = Array.isArray(ext) && ext.length > 0
    ? ext.map((e) => String(e).replace(/^\./, '').toLowerCase())
    : null;

  const entries = [];
  let truncated = false;

  for (const item of tree) {
    if (entries.length >= cap) {
      truncated = true;
      break;
    }
    // GitHub types: "blob" (file), "tree" (dir), "commit" (submodule) — submodules
    // are skipped: they have no path content to copy.
    const type = item.type === 'tree' ? 'dir' : item.type === 'blob' ? 'file' : null;
    if (!type) continue;
    if (dirsOnly && type !== 'dir') continue;
    // "ext" restricts to matching files only — directories are filtered out too.
    if (suffixes) {
      if (type !== 'file') continue;
      const lower = item.path.toLowerCase();
      if (!suffixes.some((s) => lower.endsWith('.' + s))) continue;
    }
    if (depth != null && item.path.split('/').length > depth) continue;

    entries.push({ path: item.path, type });
  }

  return { entries, truncated };
}

/**
 * Repository file/folder structure via the Git Trees API
 * (`GET /repos/{owner}/{repo}/git/trees/{tree_sha}?recursive=1` — one call for
 * the whole tree; GitHub resolves branch/tag refs itself).
 *
 * When `ref` is omitted the default branch is resolved first via the repo
 * endpoint — the same call also verifies repo existence, so no extra API call
 * is spent on a separate existence check.
 *
 * @param {string} repo - "owner/repo"
 * @param {{ token?: string|null, ref?: string|null, depth?: number, dirsOnly?: boolean,
 *           ext?: string[], maxEntries?: number }} [options]
 * @returns {Promise<object>} `{ repo, ref, truncated, entries }`,
 *   `{ repo, ref, truncated: false, entries: [] }` for an empty repo (409), or
 *   `{ exists: false, reason: 'not_found_or_no_access' }` when the repo is
 *   gone/private. Throws `GithubError` for other errors — including a
 *   nonexistent `ref` on an existing repo (trees API answers 404, ambiguous
 *   with a missing repo; the repo endpoint is re-checked to disambiguate →
 *   `GithubError` 404 "Ref not found: <ref>").
 */
async function getRepoStructure(repo, { token, ref = null, depth, dirsOnly = false, ext, maxEntries = 500 } = {}) {
  let treeSha = ref;
  let usedRef = ref;
  let repoVerified = false;

  // Default depth: top level only — unlimited when ext is given (the
  // exclude-files use case needs the whole tree). Guards against fetching
  // the full tree of a huge repo when only a shallow listing is needed.
  const effectiveDepth = depth != null ? depth : (Array.isArray(ext) && ext.length > 0 ? undefined : 1);

  if (!treeSha) {
    let info;
    try {
      info = await getRepoInfo(repo, { token });
    } catch (err) {
      throw err; // non-404 GithubError → caller decides how to surface it
    }
    if (!info.exists) return notFoundResult(repo);
    if (!info.defaultBranch) {
      // Repo without a default branch configured — nothing to list.
      return { repo, ref: null, truncated: false, entries: [] };
    }
    treeSha = info.defaultBranch;
    usedRef = info.defaultBranch;
    repoVerified = true;
  }

  let data;
  try {
    data = await githubGet(
      `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
      { token }
    );
  } catch (err) {
    if (err instanceof GithubError && err.status === 404) {
      // The trees API answers 404 both for a missing/private repo AND for a
      // nonexistent branch/tag (422 is only for malformed 40-hex SHAs). When
      // the repo was not just verified, re-check its existence to tell the
      // two apart.
      if (!repoVerified) {
        let info;
        try {
          info = await getRepoInfo(repo, { token });
        } catch (checkErr) {
          throw checkErr; // non-404 GithubError from the repo re-check
        }
        if (!info.exists) return notFoundResult(repo);
      }
      // Repo is alive (just verified, or verified while resolving the default
      // branch) → the ref itself is the problem.
      throw new GithubError(`Ref not found: ${treeSha}`, 404);
    }
    if (err instanceof GithubError && err.status === 409) {
      // Empty repository (no commits yet) — no tree.
      return { repo, ref: usedRef, truncated: false, entries: [] };
    }
    throw err;
  }

  const filtered = filterTreeEntries(data.tree || [], { depth: effectiveDepth, dirsOnly, ext, maxEntries });
  return {
    repo,
    ref: usedRef,
    // GitHub-side truncation (100k entries) also makes the answer incomplete.
    truncated: data.truncated === true || filtered.truncated,
    entries: filtered.entries,
  };
}

module.exports = {
  GithubError,
  isValidRepo,
  validateRepoStructureOptions,
  githubGet,
  getRepoInfo,
  listBranches,
  getRepoStructure,
  filterTreeEntries,
};
