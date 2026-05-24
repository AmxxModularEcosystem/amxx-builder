const fs   = require('fs');
const path = require('path');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { execSync } = require('child_process');
const logger = require('./logger');
const { getCacheDir } = require('./cache-dir');

const AMXX_DROP = 'https://www.amxmodx.org/amxxdrop/';

/**
 * Ensures the amxxpc compiler is available locally.
 * Downloads from amxmodx.org/amxxdrop/ (official nightly drop, no auth needed).
 *
 * Returns { compilerPath, includeDir } where includeDir points to the
 * bundled standard includes (amxmodx.inc etc.) extracted alongside the binary.
 */
async function fetchCompiler(version) {
  const resolvedVersion = version || await fetchLatestVersion();
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
  extractScripting(archivePath, cacheDir, platform);
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

async function fetchLatestVersion() {
  logger.step('Compiler: resolving latest amxmodx version...');
  const platform = getPlatform();

  // 1 — list of major.minor dirs on the drop page
  const { data: mainPage } = await axios.get(AMXX_DROP).catch((e) => {
    throw new Error(`Failed to fetch ${AMXX_DROP}: ${e.message}`);
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
    `href="amxmodx-[\\d.]+-git(\\d+)-base-${platform}\\.\\w+"`,
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

function getPlatform() {
  if (process.platform === 'win32')  return 'windows';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

async function downloadFile(url, dest) {
  const response = await axios.get(url, { responseType: 'arraybuffer', maxRedirects: 5 });
  fs.writeFileSync(dest, Buffer.from(response.data));
}

/**
 * Extracts only addons/amxmodx/scripting/ from the base archive into destDir.
 * Result: destDir/amxxpc[.exe], destDir/include/*.inc, etc.
 */
function extractScripting(archivePath, destDir, platform) {
  const SCRIPTING_PREFIX = 'addons/amxmodx/scripting/';

  if (archivePath.endsWith('.zip')) {
    const zip = new AdmZip(archivePath);
    for (const entry of zip.getEntries()) {
      const name = entry.entryName.replace(/\\/g, '/');
      if (entry.isDirectory || !name.startsWith(SCRIPTING_PREFIX)) continue;
      const rel  = name.slice(SCRIPTING_PREFIX.length);
      if (!rel) continue;
      const dest = path.join(destDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entry.getData());
    }
  } else {
    const tmpDir = destDir + '_tmp';
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      const flag = archivePath.endsWith('.tar.bz2') ? 'xjf' : 'xzf';
      execSync(`tar ${flag} "${archivePath}" -C "${tmpDir}"`, { stdio: 'pipe' });

      const scriptingSrc = findDir(tmpDir, 'scripting');
      if (!scriptingSrc) throw new Error(`scripting/ dir not found in archive ${path.basename(archivePath)}`);
      copyDirContents(scriptingSrc, destDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

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

function copyDirContents(src, dest) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath  = path.join(src,  entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyDirContents(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

module.exports = { fetchCompiler };
