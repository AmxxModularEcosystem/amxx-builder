'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const logger = require('./logger');

const fileHashes = new Map();

function contentChanged(filePath) {
  let data;
  try { data = fs.readFileSync(filePath); } catch { return false; }
  const hash = crypto.createHash('sha1').update(data).digest('hex');
  if (fileHashes.get(filePath) === hash) return false;
  fileHashes.set(filePath, hash);
  return true;
}

/**
 * Starts watching local project files for changes.
 *
 * Uses chokidar's awaitWriteFinish as the debounce mechanism —
 * a file is only reported stable after it hasn't changed for debounceMs.
 * This handles VSCode auto-save correctly: rapid saves are coalesced.
 *
 * Watch targets:
 *   - amxmodx/scripting/**‌/*.sma  → onSmaChange(absPath)
 *   - amxmodx/**  (non-.sma)      → onFileChange(relPath, 'amxmodx')
 *   - assets/**                   → onFileChange(relPath, 'assets')
 *   - amxbuild.yml / amxbuild.yaml → onManifestChange()
 *
 * Returns the chokidar watcher instance.
 */
function startWatch(manifest, manifestPath, handlers) {
  const chokidar = require('chokidar');

  const debounceMs  = manifest.deploy.watch_debounce_ms;
  const manifestDir = path.dirname(path.resolve(manifestPath));

  const localAmxmodxDir = path.join(manifestDir, manifest.amxmodx.dir);
  const localAssetsDir  = path.join(manifestDir, 'assets');

  const watchPaths = [path.resolve(manifestPath)];
  if (fs.existsSync(localAmxmodxDir)) watchPaths.push(localAmxmodxDir);
  if (fs.existsSync(localAssetsDir))  watchPaths.push(localAssetsDir);

  logger.info('Watching for changes (Ctrl+C to stop)...');
  for (const p of watchPaths) logger.dim(`  ${p}`);

  const watcher = chokidar.watch(watchPaths, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: debounceMs,
      pollInterval: 100,
    },
  });

  watcher.on('all', (event, filePath) => {
    if (!['add', 'change'].includes(event)) return;

    const absPath = path.resolve(filePath);
    if (!contentChanged(absPath)) return;

    const rel = path.relative(manifestDir, absPath);

    // Manifest changed → full rebuild
    if (absPath === path.resolve(manifestPath)) {
      logger.step(`Manifest changed → full rebuild`);
      handlers.onManifestChange();
      return;
    }

    // .sma → recompile single plugin
    if (filePath.endsWith('.sma')) {
      logger.step(`Changed: ${rel}`);
      handlers.onSmaChange(absPath);
      return;
    }

    // .inc → recompile affected plugins
    if (filePath.endsWith('.inc')) {
      logger.step(`Include changed: ${rel}`);
      handlers.onIncChange(absPath);
      return;
    }

    // Other file in amxmodx/ or assets/
    const inAmxmodx = absPath.startsWith(localAmxmodxDir + path.sep) || absPath === localAmxmodxDir;
    const section   = inAmxmodx ? 'amxmodx' : 'assets';
    const baseDir   = inAmxmodx ? localAmxmodxDir : localAssetsDir;
    const relToBase = path.relative(baseDir, absPath);

    logger.step(`Changed: ${rel}`);
    handlers.onFileChange(relToBase, section);
  });

  watcher.on('error', (err) => logger.warn(`Watcher error: ${err.message}`));

  return watcher;
}

module.exports = { startWatch };
