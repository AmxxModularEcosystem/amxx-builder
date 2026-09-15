#!/usr/bin/env node
'use strict';

/**
 * `amxb serve` — thin JSON-RPC interface adapter for editor integration.
 *
 * Generic JSON-RPC 2.0 over stdio (src/jsonrpc-transport.js). Every method is a
 * thin mapping: normalize args → call the core single-source function → shape
 * the result. NO domain logic lives here (per AGENTS.md); if a behavior is
 * needed in more than one interface it belongs in src/.
 *
 * Environment: stdout must stay pure JSON-RPC, so logs go to stderr
 * (logger.setStderr) and progress bars are disabled. .env is loaded from the
 * workspace root (cwd), like the CLI.
 *
 * Method table:
 *   manifest.validate       → validate.manifestFile
 *   manifest.resolve        → env.loadEnv + manifest.resolveManifest
 *   manifest.dep            → agent-assets readDepManifest + parseDocEntries/parseSkillEntries
 *   docs.list / docs.get    → agent-assets collectDepAssets / collectLocalAssets
 *   skills.list / skills.get → agent-assets collectDepAssets / collectLocalAssets
 *   include.resolve         → include-tree parseIncludeDirective + searchIncludeFile
 *   include.list            → deps-resolver collectDepIncludeDirs + include-tree collectIncFiles
 *   amxmodx.includes.list   → compiler-fetcher fetchCompiler + glob
 *   amxmodx.include.get     → compiler-fetcher fetchCompiler + glob + read
 *   deps.tree               → deps-tree buildDepTree + assembleRootDeps
 *   releases.list           → release-lister listReleases / listTags
 *   repos.info              → github-api getRepoInfo
 *   repos.branches          → github-api listBranches
 *   repos.structure         → github-api getRepoStructure
 *   cache.info              → cache-info getCacheInfo
 *   compiler.info           → compiler-fetcher getCompilerInfo
 *   dep-graph.get           → dep-graph DepGraph
 *   build.plan              → build-plan buildPlanData
 *   build.start             → build-service runBuild (+ event notifications)
 *   build.cancel            → abort the running build (AbortController)
 *   compile.single          → compiler.compileSingle (+ captured output)
 *   deploy.start / deploy.file / deploy.remove → deployer deployBuild/deployFile/removeDeployedFile
 *   rcon.send               → rcon sendRcon
 *   watch.start / watch.stop → watcher.startWatch (+ watch.changed notifications)
 *   serve.ping              → process info (health check)
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const glob = require('fast-glob');
const dotenv = require('dotenv');

const logger   = require('../logger');
const progress = require('../progress');
const { JsonRpcServer } = require('../jsonrpc-transport');
const { on, off, EVENTS } = require('../events');

const { loadEnv } = require('../env');
const { resolveManifestPath } = require('../manifest-path');
const { resolveManifest, parseManifest, resolveGithubToken, parseDepString, parseDepObject, parseDocEntries, parseSkillEntries } = require('../manifest');
const { resolveLocalEntry } = require('../local-sources');
const { readDepManifest, collectDepAssets, collectLocalAssets } = require('../agent-assets');
const { validateManifestFile } = require('../validate');
const { collectIncFiles, parseIncludeDirective, searchIncludeFile } = require('../include-tree');
const { depLabel, collectDepIncludeDirs } = require('../deps-resolver');
const { fetchCompiler, resolveAmxmodxVersion, getCompilerInfo, getHostPlatform, resolveStdlibVersion } = require('../compiler-fetcher');
const { buildDepTree, assembleRootDeps } = require('../deps-tree');
const { listReleases, listTags } = require('../release-lister');
const {
  getRepoInfo, listBranches, getRepoStructure,
  GithubError, isValidRepo, validateRepoStructureOptions,
} = require('../github-api');
const { getCacheInfo } = require('../cache-info');
const { buildPlanData } = require('../build-plan');
const { runBuild } = require('../build-service');
const { compileSingle } = require('../compiler');
const { deployBuild, deployFile, removeDeployedFile } = require('../deployer');
const { sendRcon } = require('../rcon');
const { DepGraph } = require('../dep-graph');
const { startWatch } = require('../watcher');
const pkg = require('../../package.json');

// ─── Small interface helpers (no domain logic) ────────────────────────────────

function readFileSafe(absPath) {
  try {
    const text = fs.readFileSync(absPath, 'utf8');
    return text;
  } catch (err) {
    return `[error reading file: ${err.message}]`;
  }
}

// JSON-RPC params spell no-fetch either `noFetch` (serve convention) or
// `no_fetch` (snake_case convention) — normalize once here.
function noFetchParam(params) {
  return params?.noFetch === true || params?.no_fetch === true;
}

// Resolve a concrete compiler version string for handlers that go on to call
// fetchCompiler() (dep-graph.get, compile.single). Explicit `version` arg wins,
// then the project manifest's amxmodx.version, then latest — priority lives in
// core (compiler-fetcher.resolveAmxmodxVersion). An invalid explicit version is
// a JSON-RPC param error (-32602); everything else (incl. LATEST_NOT_CACHED)
// propagates — these handlers fetch a real compiler, so a graceful empty state
// is meaningless here.
async function resolveVersionFromParams(params) {
  try {
    if (params?.version) {
      // await is required: a returned non-awaited promise bypasses this
      // try/catch, so INVALID_AMXMODX_VERSION would never map to -32602.
      return await resolveAmxmodxVersion(null, { version: params.version, noFetch: noFetchParam(params) });
    }

    const manifestPath = params?.manifest
      ? path.resolve(params.manifest)
      : resolveManifestPath().path;
    let manifest = null;
    if (fs.existsSync(manifestPath)) {
      try { manifest = parseManifest(manifestPath); } catch { manifest = null; }
    }
    return await resolveAmxmodxVersion(manifest, { noFetch: noFetchParam(params) });
  } catch (err) {
    if (err && err.code === 'INVALID_AMXMODX_VERSION') {
      err.code = -32602;
      throw err;
    }
    throw err;
  }
}

// Informational stdlib lookup for manifest-less / offline clients. Never
// downloads when noFetch; if latest cannot be resolved offline, degrades to
// the newest cached compiler instead of failing (degraded: true). Nothing
// cached at all → graceful empty state (version: null), not an error.
// Version-priority + offline degradation live in core
// (compiler-fetcher.resolveStdlibVersion); this wrapper only does arg/manifest
// discovery, the INVALID→-32602 remap and getCompilerInfo state shaping.
async function resolveStdlibState(params) {
  const noFetch = noFetchParam(params);
  let manifest = null;
  if (!params?.version) {
    const manifestPath = manifestPathFor(params);
    if (fs.existsSync(manifestPath)) {
      try { manifest = parseManifest(manifestPath); } catch { manifest = null; }
    }
  }
  const { version, degraded, error } = await resolveStdlibVersion({
    version: params?.version,
    manifest,
    noFetch,
  });
  if (error) {
    if (error.code === 'INVALID_AMXMODX_VERSION') error.code = -32602;
    throw error;
  }
  if (version === null) {
    return { version: null, degraded: false, platform: getHostPlatform(), compilerPath: null, includeDir: null, cached: false };
  }
  const info = await getCompilerInfo(version, { noFetch });
  return { version: info.version, degraded, platform: info.platform, compilerPath: info.compilerPath, includeDir: info.includeDir, cached: info.cached };
}

function manifestPathFor(params) {
  return params?.manifest ? path.resolve(params.manifest) : resolveManifestPath().path;
}

/**
 * GitHub token for repo-scope methods. Manifest tokens win: the .env next to
 * the manifest is loaded first (it overrides the cwd .env loaded at startup —
 * per the env convention: manifest .env is primary, cwd is the fallback).
 * Then the explicit `token` param, then the process env, then anonymous.
 */
