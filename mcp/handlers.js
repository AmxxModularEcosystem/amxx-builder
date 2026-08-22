'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const glob = require('fast-glob');

const { fetchRepo, resolveRefIfLatest } = require('../src/repo-fetcher');
const { fetchReleaseDep }       = require('../src/release-fetcher');
const { fetchCompiler, resolveAmxmodxVersion: resolveAmxmodxVersionCore } = require('../src/compiler-fetcher');
const { resolveManifest, resolveGithubToken, parseDepString, parseDepObject } = require('../src/manifest');
const { parseManifest }         = require('../src/manifest');
const { validateManifestFile }  = require('../src/validate');
const { getManifestSchema }     = require('../src/schema');
const { getCacheInfo }          = require('../src/cache-info');
const { buildDepTree, assembleRootDeps } = require('../src/deps-tree');
const { buildIncludeTree, fetchDepIncludeDir, parseIncludeDirective, searchIncludeFile, collectIncFiles } = require('../src/include-tree');
const { listReleases, listTags } = require('../src/release-lister');
const { buildPlanData }         = require('../src/build-plan');
const { spawnCompiler, buildIncludeArgs, buildDefineArgs } = require('../src/compile-utils');
const { buildIndex, searchIndex } = require('./symbol-index');
const { loadEnv }               = require('../src/env');
const { resolveManifestPath }   = require('../src/manifest-path');
const { formatBytes }           = require('../src/format');
const logger                    = require('../src/logger');

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

// Fallback token when no manifest is in scope — plain `token || GITHUB_TOKEN`.
function fallbackToken(token) {
  return token || process.env.GITHUB_TOKEN || null;
}

// ─── Output limits ─────────────────────────────────────────────────────────────

const DEFAULT_MAX_OUTPUT_BYTES = 200 * 1024; // 200 KB
const DEFAULT_MAX_FILES        = 50;

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
  if (typeof raw === 'string') return parseDepString(raw);
  if (raw && typeof raw === 'object') return parseDepObject(raw);
  throw new Error('Dep must be a string or an object');
}

function resolveDepRef(dep, token) {
  return resolveRefIfLatest(dep.ref, dep.repo, token);
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

// ─── Tool handlers ─────────────────────────────────────────────────────────────

async function handleGetDepInterface(args, token, noFetch) {
  token = fallbackToken(token);
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
  token = fallbackToken(token);
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
  let tokenFor = null;

  if (args?.manifest) {
    const manifest = parseManifest(path.resolve(args.manifest));
    tokenFor = (repo) => resolveGithubToken(manifest, repo);
    const assembled = assembleRootDeps(manifest);
    rootDeps = assembled.rootDeps;
    getDepsOverride = assembled.getDepsOverride;
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
    tokenFor,
    noFetch,
    depth,
    from: args?.manifest ? 'manifest' : 'user',
    getDepsOverride,
  });

  return textResult(applyOutputLimit(JSON.stringify(tree, null, 2), args));
}

async function handleResolveManifestTool(args) {
  const manifestPath = resolveManifestPath(args?.manifest).path;
  const fullPath = path.resolve(manifestPath);
  loadEnv(fullPath);

  const manifest = resolveManifest(fullPath, {
    set:    args?.set,
    define: args?.define,
  });

  return textResult(applyOutputLimit(JSON.stringify(manifest, null, 2), args));
}

