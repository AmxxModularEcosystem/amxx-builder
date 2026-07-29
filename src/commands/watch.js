'use strict';

const fs   = require('fs');
const path = require('path');

const logger                = require('../logger');
const { parseManifest }     = require('../manifest');
const { fetchCompiler }     = require('../compiler-fetcher');
const { compileSingle, applyPluginRule } = require('../compiler');
const { deployBuild, deployPlugin, deployFile } = require('../deployer');
const { sendRconForPlugins } = require('../rcon');
const { DepGraph }           = require('../dep-graph');
const { startWatch }         = require('../watcher');
const { resolveManifestPath, loadEnv } = require('./shared');
const { runBuild } = require('./build');

async function runWatch(options) {
  const manifestPath = resolveManifestPath(options.manifest);
  const buildDir     = path.resolve(options.buildDir || './build');
  const doDeploy     = options.deploy !== false;

  loadEnv(manifestPath);

  logger.info('Running initial build...');
  await runBuild({ manifest: manifestPath, buildDir: options.buildDir });

  let manifest = parseManifest(manifestPath);
  if (options.verbose) logger.setVerbose(true);

  const { compilerPath, includeDir: compilerIncludeDir } = await fetchCompiler(manifest.amxmodx.version);
  const depsIncludeRoot = path.join(buildDir, '_includes');
  const depsDirs = fs.existsSync(depsIncludeRoot)
    ? fs.readdirSync(depsIncludeRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(depsIncludeRoot, e.name))
    : [];
  const includeDirs = [
    ...depsDirs,
    ...(compilerIncludeDir ? [compilerIncludeDir] : []),
  ];

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

  if (doDeploy && manifest.deploy.path) {
    await deployBuild(manifest, buildDir, { incremental: true });
  }

  const handlers = {
    async onSmaChange(smaPath) {
      depGraph.update(smaPath);
      const smaRel = path.relative(scriptingRootDir, smaPath).split(path.sep).join('/');
      const pluginRule = applyPluginRule(smaRel, manifest.pluginRules, manifest.globalPostfix);
      if (!pluginRule) {
        logger.dim(`  Skipped by plugin rule: ${smaRel}`);
        return;
      }
      const amxxName = await compileSingle(manifest, smaPath, compilerPath, includeDirs, buildDir, scriptingRootDir);
      if (!amxxName) return;
      if (doDeploy && manifest.deploy.path) {
        deployPlugin(manifest, buildDir, amxxName);
        const pluginName = path.basename(amxxName).replace(/\.amxx$/, '');
        await sendRconForPlugins(manifest.deploy, [pluginName]);
      }
    },

    async onIncChange(incPath) {
      depGraph.update(incPath);
      const affected = depGraph.getSmasDependingOn(incPath);

      if (affected.size === 0) {
        logger.dim(`  No plugins depend on ${path.relative(manifestDir, incPath)}, skipping`);
        return;
      }

      try {
        const compiled = [];
        for (const smaPath of affected) {
          const smaRel = path.relative(scriptingRootDir, smaPath).split(path.sep).join('/');
          const pluginRule = applyPluginRule(smaRel, manifest.pluginRules, manifest.globalPostfix);
          if (!pluginRule) {
            logger.dim(`  Skipped by plugin rule: ${smaRel}`);
            continue;
          }
          const amxxName = await compileSingle(manifest, smaPath, compilerPath, includeDirs, buildDir, scriptingRootDir);
          if (amxxName) compiled.push(amxxName);
        }
        if (doDeploy && manifest.deploy.path) {
          const pluginNames = [];
          for (const amxxName of compiled) {
            deployPlugin(manifest, buildDir, amxxName);
            pluginNames.push(path.basename(amxxName).replace(/\.amxx$/, ''));
          }
          await sendRconForPlugins(manifest.deploy, pluginNames);
        }
      } catch (err) {
        logger.error(err.message);
      }
    },

    onFileChange(relPath, section) {
      if (doDeploy && manifest.deploy.path) {
        deployFile(manifest, buildDir, relPath, section);
      }
    },

    async onManifestChange() {
      try {
        logger.info('Rebuilding...');
        await runBuild({ manifest: manifestPath, buildDir: options.buildDir });
        manifest = parseManifest(manifestPath);
        if (doDeploy && manifest.deploy.path) {
          await deployBuild(manifest, buildDir, { incremental: true });
          const pluginNames = gatherPluginNames(buildDir);
          await sendRconForPlugins(manifest.deploy, pluginNames);
        }
        logger.warn('Note: if new watch paths were added, restart amxb watch to pick them up');
      } catch (err) {
        logger.error(err.message);
      }
    },
  };

  startWatch(manifest, manifestPath, handlers);
}

function gatherPluginNames(buildDir) {
  const pluginsDir = path.join(buildDir, 'amxmodx', 'plugins');
  if (!fs.existsSync(pluginsDir)) return [];
  return fs.readdirSync(pluginsDir)
    .filter(f => f.endsWith('.amxx'))
    .map(f => f.replace(/\.amxx$/, ''));
}

module.exports = { runWatch };
