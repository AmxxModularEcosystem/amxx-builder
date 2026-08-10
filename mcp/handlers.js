'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const glob = require('fast-glob');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { fetchRepo, resolveRef } = require('../src/repo-fetcher');
const { fetchReleaseDep }       = require('../src/release-fetcher');
const { fetchCompiler, fetchLatestVersion } = require('../src/compiler-fetcher');
const { parseDepsLines, resolveManifest } = require('../src/manifest');
const { parseManifest }         = require('../src/manifest');
const { validateManifestFile }  = require('../src/validate');
const { getManifestSchema }     = require('../src/schema');
const { getCacheInfo }          = require('../src/cache-info');
const { buildDepTree }          = require('../src/deps-tree');
const { buildIncludeTree }      = require('../src/include-tree');
const { listReleases, listTags } = require('../src/release-lister');
const { buildPlanData }         = require('../src/commands/dry-run');
const { buildIndex, searchIndex } = require('./symbol-index');
const logger                    = require('../src/logger');

const execFileP = promisify(execFile);

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

// ─── Output limits ─────────────────────────────────────────────────────────────

const DEFAULT_MAX_OUTPUT_BYTES = 200 * 1024; // 200 KB
const DEFAULT_MAX_FILES        = 50;

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function applyOutputLimit(text, args, maxBytes = DEFAULT_MAX_OUTPUT_BYTES) {
  if (args?.full_output) return text;
  const size = Buffer.byteLength(text, 'utf8');
  if (size <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf8').subarray(0, maxBytes);
  // Walk back past any UTF-8 continuation bytes so we never split a character.
  let cutLen = buf.length;
  while (cutLen > 0 && (buf[cutLen - 1] & 0xc0) === 0x80) cutLen--;
  const cut = buf.subarray(0, cutLen).toString('utf8');
  return (
    cut +
    `\n… [truncated ${formatBytes(size)} → ${formatBytes(maxBytes)}; ` +
    `pass full_output=true for the complete output]`
  );
}

function limitFiles(files, args) {
  if (args?.full_output || files.length <= DEFAULT_MAX_FILES) return files;
  return files.slice(0, DEFAULT_MAX_FILES);
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

  const shown    = limitFiles(files, args);
  const skipped  = files.length - shown.length;
  let out =
    `Found ${files.length} .inc file(s) in ${dep.repo}@${resolvedRef}:\n\n` +
    shown
      .map(
        (f) =>
          `──── ${f.path} ────\n${f.content}${f.content.endsWith('\n') ? '' : '\n'}`
      )
      .join('\n');
  if (skipped > 0) out += `\n… [${skipped} more file(s); pass full_output=true to list them]`;
  return textResult(applyOutputLimit(out, args));
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
    applyOutputLimit(`Dependency ${dep.repo}@${resolvedRef} — ${incFiles.length} .inc file(s):\n\n${listing}`, args)
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

  return textResult(applyOutputLimit(JSON.stringify(tree, null, 2), args));
}

async function handleResolveManifestTool(args) {
  const manifestPath = resolveManifestPath(args?.manifest);
  const fullPath = path.resolve(manifestPath);
  require('dotenv').config({ path: path.join(path.dirname(fullPath), '.env'), override: true });

  const manifest = resolveManifest(fullPath, {
    set:    args?.set,
    define: args?.define,
  });

  return textResult(applyOutputLimit(JSON.stringify(manifest, null, 2), args));
}

async function handleValidateManifestTool(args) {
  const manifestPath = resolveManifestPath(args?.manifest);
  const result = validateManifestFile(manifestPath);
  return textResult(applyOutputLimit(JSON.stringify(result, null, 2), args));
}

async function handleGetCacheInfo(args) {
  const manifestPath = args?.manifest ? path.resolve(args.manifest) : undefined;
  const info = getCacheInfo(manifestPath);
  return textResult(applyOutputLimit(JSON.stringify(info, null, 2), args));
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

  return textResult(applyOutputLimit(JSON.stringify(entries, null, 2), args));
}

async function handleBuildIncludeTree(args, token, noFetch) {
  if (!args?.file) return errorResult('Missing required "file" parameter', -32602);

  try {
    const result = await buildIncludeTree(
      args.manifest || undefined,
      args.file,
      {
        direction: args.direction || 'auto',
        depth:     args.depth     || 0,
        format:    args.format    || 'text',
        token,
        noFetch:   noFetch || args?.no_fetch === true,
      }
    );
    return textResult(applyOutputLimit(result.text, args));
  } catch (err) {
    return errorResult(err.message);
  }
}

// ─── AMXX standard include helpers ────────────────────────────────────────────

/**
 * Resolve the AMX Mod X version to use for standard includes.
 * Priority: explicit `version` arg → manifest `amxmodx.version` → latest.
 */
async function resolveAmxmodxVersion(args, noFetch) {
  if (args?.version) return args.version;

  const manifestPathStr = args?.manifest;
  const manifestPath = resolveManifestPath(manifestPathStr || undefined);
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = parseManifest(manifestPath);
      if (manifest.amxmodx?.version) return manifest.amxmodx.version;
    } catch (err) {
      logger.warn(`Manifest parse failed (${manifestPath}), falling back to latest: ${err.message}`);
    }
  }

  return fetchLatestVersion({ noFetch });
}

