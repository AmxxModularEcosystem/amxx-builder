const fs   = require('fs');
const path = require('path');
const axios = require('axios');
// Default for API calls; download sites pass their own longer timeout.
axios.defaults.timeout = 30000;
const AdmZip = require('adm-zip');
const chalk = require('chalk');
const logger = require('./logger');
const { getCacheDir } = require('./cache-dir');
const { copyDirContents, safeExtractTar } = require('./fs-utils');
const { withRetry } = require('./retry');

const AMXX_DROP = 'https://www.amxmodx.org/amxxdrop/';

const LATEST_VERSION_TTL_MS = 60 * 60 * 1000; // 1 hour — amxxdrop updates rarely

let _latestMem   = null; // { version, at } — process-lifetime cache
let _latestFetch = null; // in-flight promise, dedupes concurrent calls

/**
 * Ensures the amxxpc compiler is available locally.
 * Downloads from amxmodx.org/amxxdrop/ (official nightly drop, no auth needed).
 *
 * Returns { compilerPath, includeDir } where includeDir points to the
 * bundled standard includes (amxmodx.inc etc.) extracted alongside the binary.
 */
async function fetchCompiler(version, options = {}) {
  const resolvedVersion = version || await fetchLatestVersion(options);
  const platform        = getPlatform();
  const cacheDir        = path.join(getCacheDir(), 'amxxpc', resolvedVersion, platform);
  const binaryName      = platform === 'windows' ? 'amxxpc.exe' : 'amxxpc';
  const binaryPath      = path.join(cacheDir, binaryName);
  const includeDir      = path.join(cacheDir, 'include');

  if (fs.existsSync(binaryPath)) {
    logger.info(`Compiler: amxxpc ${resolvedVersion} (${process.platform}, cached)`);
    return { compilerPath: binaryPath, includeDir: fs.existsSync(includeDir) ? includeDir : null };
  }

  const { major, minor, build } = parseVersion(resolvedVersion);
  const downloadUrl = buildDownloadUrl(major, minor, build, platform);

  logger.step(`Compiler: downloading amxxpc ${resolvedVersion} for ${platform}...`);
  logger.dim(`  ${downloadUrl}`);

  fs.mkdirSync(cacheDir, { recursive: true });
  const archivePath = path.join(cacheDir, path.basename(downloadUrl));

  await downloadFile(downloadUrl, archivePath);
  extractWithPrefix(archivePath, cacheDir, {
    prefix: 'addons/amxmodx/scripting/',
    onDone: (d) => makeBinaryExecutable(d, platform),
  });
  fs.rmSync(archivePath, { force: true });

  if (!fs.existsSync(binaryPath)) {
    throw new Error(
      `amxxpc binary not found after extraction.\n` +
      `Expected "${binaryName}" in ${cacheDir}.\n` +
      `Archive: ${path.basename(downloadUrl)}`
    );
  }

  logger.success(`Compiler: amxxpc ${resolvedVersion} ready`);
  return { compilerPath: binaryPath, includeDir: fs.existsSync(includeDir) ? includeDir : null };
}

/**
 * Compiler info without necessarily downloading. With noFetch the report only
 * reflects what is already cached; otherwise the compiler is ensured to be
 * present (downloaded on first use), exactly like fetchCompiler.
 *
 * @param {string} [version] - explicit version (else resolved like the CLI: manifest → latest)
 * @param {object} [options]
 * @param {boolean} [options.noFetch] - don't download; report cache state only
 * @returns {Promise<{version: string, platform: string, compilerPath: string|null, includeDir: string|null, cached: boolean}>}
 */
async function getCompilerInfo(version, options = {}) {
  const { noFetch = false } = options;
  const resolved = version || await fetchLatestVersion({ noFetch });
  const platform = getPlatform();
  const cacheDir = path.join(getCacheDir(), 'amxxpc', resolved, platform);
  const binaryName = platform === 'windows' ? 'amxxpc.exe' : 'amxxpc';
  const compilerPath = path.join(cacheDir, binaryName);
  const includeDir = path.join(cacheDir, 'include');

  if (!fs.existsSync(compilerPath) && !noFetch) {
    await fetchCompiler(resolved);
  }

  const cached = fs.existsSync(compilerPath);
  return {
    version: resolved,
    platform,
    compilerPath: cached ? compilerPath : null,
    includeDir: fs.existsSync(includeDir) ? includeDir : null,
    cached,
  };
}

