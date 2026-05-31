'use strict';

const fs   = require('fs');
const path = require('path');
const logger = require('./logger');

function expand(manifest, tpl) {
  return tpl
    .replace('{name}',    manifest.name)
    .replace('{version}', manifest.version);
}

function resolveDeployDirs(manifest) {
  const deploy = manifest.deploy;
  const out    = manifest.output;

  const amxmodxDest = path.join(
    deploy.path,
    expand(manifest, deploy.amxmodx_path)
  );

  const assetsDest = deploy.assets_path != null
    ? path.join(deploy.path, expand(manifest, deploy.assets_path))
    : out.assets_path
      ? path.join(deploy.path, expand(manifest, out.assets_path))
      : deploy.path; // root

  return { amxmodxDest, assetsDest };
}

/**
 * Full deploy: copies build/amxmodx/ and build/assets/ to the deploy path.
 * Returns number of files copied.
 */
async function deployBuild(manifest, buildDir, { incremental = false } = {}) {
  assertDeployPath(manifest);

  const { amxmodxDest, assetsDest } = resolveDeployDirs(manifest);

  logger.step(`Deploying to ${manifest.deploy.path}${incremental ? ' (incremental)' : ''}...`);

  let count = 0;

  const deployRoot     = manifest.deploy.path;
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

  const { amxmodxDest } = resolveDeployDirs(manifest);
  const src  = path.join(buildDir, 'amxmodx', 'plugins', amxxName);
  const dest = path.join(amxmodxDest, 'plugins', amxxName);

  if (!fs.existsSync(src)) {
    logger.warn(`Deploy: plugin not found in build: ${amxxName}`);
    return null;
  }

  if (isExcluded(dest, manifest.deploy.path, manifest.deploy.exclude || [])) {
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
 */
function deployFile(manifest, buildDir, relPath, section) {
  if (!manifest.deploy.path) return;

  const { amxmodxDest, assetsDest } = resolveDeployDirs(manifest);

  const srcBase  = path.join(buildDir, section === 'assets' ? 'assets' : 'amxmodx');
  const destBase = section === 'assets' ? assetsDest : amxmodxDest;

  const src  = path.join(srcBase, relPath);
  const dest = path.join(destBase, relPath);

  if (!fs.existsSync(src)) return;
  if (isExcluded(dest, manifest.deploy.path, manifest.deploy.exclude || [])) {
    logger.verbose(`  skip (excluded): ${relPath}`);
    return;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  logger.success(`Deployed: ${relPath}`);
  logger.verbose(`  → ${dest}`);
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
  return s.size === d.size && s.mtimeMs <= d.mtimeMs;
}

function assertDeployPath(manifest) {
  if (!manifest.deploy.path) {
    throw new Error(
      'Deploy path not configured.\n' +
      '  → Set AMXB_DEPLOY_PATH in .env, or add deploy.path to your manifest'
    );
  }
}

module.exports = { deployBuild, deployPlugin, deployFile };
