#!/usr/bin/env node
'use strict';

const { program } = require('commander');
const fs   = require('fs');
const path = require('path');


const logger             = require('./src/logger');
const { setVerbose }     = logger;
const { parseManifest, applyOverrides, resolveManifest } = require('./src/manifest');
const { fetchCompiler }  = require('./src/compiler-fetcher');
const { fetchRepo, resolveRef } = require('./src/repo-fetcher');
const { resolveDeps }    = require('./src/deps-resolver');
const { compilePlugins, compileSingle, applyPluginRule } = require('./src/compiler');
const { deployBuild, deployPlugin, deployFile } = require('./src/deployer');
const { sendRconCommand, sendRconForPlugins } = require('./src/rcon');
const { startWatch }       = require('./src/watcher');
const { DepGraph }         = require('./src/dep-graph');
const { collectAll }     = require('./src/collector');
const { fetchAssets }    = require('./src/asset-fetcher');
const { buildIniFiles }  = require('./src/ini-builder');
const { createArchive, copyOutput } = require('./src/archiver');
const { getCacheDir }    = require('./src/cache-dir');
const { buildDepTree }   = require('./src/deps-tree');
const { validateManifestFile } = require('./src/validate');
const { getCacheInfo, dirSize, fmtSize, parseCacheKey } = require('./src/cache-info');
const { listReleases, listTags } = require('./src/release-lister');

const TEMPLATES_DIR = path.join(__dirname, 'templates');
const SCHEMA_URL    = 'https://raw.githubusercontent.com/AmxxModularEcosystem/amxx-builder/master/schema/amxbuild.schema.json';

program
  .name('amxx-builder')
  .description('Build and package AMX Mod X server plugins')
  .version(require('./package.json').version);

// ─── build ───────────────────────────────────────────────────────────────────

program
  .command('build')
  .description('Build plugins from manifest')
  .option('--manifest <path>',       'Path to manifest file (default: amxbuild.yml, fallback: manifest.yml)')
  .option('--build-dir <path>',     'Override build staging directory (default: ./build)')
  .option('--set <key=value...>',    'Override manifest field (e.g. --set version=1.2.3 --set output.archive_name="{name}-{version}.zip")')
  .option('--define <flag...>',     'Add compiler define, e.g. --define DEBUG --define "VERSION=1.2.3" (appends to amxmodx.defines)')
  .option('--no-fetch',             'Use cached repos without re-cloning')
  .option('--no-archive',           'Compile only, skip archiving')
  .option('--dry-run',              'Show plan without executing')
  .option('--verbose',              'Show detailed output (compiler commands, per-file copies, include dirs)')
  .action(async (options) => {
    try {
      await runBuild(options);
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }
  });

// ─── clean ───────────────────────────────────────────────────────────────────

program
  .command('clean')
  .description('Clean build directory and repo clone cache')
  .option('--build-dir <path>', 'Override build staging directory (default: ./build)')
  .option('--all', 'Also clean compiler cache')
  .action(async (options) => {
    try {
      await runClean(options);
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }
  });

// ─── cache ───────────────────────────────────────────────────────────────────

const cacheCmd = program
  .command('cache')
  .description('Manage the local cache');

cacheCmd
  .command('info', { isDefault: true })
  .description('Show cache contents and disk usage')
  .option('--manifest <path>', 'Show local .amxb-cache/ for this manifest')
  .action((options) => {
    try {
      runCacheInfo(options);
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }
  });

cacheCmd
  .command('clean')
  .description('Remove cached files')
  .option('--compiler', 'Clean compiler cache (amxxpc binaries)')
  .option('--repos',    'Clean repository clones')
  .option('--deps',     'Clean release dependency clones')
  .option('--all',      'Clean all caches')
  .action((options) => {
    try {
      runCacheClean(options);
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }
  });

// ─── deps-tree ────────────────────────────────────────────────────────────────

program
  .command('deps-tree')
  .description('Show recursive dependency tree for manifest or inline deps')
  .option('--manifest <path>', 'Path to manifest file')
  .option('--depth <n>',       'Max recursion depth (0 = unlimited)', parseInt)
  .option('--json',            'Output as JSON instead of tree view')
  .option('--cycle-only',      'Show only cycles')
  .option('--no-fetch',        'Use cached repos without re-cloning')
  .action(async (options) => {
    try {
      await runDepsTree(options);
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }
  });