// "1.10.5428" → { major: '1', minor: '10', build: '5428' }
function parseVersion(versionStr) {
  const parts = String(versionStr).split('.');
  if (parts.length !== 3) {
    throw new Error(
      `Invalid amxmodx version: "${versionStr}". ` +
      `Expected major.minor.build format (e.g. "1.10.5428").`
    );
  }
  return { major: parts[0], minor: parts[1], build: parts[2] };
}

// https://www.amxmodx.org/amxxdrop/1.10/amxmodx-1.10.0-git5428-base-windows.zip
function buildDownloadUrl(major, minor, build, platform) {
  const ext = platform === 'windows' ? 'zip' : 'tar.gz';
  return `${AMXX_DROP}${major}.${minor}/amxmodx-${major}.${minor}.0-git${build}-base-${platform}.${ext}`;
}

async function fetchLatestVersion(options = {}) {
  const { noFetch } = options;
  const now = Date.now();

  if (_latestMem && now - _latestMem.at < LATEST_VERSION_TTL_MS) {
    return _latestMem.version;
  }

  const cacheFile = path.join(getCacheDir(), 'amxxpc', `.latest-version-${getPlatform()}`);
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cached && cached.version && now - cached.at < LATEST_VERSION_TTL_MS) {
      _latestMem = cached;
      return cached.version;
    }
  } catch (_) {} // no/invalid cache file — resolve from web

  if (noFetch) {
    throw new Error(
      'Latest amxmodx version is not cached and no-fetch is set.\n' +
      'Run once without --no-fetch (or set amxmodx.version explicitly) to populate the cache.'
    );
  }

  if (_latestFetch) return _latestFetch;

  _latestFetch = resolveLatestVersionFromWeb().then((version) => {
    _latestMem = { version, at: Date.now() };
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(_latestMem));
    } catch (_) {} // cache write is best-effort
    return version;
  }).finally(() => {
    _latestFetch = null;
  });

  return _latestFetch;
}

async function resolveLatestVersionFromWeb() {
  logger.step('Compiler: resolving latest amxmodx version...');
  const platform = getPlatform();

  // 1 — list of major.minor dirs on the drop page
  const { data: mainPage } = await axios.get(AMXX_DROP).catch((e) => {
    throw new Error(`Failed to fetch ${AMXX_DROP}: ${e.message}\n  → Check your internet connection or set amxmodx.version explicitly`);
  });

  const mmPattern = /href="(\d+\.\d+)\/"/g;
  const majorMinors = [];
  let m;
  while ((m = mmPattern.exec(mainPage)) !== null) majorMinors.push(m[1]);

  if (!majorMinors.length) {
    throw new Error(`No amxmodx version directories found at ${AMXX_DROP}`);
  }

  majorMinors.sort((a, b) => {
    const [aMaj, aMin] = a.split('.').map(Number);
    const [bMaj, bMin] = b.split('.').map(Number);
    return aMaj !== bMaj ? aMaj - bMaj : aMin - bMin;
  });
  const latestMM = majorMinors[majorMinors.length - 1];

  // 2 — find the highest build number for the current platform
  const { data: dirPage } = await axios.get(`${AMXX_DROP}${latestMM}/`).catch((e) => {
    throw new Error(`Failed to fetch ${AMXX_DROP}${latestMM}/: ${e.message}`);
  });

  const buildPattern = new RegExp(
    `href="amxmodx-[\\d.]+-git(\\d+)-base-${platform}(?:\\.\\w+){1,2}"`,
    'g'
  );
  const builds = [];
  while ((m = buildPattern.exec(dirPage)) !== null) builds.push(parseInt(m[1], 10));

  if (!builds.length) {
    throw new Error(
      `No amxmodx builds found for platform "${platform}" in ` +
      `${AMXX_DROP}${latestMM}/`
    );
  }

  builds.sort((a, b) => a - b);
  const version = `${latestMM}.${builds[builds.length - 1]}`;
  logger.dim(`  Latest: ${version}`);
  return version;
}

/**
 * Resolve the AMX Mod X version to use.
 * Priority: explicit `version` option → manifest `amxmodx.version` → latest.
 * Single source of truth shared by the CLI build, include-tree and the MCP
 * amxmodx-include / resolve_include / compile_sma tools.
 *
 * @param {object|null} manifest - parsed manifest (pass null when absent or unparseable)
 * @param {object} [options]
 * @param {string} [options.version] - explicit version override (highest priority)
 * @param {boolean} [options.noFetch] - skip network when resolving "latest"
 * @returns {Promise<string>}
 */
async function resolveAmxmodxVersion(manifest, options = {}) {
  const { version, noFetch } = options;
  if (version) return version;
  if (manifest && manifest.amxmodx && manifest.amxmodx.version) return manifest.amxmodx.version;
  return fetchLatestVersion({ noFetch });
}