function resolveGithubTokenFor(params, repo) {
  const manifestPath = manifestPathFor(params);
  if (fs.existsSync(manifestPath)) {
    loadEnvQuiet(manifestPath);
    try {
      const fromManifest = resolveGithubToken(parseManifest(manifestPath), repo);
      if (fromManifest) return fromManifest;
    } catch { /* unparseable manifest — fall back to explicit/env token */ }
  }
  return params?.token || process.env.GITHUB_TOKEN || null;
}

// Build a parsed dep object from params: either a full `dep` string/object or
// explicit { repo, ref?, source?, include_path?, asset? } fields.
function depFromParams(params) {
  let dep;
  if (params?.dep) {
    if (typeof params.dep === 'string') dep = parseDepString(params.dep);
    else if (params.dep.source === 'local') dep = parseDepObject(params.dep);
    else dep = { ...params.dep };
  } else {
    if (!params?.repo) throw new Error('Provide either "dep" or "repo"');
    const source = params.source || 'git';
    const ref = params.ref || (source === 'release' ? 'latest' : null);
    dep = { repo: params.repo, ref, source, include_path: params.include_path || null, asset: params.asset ?? null };
  }
  if (params?.source) dep.source = params.source;
  if (params?.include_path) dep.include_path = params.include_path;
  if (params?.asset != null) dep.asset = params.asset;
  return resolveLocalEntry(
    dep,
    params?.manifest ? path.dirname(path.resolve(params.manifest)) : process.cwd()
  );
}

