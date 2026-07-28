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

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a recursive dependency tree.
 *
 * @param {Object[]} rootDeps — root dep entries.
 *   Each entry: { repo, ref, source?, include_path?, asset? }
 * @param {Object} [options]
 * @param {string}   [options.token]       — GitHub PAT (falls back to env)
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
    token   = null,
    noFetch = false,
    depth   = 0,
    from: rootFrom = 'manifest',
    getDepsOverride = null,
  } = options;

  const visited = new Set(); // Set<"owner/repo@resolvedRef">
  const tree = [];

  for (const dep of rootDeps) {
    const node = await walkDep(dep, {
      token, noFetch, depth, visited,
      from: rootFrom,
      currentDepth: 0,
      getDepsOverride,
    });
    tree.push(node);
  }

  return { dependencies: tree };
}

// ─── Recursive walk ────────────────────────────────────────────────────────────

async function walkDep(dep, ctx) {
  const { token, noFetch, depth, visited, getDepsOverride } = ctx;

  const repo = dep.repo;
  const ref  = dep.ref || 'HEAD';

  // ── Resolve ref (e.g. "latest" → concrete tag) ──────────────────────────
  let resolvedRef;
  let refError = null;
  try {
    resolvedRef = await resolveRef(repo, dep.ref, token);
  } catch (err) {
    resolvedRef = null;
    refError = err.message;
  }

  // ── Cycle detection (using resolvedRef to catch "latest" dups) ──────────
  const normRepo  = repo.toLowerCase();
  const visitedKey = resolvedRef
    ? `${normRepo}@${resolvedRef}`
    : `${normRepo}@${ref}`; // if resolve failed, use original ref

  const isCycle = visited.has(visitedKey);

  // Mark visited before deeper recursion (even if resolve failed, prevents
  // infinite retry of unresolvable deps)
  if (resolvedRef) visited.add(visitedKey);

  // ── Check depth ─────────────────────────────────────────────────────────
  const currentDepth = ctx.currentDepth || 0;
  const atDepthLimit = depth > 0 && currentDepth >= depth;

  // ── Sub-dependencies ────────────────────────────────────────────────────
  let subDeps = [];
  let fetchError = null;

  if (!isCycle && !atDepthLimit && resolvedRef && dep.source !== 'release') {
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

module.exports = { buildDepTree };
