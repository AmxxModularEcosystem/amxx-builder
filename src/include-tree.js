'use strict';

/**
 * AMXX Include Tree — bidirectional #include dependency graph builder.
 *
 * Core engine that:
 *   - Scans all .sma files (local + repos) as roots
 *   - Parses #include / #tryinclude directives in .sma and .inc files
 *   - Resolves includes using the same logic as amxxpc (quoted → local first,
 *     angle → include dirs)
 *   - Detects include guards (#if defined … #endinput … #endif … #define)
 *     to avoid re-expanding already-guarded files within a root's tree
 *   - Builds a bidirectional graph so you can traverse both DOWN
 *     (root → transitive includes) and UP (leaf → roots that reach it)
 *   - Formats the result as a human-readable tree or raw JSON
 *
 * Public API:
 *   const { buildIncludeTree } = require('./include-tree');
 *   const result = await buildIncludeTree(manifestPath, targetPath, options);
 *   // result.text  — formatted tree string
 *   // result.tree  — structured tree data (JSON-safe)
 *   // result.graph — full graph object (for programmatic use)
 */

const fs   = require('fs');
const path = require('path');
const glob = require('fast-glob');

const { parseManifest }     = require('./manifest');
const { fetchCompiler, fetchLatestVersion } = require('./compiler-fetcher');
const { fetchRepo, resolveRef } = require('./repo-fetcher');
const { fetchReleaseDep }   = require('./release-fetcher');

// ─── Regex ───────────────────────────────────────────────────────────────────

/** Matches #include <file> and #include "file" (and #tryinclude variants). */
const RE_INCLUDE = /^[ \t]*#(?:try)?include[ \t]+([<"])([^>"]+)[>"][ \t]*(?:\/\/.*)?$/gm;

/** Matches #if defined <GUARD> — the start of an include guard block. */
const RE_IF_DEFINED = /^[ \t]*#if[ \t]+defined[ \t]+(\w+)/m;

/** Matches #define <GUARD> — the companion define of an include guard. */
const RE_DEFINE = (guard) => new RegExp(
  '^[ \\t]*#define[ \\t]+' + guard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  'm'
);

// ─── IncludeGraph — bidirectional graph of #include relationships ────────────

class IncludeGraph {
  constructor() {
    /** Map<absPath, IncludeNode> */
    this.nodes = new Map();

    /** absPath of all discovered .sma root files */
    this.roots = [];

    /**
     * Ordered list of directories and their labels for resolving
     * <angle> includes (and "quoted" fallback).
     * @type {{ path: string, label: string }[]}
     */
    this.includeDirs = [];
  }

  // ── Node management ──────────────────────────────────────────────────────

  /**
   * Get or create a node for an absolute path.
   * @param {string} absPath
   * @param {object} [meta] - Optional metadata (name, source, type, guard, error)
   * @returns {IncludeNode}
   */
  node(absPath, meta) {
    let n = this.nodes.get(absPath);
    if (!n) {
      n = new IncludeNode(absPath, meta);
      this.nodes.set(absPath, n);
    }
    if (meta) {
      if (meta.name   != null) n.name   = meta.name;
      if (meta.source != null) n.source = meta.source;
      if (meta.type   != null) n.type   = meta.type;
      if (meta.guard  != null) n.guard  = meta.guard;
      if (meta.error  != null) n.error  = meta.error;
    }
    return n;
  }

  /**
   * Add a directed edge: fromFile includes toFile.
   * Also stores how the include was spelled (<name> or "name").
   */
  addEdge(fromPath, toPath, { name, isAngle } = {}) {
    const from = this.node(fromPath);
    const to   = this.node(toPath);
    const display = isAngle ? `<${name}>` : `"${name}"`;
    // Avoid duplicates
    if (!from.includes.some(e => e.absPath === toPath)) {
      from.includes.push({ absPath: toPath, display });
      to.includedBy.push({ absPath: fromPath, display });
    }
  }