// ─── resolve-manifest ──────────────────────────────────────────────────────────

program
  .command('resolve-manifest')
  .description('Parse and fully resolve manifest (defaults + overrides)')
  .option('--manifest <path>', 'Path to manifest file')
  .option('--set <key=value...>', 'Override manifest field (dot notation)')
  .option('--define <flag...>', 'Add compiler define')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      await runResolveManifest(options);
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }
  });

// ─── validate ──────────────────────────────────────────────────────────────────

program
  .command('validate')
  .description('Validate manifest and show diagnostics')
  .option('--manifest <path>', 'Path to manifest file')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      await runValidate(options);
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }
  });

// ─── releases ──────────────────────────────────────────────────────────────────

program
  .command('releases')
  .description('List GitHub releases or tags for a repository')
  .argument('<repo>', 'Repository in format owner/repo')
  .option('--limit <n>', 'Max results (default: 10)', parseInt)
  .option('--tags', 'List git tags instead of releases')
  .option('--assets', 'Include asset details')
  .option('--json', 'Output as JSON')
  .action(async (repo, options) => {
    try {
      await runReleases(repo, options);
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }
  });

// ─── deploy ──────────────────────────────────────────────────────────────────

program
  .command('deploy')
  .description('Deploy build output to the server directory')
  .option('--manifest <path>',  'Path to manifest file')
  .option('--build-dir <path>', 'Build staging directory (default: ./build)')
  .option('--incremental',      'Only copy files newer than the destination')
  .option('--build',            'Run a full build before deploying')
  .action(async (options) => {
    try {
      await runDeploy(options);
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }
  });

// ─── watch ───────────────────────────────────────────────────────────────────

program
  .command('watch')
  .description('Watch local files and incrementally build + deploy on changes')
  .option('--manifest <path>',  'Path to manifest file')
  .option('--build-dir <path>', 'Build staging directory (default: ./build)')
  .option('--no-deploy',        'Watch and rebuild only, skip deploy')
  .action(async (options) => {
    try {
      await runWatch(options);
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }
  });

// ─── doctor ──────────────────────────────────────────────────────────────────

program
  .command('doctor')
  .description('Check system health and validate manifest')
  .option('--manifest <path>', 'Path to manifest file to validate')
  .action(async (options) => {
    try {
      await runDoctor(options);
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }
  });

// ─── init ────────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Scaffold a new plugin project in the current directory')
  .option('--name <name>',   'Package name (default: current directory name)')
  .option('--workflow',      'Generate .github/workflows/ci.yml')
  .option('--ci',           'Alias for --workflow')
  .option('--plugin <name>', 'Create amxmodx/scripting/<name>.sma')
  .option('--gitignore',     'Create .gitignore')
  .option('--opencode',      'Create .opencode/opencode.json with amxx-dep-resolver MCP config')
  .option('--deploy',        'Create .env with deploy stubs (AMXB_DEPLOY_*)')
  .option('-i, --interactive', 'Interactive mode with prompts')
  .action(async (options) => {
    try {
      if (options.interactive) {
        await runInitInteractive(options);
      } else {
        runInit(options);
      }
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }
  });

program.parse(process.argv);

// ─── build implementation ────────────────────────────────────────────────────

function resolveManifestPath(explicit) {
  if (explicit) return explicit;
  if (fs.existsSync('./amxbuild.yml'))  return './amxbuild.yml';
  if (fs.existsSync('./amxbuild.yaml')) return './amxbuild.yaml';
  if (fs.existsSync('./manifest.yml')) {
    logger.warn('manifest.yml is deprecated — rename it to amxbuild.yml');
    return './manifest.yml';
  }
  return './amxbuild.yml'; // will fail with a clear error in parseManifest
}

