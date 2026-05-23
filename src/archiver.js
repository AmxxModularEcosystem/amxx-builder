const fs      = require('fs');
const path    = require('path');
const archiver = require('archiver');
const logger  = require('./logger');

/**
 * Creates the output .zip archive from the build directory,
 * mapping build subdirs to the layout paths defined in manifest.output.layout.
 */
async function createArchive(manifest, buildDir) {
  const { dir, archive_name, layout } = manifest.output;

  const archiveName = archive_name
    .replace('{name}',    manifest.name)
    .replace('{version}', manifest.version);

  fs.mkdirSync(path.resolve(dir), { recursive: true });
  const archivePath = path.join(path.resolve(dir), archiveName);

  // Build layout mapping: buildSubdir → archivePath
  const mappings = [
    { build: path.join(buildDir, 'plugins'),   archive: normalizeDir(layout.plugins) },
    { build: path.join(buildDir, 'configs'),   archive: normalizeDir(layout.configs) },
    { build: path.join(buildDir, 'lang'),      archive: normalizeDir(layout.lang) },
    { build: path.join(buildDir, '_includes'), archive: normalizeDir(layout.includes) },
  ];

  const output  = fs.createWriteStream(archivePath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  const fileList = [];
  let totalSize  = 0;

  archive.on('entry', (entry) => {
    if (!entry.stats.isDirectory()) {
      fileList.push(entry.name);
      totalSize += entry.stats.size || 0;
    }
  });

  await new Promise((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);

    for (const { build, archive: archiveDir } of mappings) {
      if (fs.existsSync(build)) {
        archive.directory(build + path.sep, archiveDir);
      }
    }

    // Copy any README-*.md files from build root
    const readmes = fs.readdirSync(buildDir).filter((f) => f.match(/^README.*\.md$/i));
    for (const readme of readmes) {
      archive.file(path.join(buildDir, readme), { name: readme });
    }

    archive.finalize();
  });

  const sizeKb = Math.round(totalSize / 1024);
  logger.success(`Archive: ${path.join(dir, archiveName)} (${sizeKb} KB)`);

  // Print file listing grouped by top-level dir
  const grouped = groupByTopDir(fileList);
  for (const [dir2, files] of Object.entries(grouped)) {
    if (files.length === 1) {
      logger.dim(`  ${files[0]}`);
    } else {
      logger.dim(`  ${dir2}/ (${files.length} files)`);
    }
  }
}

function normalizeDir(p) {
  return p.replace(/\\/g, '/').replace(/\/?$/, '/');
}

function groupByTopDir(files) {
  const map = {};
  for (const f of files) {
    const parts = f.split('/');
    // Use first 3 path components as the group key
    const key = parts.slice(0, 3).join('/');
    if (!map[key]) map[key] = [];
    map[key].push(f);
  }
  return map;
}

module.exports = { createArchive };
