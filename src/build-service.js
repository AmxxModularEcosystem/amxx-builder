'use strict';

/**
 * Staged build orchestration — the single source of truth for the AMXX build
 * pipeline. Interface-agnostic core: it emits structured lifecycle events on
 * the shared event bus (src/events.js) and optionally via an `onEvent`
 * callback; it never touches process.argv/stdout directly (rendering is the
 * job of the calling interface).
 *
 * This is an EXTRACTION of the pipeline that used to live in
 * src/commands/build.js — same core functions, same order, no new domain
 * logic. Interfaces that need a full build (CLI `amxb build`, serve
 * `build.start`, watch's manifest-triggered rebuild) call runBuild here.
 *
 * Event contract (emitted on the bus, plus delivered to `options.onEvent`):
 *   EVENTS.STAGE   { stage, message }      — 'compiler'|'repos'|'deps'|
 *                                            'collect'|'assets'|'compile'|
 *                                            'ini'|'archive'
 *   EVENTS.COMPILED { baseName, ok, ... }  — emitted by src/compiler.js during
 *                                            the compile stage (not here)
 *   EVENTS.PROGRESS { label, current, total } — emitted by src/progress.js
 *                                            (downloads/archiving)
 *   EVENTS.DONE    { ok: true, elapsed, noArchive?, message }
 *   EVENTS.ERROR   { ok: false, message }
 *
 * Cancellation: pass an AbortSignal (`signal`) or an `isCancelled()` predicate.
 * Checked between stages; a cancelled build throws an Error with
 * `err.code === 'CANCELLED'`. The compile stage itself runs to completion and
 * cannot be aborted mid-flight (each amxxpc invocation is atomic); cancellation
 * only takes effect between stages.
 */

const fs   = require('fs');
const path = require('path');

const logger = require('./logger');
const { emit, EVENTS } = require('./events');
const { resolveGithubToken } = require('./manifest');
const { fetchCompiler }  = require('./compiler-fetcher');
const { fetchRepo, resolveRepoRefs } = require('./repo-fetcher');
const { resolveDeps, repoKey } = require('./deps-resolver');
const { compilePlugins } = require('./compiler');
const { collectAll }     = require('./collector');
const { fetchAssets }    = require('./asset-fetcher');
const { buildIniFiles }  = require('./ini-builder');
const { createArchive, copyOutput } = require('./archiver');

/**
 * Run the full build pipeline for an already-resolved manifest.
 *
 * @param {object} manifest - fully resolved manifest (parseManifest + any
 *   applyOverrides/resolveManifest output). Manifest parsing is the caller's
 *   job so every interface controls its own resolution boundary.
 * @param {object} [options]
 * @param {string}   [options.buildDir='./build'] - build staging directory
 * @param {boolean}  [options.fetch=true]  - false skips cloning/downloads
 * @param {boolean}  [options.archive=true] - false skips archiving/copying
 * @param {function} [options.onEvent]      - optional callback, called with
 *   every emitted event ({ type, ...payload }) in addition to the bus emit
 * @param {AbortSignal} [options.signal]    - abort between stages
 * @param {function} [options.isCancelled]  - () => boolean, checked between stages
 * @returns {Promise<{ ok: true, elapsed: string, noArchive?: boolean }>}
 * @throws {Error} on failure (after emitting EVENTS.ERROR); err.code ===
 *   'CANCELLED' when the build was cancelled between stages.
 */