  // ── Include guard detection ──────────────────────────────────────────────

  /**
   * Detect an include guard in a file's content.
   * Returns the guard symbol or null.
   *
   * Pattern:
   *   #if defined <GUARD>
   *     #endinput
   *   #endif
   *   #define <GUARD>
   */
  static detectGuard(content) {
    const m = content.match(RE_IF_DEFINED);
    if (!m) return null;
    const guard = m[1];
    // #endinput must be present — signals "stop reading here"
    if (!content.includes('#endinput')) return null;
    // #define <GUARD> must exist somewhere after the #if block
    if (!RE_DEFINE(guard).test(content)) return null;
    return guard;
  }

  // ── Include parsing ──────────────────────────────────────────────────────

  /**
   * Extract #include/#tryinclude directives from file content.
   * @param {string} content
   * @returns {{ name: string, isAngle: boolean }[]}
   */
  static parseIncludesFromContent(content) {
    const result = [];

    // Use a fresh regex instance per call to avoid state leakage
    const re = new RegExp(RE_INCLUDE.source, 'gm');
    let m;
    while ((m = re.exec(content)) !== null) {
      result.push({ name: m[2].trim(), isAngle: m[1] === '<' });
    }
    return result;
  }

  /**
   * Read and parse includes from a file on disk.
   * @param {string} absPath
   * @returns {{ name: string, isAngle: boolean }[]}
   */
  static readIncludes(absPath) {
    let content;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch {
      return [];
    }
    return IncludeGraph.parseIncludesFromContent(content);
  }

  // ── Include resolution ───────────────────────────────────────────────────

  /**
   * Resolve an #include name to an absolute file path.
   *
   * Resolution order mirrors amxxpc:
   *   1. "quoted" includes — check the including file's own directory first
   *   2. <angle> or fallback — search includeDirs in order
   *   3. Case-insensitive fallback on all of the above
   *
   * @param {string} fromFile - Absolute path of the file doing the #include
   * @param {string} name     - The bare filename from the directive (<X> or "X")
   * @param {boolean} isAngle - Whether the include was <angle> style
   * @returns {{ absPath: string, source: string|null } | null}
   */
  resolveInclude(fromFile, name, isAngle) {
    const withExt = /\.inc$/i.test(name) ? name : name + '.inc';

    // ── 1. "quoted" — check the including file's own directory ──
    if (!isAngle) {
      const rel = path.resolve(path.dirname(fromFile), withExt);
      if (fs.existsSync(rel)) {
        return { absPath: rel, source: null };
      }
    }

    // ── 2. Search include dirs (exact match first) ──
    for (const dir of this.includeDirs) {
      const full = path.join(dir.path, withExt);
      if (fs.existsSync(full)) {
        return { absPath: full, source: dir.label };
      }
    }

    // ── 3. "quoted" — case-insensitive fallback in file's own dir ──
    if (!isAngle) {
      const ci = findCaseInsensitive(path.dirname(fromFile), withExt);
      if (ci) return { absPath: ci, source: null };
    }

    // ── 4. Case-insensitive fallback in include dirs ──
    for (const dir of this.includeDirs) {
      const ci = findCaseInsensitive(dir.path, withExt);
      if (ci) return { absPath: ci, source: dir.label };
    }

    return null; // unresolvable
  }

  // ── Graph building ───────────────────────────────────────────────────────

