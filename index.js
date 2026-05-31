#!/usr/bin/env node
'use strict';

const { program } = require('commander');
const fs   = require('fs');
const path = require('path');


const logger             = require('./src/logger');
const { setVerbose }     = logger;
const { parseManifest }  = require('./src/manifest');
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

// ─── init ────────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Scaffold a new plugin project in the current directory')
  .option('--name <name>',   'Package name (default: current directory name)')
  .option('--workflow',      'Generate .github/workflows/ci.yml')
  .option('--ci',           'Alias for --workflow')
  .option('--plugin <name>', 'Create amxmodx/scripting/<name>.sma')
  .option('--gitignore',     'Create .gitignore')
  .option('--deploy',        'Create .env with deploy stubs (AMXB_DEPLOY_*)')
  .action((options) => {
    try {
      runInit(options);
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

  await sendRconForPlugins(manifest.deploy, []);
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

function dirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

function fmtSize(bytes) {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 ** 2)  return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3)  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function parseCacheKey(key) {
  // owner__repo__ref  →  owner/repo @ ref
  const parts = key.split('__');
  if (parts.length < 3) return key;
  return `${parts.slice(0, -1).join('/')} @ ${parts[parts.length - 1]}`;
}

function runCacheInfo(options = {}) {
  const cacheRoot = getCacheDir();
  const compDir   = path.join(cacheRoot, 'amxxpc');
  const reposDir  = path.join(cacheRoot, 'repos');
  const depsDir   = path.join(cacheRoot, 'release-deps');

  const total = dirSize(cacheRoot);
  logger.info(`Cache: ${cacheRoot} (${fmtSize(total)} total)`);

  if (!fs.existsSync(cacheRoot) || total === 0) {
    logger.dim('  (empty)');
    return;
  }

  if (fs.existsSync(compDir)) {
    const versions = fs.readdirSync(compDir, { withFileTypes: true }).filter(e => e.isDirectory());
    if (versions.length) {
      logger.info('\nCompiler (amxxpc):');
      for (const ver of versions) {
        const verDir    = path.join(compDir, ver.name);
        const platforms = fs.readdirSync(verDir, { withFileTypes: true }).filter(e => e.isDirectory());
        for (const plat of platforms) {
          const size = dirSize(path.join(verDir, plat.name));
          logger.dim(`  ${ver.name.padEnd(14)} ${plat.name.padEnd(10)} ${fmtSize(size)}`);
        }
      }
    }
  }

  if (fs.existsSync(reposDir)) {
    const entries = fs.readdirSync(reposDir, { withFileTypes: true }).filter(e => e.isDirectory());
    if (entries.length) {
      logger.info(`\nRepos (${entries.length}, ${fmtSize(dirSize(reposDir))} total):`);
      for (const e of entries) {
        const label = parseCacheKey(e.name);
        const size  = dirSize(path.join(reposDir, e.name));
        logger.dim(`  ${label.padEnd(52)} ${fmtSize(size)}`);
      }
    }
  }

  if (fs.existsSync(depsDir)) {
    const entries = fs.readdirSync(depsDir, { withFileTypes: true }).filter(e => e.isDirectory());
    if (entries.length) {
      logger.info(`\nRelease deps (${entries.length}, ${fmtSize(dirSize(depsDir))} total):`);
      for (const e of entries) {
        const label = parseCacheKey(e.name);
        const size  = dirSize(path.join(depsDir, e.name));
        logger.dim(`  ${label.padEnd(52)} ${fmtSize(size)}`);
      }
    }
  }

  // Local .amxb-cache/ next to manifest
  const manifestPath = resolveManifestPath(options.manifest);
  const localCacheDir = path.join(path.dirname(path.resolve(manifestPath)), '.amxb-cache', 'assets');
  if (fs.existsSync(localCacheDir)) {
    const entries = fs.readdirSync(localCacheDir, { withFileTypes: true }).filter(e => e.isDirectory());
    if (entries.length) {
      logger.info(`\nLocal asset cache (${entries.length}, ${fmtSize(dirSize(localCacheDir))}):`)
      logger.dim(`  ${localCacheDir}`);
    }
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

// ─── manifest overrides ───────────────────────────────────────────────────────

function applyOverrides(manifest, pairs) {
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) throw new Error(`--set: invalid format "${pair}" (expected key=value)`);
    const keys  = pair.slice(0, eqIdx).trim().split('.');
    const value = parseOverrideValue(pair.slice(eqIdx + 1));
    let node = manifest;
    for (let i = 0; i < keys.length - 1; i++) {
      if (node[keys[i]] == null) node[keys[i]] = {};
      node = node[keys[i]];
    }
    node[keys[keys.length - 1]] = value;
  }
}

function parseOverrideValue(str) {
  if (str === 'true')  return true;
  if (str === 'false') return false;
  if (str === 'null')  return null;
  if (/^\d+$/.test(str)) return parseInt(str, 10);
  return str;
}

// ─── init ─────────────────────────────────────────────────────────────────────

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
}

function writeIfAbsent(filePath, content) {
  if (fs.existsSync(filePath)) {
    logger.warn(`${filePath} already exists, skipping`);
    return;
  }
  fs.writeFileSync(filePath, content);
  logger.success(`Created ${filePath}`);
}

const TEMPLATES_DIR = path.join(__dirname, 'templates');
const SCHEMA_URL    = 'https://raw.githubusercontent.com/AmxxModularEcosystem/amxx-builder/master/schema/amxbuild.schema.json';

function renderTemplate(name, vars = {}) {
  let content = fs.readFileSync(path.join(TEMPLATES_DIR, name), 'utf8');
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  return content;
}
