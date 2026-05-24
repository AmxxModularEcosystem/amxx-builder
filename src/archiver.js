const fs      = require('fs');
const path    = require('path');
const archiver = require('archiver');
const logger  = require('./logger');

/**
 * Creates the output .zip.
 *
 * {name} and {version} are expanded in amxmodx_path and assets_path.
 *
 *   build/amxmodx/**  → <amxmodx_path>/**   e.g. "addons/amxmodx" or "{name}/addons/amxmodx"
 *   build/assets/**   → <assets_path>/**     e.g. "" (root) or "{name}"
 *   README.md         → <assets_path>/       if output.readme = true
 */
async function createArchive(manifest, buildDir) {
  const out = manifest.output;

  const expand = (tpl) => tpl
    .replace('{name}',    manifest.name)
    .replace('{version}', manifest.version);

  const archiveName  = expand(out.archive_name);
  const amxmodxDest  = expand(out.amxmodx_path).replace(/\/?$/, '/');
  const assetsDest   = expand(out.assets_path);  // '' = root

  fs.mkdirSync(path.resolve(out.dir), { recursive: true });
  const archivePath = path.join(path.resolve(out.dir), archiveName);

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

    // amxmodx content
    const amxmodxBuildDir = path.join(buildDir, 'amxmodx');
    if (fs.existsSync(amxmodxBuildDir)) {
      archive.directory(amxmodxBuildDir + path.sep, amxmodxDest);
    }

    // assets — false means archive root, otherwise the given prefix
    const assetsBuildDir = path.join(buildDir, 'assets');
    if (fs.existsSync(assetsBuildDir)) {
      archive.directory(assetsBuildDir + path.sep, assetsDest || false);
    }

    // README.md next to manifest
    if (out.readme) {
      const readmeSrc = path.join(path.dirname(manifest._path), 'README.md');
      if (fs.existsSync(readmeSrc)) {
        archive.file(readmeSrc, { name: 'README.md' });
      } else {
        logger.warn('readme: true but README.md not found next to manifest');
      }
    }

    archive.finalize();
  });

  const sizeKb = Math.round(fs.statSync(archivePath).size / 1024);
  logger.success(`Archive: ${path.join(out.dir, archiveName)} (${sizeKb} KB)`);
  printFileListing(fileList);
}

function printFileListing(files) {
  const grouped = new Map();
  for (const f of files) {
    const parts = f.split('/');
    const key   = parts.length > 1 ? parts.slice(0, parts.length - 1).join('/') : '.';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(f);
  }
  for (const [dir, dirFiles] of grouped) {
    if (dirFiles.length === 1) logger.dim(`  ${dirFiles[0]}`);
    else                       logger.dim(`  ${dir}/ (${dirFiles.length} files)`);
  }
}

/**
 * Same layout as createArchive but copies files to output.dir instead of zipping.
 * Used when output.pack = false (e.g. in CI to avoid artifact double-wrapping).
 */
function copyOutput(manifest, buildDir) {
  const out    = manifest.output;
  const expand = (tpl) => tpl
    .replace('{name}',    manifest.name)
    .replace('{version}', manifest.version);

  const outDir     = path.resolve(out.dir);
  const amxmodxDst = path.join(outDir, expand(out.amxmodx_path));
  const assetsDst  = out.assets_path
    ? path.join(outDir, expand(out.assets_path))
    : outDir;

  const amxmodxSrc = path.join(buildDir, 'amxmodx');
  if (fs.existsSync(amxmodxSrc)) copyDirSync(amxmodxSrc, amxmodxDst);

  const assetsSrc = path.join(buildDir, 'assets');
  if (fs.existsSync(assetsSrc)) copyDirSync(assetsSrc, assetsDst);

  if (out.readme) {
    const readmeSrc = path.join(path.dirname(manifest._path), 'README.md');
    if (fs.existsSync(readmeSrc)) {
      fs.copyFileSync(readmeSrc, path.join(outDir, 'README.md'));
    } else {
      logger.warn('readme: true but README.md not found next to manifest');
    }
  }

  logger.success(`Output dir: ${out.dir}`);
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src,  entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

module.exports = { createArchive, copyOutput };
