'use strict';

const fs   = require('fs');
const path = require('path');

const logger         = require('../logger');
const { parseManifest, applyOverrides, resolveManifest, resolveGithubToken } = require('../manifest');
const { fetchCompiler }  = require('../compiler-fetcher');
const { fetchRepo, resolveRef } = require('../repo-fetcher');
const { resolveDeps }    = require('../deps-resolver');
const { compilePlugins } = require('../compiler');
const { collectAll }     = require('../collector');
const { fetchAssets }    = require('../asset-fetcher');
const { buildIniFiles }  = require('../ini-builder');
const { createArchive, copyOutput } = require('../archiver');
const { resolveManifestPath, loadEnv } = require('./shared');
const { printDryRun } = require('./dry-run');

async function runBuild(options) {
  const buildStart   = Date.now();
  if (options.verbose) logger.setVerbose(true);
  const manifestPath = resolveManifestPath(options.manifest);
  const noFetch      = options.fetch === false;
  const noArchive    = options.archive === false;
  const dryRun       = options.dryRun || false;
  const buildDir     = path.resolve(options.buildDir || './build');

  loadEnv(manifestPath);

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

  const { compilerPath, includeDir: compilerIncludeDir } = await fetchCompiler(manifest.amxmodx.version, { noFetch });

  const repoLocalDirs = {};
  if (hasRepos) {
    await Promise.all(manifest.repos.map(async (repoConfig) => {
      repoConfig._resolvedRef = await resolveRef(
        repoConfig.repo, repoConfig.ref, resolveGithubToken(manifest, repoConfig.repo)
      );
    }));

    const cloneJobs = new Map();
    for (const repoConfig of manifest.repos) {
      const key = `${repoConfig.repo}@${repoConfig._resolvedRef || 'HEAD'}`;
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
  }

  const depsIncludeDirs = await resolveDeps(manifest, repoLocalDirs, noFetch, buildDir);
  const includeDirs = compilerIncludeDir ? [...depsIncludeDirs, compilerIncludeDir] : depsIncludeDirs;

  await collectAll(manifest, repoLocalDirs, buildDir);
  await fetchAssets(manifest, buildDir, noFetch);

  const compiledPlugins = await compilePlugins(
    manifest, repoLocalDirs, compilerPath, includeDirs, buildDir
  );

  if (manifest.output.generate_ini) {
    buildIniFiles(compiledPlugins, buildDir);
  }

  if (noArchive) {
    logger.info('--no-archive: skipping zip creation');
    return;
  }

  if (manifest.output.pack === false) {
    copyOutput(manifest, buildDir);
  } else {
    await createArchive(manifest, buildDir);
  }

  const elapsed = ((Date.now() - buildStart) / 1000).toFixed(1);
  logger.success(`Done in ${elapsed}s`);
}

module.exports = { runBuild };
