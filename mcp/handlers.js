'use strict';

const fs   = require('fs');
const path = require('path');
const glob = require('fast-glob');

const { fetchRepo, resolveRef } = require('../src/repo-fetcher');
const { fetchReleaseDep }       = require('../src/release-fetcher');
const { fetchCompiler, fetchLatestVersion } = require('../src/compiler-fetcher');
const { parseDepsLines, resolveManifest } = require('../src/manifest');
const { parseManifest }         = require('../src/manifest');
const { validateManifestFile }  = require('../src/validate');
const { getCacheInfo }          = require('../src/cache-info');
const { buildDepTree }          = require('../src/deps-tree');
const { listReleases, listTags } = require('../src/release-lister');

// ─── Response formatters ───────────────────────────────────────────────────────

function textResult(text) {
  return {
    content: [{ type: 'text', text }],
  };
}

function errorResult(message, code = -32603) {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
    _meta: code ? { code } : undefined,
  };
}

// ─── Dep parsing helpers ───────────────────────────────────────────────────────

function parseDep(raw) {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    const match = trimmed.match(/^([^@\s]+)@([^:\s]+)(?::(.+))?$/);
    if (!match) {
      throw new Error(
        `Invalid dep string: "${trimmed}". Expected format: "owner/repo@ref" or "owner/repo@ref:include_path"`
      );
    }
    const [, repo, ref, includePath] = match;
    return {
      repo:         repo.trim(),
      ref:          ref.trim(),
      include_path: includePath ? includePath.trim() : null,
      source:       'git',
      asset:        null,
    };
  }

  if (raw && typeof raw === 'object') {
    if (!raw.repo || !raw.ref) {
      throw new Error('Dep object must include both "repo" and "ref" fields');
    }
    const source = raw.source || 'git';
    if (!['git', 'release'].includes(source)) {
      throw new Error(`Dep source must be "git" or "release", got "${source}"`);
    }
    return {
      repo:         String(raw.repo).trim(),
      ref:          String(raw.ref).trim(),
      include_path: raw.include_path ? String(raw.include_path).trim() : null,
      source,
      asset:        raw.asset != null ? raw.asset : null,
    };
  }

  throw new Error('Dep must be a string or an object');
}

async function resolveDepRef(dep, token) {
  if (dep.ref !== 'latest') return dep.ref;
  return resolveRef(dep.repo, dep.ref, token);
}

async function fetchDepIncludeDir(dep, token, noFetch) {
  if (dep.source === 'release') {
    return fetchReleaseDep(
      { repo: dep.repo, ref: dep.ref, include_path: dep.include_path, asset: dep.asset },
      token,
      noFetch
    );
  }

  const repoDir = await fetchRepo(dep.repo, dep.ref, token, noFetch, false);
  const candidates = dep.include_path
    ? [dep.include_path]
    : ['scripting/include', 'amxmodx/scripting/include', 'include', '.'];

  for (const candidate of candidates) {
    const full = path.join(repoDir, candidate);
    if (fs.existsSync(full)) return full;
  }

  return repoDir;
}

async function collectIncFiles(srcDir) {
  const entries = await glob('**/*.inc', { cwd: srcDir, dot: false });
  entries.sort();
  return entries.map((rel) => ({
    rel,
    abs: path.join(srcDir, rel),
  }));
}

function readFileSafe(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
    try {
      const text = buf.toString('utf8');
      if (text.includes('\u0000')) {
        return `[binary file, ${buf.length} bytes]`;
      }
      return text;
    } catch (_) {
      return `[binary file, ${buf.length} bytes]`;
    }
  } catch (err) {
    return `[error reading file: ${err.message}]`;
  }
}

/**
 * Grep content with configurable before/after context lines.
 *
 * @param {string} content  - File content to search in.
 * @param {string} pattern  - Substring to match (case-insensitive).
 * @param {number} [before=0] - Lines of context before each match.
 * @param {number} [after=0]  - Lines of context after each match.
 * @returns {string} Formatted grep result or "No matches found." message.
 */
function grepContent(content, pattern, before = 0, after = 0) {
  if (!pattern) return content;
  const lines = content.split('\n');
  const matches = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(pattern.toLowerCase())) {
      const start = Math.max(0, i - before);
      const end   = Math.min(lines.length - 1, i + after);
      matches.push({ matchLine: i, start, end });
    }
  }

  if (matches.length === 0) return `[grep: no matches for "${pattern}"]`;

  // Merge overlapping ranges
  const merged = [];
  for (const m of matches) {
    if (merged.length > 0 && m.start <= merged[merged.length - 1].end + 1) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, m.end);
    } else {
      merged.push({ ...m });
    }
  }

  const parts = merged.map((range, ri) => {
    const chunk = [];
    if (ri > 0) chunk.push('┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄');
    for (let ln = range.start; ln <= range.end; ln++) {
      const marker = ln === range.matchLine ? '>' : ' ';
      chunk.push(`${marker} ${String(ln + 1).padStart(4, ' ')} │ ${lines[ln]}`);
    }
    return chunk.join('\n');
  });

  return parts.join('\n');
}