async function handleValidateManifestTool(args) {
  const manifestPath = resolveManifestPath(args?.manifest).path;
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
  token = fallbackToken(token);

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
 * Resolve the AMX Mod X version to use.
 * Priority: explicit `version` arg → manifest `amxmodx.version` → latest.
 * The priority logic lives in core (compiler-fetcher.resolveAmxmodxVersion);
 * this wrapper only does arg extraction + manifest discovery/parse, keeping
 * the current error-fallback behavior (unparseable manifest → latest).
 */
async function resolveAmxmodxVersion(args, noFetch) {
  if (args?.version) return resolveAmxmodxVersionCore(null, { version: args.version });

  const manifestPathStr = args?.manifest;
  const manifestPath = resolveManifestPath(manifestPathStr || undefined).path;
  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = parseManifest(manifestPath);
    } catch (err) {
      logger.warn(`Manifest parse failed (${manifestPath}), falling back to latest: ${err.message}`);
    }
  }

  return resolveAmxmodxVersionCore(manifest, { noFetch });
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

  // Dep includes come BEFORE the stdlib — matching the real build's search
  // order (deps first, then the compiler bundle).
  const manifestPath = resolveManifestPath(args?.manifest || undefined).path;
  const depErrors = [];
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = parseManifest(manifestPath);
      for (const dep of manifest.globalDeps) {
        try {
          const depDir = await fetchDepIncludeDir(dep, resolveGithubToken(manifest, dep.repo), noFetch);
          searchPaths.push({ path: depDir, label: `${dep.repo}@${dep.ref}` });
        } catch (err) {
          depErrors.push(`${dep.repo}@${dep.ref}: ${err.message}`);
        }
      }
    } catch (err) {
      depErrors.push(`manifest ${manifestPath}: ${err.message}`);
    }
  }

  const version = await resolveAmxmodxVersion(args, noFetch);
  const { includeDir } = await fetchCompiler(version);
  if (includeDir) {
    searchPaths.push({ path: includeDir, label: `AMXX stdlib ${version}` });
  }

  const result = searchIncludeFile(searchPaths, filename);

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
  const manifestPath = resolveManifestPath(args?.manifest).path;
  const fullPath = path.resolve(manifestPath);
  loadEnv(fullPath, { quiet: true, override: false });

  try {
    const manifest = resolveManifest(fullPath, { set: args?.set, define: args?.define });
    return textResult(applyOutputLimit(JSON.stringify(buildPlanData(manifest), null, 2), args));
  } catch (err) {
    return errorResult(err.message);
  }
}

// ─── Repo file access ──────────────────────────────────────────────────────────

async function fetchDepRoot(args, token, noFetch) {
  token = fallbackToken(token);
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

  const resolvedRef = await resolveRefIfLatest(dep.ref, dep.repo, token);
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
  return spawnCompiler(cmd, args);
}

async function handleCompileSma(args, token, noFetch) {
  if (!args?.sma_file) return errorResult('Missing required "sma_file" parameter', -32602);
  const smaPath = path.resolve(args.sma_file);
  if (!fs.existsSync(smaPath)) return errorResult(`File not found: ${smaPath}`);

  const version = await resolveAmxmodxVersion(args, noFetch);
  const { compilerPath, includeDir } = await fetchCompiler(version);

  const depDirs = [];
  const depErrors = [];
  const manifestPath = resolveManifestPath(args?.manifest || undefined).path;
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = parseManifest(manifestPath);
      for (const dep of manifest.globalDeps) {
        try {
          depDirs.push(await fetchDepIncludeDir(dep, resolveGithubToken(manifest, dep.repo), noFetch));
        } catch (err) {
          depErrors.push(`${dep.repo}@${dep.ref}: ${err.message}`);
        }
      }
    } catch (err) {
      depErrors.push(`manifest ${manifestPath}: ${err.message}`);
    }
  }

  // Dep includes come BEFORE the stdlib — matching the real build's search
  // order (deps first, then the compiler bundle).
  const includeDirs = [...depDirs];
  if (includeDir) includeDirs.push(includeDir);
  for (const d of args?.include_dirs || []) includeDirs.push(path.resolve(d));

  const includes = buildIncludeArgs({
    scriptingDir: path.dirname(smaPath),
    localIncDir: path.join(path.dirname(smaPath), 'include'),
    collectedIncDir: undefined,
    includeDirs,
  });
  const defines = buildDefineArgs(args?.define);

  const outDir = path.join(os.tmpdir(), 'amxb-mcp-compile');
  fs.mkdirSync(outDir, { recursive: true });
  // Unique suffix per call: the server now dispatches requests concurrently,
  // so two compile_sma calls for the same file must not share an output path.
  const outPath = path.join(outDir, `${path.basename(smaPath, '.sma')}_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.amxx`);

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
  const manifestPath = resolveManifestPath(args?.manifest).path;
  const fullPath = path.resolve(manifestPath);

  let manifest;
  try {
    manifest = parseManifest(fullPath);
  } catch (err) {
    return errorResult(err.message);
  }

  const plan = buildPlanData(manifest, {
    detailedAssets: true,
    listLocal: args?.list_local !== false,
  });

  return textResult(
    applyOutputLimit(
      JSON.stringify({ on_conflict: manifest.assets.on_conflict, sources: plan.assets }, null, 2),
      args
    )
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

  const manifestPath = resolveManifestPath(args?.manifest || undefined).path;
  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = parseManifest(manifestPath);
    } catch (err) {
      errors.push(`manifest ${manifestPath}: ${err.message}`);
    }
  }

  // Per-owner token when a manifest is in scope; plain arg/env fallback otherwise.
  const tokenFor = (repo) => manifest
    ? resolveGithubToken(manifest, repo)
    : fallbackToken(token);

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
          const dir = await fetchDepIncludeDir(dep, tokenFor(dep.repo), noFetch);
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
