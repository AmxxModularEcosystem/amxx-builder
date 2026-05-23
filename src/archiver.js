const fs      = require('fs');
const path    = require('path');
const archiver = require('archiver');
const logger  = require('./logger');

/**
 * Creates the output .zip:
 *   build/amxmodx/**  → <output.amxmodx_path>/**   (e.g. addons/amxmodx/)
 *   build/assets/**   → **  (archive root)
 */
async function createArchive(manifest, buildDir) {
  const { dir, archive_name, amxmodx_path } = manifest.output;

  const archiveName = archive_name
    .replace('{name}',    manifest.name)
    .replace('{version}', manifest.version);

  fs.mkdirSync(path.resolve(dir), { recursive: true });
  const archivePath = path.join(path.resolve(dir), archiveName);

  const output  = fs.createWriteStream(archivePath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  const fileList = [];
  archive.on('entry', (entry) => {
    if (!entry.stats || !entry.stats.isDirectory()) fileList.push(entry.name);
  });

  await new Promise((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);

    const amxmodxBuildDir = path.join(buildDir, 'amxmodx');
    if (fs.existsSync(amxmodxBuildDir)) {
      const dest = amxmodx_path.replace(/\/?$/, '/');
      archive.directory(amxmodxBuildDir + path.sep, dest);
    }

    const assetsBuildDir = path.join(buildDir, 'assets');
    if (fs.existsSync(assetsBuildDir)) {
      // false = no prefix, files land at archive root
      archive.directory(assetsBuildDir + path.sep, false);
    }

    archive.finalize();
  });

  const sizeKb = Math.round(fs.statSync(archivePath).size / 1024);
  logger.success(`Archive: ${path.join(dir, archiveName)} (${sizeKb} KB)`);

  printFileListing(fileList, amxmodx_path);
}

function printFileListing(files, amxmodxPath) {
  // Group files by second-level dir under amxmodx_path (e.g. addons/amxmodx/plugins/)
  const grouped = new Map();
  for (const f of files) {
    const parts = f.split('/');
    const key   = parts.length > 1 ? parts.slice(0, parts.length - 1).join('/') : '.';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(f);
  }

  for (const [dir, dirFiles] of grouped) {
    if (dirFiles.length === 1) {
      logger.dim(`  ${dirFiles[0]}`);
    } else {
      logger.dim(`  ${dir}/ (${dirFiles.length} files)`);
    }
  }
}

module.exports = { createArchive };