// Agent docs/skills: dep mode when dep/repo is present, otherwise the local
// project's own manifest.
async function collectAgentAssets(params) {
  const noFetch = noFetchParam(params);
  if (params?.dep || params?.repo) {
    const dep = depFromParams(params);
    const token = resolveGithubTokenFor(params, dep.repo);
    return collectDepAssets(dep, { token, noFetch });
  }
  const manifestPath = manifestPathFor(params);
  loadEnvQuiet(manifestPath);
  return collectLocalAssets(parseManifest(manifestPath));
}

/**
 * Shape a GitHub API error into the JSON-RPC error contract: -32603 with
 * error.data = { status, repo, message }. Returns null for non-GitHub errors
 * so the caller rethrows them unchanged.
 */
function githubRpcError(err, repo) {
  if (err instanceof GithubError) {
    err.code = -32603;
    err.data = { status: err.status, repo, message: err.message };
    return err;
  }
  if (err && err.response && typeof err.response.status === 'number') {
    // Raw axios error (release-lister path) — normalize to the same contract.
    const message = (err.response.data && err.response.data.message) || err.message;
    const shaped = new Error(message);
    shaped.code = -32603;
    shaped.data = { status: err.response.status, repo, message };
    return shaped;
  }
  return null;
}

function repoParamError(params) {
  if (!params?.repo) return 'Missing required "repo" field';
  if (!isValidRepo(params.repo)) return 'Invalid "repo": expected "owner/repo"';
  return null;
}

// dotenv@17 prints an "injected env" line to stdout by default, which would
// break the pure-JSON-RPC stdout contract — always load quietly here.
function loadEnvQuiet(manifestPath) {
  loadEnv(manifestPath, { quiet: true });
}

// Full manifest (defaults merged, set/define applied) for deploy methods.
function deployRequestManifest(params) {
  const manifestPath = manifestPathFor(params);
  loadEnvQuiet(manifestPath);
  return resolveManifest(manifestPath, { set: params?.set, define: params?.define });
}

function buildDirFor(params) {
  return params?.buildDir ? path.resolve(params.buildDir) : path.join(process.cwd(), 'build');
}

/**
 * Create and configure the JSON-RPC server with all methods wired to core.
 * Does NOT connect or set up the environment — call runServe() for that.
 */