function resolveManifestPath(explicit) {
  if (explicit) return explicit;
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'amxbuild.yml')))  return path.join(cwd, 'amxbuild.yml');
  if (fs.existsSync(path.join(cwd, 'amxbuild.yaml'))) return path.join(cwd, 'amxbuild.yaml');
  if (fs.existsSync(path.join(cwd, 'manifest.yml')))  return path.join(cwd, 'manifest.yml');
  return path.join(cwd, 'amxbuild.yml');
}

// ─── Tool handlers ─────────────────────────────────────────────────────────────

async function handleGetDepInterface(args, token, noFetch) {
  let dep;
  try {
    dep = parseDep(args?.dep || args);
  } catch (parseErr) {
    return errorResult(parseErr.message);
  }
  if (args?.source)         dep.source = args.source;
  if (args?.include_path)   dep.include_path = args.include_path;
  if (args?.asset != null)  dep.asset = args.asset;

  const resolvedRef = await resolveDepRef(dep, token);
  const srcDir      = await fetchDepIncludeDir(dep, token, noFetch);
  const incFiles    = await collectIncFiles(srcDir);

  if (incFiles.length === 0) {
    return textResult(
      `Dependency ${dep.repo}@${resolvedRef} has no .inc files in its include path.`
    );
  }

  const grep   = args?.grep;
  const before = args?.before || 0;
  const after  = args?.after || 0;

  const files = incFiles.map((f) => ({
    path: f.rel,
    content: grep ? grepContent(readFileSafe(f.abs), grep, before, after) : readFileSafe(f.abs),
  }));

  return textResult(
    `Found ${files.length} .inc file(s) in ${dep.repo}@${resolvedRef}:\n\n` +
    files
      .map(
        (f) =>
          `──── ${f.path} ────\n${f.content}${f.content.endsWith('\n') ? '' : '\n'}`
      )
      .join('\n')
  );
}

async function handleListDepIncs(args, token, noFetch) {
  let dep;
  try {
    dep = parseDep(args?.dep || args);
  } catch (parseErr) {
    return errorResult(parseErr.message);
  }
  if (args?.source)         dep.source = args.source;
  if (args?.include_path)   dep.include_path = args.include_path;
  if (args?.asset != null)  dep.asset = args.asset;

  const resolvedRef = await resolveDepRef(dep, token);
  const srcDir      = await fetchDepIncludeDir(dep, token, noFetch);
  const incFiles    = await collectIncFiles(srcDir);

  if (incFiles.length === 0) {
    return textResult(
      `Dependency ${dep.repo}@${resolvedRef} has no .inc files in its include path.`
    );
  }

  const listing = incFiles.map((f) => `  ${f.rel}`).join('\n');

  return textResult(
    `Dependency ${dep.repo}@${resolvedRef} — ${incFiles.length} .inc file(s):\n\n${listing}`
  );
}

async function handleGetDepTree(args, token, noFetch) {
  const depth = args?.depth || 0;
  let rootDeps;
  let getDepsOverride = null;

  if (args?.manifest) {
    const manifest = parseManifest(path.resolve(args.manifest));
    rootDeps = [];

    for (const repoConfig of manifest.repos) {
      rootDeps.push({ repo: repoConfig.repo, ref: repoConfig.ref });
    }
    for (const d of manifest.globalDeps) {
      rootDeps.push({ ...d });
    }

    getDepsOverride = (repo) => {
      const config = manifest.repos.find(r => r.repo === repo);
      return config ? config.deps_override : null;
    };
  } else if (args?.deps) {
    rootDeps = args.deps.map((entry) => {
      if (typeof entry === 'string') {
        const parsed = parseDep(entry);
        return { repo: parsed.repo, ref: parsed.ref, source: parsed.source, include_path: parsed.include_path, asset: parsed.asset };
      }
      return { repo: entry.repo, ref: entry.ref, source: entry.source || 'git', include_path: entry.include_path || null, asset: entry.asset != null ? entry.asset : null };
    });
  } else {
    return errorResult('Provide either "manifest" or "deps"', -32602);
  }

  const tree = await buildDepTree(rootDeps, {
    token,
    noFetch,
    depth,
    from: args?.manifest ? 'manifest' : 'user',
    getDepsOverride,
  });

  return textResult(JSON.stringify(tree, null, 2));
}

