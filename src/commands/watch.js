'use strict';

const fs   = require('fs');
const path = require('path');

const logger                = require('../logger');
const { parseManifest, resolveGithubToken } = require('../manifest');
const { fetchCompiler }     = require('../compiler-fetcher');
const { compileSingle, applyPluginRule, pluginRuleBase } = require('../compiler');
const { deployBuild, deployPlugin, deployFile, removeDeployedFile, gatherPluginNames } = require('../deployer');
const { sendRconForPlugins } = require('../rcon');
const { DepGraph }           = require('../dep-graph');
const { startWatch }         = require('../watcher');
const { resolveRepoRefs } = require('../repo-fetcher');
const { cloneRepoLocalDirs, resolveBuildIncludeDirs } = require('../build-service');
const { resolveManifestPath, loadEnv } = require('./shared');
const { runBuild } = require('./build');
const { subscribeCompiledRendering } = require('./compile-renderer');

// Render compiler 'compiled' events (previously direct stdout/stderr writes).
subscribeCompiledRendering();

async function runWatch(options) {
  const manifestPath = resolveManifestPath(options.manifest);
  const buildDir     = path.resolve(options.buildDir || './build');
  const doDeploy     = options.deploy !== false;

  loadEnv(manifestPath);

  logger.info('Running initial build...');
  await runBuild({ manifest: manifestPath, buildDir: options.buildDir });

  if (options.verbose) logger.setVerbose(true);

  // Mutable watch state — rebuilt after every manifest-triggered full rebuild
  // so the compiler version, include dirs and dep graph never go stale.
  let state = null;

  async function buildWatchState() {
    const manifest = parseManifest(manifestPath);
    const { compilerPath, includeDir: compilerIncludeDir } = await fetchCompiler(manifest.amxmodx.version);

    // Include dirs come from the same single-source helpers as the build
    // pipeline (src/build-service.js): clone manifest repos (cache-only — the
    // initial build just populated the clone cache), then resolveDeps collects
    // dep .inc files into build/_includes/ and returns those dirs; the compiler
    // bundle is appended last (deps before stdlib, matching the real build).
    // Refs stay inline (R1) so watch keeps its own resolution boundary; the
    // helper is clone+map only.
    let repoLocalDirs = {};
    if (manifest.repos.length > 0) {
      await resolveRepoRefs(manifest.repos, (repo) => resolveGithubToken(manifest, repo));
      // Dedup by the case-insensitive normalizeRepo identity (two spellings of
      // the same repo are one clone job), then map every manifest entry's raw
      // repoKey to the shared dir — mirroring src/build-service.js.
      repoLocalDirs = await cloneRepoLocalDirs(manifest, { noFetch: true });
    }

    const includeDirs = await resolveBuildIncludeDirs(
      manifest, repoLocalDirs, { compilerIncludeDir, noFetch: true, buildDir }
    );

    const manifestDir      = path.dirname(path.resolve(manifestPath));
    const scriptingRootDir = path.join(manifestDir, manifest.amxmodx.dir, 'scripting');

    const localIncDir = path.join(scriptingRootDir, 'include');
    const collectedIncDir = path.join(buildDir, 'amxmodx', 'scripting', 'include');
    const graphIncludeDirs = [
      scriptingRootDir,
      ...(fs.existsSync(localIncDir)     ? [localIncDir]     : []),
      ...(fs.existsSync(collectedIncDir) ? [collectedIncDir] : []),
      ...includeDirs,
    ];
    const depGraph = new DepGraph(graphIncludeDirs);

    const glob = require('fast-glob');
    if (fs.existsSync(scriptingRootDir)) {
      const smaFiles = await glob('**/*.sma', { cwd: scriptingRootDir, absolute: true });
      for (const f of smaFiles) depGraph.parseFile(f);
      logger.dim(`  Dep graph: ${smaFiles.length} .sma file(s) indexed`);
    }

    return { manifest, compilerPath, includeDirs, scriptingRootDir, manifestDir, depGraph };
  }

  state = await buildWatchState();

  if (doDeploy && state.manifest.deploy.path) {
    await deployBuild(state.manifest, buildDir, { incremental: true });
  }

  // Serialize all incremental work through a single promise chain so no two
  // tasks ever touch build/ at the same time.
  let queue = Promise.resolve();
  const enqueue = (fn) => {
    queue = queue.then(() => fn()).catch((err) => logger.error(`Watch task error: ${err.message}`));
    return queue;
  };

  // Full rebuilds (manifest change) run on the same chain. Coalescing: a second
  // manifest save while a rebuild is queued/running only marks a re-run instead
  // of starting a second concurrent rebuild over the same build/.
  let rebuildQueued = false;
  let rebuildAgain  = false;

  async function performRebuild() {
    logger.info('Rebuilding...');
    await runBuild({ manifest: manifestPath, buildDir: options.buildDir });
    state = await buildWatchState();
    if (doDeploy && state.manifest.deploy.path) {
      await deployBuild(state.manifest, buildDir, { incremental: true });
      const pluginNames = gatherPluginNames(buildDir);
      await sendRconForPlugins(state.manifest.deploy, pluginNames);
    }
    logger.warn('Note: if new watch paths were added, restart amxb watch to pick them up');
  }

  function scheduleRebuild() {
    if (rebuildQueued) {
      rebuildAgain = true;
      return;
    }
    rebuildQueued = true;
    return enqueue(async () => {
      try {
        do {
          rebuildAgain = false;
          await performRebuild();
        } while (rebuildAgain);
      } finally {
        rebuildQueued = false;
      }
    });
  }

  const handlers = {
    onSmaChange(smaPath) {
      return enqueue(async () => {
        state.depGraph.update(smaPath);
        const smaRel = path.relative(state.scriptingRootDir, smaPath).split(path.sep).join('/');
        const pluginRule = applyPluginRule(smaRel, state.manifest.plugins.rules, pluginRuleBase(state.manifest));
        if (!pluginRule) {
          logger.dim(`  Skipped by plugin rule: ${smaRel}`);
          return;
        }
        const amxxName = await compileSingle(state.manifest, smaPath, state.compilerPath, state.includeDirs, buildDir, state.scriptingRootDir);
        if (!amxxName) return;
        if (doDeploy && state.manifest.deploy.path) {
          deployPlugin(state.manifest, buildDir, amxxName);
          const pluginName = path.basename(amxxName).replace(/\.amxx$/, '');
          await sendRconForPlugins(state.manifest.deploy, [pluginName]);
        }
      });
    },

    onIncChange(incPath) {
      return enqueue(async () => {
        state.depGraph.update(incPath);
        const affected = state.depGraph.getSmasDependingOn(incPath);
        // A newly-added .inc can satisfy includes that were previously missing
        // (e.g. a plugin saved with #include <newlib> before newlib.inc existed).
        for (const smaPath of state.depGraph.reattachMissingIncludes(incPath)) {
          affected.add(smaPath);
        }

        if (affected.size === 0) {
          logger.dim(`  No plugins depend on ${path.relative(state.manifestDir, incPath)}, skipping`);
          return;
        }

        try {
          const compiled = [];
          for (const smaPath of affected) {
            const smaRel = path.relative(state.scriptingRootDir, smaPath).split(path.sep).join('/');
            const pluginRule = applyPluginRule(smaRel, state.manifest.plugins.rules, pluginRuleBase(state.manifest));
            if (!pluginRule) {
              logger.dim(`  Skipped by plugin rule: ${smaRel}`);
              continue;
            }
            const amxxName = await compileSingle(state.manifest, smaPath, state.compilerPath, state.includeDirs, buildDir, state.scriptingRootDir);
            if (amxxName) compiled.push(amxxName);
          }
          if (doDeploy && state.manifest.deploy.path) {
            const pluginNames = [];
            for (const amxxName of compiled) {
              deployPlugin(state.manifest, buildDir, amxxName);
              pluginNames.push(path.basename(amxxName).replace(/\.amxx$/, ''));
            }
            await sendRconForPlugins(state.manifest.deploy, pluginNames);
          }
        } catch (err) {
          logger.error(err.message);
        }
      });
    },

    onFileChange(relPath, section) {
      return enqueue(() => {
        if (doDeploy && state.manifest.deploy.path) {
          const srcRoot = section === 'assets'
            ? path.join(state.manifestDir, 'assets')
            : path.join(state.manifestDir, state.manifest.amxmodx.dir);
          deployFile(state.manifest, buildDir, relPath, section, srcRoot);
        }
      });
    },

    onFileDelete(relPath, section) {
      return enqueue(() => {
        if (doDeploy && state.manifest.deploy.path) {
          removeDeployedFile(state.manifest, buildDir, relPath, section);
        }
      });
    },

    onManifestChange() {
      return scheduleRebuild();
    },
  };

  startWatch(state.manifest, manifestPath, handlers);
}

module.exports = { runWatch };
