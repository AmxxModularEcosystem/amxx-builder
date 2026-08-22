#!/usr/bin/env node
'use strict';

const { program } = require('commander');

const logger = require('./logger');
const { checkForUpdate } = require('./update-check');

const { runBuild }            = require('./commands/build');
const { runClean }            = require('./commands/clean');
const { runDeploy }           = require('./commands/deploy');
const { runWatch }            = require('./commands/watch');
const { runCacheInfo, runCacheClean } = require('./commands/cache');
const { runDoctor }           = require('./commands/doctor');
const { runDepsTree }         = require('./commands/deps-tree');
const { runResolveManifest }  = require('./commands/resolve-manifest');
const { runValidate }         = require('./commands/validate');
const { runReleases }         = require('./commands/releases');
const { runInit, runInitInteractive } = require('./commands/init');
const { runMcp }                     = require('./commands/mcp');
const { runServe }                   = require('./commands/serve');

program
  .name('amxx-builder')
  .description('Build and package AMX Mod X server plugins')
  .version(require('../package.json').version);

// ─── Update check ──────────────────────────────────────────────────────────────

program.hook('preAction', async () => {
  // The MCP server and the serve JSON-RPC server own stdout; an update notice
  // would corrupt the protocol stream.
  if (program.args[0] === 'mcp' || program.args[0] === 'serve') return;
  try {
    const latest = await checkForUpdate();
    if (latest) {
      logger.info(`Доступна новая версия: ${latest} (текущая: ${require('../package.json').version})`);
      logger.dim(`  Обновить: npm install -g github:AmxxModularEcosystem/amxx-builder`);
    }
  } catch { /* update check never blocks */ }
});

// ─── build ────────────────────────────────────────────────────────────────────

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

// ─── clean ────────────────────────────────────────────────────────────────────

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

// ─── cache ────────────────────────────────────────────────────────────────────

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

// ─── deploy ───────────────────────────────────────────────────────────────────

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

// ─── watch ────────────────────────────────────────────────────────────────────

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

// ─── doctor ───────────────────────────────────────────────────────────────────

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

// ─── init ─────────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Scaffold a new plugin project in the current directory')
  .option('--name <name>',   'Package name (default: current directory name)')
  .option('--workflow',      'Generate .github/workflows/ci.yml')
  .option('--ci',           'Alias for --workflow')
  .option('--plugin <name>', 'Create amxmodx/scripting/<name>.sma')
  .option('--gitignore',     'Create .gitignore')
  .option('--opencode',      'Create .opencode/opencode.json with MCP config (amxb mcp)')
  .option('--deploy',        'Create .env with deploy stubs (AMXB_DEPLOY_*)')
  .option('--script',        'Create build.bat and build.sh quick-build scripts')
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

// ─── mcp ──────────────────────────────────────────────────────────────────────

program
  .command('mcp')
  .description('Start the MCP (Model Context Protocol) server for AMXX dependency resolution (stdio transport)')
  .action(async () => {
    try {
      await runMcp();
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }
  });

// ─── serve ───────────────────────────────────────────────────────────────────

program
  .command('serve')
  .description('Start JSON-RPC server for editor integration (stdio)')
  .action(async () => {
    try {
      await runServe();
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }
  });

// ─── version ───────────────────────────────────────────────────────────────────

program
  .command('version')
  .description('Show current version')
  .action(() => {
    console.log(require('../package.json').version);
  });

program.parse(process.argv);
