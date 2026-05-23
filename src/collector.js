const fs   = require('fs');
const path = require('path');
const glob = require('fast-glob');
const logger = require('./logger');

/**
 * Copies everything from each repo's amxmodx_dir into build/amxmodx/,
 * then merges local amxmodx/ and assets/ directories (next to manifest.yml).
 *
 * .sma files are NOT copied — they are compiled; .amxx output is already in plugins/.
 * Everything else (configs, lang, includes, etc.) is copied as-is.
 */
async function collectAll(manifest, repoLocalDirs, buildDir) {
  const amxmodxBuildDir = path.join(buildDir, 'amxmodx');
  fs.mkdirSync(amxmodxBuildDir, { recursive: true });

  // Copy from each repo
  for (const repoConfig of manifest.repos) {
    const repoDir = repoLocalDirs[`${repoConfig.repo}@${repoConfig._resolvedRef || repoConfig.ref || 'HEAD'}`];
    const srcDir  = path.join(repoDir, repoConfig.amxmodx_dir);

    if (!fs.existsSync(srcDir)) {
      logger.warn(`${repoConfig.repo}: amxmodx dir not found: ${repoConfig.amxmodx_dir}/`);
      continue;
    }

    const files = await glob('**/*', {
      cwd: srcDir,
      onlyFiles: true,
      ignore: ['scripting/**/*.sma'],  // sources are compiled, not deployed
    });

    for (const f of files) {
      const dest = path.join(amxmodxBuildDir, f);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(srcDir, f), dest);
    }

    logger.dim(`  ${repoConfig.repo}: ${files.length} files from ${repoConfig.amxmodx_dir}/`);
  }

  // Merge local amxmodx/ dir (next to manifest.yml)
  const manifestDir     = path.dirname(manifest._path);
  const localAmxmodxDir = path.join(manifestDir, manifest.amxmodx.dir);

  if (fs.existsSync(localAmxmodxDir)) {
    const files = await glob('**/*', {
      cwd: localAmxmodxDir,
      onlyFiles: true,
      ignore: ['scripting/**/*.sma'],
    });
    for (const f of files) {
      const dest = path.join(amxmodxBuildDir, f);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(localAmxmodxDir, f), dest);
    }
    if (files.length) logger.info(`Local ${manifest.amxmodx.dir}/: ${files.length} files merged`);
  }

  // Copy local assets/ → build/assets/ (go to archive root)
  const localAssetsDir = path.join(manifestDir, 'assets');
  if (fs.existsSync(localAssetsDir)) {
    const assetsBuildDir = path.join(buildDir, 'assets');
    const files = await glob('**/*', { cwd: localAssetsDir, onlyFiles: true });
    for (const f of files) {
      const dest = path.join(assetsBuildDir, f);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(localAssetsDir, f), dest);
    }
    if (files.length) logger.info(`Local assets/: ${files.length} files → archive root`);
  }
}

module.exports = { collectAll };