async function runBuild(manifest, options = {}) {
  const buildStart = Date.now();

  const buildDir   = path.resolve(options.buildDir || './build');
  const noFetch    = options.fetch === false;
  const noArchive  = options.archive === false;
  const onEvent    = typeof options.onEvent === 'function' ? options.onEvent : null;

  const emitEvent = (name, payload) => {
    emit(name, payload);
    if (onEvent) onEvent({ type: name, ...payload });
  };

  // The shared bus is a plain EventEmitter where an 'error' event with no
  // subscriber throws ERR_UNHANDLED_ERROR. Subscribers (serve) receive the
  // event normally; when nobody listens, swallow so the original error still
  // propagates up to the caller unchanged.
  const emitError = (payload) => {
    try {
      emitEvent(EVENTS.ERROR, payload);
    } catch (_) { /* no subscriber — keep the original error surface */ }
  };

  // Cancellation is checked between stages. Compilation itself is atomic per
  // plugin and runs to completion — cancellation only takes effect at the next
  // stage boundary (documented in the module docstring).
  const checkCancelled = () => {
    const cancelled = typeof options.isCancelled === 'function'
      ? options.isCancelled()
      : !!(options.signal && options.signal.aborted);
    if (cancelled) {
      const err = new Error('Build cancelled');
      err.code = 'CANCELLED';
      throw err;
    }
  };

  try {
    fs.rmSync(buildDir, { recursive: true, force: true });
    fs.mkdirSync(buildDir, { recursive: true });

    const hasRepos = manifest.repos.length > 0;

    // ── 1. Compiler ─────────────────────────────────────────────────────────
    emitEvent(EVENTS.STAGE, { stage: 'compiler', message: 'Fetching compiler' });
    const { compilerPath, includeDir: compilerIncludeDir } = await fetchCompiler(manifest.amxmodx.version, { noFetch });
    checkCancelled();

    // ── 2. Repos — resolve refs + clone (deduped by repo@resolved_ref) ──────
    const repoLocalDirs = {};
    if (hasRepos) {
      emitEvent(EVENTS.STAGE, { stage: 'repos', message: 'Resolving refs and cloning repos' });
      await resolveRepoRefs(manifest.repos, (repo) => resolveGithubToken(manifest, repo));
      checkCancelled();

      const cloneJobs = new Map();
      for (const repoConfig of manifest.repos) {
        const key = repoKey(repoConfig);
        if (!cloneJobs.has(key)) {
          cloneJobs.set(key,
            fetchRepo(repoConfig.repo, repoConfig._resolvedRef, resolveGithubToken(manifest, repoConfig.repo), noFetch, manifest.github.ssh)
          );
        }
      }
      const cloned = await Promise.all(
        [...cloneJobs.entries()].map(async ([key, p]) => ({ key, dir: await p }))
      );
      for (const { key, dir } of cloned) repoLocalDirs[key] = dir;
      checkCancelled();
    }

    // ── 3. Deps — resolve + collect .inc ────────────────────────────────────
    emitEvent(EVENTS.STAGE, { stage: 'deps', message: 'Resolving dependencies' });
    const depsIncludeDirs = await resolveDeps(manifest, repoLocalDirs, noFetch, buildDir);
    const includeDirs = compilerIncludeDir ? [...depsIncludeDirs, compilerIncludeDir] : depsIncludeDirs;
    checkCancelled();

    // ── 4. Collect — repos + local amxmodx + assets ─────────────────────────
    emitEvent(EVENTS.STAGE, { stage: 'collect', message: 'Collecting files' });
    await collectAll(manifest, repoLocalDirs, buildDir);

    // ── 5. Fetch remote assets ──────────────────────────────────────────────
    emitEvent(EVENTS.STAGE, { stage: 'assets', message: 'Fetching assets' });
    await fetchAssets(manifest, buildDir, noFetch);
    checkCancelled();

    // ── 6. Compile — all .sma → .amxx (emits EVENTS.COMPILED per plugin) ────
    emitEvent(EVENTS.STAGE, { stage: 'compile', message: 'Compiling plugins' });
    const compiledPlugins = await compilePlugins(
      manifest, repoLocalDirs, compilerPath, includeDirs, buildDir
    );

    // ── 7. Generate plugins-*.ini ───────────────────────────────────────────
    if (manifest.output.generate_ini) {
      emitEvent(EVENTS.STAGE, { stage: 'ini', message: 'Generating plugins ini files' });
      buildIniFiles(compiledPlugins, buildDir);
    }
    checkCancelled();

    // ── 8. Archive or copy output ───────────────────────────────────────────
    if (noArchive) {
      logger.info('--no-archive: skipping zip creation');
      const elapsed = ((Date.now() - buildStart) / 1000).toFixed(1);
      return { ok: true, elapsed, noArchive: true };
    }

    emitEvent(EVENTS.STAGE, { stage: 'archive', message: 'Archiving output' });
    if (manifest.output.pack === false) {
      copyOutput(manifest, buildDir);
    } else {
      await createArchive(manifest, buildDir);
    }

    const elapsed = ((Date.now() - buildStart) / 1000).toFixed(1);
    emitEvent(EVENTS.DONE, { ok: true, elapsed, message: `Done in ${elapsed}s` });
    return { ok: true, elapsed };
  } catch (err) {
    emitError({ ok: false, message: err.message });
    throw err;
  }
}

module.exports = { runBuild };