async function handleListAmxmodxIncs(args, token, noFetch) {
  const version = await resolveAmxmodxVersion(args, noFetch);
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
    applyOutputLimit(`AMX Mod X ${version} — ${files.length} standard include file(s):\n\n${listing}`, args)
  );
}

async function handleGetAmxmodxInclude(args, token, noFetch) {
  const version = await resolveAmxmodxVersion(args, noFetch);
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

  const shown    = limitFiles(files, args);
  const skipped  = files.length - shown.length;
  const contents = shown
    .map((rel) => {
      const raw = readFileSafe(path.join(includeDir, rel));
      const processed = grep ? grepContent(raw, grep, before, after) : raw;
      return `──── ${rel} ────\n${processed}${processed.endsWith('\n') ? '' : '\n'}`;
    })
    .join('\n')
    + (skipped > 0 ? `\n… [${skipped} more file(s); pass full_output=true to list them]` : '');

  return textResult(
    applyOutputLimit(`AMX Mod X ${version} — ${files.length} standard include file(s):\n\n${contents}`, args)
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

  const version = await resolveAmxmodxVersion(args, noFetch);
  const { includeDir } = await fetchCompiler(version);
  if (includeDir) {
    searchPaths.push({ path: includeDir, label: `AMXX stdlib ${version}` });
  }

  const manifestPath = resolveManifestPath(args?.manifest || undefined);
  const depErrors = [];
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = parseManifest(manifestPath);
      for (const dep of manifest.globalDeps) {
        try {
          const depDir = await fetchDepIncludeDir(dep, token, noFetch);
          searchPaths.push({ path: depDir, label: `${dep.repo}@${dep.ref}` });
        } catch (err) {
          depErrors.push(`${dep.repo}@${dep.ref}: ${err.message}`);
        }
      }
    } catch (err) {
      depErrors.push(`manifest ${manifestPath}: ${err.message}`);
    }
  }

  const result = searchIncludeFile(filename, searchPaths);

  if (!result) {
    let msg =
      `Include "${filename}" not found.\n\n` +
      `Searched:\n` +
      searchPaths.map((s) => `  ${s.label}`).join('\n');
    if (depErrors.length) {
      msg +=
        `\n\nFailed to resolve:\n` +
        depErrors.map((e) => `  ${e}`).join('\n');
    }
    msg += '\n\nTip: provide a manifest with deps, or ensure the compiler is cached.';
    return textResult(msg);
  }

  const content = readFileSafe(result.foundPath);
  const grep   = args?.grep;
  const before = args?.before || 0;
  const after  = args?.after || 0;
  const displayed = grep ? grepContent(content, grep, before, after) : content;

  let out =
    `Include "${parsed.filename}" resolved to:\n` +
    `  Source: ${result.label}\n` +
    `  Path:   ${result.foundPath}\n\n` +
    `──── ${parsed.filename} ────\n${displayed}${displayed.endsWith('\n') ? '' : '\n'}`;
  if (depErrors.length) {
    out += `\nNote — some deps failed to resolve:\n` + depErrors.map((e) => `  ${e}`).join('\n');
  }
  return textResult(applyOutputLimit(out, args));
}

// ─── Build plan ────────────────────────────────────────────────────────────────

async function handleBuildPlan(args) {
  const manifestPath = resolveManifestPath(args?.manifest);
  const fullPath = path.resolve(manifestPath);
  require('dotenv').config({ path: path.join(path.dirname(fullPath), '.env'), quiet: true });

  try {
    const manifest = resolveManifest(fullPath, { set: args?.set, define: args?.define });
    return textResult(applyOutputLimit(JSON.stringify(buildPlanData(manifest), null, 2), args));
  } catch (err) {
    return errorResult(err.message);
  }
}

