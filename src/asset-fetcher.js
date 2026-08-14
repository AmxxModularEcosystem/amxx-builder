'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const axios  = require('axios');
// Default for API calls; download sites pass their own longer timeout.
axios.defaults.timeout = 30000;
const AdmZip = require('adm-zip');

const chalk = require('chalk');
const { safeExtractTar } = require('./fs-utils');
const logger = require('./logger');
const { getCacheDir }        = require('./cache-dir');
const { withRetry }          = require('./retry');
const { getAmxmodxFullDir, getHostPlatform } = require('./compiler-fetcher');
const { getReleaseCacheDir } = require('./release-fetcher');
const { resolveGithubToken } = require('./manifest');

/**
 * Processes all asset sources defined in manifest.assets.sources in order.
 * Sources are written directly to build/assets/ with on_conflict resolution.
 * source: local copies from assets/ next to the manifest.
 */
async function fetchAssets(manifest, buildDir, noFetch = false) {
  const { sources, on_conflict } = manifest.assets;
  if (!sources.length) return;

  const manifestDir = path.dirname(manifest._path);
  const assetsDir   = path.join(buildDir, 'assets');

  fs.mkdirSync(assetsDir, { recursive: true });

  logger.info(`Assets: processing ${sources.length} source(s)...`);

  const origins = new Map(); // relPath → source label (for conflict tracking)

  // Resolve all sources in parallel (network-bound: release, url), apply maps sequentially
  const resolved = await Promise.all(
    sources.map(src => resolveSource(src, manifest, manifestDir, buildDir, noFetch))
  );
  for (let i = 0; i < sources.length; i++) {
    const srcDir = resolved[i];
    if (!srcDir) continue;
    applyMap(srcDir, assetsDir, sources[i].map, sourceLabel(sources[i]), on_conflict, origins);
  }
}

function sourceLabel(source) {
  if (source.type === 'local')   return 'local';
  if (source.type === 'amxmodx') return 'amxmodx';
  if (source.type === 'release') return `${source.repo}@${source.ref}`;
  return source.url;
}

// ─── source resolution ────────────────────────────────────────────────────────

async function resolveSource(source, manifest, manifestDir, buildDir, noFetch) {
  if (source.type === 'local') {
    const localAssetsDir = path.join(manifestDir, 'assets');
    if (!fs.existsSync(localAssetsDir)) return null;
    logger.dim(`  local assets/`);
    return localAssetsDir;
  }
  if (source.type === 'amxmodx') {
    const version  = manifest.amxmodx.version;
    const platform = manifest.platform || getHostPlatform();
    if (!version) throw new Error('assets: source: amxmodx requires amxmodx.version to be set');
    logger.step(`Assets: amxmodx ${version} (${platform})...`);
    return getAmxmodxFullDir(version, platform);
  }
  if (source.type === 'release') {
    return getReleaseCacheDir(source, resolveGithubToken(manifest, source.repo), noFetch);
  }
  return resolveUrlSource(source, manifestDir, buildDir, noFetch);
}

async function resolveUrlSource(source, manifestDir, buildDir, noFetch) {
  const cacheDir = getCacheDirForUrl(source.url, source.cache, manifestDir, buildDir);
  const sentinel = path.join(cacheDir, '.cached');

  if (fs.existsSync(sentinel)) {
    logger.dim(`  ${source.url} (cached)`);
    return cacheDir;
  }

  if (noFetch) {
    logger.warn(`Assets: skipping ${source.url} (--no-fetch, cache: none)`);
    return null;
  }

  const filename = getFilenameFromUrl(source.url);
  logger.step(`Assets: downloading ${filename}...`);
  fs.mkdirSync(cacheDir, { recursive: true });

  const bar = require('./progress').createBar(100, `  ${chalk.cyan('Downloading')} ${(filename || 'file').padEnd(30)}`);

  try {
    const response    = await withRetry(
      () => axios.get(source.url, {
        responseType: 'arraybuffer',
        maxRedirects: 5,
        timeout: 600000, // large archives — allow slow links, still bound hangs
        onDownloadProgress: (e) => {
          if (bar && e.total) {
            bar.update(Math.round(e.loaded / e.total * 100));
          }
        },
      }),
      { label: filename }
    );
    if (bar) bar.stop();
    const contentType = response.headers['content-type'] || '';
    const data        = Buffer.from(response.data);

    if (isArchive(filename, contentType)) {
      extractArchive(data, filename, cacheDir);
    } else {
      const filePath = path.join(cacheDir, filename);
      const part     = filePath + '.part';
      fs.writeFileSync(part, data);
      fs.renameSync(part, filePath);
    }

    const sentinelTmp = sentinel + '.tmp';
    fs.writeFileSync(sentinelTmp, JSON.stringify({ url: source.url, cached_at: new Date().toISOString() }));
    fs.renameSync(sentinelTmp, sentinel);
    logger.info(`Assets: ${filename} ready`);
    return cacheDir;
  } catch (err) {
    // Never rmSync the whole cache dir: it may be a shared 'global' entry used
    // by parallel sources or other projects. Invalidate the sentinel only and
    // leave the content to be overwritten on the next fetch.
    try { fs.rmSync(sentinel, { force: true }); } catch (_) {}
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
  try {
    const base = path.basename(new URL(url).pathname) || 'download';
    try { return decodeURIComponent(base); } catch { return base; }
  } catch { return 'download'; }
}

function isArchive(filename, contentType) {
  if (/\.(zip|tar\.gz|tgz|tar\.bz2)$/i.test(filename)) return true;
  return /zip|tar|gzip|x-compressed/.test(contentType);
}

function extractArchive(data, filename, destDir) {
  const isZip = /\.zip$/i.test(filename) || isZipMagic(data);
  if (isZip) {
    new AdmZip(data).extractAllTo(destDir, true);
    return;
  }
  const tmpFile = path.join(destDir, filename);
  fs.writeFileSync(tmpFile, data);
  try {
    safeExtractTar(tmpFile, destDir);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

// ZIP archives start with "PK" — filename extensions are unreliable for
// CDN/redirect URLs, so sniff the actual bytes when the name is inconclusive.
function isZipMagic(buf) {
  return buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b;
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
      if (onConflict === 'error') {
        throw new Error(`Asset conflict: "${relKey}" — provided by both "${prev}" and "${label}"`);
      }
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
        if (onConflict === 'error') {
          throw new Error(`Asset conflict: "${relKey}" — provided by both "${prev}" and "${label}"`);
        }
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


module.exports = { fetchAssets };
