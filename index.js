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
  .option('--set <key=value...>',   'Override manifest field (e.g. --set version=1.2.3 --set output.archive_name="{name}-{version}.zip")')
  .option('--no-fetch',             'Use cached repos without re-cloning')
  .option('--no-archive',           'Compile only, skip archiving')
  .option('--dry-run',              'Show plan without executing')
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
  .action(() => {
    try {
      runCacheInfo();
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

// ─── init ────────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Scaffold a new plugin project in the current directory')
  .option('--name <name>',   'Package name (default: current directory name)')
  .option('--workflow',      'Generate .github/workflows/ci.yml')
  .option('--ci',           'Alias for --workflow')
  .option('--plugin <name>', 'Create amxmodx/scripting/<name>.sma')
  .option('--gitignore',     'Create .gitignore')
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
  const manifestPath = resolveManifestPath(options.manifest);
  const noFetch      = options.fetch === false;
  const noArchive    = options.archive === false;
  const dryRun       = options.dryRun || false;
  const buildDir     = path.resolve(options.buildDir || './build');

  // Load .env from the manifest's directory (before any token is read)
  const manifestDir = path.dirname(path.resolve(manifestPath));
  require('dotenv').config({ path: path.join(manifestDir, '.env') });

  // Step 1 — Parse manifest, then apply --set overrides
  const manifest = parseManifest(manifestPath);
  if (options.set?.length) applyOverrides(manifest, options.set);
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

function runCacheInfo() {
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

  writeIfAbsent('amxbuild.yml', manifestTemplate(pkgName));

  if (options.workflow || options.ci) {
    const dest = path.join('.github', 'workflows', 'ci.yml');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writeIfAbsent(dest, workflowTemplate(actionTag));
  }

  if (options.plugin) {
    const dest = path.join('amxmodx', 'scripting', `${options.plugin}.sma`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writeIfAbsent(dest, '');
  }

  if (options.gitignore) {
    writeIfAbsent('.gitignore', [
      '*.amxx', '*.zip', '.env', '.claude', 'build', 'dist', '',
    ].join('\n'));
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

function manifestTemplate(name) {
  const schemaUrl = 'https://raw.githubusercontent.com/AmxxModularEcosystem/amxx-builder/master/schema/amxbuild.schema.json';
  return `# yaml-language-server: $schema=${schemaUrl}

name: ${name}

amxmodx:
  version: "1.10.5428"

deps:
  # org/repo@tag

output:
  dir: ./
  archive_name: "{name}.zip"
  amxmodx_path: "{name}/addons/amxmodx"
  readme: false
  generate_ini: false
`;
}

function workflowTemplate(actionTag) {
  /* eslint-disable no-template-curly-in-string */
  return `name: CI

on:
  push:
    branches: [master, feature/**, fix/**]
    paths-ignore:
      - "**.md"
  pull_request:
    types: [opened, reopened, synchronize]
  release:
    types: [published]

jobs:
  build:
    name: Build
    runs-on: ubuntu-latest
    outputs:
      sha:  \${{ steps.sha.outputs.SHORT }}
      name: \${{ steps.build.outputs.name }}
    steps:
      - uses: actions/checkout@v4

      - id: sha
        run: echo "SHORT=$(git rev-parse --short HEAD)" >> $GITHUB_OUTPUT

      - id: build
        uses: AmxxModularEcosystem/amxx-builder@${actionTag}
        with:
          set: |
            output.pack=false
            output.dir=./artifact

      - uses: actions/upload-artifact@v4
        with:
          name: \${{ steps.build.outputs.name }}-\${{ steps.sha.outputs.SHORT }}-dev
          path: artifact/

  publish:
    name: Publish release
    runs-on: ubuntu-latest
    needs: [build]
    if: |
      github.event_name == 'release' &&
      github.event.action == 'published' &&
      startsWith(github.ref, 'refs/tags/')
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: \${{ needs.build.outputs.name }}-\${{ needs.build.outputs.sha }}-dev
          path: artifact/

      - name: Package for release
        run: |
          cd artifact
          zip -r "../\${{ needs.build.outputs.name }}-\${{ github.ref_name }}.zip" .

      - uses: softprops/action-gh-release@v2
        with:
          files: "\${{ needs.build.outputs.name }}-*.zip"
`;
  /* eslint-enable no-template-curly-in-string */
}