// ─── Repo file access ──────────────────────────────────────────────────────────

async function fetchDepRoot(args, token, noFetch) {
  let dep;
  if (args?.dep) {
    dep = parseDep(args.dep);
  } else {
    if (!args?.repo) throw new Error('Provide either "dep" or "repo"');
    const source = args.source || 'git';
    // Release deps need a ref — default to 'latest' when omitted.
    const ref = args.ref || (source === 'release' ? 'latest' : null);
    dep = { repo: args.repo, ref, source, include_path: args.include_path || null, asset: args.asset ?? null };
  }
  if (args?.source)        dep.source = args.source;
  if (args?.include_path)  dep.include_path = args.include_path;
  if (args?.asset != null) dep.asset = args.asset;

  if (dep.source === 'release') {
    const dir = await fetchReleaseDep(dep, token, noFetch);
    return { rootDir: dir, label: `${dep.repo}@${dep.ref} (release)` };
  }

  const resolvedRef = dep.ref === 'latest'
    ? await resolveRef(dep.repo, dep.ref, token)
    : dep.ref;
  const repoDir = await fetchRepo(dep.repo, resolvedRef, token, noFetch, false);
  if (dep.include_path) {
    const sub = path.join(repoDir, dep.include_path);
    if (!fs.existsSync(sub)) {
      throw new Error(`include_path "${dep.include_path}" not found in ${dep.repo}`);
    }
    return { rootDir: sub, label: `${dep.repo}@${dep.ref || 'default branch'}` };
  }
  return { rootDir: repoDir, label: `${dep.repo}@${dep.ref || 'default branch'}` };
}

async function handleListRepoFiles(args, token, noFetch) {
  let root;
  try {
    root = await fetchDepRoot(args, token, noFetch);
  } catch (err) {
    return errorResult(err.message);
  }

  const pattern = args?.pattern || '**/*';
  const limit   = args?.limit || 500;

  let files;
  try {
    files = await glob(pattern, { cwd: root.rootDir, dot: false });
  } catch (err) {
    return errorResult(`Invalid pattern "${pattern}": ${err.message}`);
  }
  files.sort();

  const shown   = files.slice(0, limit);
  const skipped = files.length - shown.length;
  const listing = shown.map((f) => `  ${f}`).join('\n')
    + (skipped > 0 ? `\n  … [${skipped} more; pass a higher limit]` : '');

  return textResult(
    applyOutputLimit(
      `${root.label} — ${files.length} file(s) matching "${pattern}":\n\n${listing}`,
      args
    )
  );
}

async function handleReadRepoFile(args, token, noFetch) {
  if (!args?.file) return errorResult('Missing required "file" parameter', -32602);

  let root;
  try {
    root = await fetchDepRoot(args, token, noFetch);
  } catch (err) {
    return errorResult(err.message);
  }

  const target = path.resolve(root.rootDir, args.file);
  if (target !== root.rootDir && !target.startsWith(root.rootDir + path.sep)) {
    return errorResult(`Path escapes the repo root: "${args.file}"`);
  }
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    return errorResult(`File not found in ${root.label}: ${args.file}`);
  }

  const content = readFileSafe(target);
  const grep   = args?.grep;
  const before = args?.before || 0;
  const after  = args?.after || 0;
  const displayed = grep ? grepContent(content, grep, before, after) : content;

  return textResult(
    applyOutputLimit(
      `──── ${args.file} (${root.label}) ────\n${displayed}${displayed.endsWith('\n') ? '' : '\n'}`,
      args
    )
  );
}

// ─── Single-file compilation ───────────────────────────────────────────────────

async function runCompiler(cmd, args) {
  const env = { ...process.env };
  if (process.platform === 'linux') {
    // amxxpc needs its .so next to the binary — same as src/compiler.js spawnAsync
    const compilerDir = path.dirname(cmd);
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH
      ? `${compilerDir}:${env.LD_LIBRARY_PATH}`
      : compilerDir;
  }
  try {
    const { stdout, stderr } = await execFileP(cmd, args, { env, maxBuffer: 10 * 1024 * 1024, windowsHide: true });
    return { status: 0, output: stdout + stderr };
  } catch (err) {
    // err.code is a string ('ENOENT') on spawn failure — never let it leak as status.
    const status = Number.isInteger(err.code) ? err.code : 1;
    return { status, output: (err.stdout || '') + (err.stderr || '') };
  }
}

