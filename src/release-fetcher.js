const fs   = require('fs');
const path = require('path');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { execSync } = require('child_process');
const logger = require('./logger');
const { getCacheDir } = require('./cache-dir');
const { withRetry } = require('./retry');

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
  const resolvedRef  = await resolveReleaseTag(repo, ref, token);
  const cacheKey     = repo.replace('/', '__') + '__' + resolvedRef.replace(/[^a-zA-Z0-9._-]/g, '_');
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
  fs.writeFileSync(sentinelFile, resolvedRef, 'utf8');

  logger.info(`${label}: ${repo}@${resolvedRef} ready`);
  return cacheDir;
}

async function resolveReleaseTag(repo, ref, token) {
  if (ref !== 'latest') return ref;
  logger.dim(`  ${repo}: resolving latest release tag...`);
  const headers = buildHeaders(token);
  try {
    const { data } = await axios.get(
      `https://api.github.com/repos/${repo}/releases/latest`,
      { headers }
    );
    logger.dim(`  ${repo}: latest = ${data.tag_name}`);
    return data.tag_name;
  } catch (err) {
    throw new Error(`Failed to resolve latest release for ${repo}: ${err.message}`);
  }
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
  const response = await withRetry(
    () => axios.get(url, {
      headers: { ...headers, Accept: 'application/octet-stream' },
      responseType: 'arraybuffer',
      maxRedirects: 5,
    }),
    { label: path.basename(url) }
  );
  fs.writeFileSync(dest, Buffer.from(response.data));
}

function extractArchive(archivePath, destDir) {
  if (archivePath.endsWith('.zip')) {
    new AdmZip(archivePath).extractAllTo(destDir, true);
  } else {
    const flag = archivePath.endsWith('.tar.bz2') ? 'xjf' : 'xzf';
    execSync(`tar ${flag} "${archivePath}" -C "${destDir}"`, { stdio: 'pipe' });
  }
}

module.exports = { fetchReleaseDep, getReleaseCacheDir };