async function runBuild(options) {
  const buildStart   = Date.now();
  if (options.verbose) logger.setVerbose(true);
  const manifestPath = resolveManifestPath(options.manifest);
  const noFetch      = options.fetch === false;
  const noArchive    = options.archive === false;
  const dryRun       = options.dryRun || false;
  const buildDir     = path.resolve(options.buildDir || './build');

  // Load .env from the manifest's directory (before any token is read)
  const manifestDir = path.dirname(path.resolve(manifestPath));
  require('dotenv').config({ path: path.join(manifestDir, '.env'), override: true });

  // Step 1 — Parse manifest, then apply --set overrides
  const manifest = parseManifest(manifestPath);
  if (options.set?.length)    applyOverrides(manifest, options.set);
  if (options.define?.length) manifest.amxmodx.defines.push(...options.define);
  logger.info(`Manifest: ${manifest.name} v${manifest.version}`);

  if (dryRun) {
    printDryRun(manifest);
    return;
  }

  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });

  const hasRepos = manifest.repos.length > 0;

  // Step 2 — Fetch compiler (resolves latest version if not pinned)
  const { compilerPath, includeDir: compilerIncludeDir } = await fetchCompiler(manifest.amxmodx.version);

  // Step 3 — Resolve all refs in parallel, then clone deduped set in parallel
  const repoLocalDirs = {};
  if (hasRepos) {
    await Promise.all(manifest.repos.map(async (repoConfig) => {
      repoConfig._resolvedRef = await resolveRef(
        repoConfig.repo, repoConfig.ref, manifest.github.token
      );
    }));

    const cloneJobs = new Map();
    for (const repoConfig of manifest.repos) {
      const key = `${repoConfig.repo}@${repoConfig._resolvedRef || 'HEAD'}`;
      if (!cloneJobs.has(key)) {
        cloneJobs.set(key,
          fetchRepo(repoConfig.repo, repoConfig._resolvedRef, manifest.github.token, noFetch, manifest.github.ssh)
        );
      }
    }
    const cloned = await Promise.all(
      [...cloneJobs.entries()].map(async ([key, p]) => ({ key, dir: await p }))
    );
    for (const { key, dir } of cloned) repoLocalDirs[key] = dir;
  }

  // Step 4 — Resolve + clone deps, collect .inc files (always — works for local-only builds too)
  // Compiler's bundled includes (amxmodx.inc etc.) appended last — lowest priority so user includes win.
  const depsIncludeDirs = await resolveDeps(manifest, repoLocalDirs, noFetch, buildDir);
  const includeDirs = compilerIncludeDir ? [...depsIncludeDirs, compilerIncludeDir] : depsIncludeDirs;

  // Step 5 — Collect: copy amxmodx/ dirs from repos + local amxmodx/ + local assets/
  //           Must run before compile so that compiled .amxx always overwrites any pre-built ones.
  await collectAll(manifest, repoLocalDirs, buildDir);

  // Step 5.5 — Fetch remote assets, overlay onto build/assets/ (local assets from Step 5 win)
  await fetchAssets(manifest, buildDir, noFetch);

  // Step 6 — Compile .sma → .amxx (runs after collect, wins over any pre-built plugins)
  const compiledPlugins = await compilePlugins(
    manifest,
    repoLocalDirs,
    compilerPath,
    includeDirs,
    buildDir
  );

  // Step 7 — Generate plugins-*.ini into build/amxmodx/configs/
  if (manifest.output.generate_ini) {
    buildIniFiles(compiledPlugins, buildDir);
  }

  if (noArchive) {
    logger.info('--no-archive: skipping zip creation');
    return;
  }

  // Step 8 — Package
  if (manifest.output.pack === false) {
    copyOutput(manifest, buildDir);
  } else {
    await createArchive(manifest, buildDir);
  }

  const elapsed = ((Date.now() - buildStart) / 1000).toFixed(1);
  logger.success(`Done in ${elapsed}s`);
}

// ─── clean ───────────────────────────────────────────────────────────────────

async function runClean(options) {
  const buildDir     = path.resolve(options.buildDir || './build');
  const reposDir     = path.join(getCacheDir(), 'repos');
  const releasesDir  = path.join(getCacheDir(), 'release-deps');
  const compDir      = path.join(getCacheDir(), 'amxxpc');

  if (fs.existsSync(buildDir)) {
    fs.rmSync(buildDir, { recursive: true, force: true });
    logger.info(`Cleaned: ${buildDir}`);
  }
  if (fs.existsSync(reposDir)) {
    fs.rmSync(reposDir, { recursive: true, force: true });
    logger.info(`Cleaned: ${reposDir}`);
  }
  if (fs.existsSync(releasesDir)) {
    fs.rmSync(releasesDir, { recursive: true, force: true });
    logger.info(`Cleaned: ${releasesDir}`);
  }
  if (options.all && fs.existsSync(compDir)) {
    fs.rmSync(compDir, { recursive: true, force: true });
    logger.info(`Cleaned: ${compDir}`);
  }
}

// ─── deploy implementation ────────────────────────────────────────────────────

