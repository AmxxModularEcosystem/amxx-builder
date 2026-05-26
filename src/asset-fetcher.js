'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const axios  = require('axios');
const AdmZip = require('adm-zip');
const { execSync } = require('child_process');

const logger = require('./logger');
const { getCacheDir }        = require('./cache-dir');
const { getAmxmodxFullDir, getHostPlatform } = require('./compiler-fetcher');
const { getReleaseCacheDir } = require('./release-fetcher');

/**
 * Downloads and processes all asset sources defined in manifest.assets.sources.
 * Remote sources are merged into build/_assets_remote/ respecting on_conflict.
 * Then overlaid onto build/assets/ — local files already there win (placed by collectAll).
 */
async function fetchAssets(manifest, buildDir, noFetch = false) {
  const { sources, on_conflict } = manifest.assets;
  if (!sources.length) return;

  const manifestDir = path.dirname(manifest._path);
  const remoteDir   = path.join(buildDir, '_assets_remote');
  const assetsDir   = path.join(buildDir, 'assets');

  fs.mkdirSync(remoteDir, { recursive: true });

  logger.info(`Assets: processing ${sources.length} source(s)...`);

  const origins = new Map(); // relPath → source label (for conflict tracking)

  for (const source of sources) {
    const label  = source.type === 'amxmodx' ? 'amxmodx' : source.url;
    const srcDir = await resolveSource(source, manifest, manifestDir, buildDir, noFetch);
    if (!srcDir) continue;
    applyMap(srcDir, remoteDir, source.map, label, on_conflict, origins);
  }

  // Overlay remote into build/assets/, skipping files already there (local always wins)
  overlayDir(remoteDir, assetsDir);
}

// ─── source resolution ────────────────────────────────────────────────────────

async function resolveSource(source, manifest, manifestDir, buildDir, noFetch) {
  if (source.type === 'amxmodx') {
    const version  = manifest.amxmodx.version;
    const platform = manifest.platform || getHostPlatform();
    if (!version) throw new Error('assets: source: amxmodx requires amxmodx.version to be set');
    logger.step(`Assets: amxmodx ${version} (${platform})...`);
    return getAmxmodxFullDir(version, platform);
  }
  if (source.type === 'release') {
    return getReleaseCacheDir(source, manifest.github.token, noFetch);
  }
  return resolveUrlSource(source, manifestDir, buildDir);
}

async function resolveUrlSource(source, manifestDir, buildDir) {
  const cacheDir = getCacheDirForUrl(source.url, source.cache, manifestDir, buildDir);
  const sentinel = path.join(cacheDir, '.cached');

  if (fs.existsSync(sentinel)) {
    logger.dim(`  ${source.url} (cached)`);
    return cacheDir;
  }

  logger.step(`Assets: downloading ${source.url}...`);
  fs.mkdirSync(cacheDir, { recursive: true });

  try {
    const response    = await axios.get(source.url, { responseType: 'arraybuffer', maxRedirects: 5 });
    const contentType = response.headers['content-type'] || '';
    const filename    = getFilenameFromUrl(source.url);
    const data        = Buffer.from(response.data);

    if (isArchive(filename, contentType)) {
      extractArchive(data, filename, cacheDir);
    } else {
      fs.writeFileSync(path.join(cacheDir, filename), data);
    }

    fs.writeFileSync(sentinel, JSON.stringify({ url: source.url, cached_at: new Date().toISOString() }));
    logger.info(`Assets: ${filename} ready`);
    return cacheDir;
  } catch (err) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    throw new Error(`Failed to fetch asset ${source.url}: ${err.message}`);
  }
}

function getCacheDirForUrl(url, cacheType, manifestDir, buildDir) {
  const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
  if (cacheType === 'global') return path.join(getCacheDir(), 'assets', hash);
  if (cacheType === 'local')  return path.join(manifestDir, '.amxb-cache', 'assets', hash);
  return path.join(buildDir, '_assets_dl', hash); // 'none'
}

// ─── archive detection & extraction ──────────────────────────────────────────

function getFilenameFromUrl(url) {
  try { return path.basename(new URL(url).pathname) || 'download'; } catch { return 'download'; }
}

