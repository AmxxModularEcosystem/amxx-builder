const fs   = require('fs');
const path = require('path');
const glob = require('fast-glob');
const logger = require('./logger');

/**
 * Copies everything from each repo's amxmodx_dir into build/amxmodx/,
 * then merges local amxmodx/ and assets/ directories (next to manifest.yml).
 *
 * .sma files are NOT copied — they are compiled; .amxx output is written by the
 * compiler step that runs after this one, overwriting any pre-built plugins.
 *
 * Repo-vs-repo file conflicts are handled according to output.on_conflict:
 *   last_wins  (default) — later repo in list wins, warning emitted
 *   first_wins           — first repo wins, later duplicates skipped with warning
 *   error                — build fails on first conflict
 *
 * Local amxmodx/ always wins over repo files (intentional override layer, no warning).
 */
async function collectAll(manifest, repoLocalDirs, buildDir) {
  const onConflict      = manifest.output.on_conflict;
  const amxmodxBuildDir = path.join(buildDir, 'amxmodx');
  fs.mkdirSync(amxmodxBuildDir, { recursive: true });

  const origins = new Map(); // rel path → repo label (conflict tracking)

  // Copy from each remote repo
  for (const repoConfig of manifest.repos) {
    const repoDir = repoLocalDirs[`${repoConfig.repo}@${repoConfig._resolvedRef || repoConfig.ref || 'HEAD'}`];
    const srcDir  = path.join(repoDir, repoConfig.amxmodx_dir);

    if (!fs.existsSync(srcDir)) {
      logger.warn(`${repoConfig.repo}: amxmodx dir not found: ${repoConfig.amxmodx_dir}/`);
      continue;
    }

    const files = await glob(['**/*', ...repoConfig.exclude_files.map((p) => `!${p}`)], {
      cwd: srcDir,
      onlyFiles: true,
    });

    let copied = 0;
    for (const f of files) {
      if (origins.has(f)) {
        const prev = origins.get(f);
        if (onConflict === 'error') {
          throw new Error(`File conflict: "${f}" — provided by both "${prev}" and "${repoConfig.repo}"`);
        }
        if (onConflict === 'first_wins') {
          logger.warn(`Conflict (kept "${prev}"): ${f}`);
          continue;
        }
        // last_wins (default)
        logger.warn(`Conflict (overwriting "${prev}"): ${f}`);
      }
      const dest = path.join(amxmodxBuildDir, f);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(srcDir, f), dest);
      origins.set(f, repoConfig.repo);
      copied++;
    }

    logger.dim(`  ${repoConfig.repo}: ${copied}/${files.length} files from ${repoConfig.amxmodx_dir}/`);
  }

  // Merge local amxmodx/ dir — always wins over repo files (intentional override layer)
  const manifestDir     = path.dirname(manifest._path);
  const localAmxmodxDir = path.join(manifestDir, manifest.amxmodx.dir);

  if (fs.existsSync(localAmxmodxDir)) {
    const files = await glob('**/*', {
      cwd: localAmxmodxDir,
      onlyFiles: true,
      ignore: [],
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
