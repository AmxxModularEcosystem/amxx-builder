#!/usr/bin/env node
'use strict';

const { program } = require('commander');
const fs   = require('fs');
const path = require('path');


const logger             = require('./src/logger');
const { parseManifest }  = require('./src/manifest');
const { fetchCompiler }  = require('./src/compiler-fetcher');
const { fetchRepo, resolveRef } = require('./src/repo-fetcher');
const { resolveDeps }    = require('./src/deps-resolver');
const { compilePlugins } = require('./src/compiler');
const { collectAll }     = require('./src/collector');
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
  const noFetch      = options.fetch === false;
  const noArchive    = options.archive === false;
  const dryRun       = options.dryRun || false;

  // Load .env from the manifest's directory (before any token is read)
  const manifestDir = path.dirname(path.resolve(manifestPath));
  require('dotenv').config({ path: path.join(manifestDir, '.env') });

  // Step 1 — Parse manifest
  const manifest = parseManifest(manifestPath);
  logger.info(`Manifest: ${manifest.name} v${manifest.version}`);

  if (dryRun) {
    printDryRun(manifest);
    return;
  }

  const buildDir = path.resolve('./build');
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });

  const hasRepos = manifest.repos.length > 0;

  // Step 2 — Fetch compiler (resolves latest version if not pinned)
  const compilerPath = await fetchCompiler(manifest.amxmodx.version, manifest.github.token);

  // Step 3 — Resolve refs and clone all source repos (skipped for local-only builds)
  const repoLocalDirs = {};
  if (hasRepos) {
    for (const repoConfig of manifest.repos) {
      const resolvedRef = await resolveRef(repoConfig.repo, repoConfig.ref, manifest.github.token);
      repoConfig._resolvedRef = resolvedRef;

      const key = `${repoConfig.repo}@${resolvedRef || 'HEAD'}`;
      if (!repoLocalDirs[key]) {
        repoLocalDirs[key] = await fetchRepo(
          repoConfig.repo,
          resolvedRef,
          manifest.github.token,
          noFetch
        );
      }
    }
  }

  // Step 4 — Resolve + clone dependencies, collect .inc files
  const includeDirs = hasRepos
    ? await resolveDeps(manifest, repoLocalDirs, noFetch, buildDir)
    : [];

  // Step 5 — Compile .sma → .amxx
  const compiledPlugins = await compilePlugins(
    manifest,
    repoLocalDirs,
    compilerPath,
    includeDirs,
    buildDir
  );

  // Step 6 — Collect: copy amxmodx/ dirs from repos + local amxmodx/ + local assets/
  await collectAll(manifest, repoLocalDirs, buildDir);

  // Step 7 — Generate plugins-*.ini into build/amxmodx/configs/
  buildIniFiles(compiledPlugins, buildDir);

  if (noArchive) {
    logger.info('--no-archive: skipping zip creation');
    return;
  }

  // Step 8 — Package
  await createArchive(manifest, buildDir);
}

// ─── clean ───────────────────────────────────────────────────────────────────

async function runClean(options) {
  const buildDir = path.resolve('./build');
  const reposDir = path.join(getCacheDir(), 'repos');
  const compDir  = path.join(getCacheDir(), 'amxxpc');

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

// ─── dry-run ─────────────────────────────────────────────────────────────────

function printDryRun(manifest) {
  logger.info('--- DRY RUN ---');
  logger.info(`Compiler: ${manifest.amxmodx.version || 'latest'}`);
  logger.info(`amxmodx dir in repos: ${manifest.amxmodx.dir}`);
  logger.info(`Repos (${manifest.repos.length}):`);
  for (const r of manifest.repos) {
    const ref = r.ref || 'default branch';
    logger.dim(`  ${r.repo} @ ${ref}  [amxmodx_dir: ${r.amxmodx_dir}]`);
  }
  if (manifest.globalDeps.length) {
    logger.info(`Global deps (${manifest.globalDeps.length}):`);
    for (const d of manifest.globalDeps) {
      logger.dim(`  ${d.repo}@${d.ref}${d.include_path ? ':' + d.include_path : ''}`);
    }
  }
  logger.info(`Output: ${manifest.output.amxmodx_path}/ in ${manifest.output.archive_name}`);
  logger.info('--- END DRY RUN ---');
}