  /**
   * Recursively parse a file and all its #include'd files.
   *
   * @param {string} absPath - Absolute path to parse
   * @param {Set<string>} guards  - Active include guards on the current path
   * @param {Set<string>} [stack] - Recursion stack for cycle detection (per-root)
   * @param {number} depth        - Safety limit
   */
  parseFile(absPath, guards = new Set(), stack = new Set(), depth = 0) {
    if (depth > 500) return;
    if (!fs.existsSync(absPath)) return;

    const n = this.node(absPath);

    // Read content and detect guard if not already known
    let content;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch {
      n.error = 'unreadable';
      return;
    }

    if (!n.guard) {
      n.guard = IncludeGraph.detectGuard(content);
    }

    // Guard already set on this path → don't re-expand
    if (n.guard && guards.has(n.guard)) return;

    // File already in current recursion stack → cycle without guards.
    // The edge is already recorded (addEdge below), just don't expand
    // children to avoid infinite recursion.
    if (stack.has(absPath)) return;

    if (n.guard) guards.add(n.guard);
    stack.add(absPath);

    // Parse and recurse into includes
    const includes = IncludeGraph.parseIncludesFromContent(content);
    for (const inc of includes) {
      const resolved = this.resolveInclude(absPath, inc.name, inc.isAngle);
      if (resolved) {
        // Ensure target node exists (with a fallback name)
        this.node(resolved.absPath, {
          name: path.basename(resolved.absPath),
          source: resolved.source || n.source,
        });
        this.addEdge(absPath, resolved.absPath, inc);
        // Siblings share guards: a sibling that sets guard G must be visible
        // to the next sibling (same compile unit). Do NOT clone `guards`.
        this.parseFile(resolved.absPath, guards, stack, depth + 1);
      }
    }

    stack.delete(absPath);
  }

  /**
   * Build the full graph by scanning all root .sma files.
   * Must be called after roots and includeDirs are populated.
   */
  build() {
    for (const root of this.roots) {
      this.parseFile(root, new Set(), new Set());
    }
  }

  // ── Tree traversal ───────────────────────────────────────────────────────

  /**
   * Walk DOWN from a node: file → its #includes → their #includes, etc.
   * Tracks include guards per path so guarded files are not re-expanded.
   * Uses recursion-stack cycle detection so circular includes without
   * guards don't loop infinitely.
   *
   * @param {string} absPath
   * @param {Set<string>} [guards]
   * @param {Set<string>} [stack] - Recursion stack for cycle detection
   * @returns {object|null} Tree node data
   */
  walkDown(absPath, guards = new Set(), stack = new Set()) {
    const n = this.nodes.get(absPath);
    if (!n) return null;

    const isGuarded = !!(n.guard && guards.has(n.guard));
    const inCycle   = stack.has(absPath);

    const tree = {
      name:  n.name,
      absPath,
      source: n.source,
      guard:  n.guard,
      isGuarded,
      cycle:  inCycle && !isGuarded, // cycle detected (without guard)
      error:  n.error,
      children: [],
    };

    if (isGuarded || n.error || inCycle) return tree;

    if (n.guard) guards.add(n.guard);
    stack.add(absPath);

    for (const edge of n.includes) {
      // Siblings share guards (same compile unit). Do NOT clone.
      const child = this.walkDown(edge.absPath, guards, stack);
      if (child) {
        child._display = edge.display;
        tree.children.push(child);
      }
    }

    stack.delete(absPath);
    return tree;
  }

  /**
   * Walk UP from a node: file → files that #include it → their includers, etc.
   * Uses per-path cycle detection to prevent infinite loops.
   *
   * @param {string} absPath
   * @param {Set<string>} [pathVisited]
   * @returns {object|null} Tree node data
   */
  walkUp(absPath, pathVisited = new Set()) {
    if (pathVisited.has(absPath)) return null;
    pathVisited.add(absPath);

    const n = this.nodes.get(absPath);
    if (!n) return null;

    const tree = {
      name:  n.name,
      absPath,
      source: n.source,
      guard:  n.guard,
      isGuarded: false,
      error:  n.error,
      includedBy: [],
    };

    for (const edge of n.includedBy) {
      const parent = this.walkUp(edge.absPath, new Set(pathVisited));
      if (parent) {
        parent._display = edge.display; // how this file was included by parent
        tree.includedBy.push(parent);
      }
    }

    return tree;
  }