async function handleResolveManifestTool(args) {
  const manifestPath = resolveManifestPath(args?.manifest);
  const fullPath = path.resolve(manifestPath);
  require('dotenv').config({ path: path.join(path.dirname(fullPath), '.env'), override: true });

  const manifest = resolveManifest(fullPath, {
    set:    args?.set,
    define: args?.define,
  });

  return textResult(JSON.stringify(manifest, null, 2));
}

async function handleValidateManifestTool(args) {
  const manifestPath = resolveManifestPath(args?.manifest);
  const result = validateManifestFile(manifestPath);
  return textResult(JSON.stringify(result, null, 2));
}

async function handleGetCacheInfo(args) {
  const manifestPath = args?.manifest ? path.resolve(args.manifest) : undefined;
  const info = getCacheInfo(manifestPath);
  return textResult(JSON.stringify(info, null, 2));
}

async function handleListReleasesTool(args, token) {
  if (!args?.repo) return errorResult('Missing required "repo" field', -32602);
  const limit = args?.limit || 10;

  let entries;
  if (args?.tags) {
    entries = await listTags(args.repo, { token, limit });
  } else {
    entries = await listReleases(args.repo, { token, limit, includeAssets: args?.includeAssets });
  }

  return textResult(JSON.stringify(entries, null, 2));
}

// ─── AMXX standard include helpers ────────────────────────────────────────────

/**
 * Resolve the AMX Mod X version to use for standard includes.
 * Priority: explicit `version` arg → manifest `amxmodx.version` → latest.
 */
async function resolveAmxmodxVersion(args) {
  if (args?.version) return args.version;

  const manifestPathStr = args?.manifest;
  const manifestPath = resolveManifestPath(manifestPathStr || undefined);
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = parseManifest(manifestPath);
      if (manifest.amxmodx?.version) return manifest.amxmodx.version;
    } catch (_) {} // ignore parse errors, fall through to latest
  }

  return fetchLatestVersion();
}

async function handleListAmxmodxIncs(args, token, noFetch) {
  const version = await resolveAmxmodxVersion(args);
  const pattern = args?.pattern || '*.inc';

  const { includeDir } = await fetchCompiler(version);
  if (!includeDir) {
    return textResult(
      `No standard include directory found for AMX Mod X ${version}.`
    );
  }

  const files = await glob(pattern, { cwd: includeDir, dot: false });
  files.sort();

  if (files.length === 0) {
    return textResult(
      `No .inc files matching "${pattern}" in AMX Mod X ${version} includes.`
    );
  }

  const listing = files.map((f) => `  ${f}`).join('\n');
  return textResult(
    `AMX Mod X ${version} — ${files.length} standard include file(s):\n\n${listing}`
  );
}

async function handleGetAmxmodxInclude(args, token, noFetch) {
  const version = await resolveAmxmodxVersion(args);
  const pattern = args?.file || args?.pattern || '*.inc';
  const grep    = args?.grep;
  const before  = args?.before || 0;
  const after   = args?.after || 0;

  const { includeDir } = await fetchCompiler(version);
  if (!includeDir) {
    return textResult(
      `No standard include directory found for AMX Mod X ${version}.`
    );
  }

  const files = await glob(pattern, { cwd: includeDir, dot: false });
  files.sort();

  if (files.length === 0) {
    return textResult(
      `No .inc files matching "${pattern}" in AMX Mod X ${version} includes.`
    );
  }

  const contents = files
    .map((rel) => {
      const raw = readFileSafe(path.join(includeDir, rel));
      const processed = grep ? grepContent(raw, grep, before, after) : raw;
      return `──── ${rel} ────\n${processed}${processed.endsWith('\n') ? '' : '\n'}`;
    })
    .join('\n');

  return textResult(
    `AMX Mod X ${version} — ${files.length} standard include file(s):\n\n${contents}`
  );
}

// ─── Include resolution ─────────────────────────────────────────────────────────

/**
 * Parse a preprocessor include directive into a filename + search mode.
 *
 * Accepted forms:
 *   #include <file>      — global search only (<> equivalent)
 *   #include "file"      — local (sma dir) first, then global
 *   #include file        — bare filename, equivalent to <>
 *   <file>, "file", file — directive prefix is optional
 *
 * Extension defaults to .inc if missing.
 */
