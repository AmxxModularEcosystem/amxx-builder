const fs   = require('fs');
const path = require('path');
const axios = require('axios');
// Default for API calls; download sites pass their own longer timeout.
axios.defaults.timeout = 30000;
const AdmZip = require('adm-zip');
const chalk = require('chalk');
const logger = require('./logger');
const { getCacheDir } = require('./cache-dir');
const { copyDirContents, safeExtractTar, makeSiblingTmpDir } = require('./fs-utils');
const { downloadToFile } = require('./download');

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
  const completeFile    = path.join(cacheDir, '.complete');

  if (fs.existsSync(binaryPath)) {
    // Backfill the completion marker on legacy (pre-`.complete`) caches so an
    // interrupted extraction is detectable going forward; a fresh install only
    // gains the marker after a successful atomic extract.
    if (!fs.existsSync(completeFile)) {
      try { writeFileSyncAtomic(completeFile, resolvedVersion); } catch (_) {}
    }
    logger.info(`Compiler: amxxpc ${resolvedVersion} (${process.platform}, cached)`);
    return { compilerPath: binaryPath, includeDir: fs.existsSync(includeDir) ? includeDir : null };
  }

  const { major, minor, build } = parseVersion(resolvedVersion);
  const downloadUrl = buildDownloadUrl(major, minor, build, platform);

  logger.step(`Compiler: downloading amxxpc ${resolvedVersion} for ${platform}...`);
  logger.dim(`  ${downloadUrl}`);

  await installCompilerCache(cacheDir, {
    isFinalValid: () => fs.existsSync(binaryPath) && fs.existsSync(completeFile),
    sentinelName: '.complete',
    sentinelContent: resolvedVersion,
    populate: async (stagingDir) => {
      const archivePath = path.join(stagingDir, path.basename(downloadUrl));
      await downloadFile(downloadUrl, archivePath);
      extractWithPrefix(archivePath, stagingDir, {
        prefix: 'addons/amxmodx/scripting/',
        onDone: (d) => makeBinaryExecutable(d, platform),
      });
      fs.rmSync(archivePath, { force: true });
    },
  });

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
 * Atomic cache-write path shared by fetchCompiler (scripting/) and
 * getAmxmodxFullDir (addons/). Stages the download+extract into a unique
 * sibling temp dir, then:
 *   - fresh cache dir → whole-dir rename (a kill can only orphan the temp dir,
 *     never leave a partial cache),
 *   - cache dir already populated (the two variants share one dir, or a
 *     concurrent run won) → merge the staged content and write the completion
 *     sentinel LAST, so an interrupt mid-merge cannot mark partial files valid.
 * Cleans up its own temp dir on failure.
 */
async function installCompilerCache(cacheDir, { isFinalValid, sentinelName, sentinelContent, populate }) {
  const tmpDir = makeSiblingTmpDir(cacheDir);
  try {
    await populate(tmpDir);

    if (!fs.existsSync(cacheDir)) {
      writeFileSyncAtomic(path.join(tmpDir, sentinelName), sentinelContent);
      try {
        fs.renameSync(tmpDir, cacheDir);
        return;
      } catch (_) {
        // A concurrent run created cacheDir between the check and the rename.
      }
    }

    if (isFinalValid()) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
      return;
    }

    copyDirContents(tmpDir, cacheDir);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    writeFileSyncAtomic(path.join(cacheDir, sentinelName), sentinelContent);
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    throw err;
  }
}

function writeFileSyncAtomic(file, content) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
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
    const err = new Error(
      'Latest amxmodx version is not cached and no-fetch is set.\n' +
      'Run once without --no-fetch (or set amxmodx.version explicitly) to populate the cache.'
    );
    err.code = 'LATEST_NOT_CACHED';
    throw err;
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
  if (version) {
    if (version === 'latest') {
      return fetchLatestVersion({ noFetch });
    }
    try {
      parseVersion(version); // validate major.minor.build shape
    } catch (err) {
      err.code = 'INVALID_AMXMODX_VERSION';
      throw err;
    }
    return version;
  }
  if (manifest && manifest.amxmodx && manifest.amxmodx.version) return manifest.amxmodx.version;
  return fetchLatestVersion({ noFetch });
}