function isArchive(filename, contentType) {
  if (/\.(zip|tar\.gz|tgz|tar\.bz2)$/i.test(filename)) return true;
  return /zip|tar|gzip|x-compressed/.test(contentType);
}

function extractArchive(data, filename, destDir) {
  if (/\.zip$/i.test(filename)) {
    new AdmZip(data).extractAllTo(destDir, true);
    return;
  }
  const tmpFile = path.join(destDir, filename);
  fs.writeFileSync(tmpFile, data);
  const flag = /\.bz2$/i.test(filename) ? 'xjf' : 'xzf';
  try {
    execSync(`tar ${flag} "${tmpFile}" -C "${destDir}"`, { stdio: 'pipe' });
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

// ─── map application ──────────────────────────────────────────────────────────

function applyMap(srcDir, destDir, mapEntries, label, onConflict, origins) {
  for (const entry of mapEntries) {
    applyMapEntry(srcDir, destDir, entry, label, onConflict, origins);
  }
}

/**
 * Trailing-slash semantics (rsync-style):
 *
 *   from: null        → take entire srcDir contents
 *   from: "models/"   → take contents of srcDir/models/
 *   from: "models"    → take srcDir/models itself (dir placed as destDir/models/)
 *   from: "a/b.wav"   → take single file srcDir/a/b.wav
 *
 *   to: null          → place into destDir root
 *   to: "models/"     → place into destDir/models/
 *   to: "models"      → same as "models/" for dirs; for single file, rename to "models"
 */
function applyMapEntry(baseDir, destBase, { from, to }, label, onConflict, origins) {
  const fromTrailing = from && from.endsWith('/');
  const fromRel      = from ? from.replace(/\/$/, '') : null;
  const fromPath     = fromRel ? path.join(baseDir, fromRel) : baseDir;

  if (!fs.existsSync(fromPath)) {
    logger.warn(`Assets: path not found in source: ${from || '(root)'}`);
    return;
  }

  const toRel      = to ? to.replace(/\/$/, '') : null;
  const toTrailing = !to || to.endsWith('/');
  const destPath   = toRel ? path.join(destBase, toRel) : destBase;

  const stat = fs.statSync(fromPath);

  if (!fromRel || fromTrailing || stat.isDirectory()) {
    // Copy directory contents or the directory itself
    const contentsOnly = !fromRel || fromTrailing;
    const actualDest   = contentsOnly ? destPath : path.join(destPath, path.basename(fromPath));
    copyDirWithConflict(fromPath, actualDest, destBase, label, onConflict, origins);
  } else {
    // Single file
    const fileDest = toTrailing
      ? path.join(destPath, path.basename(fromPath))
      : destPath; // no trailing slash on to → rename

    const relKey = path.relative(destBase, fileDest).replace(/\\/g, '/');
    if (origins.has(relKey)) {
      const prev = origins.get(relKey);
      if (onConflict === 'first_wins') {
        logger.warn(`Asset conflict (kept "${prev}"): ${relKey}`);
        return;
      }
      logger.warn(`Asset conflict (overwriting "${prev}"): ${relKey}`);
    }
    fs.mkdirSync(path.dirname(fileDest), { recursive: true });
    fs.copyFileSync(fromPath, fileDest);
    origins.set(relKey, label);
  }
}

function copyDirWithConflict(srcDir, destDir, trackBase, label, onConflict, origins) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });

  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath  = path.join(srcDir,  entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      copyDirWithConflict(srcPath, destPath, trackBase, label, onConflict, origins);
    } else {
      const relKey = path.relative(trackBase, destPath).replace(/\\/g, '/');
      if (origins.has(relKey)) {
        const prev = origins.get(relKey);
        if (onConflict === 'first_wins') {
          logger.warn(`Asset conflict (kept "${prev}"): ${relKey}`);
          continue;
        }
        logger.warn(`Asset conflict (overwriting "${prev}"): ${relKey}`);
      }
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
      origins.set(relKey, label);
    }
  }
}

// Overlay srcDir onto destDir — skip files that already exist (local wins)
function overlayDir(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath  = path.join(srcDir,  entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      overlayDir(srcPath, destPath);
    } else if (!fs.existsSync(destPath)) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

module.exports = { fetchAssets };
