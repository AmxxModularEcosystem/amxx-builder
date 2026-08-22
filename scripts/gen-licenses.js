'use strict';

// Generates dist/licenses.txt from the installed dependency tree.
// Replaces the --license flag of @vercel/ncc, which was removed together
// with the migration to esbuild. Output format is compatible with the old
// ncc artifact: for each package a block of <name>\n<license>\n<license text>\n\n
//
// Usage: node scripts/gen-licenses.js [outputPath]
// Default output path: dist/licenses.txt

const fs   = require('fs');
const path = require('path');

const rootDir   = path.resolve(__dirname, '..');
const lockPath  = path.join(rootDir, 'package-lock.json');
const outPath   = path.resolve(process.argv[2] || path.join(rootDir, 'dist', 'licenses.txt'));

const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
if (lock.lockfileVersion !== 3) {
  throw new Error(`Unexpected lockfileVersion ${lock.lockfileVersion}; expected 3`);
}

// package-lock.json v3 keys are the node_modules paths, e.g.
//   "node_modules/@actions/core"            (top-level)
//   "node_modules/foo/node_modules/bar"     (nested)
// Only production packages are shipped inside the dist bundle, so dev deps ("dev": true) are excluded.
const packages = Object.keys(lock.packages)
  .filter(key => key !== '' && key.startsWith('node_modules/'))
  .filter(key => !lock.packages[key].dev)
  .sort();

const blocks = [];

for (const relPath of packages) {
  const pkgDir = path.join(rootDir, relPath);
  let pkgJson;
  try {
    pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  } catch (err) {
    // Optional deps for other platforms (e.g. fsevents on Linux) are not
    // installed and never end up in the bundle — skip them silently.
    if (lock.packages[relPath].optional) continue;
    process.stderr.write(`gen-licenses: skipping ${relPath} (${err.code})\n`);
    continue;
  }

  const name    = pkgJson.name || relPath.split('/').pop();
  const version = pkgJson.version || 'unknown';
  const license = Array.isArray(pkgJson.license)
    ? pkgJson.license.map(l => (l.type || l)).join(' OR ')
    : (pkgJson.license || 'UNKNOWN');

  const header = `${name}@${version}\n${license}\n`;

  // Prefer a LICENSE/LICENCE/COPYING file in the package dir.
  let text = '';
  const licenseFiles = fs.readdirSync(pkgDir)
    .filter(f => /^(LICENSE|LICENCE|COPYING|NOTICE)/i.test(f))
    .sort();
  for (const f of licenseFiles) {
    text += fs.readFileSync(path.join(pkgDir, f), 'utf8').trim() + '\n\n';
  }
  if (!text) {
    text = `(no license file found in ${relPath})\n`;
  }

  blocks.push(header + text.trim() + '\n');
}

const out = blocks.join('\n');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, out, 'utf8');
process.stdout.write(`gen-licenses: wrote ${blocks.length} packages to ${outPath}\n`);
