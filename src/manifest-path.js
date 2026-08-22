'use strict';

const fs   = require('fs');
const path = require('path');

const MANIFEST_CANDIDATES = ['amxbuild.yml', 'amxbuild.yaml', 'manifest.yml'];

/**
 * Resolve the manifest file path from an explicit arg or auto-detection.
 *
 * Single-source-of-truth for manifest discovery. Returns ABSOLUTE paths.
 * No warnings are emitted here — deprecation/fallback rendering is the job of
 * the calling interface (CLI renders the manifest.yml deprecation warning).
 *
 * @param {string} [explicit] - Explicit manifest path (may not exist yet —
 *   parseManifest will report it).
 * @returns {{ path: string, usedDefault: boolean }}
 *   usedDefault: true when a fallback was chosen — either the deprecated
 *   manifest.yml, or the amxbuild.yml default when nothing was found.
 */
function resolveManifestPath(explicit) {
  if (explicit) return { path: path.resolve(explicit), usedDefault: false };

  const cwd = process.cwd();
  for (const name of MANIFEST_CANDIDATES) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) {
      return { path: p, usedDefault: name === 'manifest.yml' };
    }
  }
  return { path: path.join(cwd, 'amxbuild.yml'), usedDefault: true };
}

module.exports = { resolveManifestPath };
