const fs   = require('fs');
const path = require('path');
const { axios, githubHeaders } = require('./http');
const { withRetry } = require('./retry');
const logger = require('./logger');
const { getCacheDir } = require('./cache-dir');
const { extractArchive, makeSiblingTmpDir, publishDir, writeFileSyncAtomic } = require('./fs-utils');
const { downloadToFile, downloadProgressLabel } = require('./download');
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
  const { repoRefKey } = require('./deps-resolver');
  const cacheKey = repoRefKey(repo, resolvedRef) + assetKey;
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

  const headers = githubHeaders(token);
  const release  = await fetchRelease(repo, resolvedRef, headers);
  const asset    = selectAsset(release.assets, assetSelector, repo);

  logger.dim(`  Asset: ${asset.name}`);

  // Download + extract into a unique sibling temp dir, then rename into place:
  // a concurrent build or a killed process can never leave — or observe — a
  // half-written cache dir (mirrors repo-fetcher).
  const tmpDir = makeSiblingTmpDir(cacheDir);
  try {
    const archivePath = path.join(tmpDir, asset.name);
    await downloadAsset(asset.browser_download_url, archivePath, headers);
    extractArchive(archivePath, tmpDir);
    fs.rmSync(archivePath, { force: true });
    // Sentinel written into tmpDir first: only complete dirs become the cache.
    writeFileSyncAtomic(path.join(tmpDir, '.extracted'), resolvedRef);
    publishDir(tmpDir, cacheDir, () => fs.existsSync(sentinelFile));
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    throw err;
  }

  logger.info(`${label}: ${repo}@${resolvedRef} ready`);
  return cacheDir;
}

async function fetchRelease(repo, tag, headers) {
  try {
    const { data } = await withRetry(
      () => axios.get(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { headers }),
      { label: `release ${repo}@${tag}` }
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

async function downloadAsset(url, dest, headers) {
  const filename = path.basename(url);
  return downloadToFile(url, dest, {
    // Default to octet-stream but let callers override (API tarball fallback
    // needs application/vnd.github+json).
    headers: { Accept: 'application/octet-stream', ...headers },
    progressLabel: downloadProgressLabel(filename),
  });
}

module.exports = { fetchReleaseDep, getReleaseCacheDir, downloadAsset };
