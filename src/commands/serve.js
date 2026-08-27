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
 *   include.resolve         → include-tree parseIncludeDirective + searchIncludeFile
 *   include.list            → include-tree fetchDepIncludeDir + collectIncFiles
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
const { resolveManifest, parseManifest, resolveGithubToken, parseDepString } = require('../manifest');
const { validateManifestFile } = require('../validate');
const { fetchDepIncludeDir, collectIncFiles, parseIncludeDirective, searchIncludeFile } = require('../include-tree');
const { fetchCompiler, resolveAmxmodxVersion, getCompilerInfo } = require('../compiler-fetcher');
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

// Resolve the AMX Mod X version for a request: explicit `version` arg wins,
// then the project manifest's amxmodx.version, then latest. Priority logic
// lives in core (compiler-fetcher.resolveAmxmodxVersion).
async function resolveVersionFromParams(params) {
  if (params?.version) return resolveAmxmodxVersion(null, { version: params.version });

  const manifestPath = params?.manifest
    ? path.resolve(params.manifest)
    : resolveManifestPath().path;
  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    try { manifest = parseManifest(manifestPath); } catch { manifest = null; }
  }
  return resolveAmxmodxVersion(manifest, { noFetch: params?.noFetch === true });
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
        for (const dep of manifest.globalDeps) {
          try {
            const depDir = await fetchDepIncludeDir(
              dep, resolveGithubToken(manifest, dep.repo),
              params?.noFetch === true, manifest.github.ssh
            );
            searchPaths.push({ path: depDir, label: `${dep.repo}@${dep.ref}` });
          } catch (err) {
            errors.push(`${dep.repo}@${dep.ref}: ${err.message}`);
          }
        }
      } catch (err) {
        errors.push(`manifest ${manifestPath}: ${err.message}`);
      }
    }

    const version = await resolveVersionFromParams(params);
    const { includeDir } = await fetchCompiler(version);
    if (includeDir) searchPaths.push({ path: includeDir, label: `AMXX stdlib ${version}` });

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

    const deps = [];
    for (const dep of manifest.globalDeps) {
      try {
        const includeDir = await fetchDepIncludeDir(
          dep, resolveGithubToken(manifest, dep.repo),
          params?.noFetch === true, manifest.github.ssh
        );
        const files = await collectIncFiles(includeDir);
        deps.push({
          repo: dep.repo,
          ref: dep.ref,
          include_path: dep.include_path || null,
          include_dir: includeDir,
          count: files.length,
          files: files.map((f) => ({ rel: f.rel, abs: f.abs })),
        });
      } catch (err) {
        deps.push({ repo: dep.repo, ref: dep.ref, error: err.message, files: [], count: 0 });
      }
    }
    return { manifest: manifestPath, deps };
  });

  // ─── AMXX standard includes ──────────────────────────────────────────────

  server.onRequest('amxmodx.includes.list', async (params) => {
    const version = await resolveVersionFromParams(params);
    const pattern = params?.pattern || '*.inc';

    const { includeDir } = await fetchCompiler(version);
    if (!includeDir) return { version, includeDir: null, pattern, count: 0, files: [] };

    const files = await glob(pattern, { cwd: includeDir, dot: false });
    files.sort();
    return { version, includeDir, pattern, count: files.length, files };
  });

  server.onRequest('amxmodx.include.get', async (params) => {
    const version = await resolveVersionFromParams(params);
    const pattern = params?.file || params?.pattern || '*.inc';

    const { includeDir } = await fetchCompiler(version);
    if (!includeDir) return { version, includeDir: null, count: 0, files: [] };

    const files = await glob(pattern, { cwd: includeDir, dot: false });
    files.sort();
    return {
      version,
      includeDir,
      count: files.length,
      files: files.map((rel) => ({ rel, content: readFileSafe(path.join(includeDir, rel)) })),
    };
  });

  // ─── Deps tree ───────────────────────────────────────────────────────────

  server.onRequest('deps.tree', async (params) => {
    const depth = params?.depth || 0;
    const noFetch = params?.noFetch === true;

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

    const noFetch = params?.noFetch === true;

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
      for (const dep of manifest.globalDeps) {
        try {
          includeDirs.push(await fetchDepIncludeDir(
            dep, resolveGithubToken(manifest, dep.repo), noFetch, manifest.github.ssh
          ));
        } catch (err) { /* keep the rest of the dirs on partial failure */ }
      }
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
    const version = await resolveVersionFromParams(params);
    return getCompilerInfo(version, { noFetch: params?.noFetch === true });
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

    const noFetch = params?.noFetch === true;

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
      for (const dep of manifest.globalDeps) {
        try {
          depDirs.push(await fetchDepIncludeDir(
            dep, resolveGithubToken(manifest, dep.repo), noFetch, manifest.github.ssh
          ));
        } catch (err) {
          depErrors.push(`${dep.repo}@${dep.ref}: ${err.message}`);
        }
      }
    }

    const includeDirs = [...depDirs];
    if (includeDir) includeDirs.push(includeDir);
    for (const d of (params?.include_dirs || [])) includeDirs.push(path.resolve(d));

    const buildDir = path.join(os.tmpdir(), 'amxb-serve-compile');
    const compileManifest = manifest || { amxmodx: { defines: [] } };

    // Capture the compiler output emitted as an event by compileSingle.
    const baseName = path.basename(smaPath);
    let compiled = null;
    const onCompiled = (p) => { if (p.baseName === baseName) compiled = p; };
    on(EVENTS.COMPILED, onCompiled);
    let amxxName;
    try {
      amxxName = await compileSingle(
        compileManifest,
        smaPath,
        compilerPath,
        includeDirs,
        buildDir,
        params?.scripting_root ? path.resolve(params.scripting_root) : undefined
      );
    } finally {
      off(EVENTS.COMPILED, onCompiled);
    }

    return {
      ok: amxxName != null,
      amxxName,
      output: compiled ? compiled.output : undefined,
      output_path: amxxName ? path.join(buildDir, 'amxmodx', 'plugins', amxxName) : null,
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