function parseIncludeDirective(raw) {
  let input = String(raw || '').trim();
  if (!input) throw new Error('Empty include directive');

  input = input.replace(/^#include\s+/, '');

  let localFirst = false;

  if (input.startsWith('"') && input.endsWith('"')) {
    input = input.slice(1, -1);
    localFirst = true;
  } else if (input.startsWith('<') && input.endsWith('>')) {
    input = input.slice(1, -1);
  }

  if (!path.extname(input)) input += '.inc';

  return { filename: input, localFirst };
}

/**
 * Case-insensitive file search inside a directory.
 * Returns the first match (by readdir order) or null.
 */
function findCaseInsensitive(dir, filename) {
  try {
    const lower = filename.toLowerCase();
    for (const entry of fs.readdirSync(dir)) {
      if (entry.toLowerCase() === lower) return path.join(dir, entry);
    }
  } catch (_) {}
  return null;
}

/**
 * Search for a file in a list of { path, label } search targets.
 * Checks exact match first, then case-insensitive fallback.
 *
 * Returns { foundPath, label } or null.
 */
function searchIncludeFile(filename, searchPaths) {
  for (const { path: sp, label } of searchPaths) {
    const exact = path.join(sp, filename);
    if (fs.existsSync(exact)) return { foundPath: exact, label };
    const ci = findCaseInsensitive(sp, filename);
    if (ci) return { foundPath: ci, label };
  }
  return null;
}

async function handleResolveInclude(args, token, noFetch) {
  let parsed;
  try {
    parsed = parseIncludeDirective(args?.directive || args?.include);
  } catch (err) {
    return errorResult(err.message);
  }

  const { filename, localFirst } = parsed;
  const searchPaths = [];

  if (localFirst) {
    const smaDir = args?.sma_file
      ? path.dirname(path.resolve(args.sma_file))
      : process.cwd();
    const label = args?.sma_file
      ? `local (${path.basename(args.sma_file)})`
      : 'local (current directory)';
    searchPaths.push({ path: smaDir, label });
  }

  const version = await resolveAmxmodxVersion(args);
  const { includeDir } = await fetchCompiler(version);
  if (includeDir) {
    searchPaths.push({ path: includeDir, label: `AMXX stdlib ${version}` });
  }

  const manifestPath = resolveManifestPath(args?.manifest || undefined);
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = parseManifest(manifestPath);
      for (const dep of manifest.globalDeps) {
        try {
          const depDir = await fetchDepIncludeDir(dep, token, noFetch);
          searchPaths.push({ path: depDir, label: `${dep.repo}@${dep.ref}` });
        } catch (_) {} // skip unresolvable
      }
    } catch (_) {} // skip deps on parse error
  }

  const result = searchIncludeFile(filename, searchPaths);

  if (!result) {
    return textResult(
      `Include "${filename}" not found.\n\n` +
      `Searched:\n` +
      searchPaths.map((s) => `  ${s.label}`).join('\n') +
      '\n\nTip: provide a manifest with deps, or ensure the compiler is cached.'
    );
  }

  const content = readFileSafe(result.foundPath);
  const grep   = args?.grep;
  const before = args?.before || 0;
  const after  = args?.after || 0;
  const displayed = grep ? grepContent(content, grep, before, after) : content;

  return textResult(
    `Include "${parsed.filename}" resolved to:\n` +
    `  Source: ${result.label}\n` +
    `  Path:   ${result.foundPath}\n\n` +
    `──── ${parsed.filename} ────\n${displayed}${displayed.endsWith('\n') ? '' : '\n'}`
  );
}

// ─── Dispatch ──────────────────────────────────────────────────────────────────

const HANDLERS = {
  get_dep_interface:    handleGetDepInterface,
  list_dep_incs:        handleListDepIncs,
  get_dep_tree:         handleGetDepTree,
  resolve_manifest:     handleResolveManifestTool,
  validate_manifest:    handleValidateManifestTool,
  get_cache_info:       handleGetCacheInfo,
  list_releases:        handleListReleasesTool,
  list_amxmodx_incs:    handleListAmxmodxIncs,
  get_amxmodx_include:  handleGetAmxmodxInclude,
  resolve_include:      handleResolveInclude,
};

async function callTool(name, args) {
  const handler = HANDLERS[name];
  if (!handler) {
    return errorResult(`Unknown tool: ${name}`, -32601);
  }

  const token = args?.token || process.env.GITHUB_TOKEN || null;
  const noFetch = args?.no_fetch === true;

  return handler(args, token, noFetch);
}

module.exports = { callTool };
