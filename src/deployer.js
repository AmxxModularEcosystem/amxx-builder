'use strict';

const fs   = require('fs');
const path = require('path');
const logger = require('./logger');

function expand(manifest, tpl) {
  return tpl
    .replaceAll('{name}',    manifest.name)
    .replaceAll('{version}', manifest.version);
}

function resolveDeployDirs(manifest) {
  const deploy = manifest.deploy;

  // Absolute root: exclusion matching (isExcluded) compares against the deploy
  // root, so a relative deploy.path would break path.relative on every dest.
  const deployRoot = path.resolve(deploy.path);

  const amxmodxRel  = expand(manifest, deploy.amxmodx_path);
  const amxmodxDest = path.join(deployRoot, amxmodxRel);

  // Deploy layout is decoupled from the archive layout: assets go to the
  // server root by default (schema: "Defaults to deploy root") so local
  // assets/ models+sound land where the game reads them — unlike
  // output.assets_path ('{name}'), which only shapes the zip.
  const assetsRel  = deploy.assets_path ? expand(manifest, deploy.assets_path) : '';
  const assetsDest = assetsRel ? path.join(deployRoot, assetsRel) : deployRoot;

  // Deploy destinations must stay inside deployRoot: exclusion matching and the
  // relative-path safety of every deploy helper assume it. An escaping path
  // (absolute or ../-traversing amxmodx_path/assets_path) would write outside
  // the configured server root and silently disable exclude patterns.
  for (const [label, rel, dest] of [
    ['deploy.amxmodx_path', amxmodxRel, amxmodxDest],
    ['deploy.assets_path',  assetsRel,  assetsDest],
  ]) {
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
      throw new Error(
        `${label} resolves outside the deploy path: ${rel}\n` +
        `  Deploy root: ${deployRoot}\n` +
        '  Use a path inside deploy.path (relative), e.g. "addons/amxmodx".'
      );
    }
  }

  return { amxmodxDest, assetsDest, deployRoot };
}

/**
 * Full deploy: copies build/amxmodx/ and build/assets/ to the deploy path.
 * Returns number of files copied.
 */
async function deployBuild(manifest, buildDir, { incremental = false } = {}) {
  assertDeployPath(manifest);

  const { amxmodxDest, assetsDest, deployRoot } = resolveDeployDirs(manifest);

  logger.step(`Deploying to ${manifest.deploy.path}${incremental ? ' (incremental)' : ''}...`);

  let count = 0;

  const excludePatterns = manifest.deploy.exclude || [];

  const amxmodxSrc = path.join(buildDir, 'amxmodx');
  if (fs.existsSync(amxmodxSrc)) {
    count += copyDir(amxmodxSrc, amxmodxDest, incremental, deployRoot, excludePatterns);
  }

  const assetsSrc = path.join(buildDir, 'assets');
  if (fs.existsSync(assetsSrc)) {
    count += copyDir(assetsSrc, assetsDest, incremental, deployRoot, excludePatterns);
  }

  logger.success(`Deployed ${count} file(s) → ${manifest.deploy.path}`);
  return count;
}

/**
 * Deploy a single compiled .amxx file (watch mode after recompile).
 * Returns the dest path or null if not deployed.
 */