function gatherPluginNames(buildDir) {
  const pluginsDir = path.join(buildDir, 'amxmodx', 'plugins');
  if (!fs.existsSync(pluginsDir)) return [];
  return fs.readdirSync(pluginsDir)
    .filter(f => f.endsWith('.amxx'))
    .map(f => f.replace(/\.amxx$/, ''));
}

async function runDeploy(options) {
  const manifestPath = resolveManifestPath(options.manifest);
  const buildDir     = path.resolve(options.buildDir || './build');

  require('dotenv').config({ path: path.join(path.dirname(path.resolve(manifestPath)), '.env'), override: true });

  if (options.build) {
    await runBuild({ ...options, manifest: manifestPath });
  } else if (!fs.existsSync(buildDir)) {
    throw new Error(`Build directory not found: ${buildDir}\n  → Run "amxb build" first, or use "amxb deploy --build"`);
  }

  const manifest = parseManifest(manifestPath);
  await deployBuild(manifest, buildDir, { incremental: options.incremental || false });

  const pluginNames = gatherPluginNames(buildDir);
  await sendRconForPlugins(manifest.deploy, pluginNames);
}

// ─── watch implementation ─────────────────────────────────────────────────────

async function runWatch(options) {
  const manifestPath = resolveManifestPath(options.manifest);
  const buildDir     = path.resolve(options.buildDir || './build');
  const doDeploy     = options.deploy !== false;

  require('dotenv').config({ path: path.join(path.dirname(path.resolve(manifestPath)), '.env'), override: true });

  // Initial full build
  logger.info('Running initial build...');
  await runBuild({ manifest: manifestPath, buildDir: options.buildDir });

  let manifest = parseManifest(manifestPath);
  if (options.verbose) logger.setVerbose(true);

  // Fetch compiler info for recompilation
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

  // Build dep graph: include dirs for <angle> resolution = local scripting/include + deps + compiler
  const localIncDir = path.join(scriptingRootDir, 'include');
  const collectedIncDir = path.join(buildDir, 'amxmodx', 'scripting', 'include');
  const graphIncludeDirs = [
    scriptingRootDir,
    ...(fs.existsSync(localIncDir)     ? [localIncDir]     : []),
    ...(fs.existsSync(collectedIncDir) ? [collectedIncDir] : []),
    ...includeDirs,
  ];
  const depGraph = new DepGraph(graphIncludeDirs);

  // Parse all local .sma files to seed the graph
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

// ─── cache implementation ─────────────────────────────────────────────────────

function runCacheInfo(options = {}) {
  const manifestPath = options.manifest ? path.resolve(options.manifest) : undefined;
  const info = getCacheInfo(manifestPath);

  logger.info(`Cache: ${info.cacheDir} (${info.totalSizeHuman} total)`);

  if (info.totalSize === 0) {
    logger.dim('  (empty)');
    return;
  }

  // Compiler
  if (info.compiler.versions.length) {
    logger.info('\nCompiler (amxxpc):');
    for (const ver of info.compiler.versions) {
      for (const [platform, size] of Object.entries(ver.platforms)) {
        logger.dim(`  ${ver.version.padEnd(14)} ${platform.padEnd(10)} ${fmtSize(size)}`);
      }
    }
  }

  // Repos
  if (info.repos.count) {
    logger.info(`\nRepos (${info.repos.count}, ${info.repos.totalSizeHuman} total):`);
    for (const e of info.repos.entries) {
      const label = parseCacheKey(e.key);
      logger.dim(`  ${label.padEnd(52)} ${fmtSize(e.size)}`);
    }
  }

  // Release deps
  if (info.releaseDeps.count) {
    logger.info(`\nRelease deps (${info.releaseDeps.count}, ${info.releaseDeps.totalSizeHuman} total):`);
    for (const e of info.releaseDeps.entries) {
      const label = parseCacheKey(e.key);
      logger.dim(`  ${label.padEnd(52)} ${fmtSize(e.size)}`);
    }
  }

  // Local asset cache
  if (info.localAssetCache) {
    logger.info(`\nLocal asset cache (${info.localAssetCache.count}, ${info.localAssetCache.totalSizeHuman}):`);
    logger.dim(`  ${info.localAssetCache.path}`);
  }
}

function runCacheClean(options) {
  const { all, compiler, repos, deps } = options;

  if (!all && !compiler && !repos && !deps) {
    logger.error('Specify what to clean: --compiler, --repos, --deps, or --all');
    process.exit(1);
  }

  const cacheRoot = getCacheDir();
  const targets = [];
  if (all || compiler) targets.push({ dir: path.join(cacheRoot, 'amxxpc'),       label: 'compiler' });
  if (all || repos)    targets.push({ dir: path.join(cacheRoot, 'repos'),         label: 'repos' });
  if (all || deps)     targets.push({ dir: path.join(cacheRoot, 'release-deps'),  label: 'release deps' });

  for (const { dir, label } of targets) {
    if (!fs.existsSync(dir)) {
      logger.dim(`  ${label}: already empty`);
      continue;
    }
    const freed = dirSize(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    logger.success(`Cleaned ${label} (${fmtSize(freed)} freed)`);
  }
}

// ─── doctor ────────────────────────────────────────────────────────────────────

async function runDoctor(options) {
  const { execSync } = require('child_process');
  const ok = [];
  const warn = [];

  // Node version
  const nodeMajor = parseInt(process.version.slice(1).split('.')[0], 10);
  (nodeMajor >= 16 ? ok : warn).push(`Node.js: ${process.version.slice(1)}${nodeMajor >= 16 ? '' : ' (minimum 16 required)'}`);

  // Git
  try {
    const gitVer = execSync('git --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    ok.push(`Git: ${gitVer.replace('git version ', '')}`);
  } catch {
    warn.push('Git: not found in PATH');
  }

  // npm
  try {
    const npmVer = execSync('npm --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    ok.push(`npm: ${npmVer}`);
  } catch {
    warn.push('npm: not found in PATH');
  }

  // GitHub API
  try {
    const axios = require('axios');
    const resp = await axios.get('https://api.github.com', { timeout: 5000 });
    if (resp.status === 200 || resp.status === 403) {
      ok.push('GitHub API: reachable');
    } else {
      warn.push(`GitHub API: returned ${resp.status}`);
    }
  } catch {
    warn.push('GitHub API: unreachable (check internet)');
  }

  // Manifest
  const manifestPath = options.manifest
    ? path.resolve(options.manifest)
    : fs.existsSync('./amxbuild.yml') ? './amxbuild.yml'
    : fs.existsSync('./amxbuild.yaml') ? './amxbuild.yaml'
    : null;

  if (manifestPath && fs.existsSync(manifestPath)) {
    try {
      const { parseManifest } = require('./src/manifest');
      parseManifest(manifestPath);
      ok.push(`Manifest: valid (${path.basename(manifestPath)})`);
    } catch (err) {
      warn.push(`Manifest: invalid — ${err.message}`);
    }
  } else {
    ok.push('Manifest: not found (run amxb init)');
  }

  // Cache
  const cacheDir = getCacheDir();
  const cacheSize = fmtSize(dirSize(cacheDir));
  ok.push(`Cache: ${cacheDir} (${cacheSize})`);

  // Output
  logger.info('=== System Check ===');
  for (const msg of ok) logger.success(`  ✓ ${msg}`);
  for (const msg of warn) logger.warn(`  ⚠ ${msg}`);

  if (warn.length) {
    process.exitCode = 1;
  }
}

// ─── deps-tree implementation ─────────────────────────────────────────────────

async function runDepsTree(options) {
  const manifestPath = options.manifest ? path.resolve(options.manifest) : resolveManifestPath(undefined);
  const manifestDir  = path.dirname(path.resolve(manifestPath));

  require('dotenv').config({ path: path.join(manifestDir, '.env'), override: true });

  const noFetch = options.fetch === false;
  const asJson  = options.json || false;
  const cycleOnly = options.cycleOnly || false;

  // Parse manifest to extract root deps (repos + global deps)
  const manifest = parseManifest(manifestPath);

  // Resolve refs for manifest repos (needed for deps resolution)
  await Promise.all(manifest.repos.map(async (repoConfig) => {
    repoConfig._resolvedRef = await resolveRef(
      repoConfig.repo, repoConfig.ref, manifest.github.token
    );
  }));

  // Build root dep list: global deps + each repo as a dep
  // Repo deps have lower priority than global deps, but both are tree roots
  // The deps_override from manifest repos is wired via getDepsOverride
  const rootDeps = [];

  for (const repoConfig of manifest.repos) {
    rootDeps.push({
      repo:  repoConfig.repo,
      ref:   repoConfig.ref,
      _from: 'repo',
    });
  }

  // Global deps
  for (const dep of manifest.globalDeps) {
    rootDeps.push({ ...dep, _from: 'manifest' });
  }

  // deps_override callback: only applies to repos listed in manifest.repos
  const getDepsOverride = (repo) => {
    const config = manifest.repos.find(r => r.repo === repo);
    return config ? config.deps_override : null;
  };

  const tree = await buildDepTree(rootDeps, {
    token:   manifest.github.token,
    noFetch,
    depth:   0,
    from:    'manifest',
    getDepsOverride,
  });

  // Filter cycles only
  const filtered = cycleOnly ? filterCycles(tree) : tree;

  if (asJson) {
    process.stdout.write(JSON.stringify(filtered, null, 2) + '\n');
    return;
  }

  printTree(filtered);
}

function printTree(tree) {
  if (!tree.dependencies || tree.dependencies.length === 0) {
    logger.info('No dependencies');
    return;
  }
  logger.info('Dependency tree:');
  for (const node of tree.dependencies) {
    printNode(node, '', true);
  }
}

function printNode(node, prefix, isLast) {
  const connector = isLast ? '└── ' : '├── ';
  const childPrefix = isLast ? '    ' : '│   ';

  const tag = buildNodeTag(node);
  logger.dim(`${prefix}${connector}${node.repo}@${node.ref || 'HEAD'}${tag}`);

  if (node.cycle) return; // don't expand cycles

  for (let i = 0; i < node.dependencies.length; i++) {
    printNode(node.dependencies[i], prefix + childPrefix, i === node.dependencies.length - 1);
  }
}

function buildNodeTag(node) {
  const parts = [];
  if (node.from)           parts.push(`from ${node.from}`);
  if (node.resolvedRef && node.ref !== node.resolvedRef) {
    parts.push(`→ ${node.resolvedRef}`);
  }
  if (node.cycle)          parts.push('⚠ cycle');
  if (node.error)          parts.push(`✗ ${node.error}`);
  return parts.length ? `  (${parts.join(', ')})` : '';
}

function filterCycles(tree) {
  const collect = [];
  function walk(nodes) {
    for (const n of nodes) {
      if (n.cycle) collect.push(n);
      else walk(n.dependencies);
    }
  }
  walk(tree.dependencies || []);
  return { dependencies: collect };
}

// ─── resolve-manifest implementation ─────────────────────────────────────────

async function runResolveManifest(options) {
  const manifestPath = options.manifest ? path.resolve(options.manifest) : resolveManifestPath(undefined);
  require('dotenv').config({ path: path.join(path.dirname(path.resolve(manifestPath)), '.env'), override: true });

  const manifest = resolveManifest(manifestPath, {
    set:    options.set,
    define: options.define,
  });

  if (options.json) {
    process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
    return;
  }

  logger.info('Resolved manifest:');
  logger.dim(JSON.stringify(manifest, null, 2));
}

// ─── validate implementation ─────────────────────────────────────────────────

async function runValidate(options) {
  const manifestPath = options.manifest ? path.resolve(options.manifest) : resolveManifestPath(undefined);
  const result = validateManifestFile(manifestPath);

  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.valid) process.exitCode = 1;
    return;
  }

  if (result.valid) {
    logger.success('Manifest is valid');
    return;
  }

  logger.error(`Manifest has ${result.errors.length} error(s) and ${result.warnings.length} warning(s):`);
  for (const err of result.errors) {
    logger.dim(`  ${err.path}: ${err.message}`);
  }
  for (const warn of result.warnings) {
    logger.warn(`  ${warn.path}: ${warn.message}`);
  }
  process.exitCode = 1;
}

// ─── releases implementation ────────────────────────────────────────────────

async function runReleases(repo, options) {
  require('dotenv').config({ override: true });
  const token = process.env.GITHUB_TOKEN || null;
  const limit = options.limit || 10;
  const asJson = options.json || false;

  let entries;
  if (options.tags) {
    entries = await listTags(repo, { token, limit });
  } else {
    entries = await listReleases(repo, { token, limit, includeAssets: options.assets });
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(entries, null, 2) + '\n');
    return;
  }

  if (entries.length === 0) {
    logger.info(`No ${options.tags ? 'tags' : 'releases'} found for ${repo}`);
    return;
  }

  const label = options.tags ? 'Tags' : 'Releases';
  logger.info(`${label} for ${repo} (${entries.length}):`);
  for (const e of entries) {
    const line = options.tags
      ? `  ${e.name}`
      : `  ${e.tagName}  ${e.prerelease ? '(pre) ' : ''}${e.publishedAt ? `— ${e.publishedAt.slice(0, 10)}` : ''}`;
    logger.dim(line);

    if (e.assets && e.assets.length > 0) {
      for (const a of e.assets) {
        logger.dim(`    └ assets/${a.name}  (${(a.size / 1024).toFixed(0)} KB)`);
      }
    }
  }
}

// ─── dry-run ─────────────────────────────────────────────────────────────────

function printDryRun(manifest) {
  const out = manifest.output;
  const expand = (tpl) => tpl.replace('{name}', manifest.name).replace('{version}', manifest.version);

  logger.info(`=== DRY RUN: ${manifest.name} v${manifest.version} ===`);

  // Compiler
  logger.info(`\nCompiler:`);
  logger.dim(`  amxxpc ${manifest.amxmodx.version || 'latest'} — dir: ${manifest.amxmodx.dir}`);
  if (manifest.platform) logger.dim(`  target platform: ${manifest.platform}`);
  if (manifest.amxmodx.defines.length) {
    logger.dim(`  defines: ${manifest.amxmodx.defines.map(d => `-D${d}`).join(' ')}`);
  }

  // Repos
  if (manifest.repos.length) {
    logger.info(`\nRepos (${manifest.repos.length}):`);
    for (const r of manifest.repos) {
      const ref = r.ref || 'default branch';
      logger.dim(`  ${r.repo} @ ${ref}  [dir: ${r.amxmodx_dir}]`);
    }
  }

  // Deps
  if (manifest.globalDeps.length) {
    logger.info(`\nGlobal deps (${manifest.globalDeps.length}):`);
    for (const d of manifest.globalDeps) {
      const src = d.source === 'release' ? 'release' : 'git';
      logger.dim(`  [${src}] ${d.repo}@${d.ref}${d.include_path ? ':' + d.include_path : ''}`);
    }
  }

  // Assets
  if (manifest.assets.sources.length) {
    logger.info(`\nAsset sources (${manifest.assets.sources.length}):`);
    for (const s of manifest.assets.sources) {
      if (s.type === 'amxmodx') {
        logger.dim(`  [amxmodx] ${manifest.amxmodx.version || 'latest'} (${manifest.platform || 'host'})`);
      } else if (s.type === 'release') {
        logger.dim(`  [release] ${s.repo}@${s.ref}  cache: ${s.cache || 'global'}`);
      } else {
        logger.dim(`  [url] ${s.url}  cache: ${s.cache || 'none'}`);
      }
    }
  }

  // Output
  logger.info(`\nOutput:`);
  if (out.pack === false) {
    logger.dim(`  copy → ${path.resolve(out.dir)}/${expand(out.amxmodx_path)}/`);
  } else {
    logger.dim(`  archive → ${path.resolve(out.dir)}/${expand(out.archive_name)}`);
    logger.dim(`  amxmodx path in archive: ${expand(out.amxmodx_path)}/`);
  }
  if (out.assets_path) logger.dim(`  assets path: ${expand(out.assets_path)}/`);
  logger.dim(`  generate_ini: ${out.generate_ini}  |  on_conflict: ${out.on_conflict}`);

  logger.info(`\n=== END DRY RUN ===`);
}

// ─── init ─────────────────────────────────────────────────────────────────────

async function runInitInteractive(options) {
  const { Input, Confirm } = require('enquirer');
  const defaultName = options.name || path.basename(process.cwd());

  const name = await new Input({
    name: 'name',
    message: 'Project name',
    initial: defaultName,
  }).run();

  const description = await new Input({
    name: 'description',
    message: 'Project description (optional)',
    initial: '',
  }).run();

  const doWorkflow = await new Confirm({
    name: 'workflow',
    message: 'Generate GitHub CI workflow?',
    initial: false,
  }).run();

  const doPlugin = await new Confirm({
    name: 'plugin',
    message: 'Create a plugin .sma file?',
    initial: true,
  }).run();
  const pluginName = doPlugin ? await new Input({
    name: 'pluginName',
    message: 'Plugin filename (without .sma)',
    initial: name,
  }).run() : null;

  const doGitignore = await new Confirm({
    name: 'gitignore',
    message: 'Create .gitignore?',
    initial: true,
  }).run();

  const doDeploy = await new Confirm({
    name: 'deploy',
    message: 'Create .env with deploy stubs?',
    initial: false,
  }).run();

  const doOpencode = await new Confirm({
    name: 'opencode',
    message: 'Create .opencode/opencode.json with amxx-dep-resolver MCP config?',
    initial: false,
  }).run();

  // Collect info for summary
  const actions = [];
  actions.push(`amxbuild.yml`);
  if (doWorkflow) actions.push('.github/workflows/ci.yml');
  if (pluginName) actions.push(`amxmodx/scripting/${pluginName}.sma`);
  if (doGitignore) actions.push('.gitignore');
  if (doDeploy) actions.push('.env');
  if (doOpencode) actions.push('.opencode/opencode.json');

  logger.info('Creating:');
  for (const a of actions) logger.dim(`  ${a}`);

  // Generate files
  const version = require('./package.json').version;
  const actionTag = `v${version.split('.')[0]}`;
  const schemaUrl = SCHEMA_URL;

  writeIfAbsent('amxbuild.yml', renderTemplate('init-manifest.yml', { name, schemaUrl }));

  if (doWorkflow) {
    const dest = path.join('.github', 'workflows', 'ci.yml');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writeIfAbsent(dest, renderTemplate('init-workflow.yml', { actionTag }));
  }

  if (pluginName) {
    const dest = path.join('amxmodx', 'scripting', `${pluginName}.sma`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writeIfAbsent(dest, '');
  }

  if (doGitignore) {
    writeIfAbsent('.gitignore', [
      '*.amxx', '*.zip', '.env', '.amxb-cache', '.claude', 'build', 'dist', '',
    ].join('\n'));
  }

  if (doDeploy) {
    writeIfAbsent('.env', renderTemplate('init-deploy.env'));
  }

  if (doOpencode) {
    writeOpencodeConfig();
  }
}

function runInit(options) {
  const pkgName = options.name || path.basename(process.cwd());
  const version = require('./package.json').version;
  const actionTag = `v${version.split('.')[0]}`;

  writeIfAbsent('amxbuild.yml', renderTemplate('init-manifest.yml', { name: pkgName, schemaUrl: SCHEMA_URL }));

  if (options.workflow || options.ci) {
    const dest = path.join('.github', 'workflows', 'ci.yml');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writeIfAbsent(dest, renderTemplate('init-workflow.yml', { actionTag }));
  }

  if (options.plugin) {
    const dest = path.join('amxmodx', 'scripting', `${options.plugin}.sma`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writeIfAbsent(dest, '');
  }

  if (options.gitignore) {
    writeIfAbsent('.gitignore', [
      '*.amxx', '*.zip', '.env', '.amxb-cache', '.claude', 'build', 'dist', '',
    ].join('\n'));
  }

  if (options.deploy) {
    writeIfAbsent('.env', renderTemplate('init-deploy.env'));
  }

  if (options.opencode) {
    writeOpencodeConfig();
  }
}

function writeIfAbsent(filePath, content) {
  if (fs.existsSync(filePath)) {
    logger.warn(`${filePath} already exists, skipping`);
    return;
  }
  fs.writeFileSync(filePath, content);
  logger.success(`Created ${filePath}`);
}

function writeOpencodeConfig() {
  const dir   = '.opencode';
  const file  = path.join(dir, 'opencode.json');
  const mcpKey = 'amxx-dep-resolver';
  const mcpConfig = {
    type: 'local',
    command: ['amxx-dep-resolver'],
    enabled: true,
  };

  if (!fs.existsSync(file)) {
    // Create new
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: { [mcpKey]: mcpConfig },
    }, null, 2) + '\n');
    logger.success(`Created ${file}`);
    return;
  }

  // Merge into existing config
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    logger.warn(`${file} exists but is invalid JSON, skipping merge`);
    return;
  }

  if (cfg.mcp?.[mcpKey]) {
    logger.warn(`${file} already has amxx-dep-resolver MCP config, skipping`);
    return;
  }

  cfg.mcp = cfg.mcp || {};
  cfg.mcp[mcpKey] = mcpConfig;
  cfg.$schema = cfg.$schema || 'https://opencode.ai/config.json';
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  logger.success(`Updated ${file} with amxx-dep-resolver MCP config`);
}

function renderTemplate(name, vars = {}) {
  let content = fs.readFileSync(path.join(TEMPLATES_DIR, name), 'utf8');
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  return content;
}