/**
 * Resolve the AMX Mod X version for an informational stdlib lookup with
 * graceful offline degradation (noFetch). The logic previously lived inline in
 * src/commands/serve.js (resolveVersionFromParams + resolveStdlibState) and is
 * duplicated — without the degradation — in the MCP layer.
 *
 * Priority: explicit `version` → manifest `amxmodx.version` (unless the literal
 * 'latest') → the latest release.
 *
 * Offline (noFetch) and latest cannot be resolved:
 *   - nothing cached                 → { version: null, degraded: false } (graceful empty)
 *   - a cached compiler exists       → { version: <newest cached>, degraded: true }
 * Invalid explicit versions and other real failures are returned as `error`
 * (with code INVALID_AMXMODX_VERSION for malformed explicit versions) rather
 * than thrown, so each interface can shape them per its convention.
 *
 * @param {object} [opts]
 * @param {string} [opts.version]      - explicit version override
 * @param {object|null} [opts.manifest] - parsed manifest (null when absent/unparseable)
 * @param {boolean} [opts.noFetch=false] - skip network when resolving "latest"
 * @returns {Promise<{ version: string|null, degraded: boolean, error: Error|null }>}
 */
async function resolveStdlibVersion({ version = null, manifest = null, noFetch = false } = {}) {
  let degraded = false;
  let resolved;
  try {
    const manifestVersion = manifest && manifest.amxmodx && manifest.amxmodx.version;
    if (version) {
      resolved = await resolveAmxmodxVersion(null, { version, noFetch });
    } else if (manifestVersion && manifestVersion !== 'latest') {
      resolved = manifestVersion;
    } else {
      resolved = await resolveAmxmodxVersion(manifestVersion === 'latest' ? null : manifest, { noFetch });
    }
  } catch (err) {
    if (noFetch && err && err.code === 'LATEST_NOT_CACHED') {
      const fallback = findNewestCachedCompiler();
      if (!fallback) return { version: null, degraded: false, error: null };
      return { version: fallback.version, degraded: true, error: null };
    }
    return { version: null, degraded: false, error: err };
  }
  return { version: resolved, degraded, error: null };
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
 * Find the newest usable cached compiler for a platform, without downloading.
 *
 * Cache layout: <cache>/amxxpc/<version>/<platform>/amxxpc[.exe] (+ include/).
 * Files directly inside amxxpc/ (e.g. .latest-version-<platform>) and any
 * non-dotted-numeric dirs are ignored. Candidates with an include/ dir are
 * preferred; otherwise the numerically newest version wins (longer tuple is
 * newer when the common prefix is equal, e.g. 1.9.0.5299 > 1.9.0).
 *
 * @param {string} [platform=getHostPlatform()]
 * @returns {{version: string, compilerPath: string, includeDir: string}|null}
 */
function findNewestCachedCompiler(platform = getHostPlatform()) {
  const amxxpcDir = path.join(getCacheDir(), 'amxxpc');
  if (!fs.existsSync(amxxpcDir)) return null;

  const binaryName = platform === 'windows' ? 'amxxpc.exe' : 'amxxpc';
  const candidates = [];

  for (const entry of fs.readdirSync(amxxpcDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+(\.\d+)+$/.test(entry.name)) continue;
    const verDir      = path.join(amxxpcDir, entry.name);
    const platformDir = path.join(verDir, platform);
    const compilerPath = path.join(platformDir, binaryName);
    if (!fs.existsSync(compilerPath)) continue;
    const includeDir = path.join(platformDir, 'include');
    candidates.push({
      version: entry.name,
      compilerPath,
      includeDir,
      hasInclude: fs.existsSync(includeDir),
      parts: entry.name.split('.').map(Number),
    });
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    if (a.hasInclude !== b.hasInclude) return a.hasInclude ? -1 : 1;
    const common = Math.min(a.parts.length, b.parts.length);
    for (let i = 0; i < common; i++) {
      if (a.parts[i] !== b.parts[i]) return b.parts[i] - a.parts[i];
    }
    return b.parts.length - a.parts.length; // longer tuple is newer on equal prefix
  });

  return {
    version: candidates[0].version,
    compilerPath: candidates[0].compilerPath,
    includeDir: candidates[0].includeDir,
  };
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

  await installCompilerCache(cacheDir, {
    isFinalValid: () => fs.existsSync(sentinel),
    sentinelName: '.addons-extracted',
    sentinelContent: '',
    populate: async (stagingDir) => {
      const archivePath = path.join(stagingDir, path.basename(downloadUrl));
      await downloadFile(downloadUrl, archivePath);
      extractWithPrefix(archivePath, stagingDir, { prefix: 'addons/', destSubdir: 'addons' });
      fs.rmSync(archivePath, { force: true });
    },
  });

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
  return downloadToFile(url, dest, {
    progressLabel: `  ${chalk.cyan('Downloading')} ${(filename || 'file').padEnd(30)}`,
  });
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

module.exports = { fetchCompiler, getCompilerInfo, getAmxmodxFullDir, getHostPlatform, fetchLatestVersion, findNewestCachedCompiler, resolveAmxmodxVersion, resolveStdlibVersion };