  /**
   * Resolve a target path to a node in the graph.
   * If the path is not already in the graph, tries to add it as a standalone node.
   *
   * @param {string} targetPath
   * @returns {string} Resolved absolute path
   */
  resolveTarget(targetPath) {
    const abs = path.resolve(targetPath);
    if (this.nodes.has(abs)) return abs;

    // Try to add the file if it exists
    if (fs.existsSync(abs)) {
      const name = path.basename(abs);
      const type = abs.endsWith('.sma') ? 'sma' : 'inc';
      this.node(abs, { name, type, source: null });
    }

    return abs;
  }
}

// ─── IncludeNode ─────────────────────────────────────────────────────────────

class IncludeNode {
  constructor(absPath, meta = {}) {
    this.absPath = absPath;
    this.name    = meta.name   || path.basename(absPath);
    this.source  = meta.source || null;
    this.type    = meta.type   || (absPath.endsWith('.sma') ? 'sma' : 'inc');
    this.guard   = meta.guard  || null;
    this.error   = meta.error  || null;

    /** @type {{ absPath: string, display: string }[]} */
    this.includes  = [];

    /** @type {{ absPath: string, display: string }[]} */
    this.includedBy = [];
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Case-insensitive file search inside a directory.
 * Returns the first match by readdir order or null.
 */
function findCaseInsensitive(dir, filename) {
  try {
    const lower = filename.toLowerCase();
    for (const entry of fs.readdirSync(dir)) {
      if (entry.toLowerCase() === lower) return path.join(dir, entry);
    }
  } catch (_) { /* ignore */ }
  return null;
}

/**
 * Depth-limit check: if depth is positive and current >= depth, stop.
 */
function reachedDepth(depth, current) {
  return depth > 0 && current >= depth;
}

/**
 * Format a tree node (from walkDown/walkUp) as text using Unicode box-drawing.
 *
 * @param {object} tree   - Tree data from walkDown or walkUp
 * @param {'down'|'up'} direction
 * @param {number} [maxDepth]
 * @returns {string}
 */
function renderTreeText(tree, direction, maxDepth) {
  const lines = [];

  const header = direction === 'up'
    ? `Include tree (UP) for ${tree.name}`
    : `Include tree (DOWN) for ${tree.name}`;

  lines.push('=== ' + header + ' ===');
  lines.push('');

  // Root line
  const rootInfo = formatNodeInfo(tree, '');
  lines.push(tree.name + rootInfo);

  const children = direction === 'up' ? tree.includedBy : tree.children;

  if (children && children.length > 0) {
    for (let i = 0; i < children.length; i++) {
      renderSubtree(children[i], '', i === children.length - 1, direction, maxDepth, 1, lines);
    }
  } else if (direction === 'up') {
    lines.push('  (no .sma files include this file)');
  } else {
    lines.push('  (no #include directives)');
  }

  // Legend
  lines.push('');
  lines.push('Legend:');
  lines.push('  <file>  — angle include  (#include <file>)');
  lines.push('  "file"  — local include  (#include "file")');
  lines.push('  [guard] — include guard detected, expansion skipped');

  return lines.join('\n');
}

function renderSubtree(node, prefix, isLast, direction, maxDepth, depth, lines) {
  if (reachedDepth(maxDepth, depth)) {
    lines.push(prefix + (isLast ? '└── ' : '├── ') + '… (max depth)');
    return;
  }

  const connector = isLast ? '└── ' : '├── ';

  // Display name: use _display if available (the spelling from the parent)
  let displayName = node._display || node.name;
  const info = formatNodeInfo(node, displayName);

  lines.push(prefix + connector + displayName + info);

  const children = direction === 'up' ? node.includedBy : node.children;
  if (children && children.length > 0) {
    const childPrefix = prefix + (isLast ? '    ' : '│   ');
    for (let i = 0; i < children.length; i++) {
      renderSubtree(children[i], childPrefix, i === children.length - 1, direction, maxDepth, depth + 1, lines);
    }
  }
}

/**
 * Format node metadata suffix (source, guard/error/not-found annotation).
 */
function formatNodeInfo(node, displayName) {
  const parts = [];

  if (node.source) {
    parts.push(node.source);
  }

  if (node.cycle) {
    parts.push('cycle');
  } else if (node.isGuarded) {
    parts.push('guard already set');
  } else if (node.guard) {
    parts.push('guard: ' + node.guard);
  }

  if (node.error) {
    parts.push('ERROR: ' + node.error);
  }

  if (parts.length === 0) return '';
  return ' [' + parts.join(', ') + ']';
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Build a directed graph of #include relationships for an AMXX project and
 * produce a tree starting from the given target file.
 *
 * @param {string} manifestPath - Path to amxbuild.yml (auto-detects if directory)
 * @param {string} targetPath   - Path to the .sma or .inc file to build tree from
 * @param {object} [options]
 * @param {'down'|'up'|'auto'} [options.direction='auto']
 *    - 'down':  show everything the target file #includes (transitively)
 *    - 'up':    show everything that #includes the target file (transitively)
 *    - 'auto':  'down' for .sma, 'up' for .inc
 * @param {number} [options.depth=0] - Max depth (0 = unlimited)
 * @param {string} [options.token]   - GitHub PAT
 * @param {boolean} [options.noFetch=false] - Skip network, use cache only
 * @param {'text'|'json'} [options.format='text']
 * @returns {Promise<{ text: string, tree: object, graph: IncludeGraph }>}
 */
async function buildIncludeTree(manifestPath, targetPath, options = {}) {
  const direction = options.direction || 'auto';
  const depth     = options.depth     || 0;
  const token     = options.token     || process.env.GITHUB_TOKEN || null;
  const noFetch   = options.noFetch   !== undefined ? !!options.noFetch : false;
  const format    = options.format    || 'text';

  // ── 1. Resolve manifest ──────────────────────────────────────────────
  const mPath = resolveManifestPath(manifestPath);
  const manifest = parseManifest(mPath);
  const manifestDir = path.dirname(mPath);

  // ── 2. Create graph ──────────────────────────────────────────────────
  const graph = new IncludeGraph();

  // ── 3. Build include directories list ────────────────────────────────

  // 3a. Standard AMXX includes (compiler bundle)
  const amxVersion = manifest.amxmodx.version || await fetchLatestVersion();
  try {
    const { includeDir } = await fetchCompiler(amxVersion);
    if (includeDir) {
      graph.includeDirs.push({ path: includeDir, label: 'AMXX stdlib ' + amxVersion });
    }
  } catch (_) { /* compiler not available */ }

  // 3b. Dependency includes
  for (const dep of manifest.globalDeps) {
    try {
      const depDir = await fetchDepIncludeDirCached(dep, token, noFetch);
      graph.includeDirs.push({ path: depDir, label: `dep: ${dep.repo}@${dep.ref}` });
    } catch (_) { /* skip unresolvable */ }
  }

  // 3c. Local scripting/ and scripting/include/ — added per-root later

  // ── 4. Find all root .sma files ──────────────────────────────────────

  // 4a. Local scripting/
  const localScripting = path.join(manifestDir, manifest.amxmodx.dir, 'scripting');
  const localIncDir    = path.join(localScripting, 'include');
  const localLabel     = 'local ' + path.relative(manifestDir, localScripting);

  if (fs.existsSync(localScripting)) {
    // Add scripting/ and scripting/include/ to include dirs
    // for <angle> includes from any file in this project
    graph.includeDirs.push({ path: localScripting, label: localLabel });
    if (fs.existsSync(localIncDir)) {
      graph.includeDirs.push({ path: localIncDir, label: localLabel + '/include' });
    }

    // Find .sma files
    const localSmas = await glob('**/*.sma', { cwd: localScripting, dot: false });
    for (const rel of localSmas) {
      const abs = path.resolve(localScripting, rel);
      graph.node(abs, {
        name: rel,
        source: localLabel,
        type: 'sma',
      });
      graph.roots.push(abs);
    }
  }

  // 4b. Repo scripting/ dirs
  for (const repoConfig of manifest.repos) {
    let repoDir;
    try {
      const resolvedRef = repoConfig.ref === 'latest'
        ? await resolveRef(repoConfig.repo, repoConfig.ref, token)
        : repoConfig.ref;
      repoDir = await fetchRepo(repoConfig.repo, resolvedRef, token, noFetch, manifest.github.ssh);
    } catch (_) {
      continue; // skip repos that can't be fetched
    }

    const scriptingDir = path.join(repoDir, repoConfig.amxmodx_dir, 'scripting');
    const incDir       = path.join(scriptingDir, 'include');
    const repoLabel    = 'repo: ' + repoConfig.repo;

    if (fs.existsSync(scriptingDir)) {
      // Add scripting/ and scripting/include/ to include dirs
      graph.includeDirs.push({ path: scriptingDir, label: repoLabel });
      if (fs.existsSync(incDir)) {
        graph.includeDirs.push({ path: incDir, label: repoLabel + '/include' });
      }

      const smas = await glob('**/*.sma', { cwd: scriptingDir, dot: false });
      for (const rel of smas) {
        const abs = path.resolve(scriptingDir, rel);
        graph.node(abs, {
          name: rel,
          source: repoLabel,
          type: 'sma',
        });
        graph.roots.push(abs);
      }
    }
  }

  // ── 5. Build the full graph from all roots ───────────────────────────
  graph.build();

  // ── 6. Determine direction and walk tree from target ─────────────────
  const targetAbs = graph.resolveTarget(targetPath);
  const treeDir = direction === 'auto'
    ? (targetAbs.endsWith('.sma') ? 'down' : 'up')
    : direction;

  let tree;
  if (treeDir === 'up') {
    tree = graph.walkUp(targetAbs);
  } else {
    tree = graph.walkDown(targetAbs);
  }

  if (!tree) {
    const msg = `Target file "${targetPath}" does not exist or could not be read.`;
    return {
      text: msg,
      tree: null,
      graph,
    };
  }

  // ── 7. Format output ─────────────────────────────────────────────────
  const text = format === 'json'
    ? JSON.stringify(tree, null, 2)
    : renderTreeText(tree, treeDir, depth);

  return { text, tree, graph };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Resolve manifest path with auto-detect.
 */
function resolveManifestPath(explicit) {
  if (explicit && fs.existsSync(explicit)) return path.resolve(explicit);
  if (explicit) return path.resolve(explicit); // let parseManifest throw

  const cwd = process.cwd();
  for (const name of ['amxbuild.yml', 'amxbuild.yaml', 'manifest.yml']) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(cwd, 'amxbuild.yml'); // will cause parseManifest to throw with a clear message
}

/**
 * Fetch a dependency's include directory, using cache where possible.
 */
async function fetchDepIncludeDirCached(dep, token, noFetch) {
  if (dep.source === 'release') {
    return fetchReleaseDep(
      { repo: dep.repo, ref: dep.ref, include_path: dep.include_path, asset: dep.asset },
      token,
      noFetch
    );
  }

  const resolvedRef = dep.ref === 'latest'
    ? await resolveRef(dep.repo, dep.ref, token)
    : dep.ref;
  const repoDir = await fetchRepo(dep.repo, resolvedRef, token, noFetch, false);
  const candidates = dep.include_path
    ? [dep.include_path]
    : ['scripting/include', 'amxmodx/scripting/include', 'include', '.'];

  for (const candidate of candidates) {
    const full = path.join(repoDir, candidate);
    if (fs.existsSync(full)) return full;
  }

  return repoDir;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = { buildIncludeTree, IncludeGraph };