function getPlatform() {
  return getHostPlatform();
}

function getHostPlatform() {
  if (process.platform === 'win32')  return 'windows';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

/**
 * Returns the path to the full amxmodx addons/ tree for the given target platform.
 * Downloads and extracts the base package if not yet cached.
 * Used by asset-fetcher when source: amxmodx is specified.
 *
 * The returned directory contains addons/amxmodx/{plugins,configs,modules,...}
 */
async function getAmxmodxFullDir(version, platform) {
  const cacheDir = path.join(getCacheDir(), 'amxxpc', version, platform);
  const sentinel = path.join(cacheDir, '.addons-extracted');

  if (fs.existsSync(sentinel)) {
    return cacheDir;
  }

  const { major, minor, build } = parseVersion(version);
  const downloadUrl = buildDownloadUrl(major, minor, build, platform);

  logger.step(`Assets: downloading amxmodx ${version} (${platform}) for asset extraction...`);
  logger.dim(`  ${downloadUrl}`);

  fs.mkdirSync(cacheDir, { recursive: true });
  const archivePath = path.join(cacheDir, path.basename(downloadUrl));

  await downloadFile(downloadUrl, archivePath);
  extractWithPrefix(archivePath, cacheDir, { prefix: 'addons/', destSubdir: 'addons' });
  fs.rmSync(archivePath, { force: true });
  const sentinelTmp = sentinel + '.tmp';
  fs.writeFileSync(sentinelTmp, '');
  fs.renameSync(sentinelTmp, sentinel);

  logger.success(`Assets: amxmodx ${version} (${platform}) ready`);
  return cacheDir;
}

/**
 * Filtered extraction from an AMXX base archive.
 *
 * For .zip: iterates entries matching `prefix`, strips prefix, saves to destDir.
 * For .tar.*: extracts to temp dir, finds `findDirName`, copies contents.
 *
 * @param {string} archivePath  — path to the archive
 * @param {string} destDir      — destination directory
 * @param {object} opts
 * @param {string} opts.prefix      — entry path prefix to filter (zip) / find in tar
 * @param {string} [opts.destSubdir] — optional sub-path under destDir for zip entries
 * @param {string} [opts.tmpSuffix]  — suffix for temp extraction dir (default: prefix-derived)
 * @param {function} [opts.onDone]   — called after extraction with (destDir)
 */
function extractWithPrefix(archivePath, destDir, opts) {
  const { prefix, destSubdir, tmpSuffix, onDone } = opts;

  if (archivePath.endsWith('.zip')) {
    const zip = new AdmZip(archivePath);
    for (const entry of zip.getEntries()) {
      const name = entry.entryName.replace(/\\/g, '/');
      if (entry.isDirectory || !name.startsWith(prefix)) continue;
      const rel  = name.slice(prefix.length);
      if (!rel || rel.split('/').includes('..')) continue; // zip-slip guard
      const dest = destSubdir ? path.join(destDir, destSubdir, rel) : path.join(destDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entry.getData());
    }
  } else {
    const findName = prefix.replace(/\/$/, '').split('/').pop();
    const tmpDir   = destDir + '_' + (tmpSuffix || prefix.replace(/[\/]+/g, '_').replace(/_$/, ''));
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      safeExtractTar(archivePath, tmpDir);
      const src = findDir(tmpDir, findName);
      if (!src) throw new Error(`${findName}/ dir not found in archive ${path.basename(archivePath)}`);
      copyDirContents(src, destSubdir ? path.join(destDir, destSubdir) : destDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  if (onDone) onDone(destDir);
}

async function downloadFile(url, dest) {
  const filename = path.basename(url);
  const bar = require('./progress').createBar(100, `  ${chalk.cyan('Downloading')} ${(filename || 'file').padEnd(30)}`);

  const response = await withRetry(
    () => axios.get(url, {
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
  const part = dest + '.part';
  fs.writeFileSync(part, Buffer.from(response.data));
  fs.renameSync(part, dest);
}

function makeBinaryExecutable(destDir, platform) {
  const binaryName = platform === 'windows' ? 'amxxpc.exe' : 'amxxpc';
  const binaryPath = path.join(destDir, binaryName);
  if (fs.existsSync(binaryPath) && platform !== 'windows') {
    fs.chmodSync(binaryPath, 0o755);
  }
}

function findDir(root, name) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    if (entry.name === name) return full;
    const nested = findDir(full, name);
    if (nested) return nested;
  }
  return null;
}

module.exports = { fetchCompiler, getCompilerInfo, getAmxmodxFullDir, getHostPlatform, fetchLatestVersion, resolveAmxmodxVersion };
