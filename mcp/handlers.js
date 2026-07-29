'use strict';

const fs   = require('fs');
const path = require('path');
const glob = require('fast-glob');

const { fetchRepo, resolveRef } = require('../src/repo-fetcher');
const { fetchReleaseDep }       = require('../src/release-fetcher');
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

  const files = incFiles.map((f) => ({
    path: f.rel,
    content: readFileSafe(f.abs),
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

// ─── Dispatch ──────────────────────────────────────────────────────────────────

const HANDLERS = {
  get_dep_interface:    handleGetDepInterface,
  list_dep_incs:        handleListDepIncs,
  get_dep_tree:         handleGetDepTree,
  resolve_manifest:     handleResolveManifestTool,
  validate_manifest:    handleValidateManifestTool,
  get_cache_info:       handleGetCacheInfo,
  list_releases:        handleListReleasesTool,
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
