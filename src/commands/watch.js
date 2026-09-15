'use strict';

const fs   = require('fs');
const path = require('path');

const logger                = require('../logger');
const { parseManifest, resolveGithubToken } = require('../manifest');
const { fetchCompiler }     = require('../compiler-fetcher');
const { compileSingle, applyPluginRule } = require('../compiler');
const { deployBuild, deployPlugin, deployFile, removeDeployedFile } = require('../deployer');
const { sendRconForPlugins } = require('../rcon');
const { DepGraph }           = require('../dep-graph');
const { startWatch }         = require('../watcher');
const { resolveRepoRefs } = require('../repo-fetcher');
const { ensureRepoDir }   = require('../local-sources');
const { resolveDeps, repoKey } = require('../deps-resolver');
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
    const repoLocalDirs = {};
    if (manifest.repos.length > 0) {
      await resolveRepoRefs(manifest.repos, (repo) => resolveGithubToken(manifest, repo));
      const cloneJobs = new Map();
      for (const repoConfig of manifest.repos) {
        const key = repoKey(repoConfig);
        if (!cloneJobs.has(key)) {
          // Cache-only, like before; ensureRepoDir returns `_localDir` for
          // local entries (no network, no noFetch check).
          cloneJobs.set(key,
            ensureRepoDir(repoConfig, {
              token: resolveGithubToken(manifest, repoConfig.repo),
              noFetch: true,
              ssh: manifest.github.ssh,
            })
          );
        }
      }
      const cloned = await Promise.all(
        [...cloneJobs.entries()].map(async ([key, p]) => ({ key, dir: await p }))
      );
      for (const { key, dir } of cloned) repoLocalDirs[key] = dir;
    }

    const depsIncludeDirs = await resolveDeps(manifest, repoLocalDirs, true, buildDir);
    const includeDirs = compilerIncludeDir ? [...depsIncludeDirs, compilerIncludeDir] : depsIncludeDirs;

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
        const pluginRule = applyPluginRule(smaRel, state.manifest.pluginRules, state.manifest.globalPostfix);
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
            const pluginRule = applyPluginRule(smaRel, state.manifest.pluginRules, state.manifest.globalPostfix);
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

function gatherPluginNames(buildDir) {
  const pluginsDir = path.join(buildDir, 'amxmodx', 'plugins');
  if (!fs.existsSync(pluginsDir)) return [];
  return fs.readdirSync(pluginsDir)
    .filter(f => f.endsWith('.amxx'))
    .map(f => f.replace(/\.amxx$/, ''));
}

module.exports = { runWatch };