function createServeServer() {
  const server = new JsonRpcServer();

  // One build / one watcher at a time (per-process).
  let activeBuild   = null; // AbortController for the running build
  let activeWatcher = null; // chokidar watcher instance

  // ─── Health check ────────────────────────────────────────────────────────

  server.onRequest('serve.ping', () => ({
    ok: true,
    pid: process.pid,
    version: pkg.version,
    node: process.version,
  }));

  // ─── Read-only: manifest ──────────────────────────────────────────────────

  server.onRequest('manifest.validate', (params) => {
    return validateManifestFile(manifestPathFor(params));
  });

  server.onRequest('manifest.resolve', (params) => {
    const manifestPath = manifestPathFor(params);
    loadEnvQuiet(manifestPath);
    return resolveManifest(manifestPath, { set: params?.set, define: params?.define });
  });

  // ─── Dependency manifest + agent assets ──────────────────────────────────

  server.onRequest('manifest.dep', async (params) => {
    let dep;
    try {
      dep = depFromParams(params);
    } catch (err) {
      err.code = -32602;
      throw err;
    }
    const token = resolveGithubTokenFor(params, dep.repo);
    const m = await readDepManifest(dep, { token, noFetch: noFetchParam(params) });

    let docs = [];
    let skills = [];
    try { docs = parseDocEntries(m.raw?.docs || []); } catch { docs = []; }
    try { skills = parseSkillEntries(m.raw?.skills || []); } catch { skills = []; }

    return {
      label: m.label,
      manifestPath: m.manifestPath,
      manifestName: m.raw?.name || null,
      raw: m.raw,
      docs: docs.map((d) => ({ name: d.name, description: d.description, file: d.file })),
      skills: skills.map((s) => ({ name: s.name, description: s.description, file: s.file, dir: s.dir })),
    };
  });

  server.onRequest('docs.list', async (params) => {
    const assets = await collectAgentAssets(params);
    return {
      label: assets.label || null,
      docs: assets.docs.map((d) => ({ name: d.name, description: d.description, file: d.file })),
      missing: assets.missing,
    };
  });

  server.onRequest('docs.get', async (params) => {
    const assets = await collectAgentAssets(params);
    let docs = assets.docs;
    if (params?.name || params?.file) {
      docs = docs.filter(
        (d) => (params.name && d.name === params.name) || (params.file && d.file === params.file)
      );
    }
    return {
      label: assets.label || null,
      docs: docs.map((d) => ({ name: d.name, description: d.description, file: d.file, content: d.content })),
      missing: assets.missing,
    };
  });

  server.onRequest('skills.list', async (params) => {
    const assets = await collectAgentAssets(params);
    return {
      label: assets.label || null,
      skills: assets.skills.map((s) => ({
        name: s.name,
        description: s.description,
        kind: s.kind,
        file: s.file,
        dir: s.dir,
        files: s.kind === 'dir' ? s.files.map((f) => f.rel) : undefined,
      })),
      missing: assets.missing,
    };
  });

  server.onRequest('skills.get', async (params) => {
    const assets = await collectAgentAssets(params);
    let skills = assets.skills;
    if (params?.name) skills = skills.filter((s) => s.name === params.name);
    return {
      label: assets.label || null,
      skills: skills.map((s) => (
        s.kind === 'dir'
          ? { name: s.name, description: s.description, kind: 'dir', dir: s.dir, files: s.files.map((f) => ({ rel: f.rel, content: f.content })) }
          : { name: s.name, description: s.description, kind: 'file', file: s.file, content: s.content }
      )),
      missing: assets.missing,
    };
  });

  // ─── Include resolution ──────────────────────────────────────────────────

  server.onRequest('include.resolve', async (params) => {
    let parsed;
    try {
      parsed = parseIncludeDirective(params?.directive || params?.include);
    } catch (err) {
      err.code = -32602;
      throw err;
    }
    const { filename, localFirst } = parsed;
    const searchPaths = [];

    if (localFirst) {
      const smaDir = params?.sma_file
        ? path.dirname(path.resolve(params.sma_file))
        : process.cwd();
      searchPaths.push({
        path: smaDir,
        label: params?.sma_file ? `local (${path.basename(params.sma_file)})` : 'local (current directory)',
      });
    }

    // Dep includes come BEFORE the stdlib — matching the real build's search
    // order (deps first, then the compiler bundle).
    const errors = [];
    let manifest = null;
    const manifestPath = manifestPathFor(params);
    if (fs.existsSync(manifestPath)) {
      loadEnvQuiet(manifestPath);
      try {
        manifest = parseManifest(manifestPath);
      } catch (err) {
        errors.push(`manifest ${manifestPath}: ${err.message}`);
      }
    }
    if (manifest) {
      const { dirs, errors: depErrors } = await collectDepIncludeDirs(manifest, {
        noFetch: noFetchParam(params),
        ssh: manifest.github.ssh,
      });
      manifest.globalDeps.forEach((dep, i) => {
        if (dirs[i]) searchPaths.push({ path: dirs[i], label: depLabel(dep) });
        else if (depErrors[i]) errors.push(`${depLabel(dep)}: ${depErrors[i]}`);
      });
    }

    const stdlib = await resolveStdlibState(params);
    if (stdlib.includeDir) searchPaths.push({ path: stdlib.includeDir, label: `AMXX stdlib ${stdlib.version}` });

    const result = searchIncludeFile(searchPaths, filename);
    if (!result) {
      return {
        found: false,
        filename,
        searched: searchPaths.map((s) => s.label),
        errors: errors.length ? errors : undefined,
      };
    }
    return {
      found: true,
      filename,
      absPath: result.foundPath,
      source: result.label,
      searched: searchPaths.map((s) => s.label),
      errors: errors.length ? errors : undefined,
    };
  });

  server.onRequest('include.list', async (params) => {
    const manifestPath = manifestPathFor(params);
    if (!fs.existsSync(manifestPath)) {
      const err = new Error(`Manifest not found: ${manifestPath}`);
      err.code = -32602;
      throw err;
    }
    loadEnvQuiet(manifestPath);
    const manifest = parseManifest(manifestPath);

    const { dirs, errors } = await collectDepIncludeDirs(manifest, {
      noFetch: noFetchParam(params),
      ssh: manifest.github.ssh,
    });

    const deps = [];
    for (let i = 0; i < manifest.globalDeps.length; i++) {
      const dep = manifest.globalDeps[i];
      const base = dep.source === 'fungun'
        ? { source: 'fungun', id: dep.id, url: dep.url }
        : { source: dep.source || 'git', repo: dep.repo, ref: dep.ref };
      if (errors[i]) {
        deps.push({ ...base, error: errors[i], files: [], count: 0 });
        continue;
      }
      try {
        const files = await collectIncFiles(dirs[i]);
        deps.push({
          ...base,
          include_path: dep.include_path || null,
          include_dir: dirs[i],
          count: files.length,
          files: files.map((f) => ({ rel: f.rel, abs: f.abs })),
        });
      } catch (err) {
        deps.push({ ...base, error: err.message, files: [], count: 0 });
      }
    }
    return { manifest: manifestPath, deps };
  });

  // ─── AMXX standard includes ──────────────────────────────────────────────

  server.onRequest('amxmodx.includes.list', async (params) => {
    const state = await resolveStdlibState(params);
    const pattern = params?.pattern || '*.inc';

    if (!state.includeDir) {
      const result = { version: state.version, includeDir: null, pattern, count: 0, files: [] };
      if (state.degraded) result.degraded = true;
      return result;
    }

    const files = await glob(pattern, { cwd: state.includeDir, dot: false });
    files.sort();
    const result = { version: state.version, includeDir: state.includeDir, pattern, count: files.length, files };
    if (state.degraded) result.degraded = true;
    return result;
  });

  server.onRequest('amxmodx.include.get', async (params) => {
    const state = await resolveStdlibState(params);
    const pattern = params?.file || params?.pattern || '*.inc';

    if (!state.includeDir) {
      const result = { version: state.version, includeDir: null, count: 0, files: [] };
      if (state.degraded) result.degraded = true;
      return result;
    }

    const files = await glob(pattern, { cwd: state.includeDir, dot: false });
    files.sort();
    const result = {
      version: state.version,
      includeDir: state.includeDir,
      count: files.length,
      files: files.map((rel) => ({ rel, content: readFileSafe(path.join(state.includeDir, rel)) })),
    };
    if (state.degraded) result.degraded = true;
    return result;
  });

  // ─── Deps tree ───────────────────────────────────────────────────────────

  server.onRequest('deps.tree', async (params) => {
    const depth = params?.depth || 0;
    const noFetch = noFetchParam(params);

    if (params?.deps) {
      const rootDeps = params.deps.map((entry) => {
        if (typeof entry === 'string') {
          const parsed = parseDepString(entry);
          return { repo: parsed.repo, ref: parsed.ref, source: parsed.source, include_path: parsed.include_path, asset: parsed.asset };
        }
        return {
          repo: entry.repo,
          ref: entry.ref,
          source: entry.source || 'git',
          include_path: entry.include_path || null,
          asset: entry.asset != null ? entry.asset : null,
        };
      });
      return buildDepTree(rootDeps, { token: params?.token, noFetch, depth, from: 'user' });
    }

    const manifestPath = manifestPathFor(params);
    loadEnvQuiet(manifestPath);
    const manifest = parseManifest(manifestPath);
    const assembled = assembleRootDeps(manifest);
    return buildDepTree(assembled.rootDeps, {
      token: params?.token,
      tokenFor: (repo) => resolveGithubToken(manifest, repo),
      noFetch,
      depth,
      from: 'manifest',
      getDepsOverride: assembled.getDepsOverride,
    });
  });

  // ─── Include dependency graph ────────────────────────────────────────────

  server.onRequest('dep-graph.get', async (params) => {
    if (!params?.sma_file) {
      const err = new Error('Missing required "sma_file" parameter');
      err.code = -32602;
      throw err;
    }
    const smaPath = path.resolve(params.sma_file);
    if (!fs.existsSync(smaPath)) {
      const err = new Error(`File not found: ${smaPath}`);
      err.code = -32602;
      throw err;
    }

    const noFetch = noFetchParam(params);

    const manifestPath = manifestPathFor(params);
    let manifest = null;
    if (fs.existsSync(manifestPath)) {
      loadEnvQuiet(manifestPath);
      try { manifest = parseManifest(manifestPath); } catch { manifest = null; }
    }

    const version = await resolveVersionFromParams(params);
    const { includeDir } = await fetchCompiler(version);

    // Dep includes come BEFORE the stdlib — matching the real build's search order.
    const includeDirs = [];
    if (manifest) {
      const { dirs } = await collectDepIncludeDirs(manifest, { noFetch, ssh: manifest.github.ssh });
      for (const dir of dirs) if (dir) includeDirs.push(dir);
    }
    if (includeDir) includeDirs.push(includeDir);
    for (const d of (params?.include_dirs || [])) includeDirs.push(path.resolve(d));

    const graph = new DepGraph(includeDirs);
    graph.parseFile(smaPath);

    const result = {
      sma_file: smaPath,
      version,
      include_dirs: includeDirs,
      ...graph.snapshot(),
    };

    // Reverse query: which .sma files transitively depend on this .inc?
    if (params?.inc) {
      const incAbs = path.resolve(params.inc);
      result.smas_depending_on = [...graph.getSmasDependingOn(incAbs)].sort();
    }

    return result;
  });

  // ─── Releases / repos / cache / plan ─────────────────────────────────────

  server.onRequest('releases.list', async (params) => {
    const invalid = repoParamError(params);
    if (invalid) {
      const err = new Error(invalid);
      err.code = -32602;
      throw err;
    }
    const repo = params.repo;
    const token = resolveGithubTokenFor(params, repo);
    const limit = params?.limit || 10;
    try {
      if (params?.tags) return await listTags(repo, { token, limit });
      return await listReleases(repo, { token, limit, includeAssets: params?.includeAssets });
    } catch (err) {
      throw githubRpcError(err, repo) || err;
    }
  });

  server.onRequest('repos.info', async (params) => {
    const invalid = repoParamError(params);
    if (invalid) {
      const err = new Error(invalid);
      err.code = -32602;
      throw err;
    }
    const repo = params.repo;
    const token = resolveGithubTokenFor(params, repo);
    try {
      return await getRepoInfo(repo, { token });
    } catch (err) {
      throw githubRpcError(err, repo) || err;
    }
  });

  server.onRequest('repos.branches', async (params) => {
    const invalid = repoParamError(params);
    if (invalid) {
      const err = new Error(invalid);
      err.code = -32602;
      throw err;
    }
    const repo = params.repo;
    const token = resolveGithubTokenFor(params, repo);
    const limit = Math.min(100, Math.max(1, params?.limit ?? 10));
    const page = Math.max(1, params?.page ?? 1);
    try {
      return await listBranches(repo, { token, limit, page });
    } catch (err) {
      throw githubRpcError(err, repo) || err;
    }
  });

  server.onRequest('repos.structure', async (params) => {
    const invalid = repoParamError(params) || validateRepoStructureOptions(params);
    if (invalid) {
      const err = new Error(invalid);
      err.code = -32602;
      throw err;
    }
    const repo = params.repo;
    const token = resolveGithubTokenFor(params, repo);
    try {
      return await getRepoStructure(repo, {
        token,
        ref: params?.ref || null,
        depth: params?.depth,
        dirsOnly: params?.dirsOnly === true,
        ext: params?.ext,
        maxEntries: params?.maxEntries,
      });
    } catch (err) {
      throw githubRpcError(err, repo) || err;
    }
  });

  server.onRequest('cache.info', (params) => {
    const manifestPath = params?.manifest ? path.resolve(params.manifest) : undefined;
    return getCacheInfo(manifestPath);
  });

  server.onRequest('compiler.info', async (params) => {
    const state = await resolveStdlibState(params);
    const result = { version: state.version, platform: state.platform, compilerPath: state.compilerPath, includeDir: state.includeDir, cached: state.cached };
    if (state.degraded) result.degraded = true;
    return result;
  });

  server.onRequest('build.plan', (params) => {
    const manifestPath = manifestPathFor(params);
    loadEnv(manifestPath, { quiet: true, override: false });
    const manifest = resolveManifest(manifestPath, { set: params?.set, define: params?.define });
    return buildPlanData(manifest, {
      detailedAssets: params?.detailedAssets === true,
      listLocal: params?.listLocal !== false,
    });
  });

  // ─── Build ───────────────────────────────────────────────────────────────

  server.onRequest('build.start', async (params) => {
    if (activeBuild) {
      const err = new Error('Build already running');
      err.code = -32000;
      throw err;
    }

    const controller = new AbortController();
    activeBuild = controller;

    try {
      const manifestPath = manifestPathFor(params);
      loadEnvQuiet(manifestPath);
      const manifest = resolveManifest(manifestPath, { set: params?.set, define: params?.define });

      // Forward core lifecycle events as server→client notifications while the
      // build runs. COMPILED/PROGRESS are emitted by compiler.js/progress.js on
      // the bus; STAGE/DONE/ERROR by build-service.
      const listeners = [
        [EVENTS.STAGE,    (p) => server.notify('build.stage', p)],
        [EVENTS.COMPILED, (p) => server.notify('build.compiled', p)],
        [EVENTS.PROGRESS, (p) => server.notify('build.progress', p)],
        [EVENTS.DONE,     (p) => server.notify('build.done', p)],
        [EVENTS.ERROR,    (p) => server.notify('build.error', p)],
      ];
      for (const [ev, fn] of listeners) on(ev, fn);

      try {
        const result = await runBuild(manifest, {
          buildDir: params?.buildDir,
          fetch:    params?.fetch,
          archive:  params?.archive,
          signal:   controller.signal,
        });
        return result;
      } catch (err) {
        if (err.code === 'CANCELLED') {
          return { ok: false, cancelled: true, message: err.message };
        }
        return { ok: false, message: err.message };
      } finally {
        for (const [ev, fn] of listeners) off(ev, fn);
      }
    } finally {
      // Even a pre-build failure (manifest missing, bad --set) must release the
      // single-build lock, or every later build.start dies with "Build already
      // running" until the process is restarted.
      activeBuild = null;
    }
  });

  server.onRequest('build.cancel', () => {
    if (!activeBuild) return { ok: false, error: 'No build running' };
    activeBuild.abort();
    return { ok: true };
  });

  // ─── Deploy ──────────────────────────────────────────────────────────────

  server.onRequest('deploy.start', async (params) => {
    const manifest = deployRequestManifest(params);
    if (!manifest.deploy || !manifest.deploy.path) {
      return { ok: false, message: 'Deploy path not configured.\n  → Set AMXB_DEPLOY_PATH in .env, or add deploy.path to your manifest' };
    }
    const copied = await deployBuild(manifest, buildDirFor(params), {
      incremental: params?.incremental === true,
    });
    return { ok: true, copied };
  });

  server.onRequest('deploy.file', (params) => {
    if (!params?.relPath) {
      const err = new Error('Missing required "relPath" parameter');
      err.code = -32602;
      throw err;
    }
    const section = params?.section === 'assets' ? 'assets' : 'amxmodx';
    const manifest = deployRequestManifest(params);
    if (!manifest.deploy || !manifest.deploy.path) {
      return { ok: false, message: 'Deploy path not configured' };
    }
    const dest = deployFile(manifest, buildDirFor(params), params.relPath, section);
    return { ok: dest != null, dest: dest || null };
  });

  server.onRequest('deploy.remove', (params) => {
    if (!params?.relPath) {
      const err = new Error('Missing required "relPath" parameter');
      err.code = -32602;
      throw err;
    }
    const section = params?.section === 'assets' ? 'assets' : 'amxmodx';
    const manifest = deployRequestManifest(params);
    if (!manifest.deploy || !manifest.deploy.path) {
      return { ok: false, message: 'Deploy path not configured' };
    }
    const dest = removeDeployedFile(manifest, buildDirFor(params), params.relPath, section);
    return { ok: dest != null, dest: dest || null };
  });

  // ─── RCON ────────────────────────────────────────────────────────────────

  server.onRequest('rcon.send', async (params) => {
    if (!params?.command) {
      const err = new Error('Missing required "command" parameter');
      err.code = -32602;
      throw err;
    }

    let host = params?.host;
    let port = params?.port;
    let password = params?.password;

    // Fall back to the manifest's deploy.rcon config when host/password are omitted.
    if ((host == null || password == null) && fs.existsSync(manifestPathFor(params))) {
      try {
        const rconCfg = parseManifest(manifestPathFor(params)).deploy?.rcon;
        if (rconCfg) {
          if (host == null) host = rconCfg.host;
          if (port == null) port = rconCfg.port;
          if (password == null) password = rconCfg.password;
        }
      } catch { /* unparseable manifest — explicit params only */ }
    }
    if (port == null) port = 27015;

    if (!host || !password) {
      const err = new Error('RCON host/password not provided (pass explicitly or configure deploy.rcon in the manifest)');
      err.code = -32602;
      throw err;
    }

    const response = await sendRcon({ host, port, password, command: params.command });
    return { ok: true, response };
  });

  // ─── Single-file compile ─────────────────────────────────────────────────

  server.onRequest('compile.single', async (params) => {
    if (!params?.sma_file) {
      const err = new Error('Missing required "sma_file" parameter');
      err.code = -32602;
      throw err;
    }
    const smaPath = path.resolve(params.sma_file);
    if (!fs.existsSync(smaPath)) {
      const err = new Error(`File not found: ${smaPath}`);
      err.code = -32602;
      throw err;
    }

    const noFetch = noFetchParam(params);

    const manifestPath = manifestPathFor(params);
    let manifest = null;
    if (fs.existsSync(manifestPath)) {
      loadEnvQuiet(manifestPath);
      try { manifest = parseManifest(manifestPath); } catch { manifest = null; }
    }

    const version = await resolveVersionFromParams(params);
    const { compilerPath, includeDir } = await fetchCompiler(version);

    // Dep includes come BEFORE the stdlib — matching the real build order.
    const depDirs = [];
    const depErrors = [];
    if (manifest) {
      const { dirs, errors } = await collectDepIncludeDirs(manifest, { noFetch, ssh: manifest.github.ssh });
      manifest.globalDeps.forEach((dep, i) => {
        if (dirs[i]) depDirs.push(dirs[i]);
        else if (errors[i]) depErrors.push(`${depLabel(dep)}: ${errors[i]}`);
      });
    }

    const includeDirs = [...depDirs];
    if (includeDir) includeDirs.push(includeDir);
    for (const d of (params?.include_dirs || [])) includeDirs.push(path.resolve(d));

    // Unique per-call build dir + event tag: the transport dispatches requests
    // concurrently, so two compile.single calls for same-named plugins must not
    // share an output path nor mis-attribute COMPILED events (cf. MCP).
    const runId     = `${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const buildDir  = path.join(os.tmpdir(), 'amxb-serve-compile', runId);
    const compileManifest = manifest || { amxmodx: { defines: [] } };

    let compiled = null;
    const onCompiled = (p) => { if (p.tag === runId) compiled = p; };
    on(EVENTS.COMPILED, onCompiled);
    let amxxName;
    try {
      amxxName = await compileSingle(
        compileManifest,
        smaPath,
        compilerPath,
        includeDirs,
        buildDir,
        params?.scripting_root ? path.resolve(params.scripting_root) : undefined,
        runId
      );
    } finally {
      off(EVENTS.COMPILED, onCompiled);
    }

    const outputPath = amxxName ? path.join(buildDir, 'amxmodx', 'plugins', amxxName) : null;
    return {
      ok: amxxName != null,
      amxxName,
      output: compiled ? compiled.output : undefined,
      output_path: outputPath,
      dep_errors: depErrors.length ? depErrors : undefined,
    };
  });

  // ─── Watch ───────────────────────────────────────────────────────────────

  server.onRequest('watch.start', (params) => {
    if (activeWatcher) {
      const err = new Error('Watch already running');
      err.code = -32000;
      throw err;
    }

    const manifestPath = manifestPathFor(params);
    loadEnvQuiet(manifestPath);
    const manifest = parseManifest(manifestPath);

    const notify = (kind, extra = {}) => server.notify('watch.changed', { kind, ...extra });
    const watcher = startWatch(manifest, manifestPath, {
      onSmaChange:     (p) => notify('sma', { path: p }),
      onIncChange:     (p) => notify('inc', { path: p }),
      onFileChange:    (rel, section) => notify('file', { rel, section }),
      onFileDelete:    (rel, section) => notify('delete', { rel, section }),
      onManifestChange: () => notify('manifest'),
    });

    activeWatcher = watcher;
    return { ok: true, watching: manifestPath };
  });

  server.onRequest('watch.stop', async () => {
    if (!activeWatcher) return { ok: false, error: 'No watcher running' };
    await activeWatcher.close();
    activeWatcher = null;
    return { ok: true };
  });

  return server;
}

  // Load project .env from the workspace root like the CLI does; keep stdout free
  // for JSON-RPC (logs → stderr, progress bars disabled).
  function prepareEnvironment() {
    dotenv.config({ path: path.join(process.cwd(), '.env'), quiet: true });
    logger.setStderr(true);
    progress.setEnabled(false);
  }

/**
 * Start the serve server — listens on stdin/stdout forever.
 */
async function runServe() {
  prepareEnvironment();
  const server = createServeServer();
  await server.connect();
}

module.exports = { runServe, createServeServer };

// ─── Direct execution guard ───────────────────────────────────────────────────

if (require.main === module) {
  runServe().catch((err) => {
    process.stderr.write(`Fatal serve error: ${err && err.message ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
