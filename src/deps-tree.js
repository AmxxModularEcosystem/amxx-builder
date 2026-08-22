'use strict';

/**
 * Recursive dependency tree builder.
 *
 * Walks a list of dep entries, fetches each repo, reads its DEPS_LIST (or
 * deps_override callback), and recursively resolves sub-dependencies.
 *
 * Used by:
 *   - CLI: amxb deps-tree
 *   - MCP: get_dep_tree tool
 *
 * No domain-specific logic — pure tree traversal with cycle detection.
 */

const fs   = require('fs');
const path = require('path');

const { fetchRepo, resolveRef } = require('./repo-fetcher');
const { parseDepsLines }        = require('./manifest');
const { normalize }             = require('./deps-resolver');

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a recursive dependency tree.
 *
 * @param {Object[]} rootDeps — root dep entries.
 *   Each entry: { repo, ref, source?, include_path?, asset? }
 * @param {Object} [options]
 * @param {string}   [options.token]       — GitHub PAT (falls back to env)
 * @param {Function} [options.tokenFor]    — (repo) => token; per-owner token resolver.
 *   When provided, takes precedence over options.token for every dep node.
 * @param {boolean}  [options.noFetch]     — only use cache, skip network
 * @param {number}   [options.depth]       — max depth (0 = unlimited)
 * @param {string}   [options.from]        — origin label for root deps ('manifest')
 * @param {Function} [options.getDepsOverride] — (repo) => dep[] | null;
 *   Called for each dep node before reading DEPS_LIST. If it returns an array,
 *   those entries are used instead of reading the repo's DEPS_LIST file.
 * @returns {Promise<{ dependencies: Object[] }>}
 */
async function buildDepTree(rootDeps, options = {}) {
  const {
    token    = null,
    tokenFor = null,
    noFetch  = false,
    depth    = 0,
    from: rootFrom = 'manifest',
    getDepsOverride = null,
  } = options;

  const resolveToken = tokenFor || (() => token);

  const visited   = new Set(); // Set<"owner/repo@resolvedRef"> — already expanded globally
  const pathStack = new Set(); // current recursion path — a dep seen here is a TRUE cycle
  const tree = [];

  for (const dep of rootDeps) {
    const node = await walkDep(dep, {
      resolveToken, noFetch, depth, visited, pathStack,
      from: rootFrom,
      currentDepth: 0,
      getDepsOverride,
    });
    tree.push(node);
  }

  return { dependencies: tree };
}

/**
 * Assemble root deps for the dependency tree from a resolved manifest.
 * Single source of truth shared by the CLI `amxb deps-tree` command and the
 * MCP `get_dep_tree` tool.
 *
 * Mirrors the historical behavior of both callers:
 *   - manifest.repos       → { ...repoConfig, _from: 'repo' } (repo/ref plus
 *     preserved repo fields, tagged with their origin)
 *   - manifest.globalDeps  → { ...dep, _from: 'manifest' }
 *   - getDepsOverride(repo) → the repo config's deps_override, or null
 *
 * @param {object} manifest - resolved manifest (parseManifest output)
 * @returns {{ rootDeps: Object[], getDepsOverride: (repo: string) => Object[]|null }}
 */
function assembleRootDeps(manifest) {
  const rootDeps = [];
  for (const repoConfig of manifest.repos) {
    rootDeps.push({ ...repoConfig, _from: 'repo' });
  }
  for (const dep of manifest.globalDeps) {
    rootDeps.push({ ...dep, _from: 'manifest' });
  }
  const getDepsOverride = (repo) => {
    const config = manifest.repos.find((r) => r.repo === repo);
    return config ? config.deps_override : null;
  };
  return { rootDeps, getDepsOverride };
}

// ─── Recursive walk ────────────────────────────────────────────────────────────

async function walkDep(dep, ctx) {
  const { resolveToken, noFetch, depth, visited, pathStack, getDepsOverride } = ctx;

  const repo = dep.repo;
  const ref  = dep.ref || 'HEAD';
  const token = resolveToken(repo);

  // ── Resolve ref (e.g. "latest" → concrete tag) ──────────────────────────
  let resolvedRef;
  let refError = null;
  try {
    resolvedRef = await resolveRef(repo, dep.ref, token);
  } catch (err) {
    resolvedRef = null;
    refError = err.message;
  }

  // ── Cycle vs shared detection ───────────────────────────────────────────
  const normRepo  = normalize(repo);
  const visitedKey = resolvedRef
    ? `${normRepo}@${resolvedRef}`
    : `${normRepo}@${ref}`; // if resolve failed, use original ref

  const isCycle  = pathStack.has(visitedKey); // on the current path → real cycle
  const isShared = visited.has(visitedKey);   // expanded elsewhere → diamond/shared dep
  const skipExpand = isCycle || isShared;

  if (resolvedRef) {
    pathStack.add(visitedKey);
    visited.add(visitedKey);
  }

  // ── Check depth ─────────────────────────────────────────────────────────
  const currentDepth = ctx.currentDepth || 0;
  const atDepthLimit = depth > 0 && currentDepth >= depth;

  // ── Sub-dependencies ────────────────────────────────────────────────────
  let subDeps = [];
  let fetchError = null;

  if (!skipExpand && !atDepthLimit && resolvedRef && dep.source !== 'release') {
    try {
      const result = await getSubDeps(dep, resolvedRef, token, noFetch, getDepsOverride);
      for (const subDep of result.deps) {
        const childNode = await walkDep(subDep, {
          ...ctx,
          from: result.from,
          currentDepth: currentDepth + 1,
        });
        subDeps.push(childNode);
      }
    } catch (err) {
      fetchError = err.message;
    }
  }

  if (resolvedRef) pathStack.delete(visitedKey);

  // ── Build node ──────────────────────────────────────────────────────────
  return {
    repo,
    ref:         dep.ref || null,
    resolvedRef,
    source:      dep.source || 'git',
    include_path: dep.include_path || null,
    asset:       dep.asset != null ? dep.asset : null,
    from:        ctx.from,
    error:       refError || fetchError || null,
    cycle:       isCycle,
    shared:      isShared,
    dependencies: subDeps,
  };
}

// ─── Read sub-deps from repo or override ──────────────────────────────────────

async function getSubDeps(dep, resolvedRef, token, noFetch, getDepsOverride) {
  // 1. Check for deps_override first
  if (typeof getDepsOverride === 'function') {
    const override = getDepsOverride(dep.repo);
    if (override && Array.isArray(override) && override.length > 0) {
      return { deps: override, from: 'deps_override' };
    }
  }

  // 2. Clone repo (or use cache) and read DEPS_LIST
  const repoDir = await fetchRepo(dep.repo, resolvedRef, token, noFetch, false);
  const depsPath = path.join(repoDir, 'DEPS_LIST');

  if (!fs.existsSync(depsPath)) {
    return { deps: [], from: 'deps_list' };
  }

  const lines = fs.readFileSync(depsPath, 'utf8').split(/\r?\n/);
  const parsed = parseDepsLines(lines);
  return { deps: parsed, from: 'deps_list' };
}

// ─── Exports ────────────────────────────────────────────────────────────────────

module.exports = { buildDepTree, assembleRootDeps };
