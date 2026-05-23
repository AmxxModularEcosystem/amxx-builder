const fs   = require('fs');
const path = require('path');
const glob = require('fast-glob');
const logger = require('./logger');

/**
 * Copies extras from each repo into the build directory.
 * Also copies README.md if store_readme is true.
 */
async function collectExtras(manifest, repoLocalDirs, buildDir) {
  for (const repoConfig of manifest.repos) {
    const repoDir = repoLocalDirs[repoConfig.repo + '@' + (repoConfig.ref || 'HEAD')];

    for (const extra of repoConfig.extras) {
      const srcPattern = extra.src.replace(/\\/g, '/');
      const isDir      = srcPattern.endsWith('/') || !srcPattern.includes('.');

      let files;
      if (isDir) {
        // Directory glob: copy all files recursively
        const baseDir  = path.join(repoDir, srcPattern.replace(/\/$/, ''));
        if (!fs.existsSync(baseDir)) {
          logger.warn(`Extras src not found: ${extra.src} in ${repoConfig.repo}`);
          continue;
        }
        files = await glob('**/*', { cwd: baseDir, dot: false, onlyFiles: true });
        for (const f of files) {
          const src  = path.join(baseDir, f);
          const dest = path.join(buildDir, extra.dst, f);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
        }
      } else {
        // Explicit glob pattern
        files = await glob(srcPattern, { cwd: repoDir, dot: false, onlyFiles: true });
        for (const f of files) {
          const src  = path.join(repoDir, f);
          const dest = path.join(buildDir, extra.dst, path.basename(f));
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
        }
      }

      logger.dim(`  extras: ${repoConfig.repo} ${extra.src} → build/${extra.dst} (${files.length} files)`);
    }

    if (repoConfig.store_readme) {
      const readmePath = path.join(repoDir, 'README.md');
      if (fs.existsSync(readmePath)) {
        const dest = path.join(buildDir, `README-${path.basename(repoConfig.repo)}.md`);
        fs.copyFileSync(readmePath, dest);
        logger.dim(`  README.md → ${path.basename(dest)}`);
      }
    }
  }
}

module.exports = { collectExtras };
