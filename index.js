#!/usr/bin/env node
'use strict';

const { program } = require('commander');
const fs   = require('fs');
const path = require('path');

const logger          = require('./src/logger');
const { parseManifest } = require('./src/manifest');
const { fetchCompiler } = require('./src/compiler-fetcher');
const { fetchRepo }     = require('./src/repo-fetcher');
const { resolveDeps }   = require('./src/deps-resolver');
const { compilePlugins } = require('./src/compiler');
const { collectExtras }  = require('./src/collector');
const { buildIniFiles }  = require('./src/ini-builder');
const { createArchive }  = require('./src/archiver');
const { getCacheDir }    = require('./src/cache-dir');

program
  .name('amxx-builder')
  .description('Build and package AMX Mod X server plugins')
  .version('1.0.0');

// ─── build ───────────────────────────────────────────────────────────────────

program
  .command('build')
  .description('Build plugins from manifest')
  .option('--manifest <path>', 'Path to manifest.yml', './manifest.yml')
  .option('--no-fetch',   'Use cached repos without re-cloning')
  .option('--no-archive', 'Compile only, skip archiving')
  .option('--dry-run',    'Show plan without executing')
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
  .option('--all', 'Also clean compiler cache')
  .action(async (options) => {
    try {
      await runClean(options);
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }
  });

program.parse(process.argv);

// ─── build implementation ────────────────────────────────────────────────────

async function runBuild(options) {
  const manifestPath = options.manifest || './manifest.yml';
  const noFetch      = options.fetch === false;   // commander inverts --no-fetch
  const noArchive    = options.archive === false;
  const dryRun       = options.dryRun || false;

  // Step 1 — Parse manifest
  const manifest = parseManifest(manifestPath);
  logger.info(`Manifest: ${manifest.name} v${manifest.version}`);

  if (dryRun) {
    printDryRun(manifest, noFetch, noArchive);
    return;
  }

  const buildDir = path.resolve('./build');
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });

  // Step 2 — Fetch compiler
  const compilerPath = await fetchCompiler(
    manifest.amxmodx.version,
    manifest.github.token
  );

  // Step 3 — Clone all source repos (deduplicated)
  const repoLocalDirs = {};
  for (const repoConfig of manifest.repos) {
    const ref = repoConfig.ref || 'HEAD';
    const key = `${repoConfig.repo}@${ref}`;
    if (!repoLocalDirs[key]) {
      repoLocalDirs[key] = await fetchRepo(
        repoConfig.repo,
        ref,
        manifest.github.token,
        noFetch
      );
    }
  }

  // Step 4 — Resolve dependencies, clone dep repos, collect includes
  const includeDirs = await resolveDeps(manifest, noFetch, buildDir);

  // Step 5 — Compile plugins
  const compiledPlugins = await compilePlugins(
    manifest,
    repoLocalDirs,
    compilerPath,
    includeDirs,
    buildDir
  );

  // Step 6 — Collect extras
  await collectExtras(manifest, repoLocalDirs, buildDir);

  // Step 7 — Generate plugins-*.ini
  buildIniFiles(compiledPlugins, manifest, buildDir);

  if (noArchive) {
    logger.info('--no-archive: skipping zip creation');
    return;
  }

  // Step 8 — Create archive
  await createArchive(manifest, buildDir);
}

// ─── clean implementation ────────────────────────────────────────────────────

async function runClean(options) {
  const buildDir  = path.resolve('./build');
  const cacheDir  = getCacheDir();
  const reposDir  = path.join(cacheDir, 'repos');
  const compDir   = path.join(cacheDir, 'amxxpc');

  if (fs.existsSync(buildDir)) {
    fs.rmSync(buildDir, { recursive: true, force: true });
    logger.info('Cleaned: ./build/');
  }

  if (fs.existsSync(reposDir)) {
    fs.rmSync(reposDir, { recursive: true, force: true });
    logger.info(`Cleaned: ${reposDir}`);
  }

  if (options.all && fs.existsSync(compDir)) {
    fs.rmSync(compDir, { recursive: true, force: true });
    logger.info(`Cleaned: ${compDir}`);
  }
}

// ─── dry-run output ──────────────────────────────────────────────────────────

function printDryRun(manifest, noFetch, noArchive) {
  logger.info('--- DRY RUN ---');
  logger.info(`Compiler version: ${manifest.amxmodx.version}`);
  logger.info(`Repos to clone (${manifest.repos.length}):`);
  for (const r of manifest.repos) {
    logger.dim(`  ${r.repo} @ ${r.ref || 'default'}`);
  }
  logger.info(`Global deps (${manifest.globalDeps.length}):`);
  for (const d of manifest.globalDeps) {
    logger.dim(`  ${d.repo}@${d.ref}${d.include_path ? ':' + d.include_path : ''}`);
  }
  logger.info(`Flags: no-fetch=${noFetch}, no-archive=${noArchive}`);
  logger.info('--- END DRY RUN ---');
}
