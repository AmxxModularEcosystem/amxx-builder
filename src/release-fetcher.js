const fs   = require('fs');
const path = require('path');
const axios = require('axios');
// Default for API calls; download sites pass their own longer timeout.
axios.defaults.timeout = 30000;
const AdmZip = require('adm-zip');
const chalk = require('chalk');
const logger = require('./logger');
const { getCacheDir } = require('./cache-dir');
const { safeExtractTar } = require('./fs-utils');
const { withRetry } = require('./retry');
const { resolveRefIfLatest } = require('./repo-fetcher');

/**
 * Downloads a GitHub release asset and extracts it locally.
 * Returns the path to the directory that should be used as an include dir.
 *
 * Cache: <CACHE_DIR>/release-deps/<owner>__<repo>__<tag>/
 *
 * Asset selection (dep.asset):
 *   null / undefined  — first .zip asset, falling back to assets[0]
 *   number            — assets[N] by index
 *   string            — first asset whose name matches the glob pattern (*, ?)
 */
async function fetchReleaseDep(dep, token, noFetch) {
  const { repo, ref, include_path, asset: assetSelector } = dep;
  const cacheDir = await ensureReleaseCacheDir(repo, ref, assetSelector, token, noFetch, 'Release dep');
  return resolveIncludePath(cacheDir, include_path, repo);
}

/**
 * Ensures the release is downloaded and extracted; returns the cache dir root.
 * Used by asset-fetcher for source: release — shares the same cache as deps.
 */
async function getReleaseCacheDir(source, token, noFetch) {
  const { repo, ref, asset: assetSelector } = source;
  return ensureReleaseCacheDir(repo, ref, assetSelector, token, noFetch, 'Release asset');
}

async function ensureReleaseCacheDir(repo, ref, assetSelector, token, noFetch, label) {
  const resolvedRef  = await resolveRefIfLatest(ref, repo, token);
  // Include the asset selector in the key: the same repo@tag with different
  // assets must not share a cache dir (first-extracted content would win).
  const assetKey = assetSelector == null ? '' : '--' + String(assetSelector).replace(/[^a-zA-Z0-9._-]/g, '_');
  // Lazy require: deps-resolver imports us, so a top-level import would cycle.
  const { normalize } = require('./deps-resolver');
  const cacheKey = normalize(repo).replace('/', '__') + '__' +
    resolvedRef.replace(/[^a-zA-Z0-9._-]/g, '_') + assetKey;
  const cacheDir     = path.join(getCacheDir(), 'release-deps', cacheKey);
  const sentinelFile = path.join(cacheDir, '.extracted');

  if (fs.existsSync(sentinelFile)) {
    logger.dim(`  ${repo}@${resolvedRef} (release, cached)`);
    return cacheDir;
  }

  if (noFetch) {
    throw new Error(
      `Release dep cache missing for ${repo}@${resolvedRef} and --no-fetch is set.\n` +
      `Run without --no-fetch to populate the cache.`
    );
  }

  logger.step(`${label}: ${repo} @ ${resolvedRef}`);

  const headers = buildHeaders(token);
  const release  = await fetchRelease(repo, resolvedRef, headers);
  const asset    = selectAsset(release.assets, assetSelector, repo);

  logger.dim(`  Asset: ${asset.name}`);

  fs.mkdirSync(cacheDir, { recursive: true });
  const archivePath = path.join(cacheDir, asset.name);

  await downloadAsset(asset.browser_download_url, archivePath, headers);
  extractArchive(archivePath, cacheDir);
  fs.rmSync(archivePath, { force: true });
  const sentinelTmp = sentinelFile + '.tmp';
  fs.writeFileSync(sentinelTmp, resolvedRef, 'utf8');
  fs.renameSync(sentinelTmp, sentinelFile);

  logger.info(`${label}: ${repo}@${resolvedRef} ready`);
  return cacheDir;
}

async function fetchRelease(repo, tag, headers) {
  try {
    const { data } = await axios.get(
      `https://api.github.com/repos/${repo}/releases/tags/${tag}`,
      { headers }
    );
    return data;
  } catch (err) {
    throw new Error(`Failed to fetch release "${tag}" for ${repo}: ${err.message}`);
  }
}

function selectAsset(assets, selector, repo) {
  if (!assets || !assets.length) {
    throw new Error(`Release for ${repo} has no assets`);
  }

  if (selector == null) {
    // Default: first .zip, then anything
    return assets.find((a) => a.name.endsWith('.zip')) || assets[0];
  }

  if (typeof selector === 'number') {
    if (selector >= assets.length) {
      throw new Error(
        `Asset index ${selector} out of range for ${repo} — ` +
        `release has ${assets.length} asset(s)`
      );
    }
    return assets[selector];
  }

  // String glob pattern
  const matched = assets.find((a) => matchGlob(selector, a.name));
  if (!matched) {
    throw new Error(
      `No asset matching "${selector}" in release for ${repo}.\n` +
      `Available: ${assets.map((a) => a.name).join(', ')}`
    );
  }
  return matched;
}

function matchGlob(pattern, name) {
  const re = new RegExp(
    '^' +
    pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') +
    '$'
  );
  return re.test(name);
}

function resolveIncludePath(cacheDir, includePath, repo) {
  if (includePath) {
    const full = path.join(cacheDir, includePath);
    if (!fs.existsSync(full)) {
      throw new Error(
        `include_path "${includePath}" not found in extracted release for ${repo}`
      );
    }
    return full;
  }
  // Auto-detect standard AMXX layouts
  for (const candidate of ['addons/amxmodx/scripting/include', 'scripting/include', 'include']) {
    const full = path.join(cacheDir, candidate);
    if (fs.existsSync(full)) return full;
  }
  return cacheDir;
}

function buildHeaders(token) {
  const h = { Accept: 'application/vnd.github+json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

async function downloadAsset(url, dest, headers) {
  const filename = path.basename(url);
  const bar = require('./progress').createBar(100, `  ${chalk.cyan('Downloading')} ${(filename || 'file').padEnd(30)}`);

  const response = await withRetry(
    () => axios.get(url, {
      // Default to octet-stream but let callers override (API tarball fallback
      // needs application/vnd.github+json).
      headers: { Accept: 'application/octet-stream', ...headers },
      responseType: 'arraybuffer',
      maxRedirects: 5,
      timeout: 600000, // large assets — allow slow links, still bound hangs
      onDownloadProgress: (e) => {
        if (bar && e.total) {
          bar.update(Math.round(e.loaded / e.total * 100));
        }
      },
    }),
    { label: filename }
  );
  if (bar) bar.stop();
  const part = dest + '.part';
  fs.writeFileSync(part, Buffer.from(response.data));
  fs.renameSync(part, dest);
}

function extractArchive(archivePath, destDir) {
  if (archivePath.endsWith('.zip') || hasZipMagic(archivePath)) {
    new AdmZip(archivePath).extractAllTo(destDir, true);
  } else {
    safeExtractTar(archivePath, destDir);
  }
}

// ZIP archives start with "PK" — sniff the bytes so an asset named without
// the .zip extension (redirects, CDNs) is still extracted correctly.
function hasZipMagic(filePath) {
  try {
    const fd  = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    return buf[0] === 0x50 && buf[1] === 0x4b;
  } catch { return false; }
}

module.exports = { fetchReleaseDep, getReleaseCacheDir, downloadAsset };