async function handleCompileSma(args, token, noFetch) {
  if (!args?.sma_file) return errorResult('Missing required "sma_file" parameter', -32602);
  const smaPath = path.resolve(args.sma_file);
  if (!fs.existsSync(smaPath)) return errorResult(`File not found: ${smaPath}`);

  const version = await resolveAmxmodxVersion(args, noFetch);
  const { compilerPath, includeDir } = await fetchCompiler(version);

  const includes = [`-i${path.dirname(smaPath)}`];
  const localInc = path.join(path.dirname(smaPath), 'include');
  if (fs.existsSync(localInc)) includes.push(`-i${localInc}`);
  if (includeDir) includes.push(`-i${includeDir}`);

  const depErrors = [];
  const manifestPath = resolveManifestPath(args?.manifest || undefined);
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = parseManifest(manifestPath);
      for (const dep of manifest.globalDeps) {
        try {
          includes.push(`-i${await fetchDepIncludeDir(dep, token, noFetch)}`);
        } catch (err) {
          depErrors.push(`${dep.repo}@${dep.ref}: ${err.message}`);
        }
      }
    } catch (err) {
      depErrors.push(`manifest ${manifestPath}: ${err.message}`);
    }
  }
  for (const d of args?.include_dirs || []) includes.push(`-i${path.resolve(d)}`);
  const defines = (args?.define || []).map((d) => `-D${d}`);

  const outDir = path.join(os.tmpdir(), 'amxb-mcp-compile');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${path.basename(smaPath, '.sma')}_${process.pid}.amxx`);

  const { status, output } = await runCompiler(compilerPath, [smaPath, `-o${outPath}`, ...includes, ...defines]);

  let msg = status === 0
    ? `Compiled OK (amxxpc ${version}): ${path.basename(smaPath)}`
    : `Compilation FAILED (amxxpc ${version}, exit ${status}): ${path.basename(smaPath)}`;

  if (status === 0 && args?.keep_output) {
    msg += `\n  Output: ${outPath}`;
  } else {
    try { fs.rmSync(outPath, { force: true }); } catch (_) {}
  }

  if (depErrors.length) {
    msg += `\n\nNote — deps failed to resolve:\n` + depErrors.map((e) => `  ${e}`).join('\n');
  }
  msg += `\n\n──── compiler output ────\n${output || '(no output)'}`;

  return textResult(applyOutputLimit(msg, args));
}

// ─── Asset plan ────────────────────────────────────────────────────────────────

async function handleResolveAssets(args) {
  const manifestPath = resolveManifestPath(args?.manifest);
  const fullPath = path.resolve(manifestPath);

  let manifest;
  try {
    manifest = parseManifest(fullPath);
  } catch (err) {
    return errorResult(err.message);
  }

  const manifestDir = path.dirname(fullPath);
  const plan = manifest.assets.sources.map((s) => {
    const entry = { type: s.type, map: s.map };
    if (s.type === 'local') {
      entry.source = 'assets/ (next to manifest)';
      if (args?.list_local !== false) {
        const dir = path.join(manifestDir, 'assets');
        entry.files = fs.existsSync(dir)
          ? glob.sync('**/*', { cwd: dir, dot: false }).sort()
          : [];
      }
    } else if (s.type === 'amxmodx') {
      entry.source = `amxmodx ${manifest.amxmodx.version || 'latest'} (${manifest.platform || 'host'})`;
    } else if (s.type === 'release') {
      entry.source = `${s.repo}@${s.ref}`;
      entry.asset  = s.asset ?? null;
      entry.cache  = 'global';
    } else {
      entry.source = s.url;
      entry.cache  = s.cache || 'none';
    }
    return entry;
  });

  return textResult(
    applyOutputLimit(JSON.stringify({ on_conflict: manifest.assets.on_conflict, sources: plan }, null, 2), args)
  );
}

// ─── Manifest schema ───────────────────────────────────────────────────────────

async function handleManifestSchema(args) {
  const schema = getManifestSchema();
  if (!schema) {
    return textResult('No schema file found (schema/amxbuild.schema.json missing).');
  }
  return textResult(applyOutputLimit(JSON.stringify(schema, null, 2), args));
}

// ─── Symbol search ─────────────────────────────────────────────────────────────

const MAX_SYMBOLS_PER_SOURCE = 100;

async function handleSearchSymbol(args, token, noFetch) {
  if (!args?.symbol) return errorResult('Missing required "symbol" parameter', -32602);
  const scope   = args?.scope || 'all';
  const partial = args?.partial === true;

  const sources = [];
  const errors  = [];

  const addSource = async (label, dirs, pattern) => {
    if (!dirs.length) return;
    try {
      const index = await buildIndex(dirs, pattern);
      sources.push({ label, index });
    } catch (err) {
      errors.push(`${label}: ${err.message}`);
    }
  };

  const manifestPath = resolveManifestPath(args?.manifest || undefined);
  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = parseManifest(manifestPath);
    } catch (err) {
      errors.push(`manifest ${manifestPath}: ${err.message}`);
    }
  }

  const jobs = [];

  if (scope === 'all' || scope === 'stdlib') {
    jobs.push((async () => {
      try {
        const version = await resolveAmxmodxVersion(args, noFetch);
        const { includeDir } = await fetchCompiler(version);
        if (includeDir) await addSource(`stdlib ${version}`, [includeDir], '**/*.inc');
      } catch (err) {
        errors.push(`stdlib: ${err.message}`);
      }
    })());
  }

  const deps = manifest?.globalDeps?.length
    ? manifest.globalDeps
    : (args?.deps || []).map(parseDep);
  if ((scope === 'all' || scope === 'deps') && deps.length) {
    for (const dep of deps) {
      jobs.push((async () => {
        try {
          const dir = await fetchDepIncludeDir(dep, token, noFetch);
          await addSource(`${dep.repo}@${dep.ref}`, [dir], '**/*.inc');
        } catch (err) {
          errors.push(`${dep.repo}@${dep.ref}: ${err.message}`);
        }
      })());
    }
  }

  if (scope === 'all' || scope === 'local') {
    const baseDir = manifest ? path.dirname(manifest._path) : process.cwd();
    const amxDir  = manifest
      ? path.join(path.dirname(manifest._path), manifest.amxmodx.dir)
      : path.join(process.cwd(), 'amxmodx');
    if (fs.existsSync(amxDir)) {
      await addSource('local project', [amxDir]);
    } else {
      errors.push('local: no amxmodx/ dir found next to the manifest');
    }
  }

  await Promise.all(jobs);

  if (!sources.length) {
    return textResult(
      `No searchable sources.\n\nErrors:\n` +
      (errors.length ? errors.map((e) => `  ${e}`).join('\n') : '  (none)')
    );
  }

  const matches = sources.map((s) => ({
    label: s.label,
    results: searchIndex(s.index, args.symbol, { partial }),
  }));

  const total = matches.reduce((n, m) => n + m.results.length, 0);
  if (total === 0) {
    let msg =
      `Symbol "${args.symbol}" not found in any source.\n\nSearched:\n` +
      matches.map((m) => `  ${m.label}`).join('\n');
    if (errors.length) msg += `\n\nFailed to search:\n` + errors.map((e) => `  ${e}`).join('\n');
    return textResult(msg);
  }

  let out = `Symbol "${args.symbol}" — ${total} declaration(s)${partial ? ' (partial match)' : ''}:\n`;
  for (const m of matches) {
    if (!m.results.length) continue;
    const shown = m.results.slice(0, MAX_SYMBOLS_PER_SOURCE);
    out += `\n── ${m.label} ──\n`;
    for (const r of shown) {
      out += `  ${r.name}\n`;
      for (const hit of r.matches) {
        out += `    ${hit.file}:${hit.line}  [${hit.kind}] ${hit.signature}\n`;
      }
    }
    if (m.results.length > shown.length) {
      out += `  … [${m.results.length - shown.length} more]`;
    }
  }
  if (errors.length) out += `\n\nNote — failed to search:\n` + errors.map((e) => `  ${e}`).join('\n');
  return textResult(applyOutputLimit(out, args));
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
  build_include_tree:   handleBuildIncludeTree,
  list_amxmodx_incs:    handleListAmxmodxIncs,
  get_amxmodx_include:  handleGetAmxmodxInclude,
  resolve_include:      handleResolveInclude,
  build_plan:           handleBuildPlan,
  list_repo_files:      handleListRepoFiles,
  read_repo_file:       handleReadRepoFile,
  compile_sma:          handleCompileSma,
  resolve_assets:       handleResolveAssets,
  manifest_schema:      handleManifestSchema,
  search_symbol:        handleSearchSymbol,
};

module.exports = { HANDLERS };
