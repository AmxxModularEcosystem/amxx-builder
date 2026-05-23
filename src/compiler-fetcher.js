const fs   = require('fs');
const path = require('path');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { execSync } = require('child_process');
const logger = require('./logger');
const { getCacheDir } = require('./cache-dir');

const COMPILER_REPO = 'wopox1337/setup-amxxpawn';

async function fetchCompiler(version, token) {
  const platform   = getPlatform();
  const cacheDir   = path.join(getCacheDir(), 'amxxpc', version, platform);
  const binaryName = platform === 'windows' ? 'amxxpc.exe' : 'amxxpc';
  const binaryPath = path.join(cacheDir, binaryName);

  if (fs.existsSync(binaryPath)) {
    logger.info(`Compiler: amxxpc ${version} (${process.platform}, cached)`);
    return binaryPath;
  }

  logger.info(`Compiler: amxxpc ${version} (${process.platform}, downloading...)`);

  const headers = buildHeaders(token);
  const asset   = await findReleaseAsset(version, platform, headers);

  fs.mkdirSync(cacheDir, { recursive: true });
  const archivePath = path.join(cacheDir, asset.name);

  await downloadFile(asset.browser_download_url, archivePath, headers);
  extractBinary(archivePath, cacheDir, binaryName);

  if (!fs.existsSync(binaryPath)) {
    throw new Error(
      `amxxpc binary not found after extraction. ` +
      `Looked for "${binaryName}" in ${cacheDir}. ` +
      `Please check the release asset structure.`
    );
  }

  if (platform !== 'windows') {
    fs.chmodSync(binaryPath, 0o755);
  }

  logger.success(`Compiler: amxxpc ${version} ready`);
  return binaryPath;
}

function getPlatform() {
  if (process.platform === 'win32')  return 'windows';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

function buildHeaders(token) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function findReleaseAsset(version, platform, headers) {
  // Try tag variants: "1.10.5428", "v1.10.5428"
  const tagCandidates = [version, `v${version}`];
  let assets = null;
  let releaseTag = null;

  for (const tag of tagCandidates) {
    try {
      const url = `https://api.github.com/repos/${COMPILER_REPO}/releases/tags/${tag}`;
      const { data } = await axios.get(url, { headers });
      assets = data.assets;
      releaseTag = tag;
      break;
    } catch (err) {
      if (err.response && err.response.status === 404) continue;
      throw err;
    }
  }

  if (!assets) {
    // Try listing all releases and searching by version substring
    const url = `https://api.github.com/repos/${COMPILER_REPO}/releases`;
    const { data } = await axios.get(url, { headers });
    const release = data.find((r) =>
      r.tag_name.includes(version) || r.name.includes(version)
    );
    if (!release) {
      throw new Error(
        `No release found for amxxpc version "${version}" in ${COMPILER_REPO}.\n` +
        `Available tags: ${data.slice(0, 5).map((r) => r.tag_name).join(', ')}`
      );
    }
    assets = release.assets;
    releaseTag = release.tag_name;
  }

  const platformKeywords = {
    windows: ['windows', 'win32', 'win'],
    linux:   ['linux'],
    mac:     ['macos', 'mac', 'darwin', 'osx'],
  };

  const keywords = platformKeywords[platform];
  let asset = assets.find((a) =>
    keywords.some((kw) => a.name.toLowerCase().includes(kw))
  );

  // Fallback: on windows try any .zip, on others any .tar.gz
  if (!asset) {
    const ext = platform === 'windows' ? '.zip' : '.tar.gz';
    asset = assets.find((a) => a.name.endsWith(ext));
  }

  if (!asset) {
    const names = assets.map((a) => a.name).join(', ');
    throw new Error(
      `No suitable asset for platform "${platform}" in release "${releaseTag}".\n` +
      `Available assets: ${names}`
    );
  }

  logger.dim(`  Release: ${releaseTag}, asset: ${asset.name}`);
  return asset;
}

async function downloadFile(url, dest, headers) {
  const response = await axios.get(url, {
    headers: { ...headers, Accept: 'application/octet-stream' },
    responseType: 'arraybuffer',
    maxRedirects: 5,
  });
  fs.writeFileSync(dest, Buffer.from(response.data));
}

function extractBinary(archivePath, destDir, binaryName) {
  if (archivePath.endsWith('.zip')) {
    const zip = new AdmZip(archivePath);
    const entry = zip.getEntries().find((e) =>
      path.basename(e.entryName) === binaryName
    );
    if (entry) {
      fs.writeFileSync(path.join(destDir, binaryName), entry.getData());
    } else {
      // Extract everything; caller checks for binary
      zip.extractAllTo(destDir, true);
    }
  } else {
    // .tar.gz / .tar.bz2 — use system tar (available on Linux/macOS)
    const flag = archivePath.endsWith('.tar.bz2') ? 'xjf' : 'xzf';
    execSync(`tar ${flag} "${archivePath}" -C "${destDir}" --strip-components=0`, {
      stdio: 'pipe',
    });
    // Try to find the binary at any depth and move it to destDir root
    moveBinaryToRoot(destDir, binaryName);
  }
}

function moveBinaryToRoot(dir, binaryName) {
  const found = findFileRecursive(dir, binaryName);
  if (found && found !== path.join(dir, binaryName)) {
    fs.renameSync(found, path.join(dir, binaryName));
  }
}

function findFileRecursive(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const result = findFileRecursive(full, name);
      if (result) return result;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

module.exports = { fetchCompiler };