function deployPlugin(manifest, buildDir, amxxName) {
  if (!manifest.deploy.path) return null;

  const { amxmodxDest, deployRoot } = resolveDeployDirs(manifest);
  const src  = path.join(buildDir, 'amxmodx', 'plugins', amxxName);
  const dest = path.join(amxmodxDest, 'plugins', amxxName);

  if (!fs.existsSync(src)) {
    logger.warn(`Deploy: plugin not found in build: ${amxxName}`);
    return null;
  }

  if (isExcluded(dest, deployRoot, manifest.deploy.exclude || [])) {
    logger.verbose(`  skip (excluded): ${amxxName}`);
    return null;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  logger.success(`Deployed: ${amxxName}`);
  logger.verbose(`  → ${dest}`);
  return dest;
}

/**
 * Deploy a single changed local file (watch mode for amxmodx/ or assets/).
 * relPath is relative to the section root (amxmodx/ or assets/).
 * srcRoot overrides the directory relPath is resolved against — watch mode
 * passes the live project dir (manifestDir/amxmodx or manifestDir/assets) so
 * the freshly-edited file is deployed; when no srcRoot is given (or the file
 * does not exist there), it falls back to the build tree, which is what the
 * editor interface (serve deploy.file) relies on for files that only exist in
 * a build (e.g. downloaded assets).
 * Returns the destination path, or null when not deployed (no deploy path,
 * missing source, or excluded).
 */
function deployFile(manifest, buildDir, relPath, section, srcRoot = null) {
  if (!manifest.deploy.path) return null;

  const { amxmodxDest, assetsDest, deployRoot } = resolveDeployDirs(manifest);

  const buildBase = path.join(buildDir, section === 'assets' ? 'assets' : 'amxmodx');
  const destBase  = section === 'assets' ? assetsDest : amxmodxDest;

  const dest = path.join(destBase, relPath);

  const projectSrc = srcRoot ? path.join(srcRoot, relPath) : null;
  const buildSrc   = path.join(buildBase, relPath);
  const src        = projectSrc && fs.existsSync(projectSrc) ? projectSrc : buildSrc;

  if (!fs.existsSync(src)) return null;
  if (isExcluded(dest, deployRoot, manifest.deploy.exclude || [])) {
    logger.verbose(`  skip (excluded): ${relPath}`);
    return null;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  logger.success(`Deployed: ${relPath}`);
  logger.verbose(`  → ${dest}`);
  return dest;
}

/**
 * Removes a deployed file that was deleted locally (watch mode).
 * relPath is relative to the section root. Honours deploy.exclude.
 * Returns the removed destination path, or null when nothing was removed.
 */
function removeDeployedFile(manifest, buildDir, relPath, section) {
  if (!manifest.deploy.path) return null;

  const { amxmodxDest, assetsDest, deployRoot } = resolveDeployDirs(manifest);

  const destBase = section === 'assets' ? assetsDest : amxmodxDest;
  const dest     = path.join(destBase, relPath);

  if (isExcluded(dest, deployRoot, manifest.deploy.exclude || [])) {
    logger.verbose(`  skip delete (excluded): ${relPath}`);
    return null;
  }

  if (!fs.existsSync(dest)) return null;
  fs.rmSync(dest, { force: true });
  logger.success(`Removed: ${relPath}`);
  return dest;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function isExcluded(absDestPath, deployRoot, patterns) {
  if (!patterns.length) return false;
  const rel = path.relative(deployRoot, absDestPath).split(path.sep).join('/');
  return patterns.some((pat) => {
    const np = pat.replace(/\\/g, '/').replace(/\/$/, '');
    return rel === np || rel.startsWith(np + '/');
  });
}

function copyDir(srcDir, destDir, incremental, deployRoot, excludePatterns) {
  if (!fs.existsSync(srcDir)) return 0;
  fs.mkdirSync(destDir, { recursive: true });
  let count = 0;

  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath  = path.join(srcDir,  entry.name);
    const destPath = path.join(destDir, entry.name);

    if (isExcluded(destPath, deployRoot, excludePatterns)) {
      logger.verbose(`  skip (excluded): ${path.relative(deployRoot, destPath)}`);
      continue;
    }

    if (entry.isDirectory()) {
      count += copyDir(srcPath, destPath, incremental, deployRoot, excludePatterns);
    } else {
      if (incremental && isUpToDate(srcPath, destPath)) continue;
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
      logger.verbose(`  → ${destPath}`);
      count++;
    }
  }
  return count;
}

function isUpToDate(src, dest) {
  if (!fs.existsSync(dest)) return false;
  const s = fs.statSync(src);
  const d = fs.statSync(dest);
  // Equal mtimes (coarse FAT/exFAT granularity) must NOT be treated as
  // up-to-date — a recompiled file in the same 2s tick would be skipped.
  return s.size === d.size && s.mtimeMs < d.mtimeMs;
}

function assertDeployPath(manifest) {
  if (!manifest.deploy.path) {
    throw new Error(
      'Deploy path not configured.\n' +
      '  → Set AMXB_DEPLOY_PATH in .env, or add deploy.path to your manifest'
    );
  }
}

module.exports = { deployBuild, deployPlugin, deployFile, removeDeployedFile };
