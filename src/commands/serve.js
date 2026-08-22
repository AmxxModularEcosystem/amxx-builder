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
 *   cache.info              → cache-info getCacheInfo
 *   build.plan              → build-plan buildPlanData
 *   build.start             → build-service runBuild (+ event notifications)
 *   build.cancel            → abort the running build (AbortController)
 *   compile.single          → compiler.compileSingle
 *   watch.start / watch.stop → watcher.startWatch (+ watch.changed notifications)
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
const { fetchCompiler, resolveAmxmodxVersion } = require('../compiler-fetcher');
const { buildDepTree, assembleRootDeps } = require('../deps-tree');
const { listReleases, listTags } = require('../release-lister');
const { getCacheInfo } = require('../cache-info');
const { buildPlanData } = require('../build-plan');
const { runBuild } = require('../build-service');
const { compileSingle } = require('../compiler');
const { startWatch } = require('../watcher');

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
 * Create and configure the JSON-RPC server with all methods wired to core.
 * Does NOT connect or set up the environment — call runServe() for that.
 */
function createServeServer() {
  const server = new JsonRpcServer();

  // One build / one watcher at a time (per-process).
  let activeBuild   = null; // AbortController for the running build
  let activeWatcher = null; // chokidar watcher instance

  // ─── Read-only: manifest ──────────────────────────────────────────────────

  server.onRequest('manifest.validate', (params) => {
    return validateManifestFile(manifestPathFor(params));
  });

  server.onRequest('manifest.resolve', (params) => {
    const manifestPath = manifestPathFor(params);
    loadEnv(manifestPath);
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
    loadEnv(manifestPath);
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

  // ─── Releases / cache / plan ─────────────────────────────────────────────

  server.onRequest('releases.list', async (params) => {
    if (!params?.repo) {
      const err = new Error('Missing required "repo" field');
      err.code = -32602;
      throw err;
    }
    const token = params?.token || process.env.GITHUB_TOKEN || null;
    const limit = params?.limit || 10;
    if (params?.tags) return listTags(params.repo, { token, limit });
    return listReleases(params.repo, { token, limit, includeAssets: params?.includeAssets });
  });

  server.onRequest('cache.info', (params) => {
    const manifestPath = params?.manifest ? path.resolve(params.manifest) : undefined;
    return getCacheInfo(manifestPath);
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
    loadEnv(manifestPath);
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
    const amxxName = await compileSingle(
      compileManifest,
      smaPath,
      compilerPath,
      includeDirs,
      buildDir,
      params?.scripting_root ? path.resolve(params.scripting_root) : undefined
    );

    return {
      ok: amxxName != null,
      amxxName,
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
