'use strict';

// Smoke-test for the bundled GitHub Action (dist/index.js).
// Verifies that @actions/core (ESM-only since 3.x, transpiled to CJS by esbuild)
// works inside the bundle: getInput reads INPUT_* env vars and setOutput writes
// the `name` output to GITHUB_OUTPUT.
//
// The test generates a minimal manifest (no repos/deps/.sma) in a temp dir, runs
// the bundle as a child process and asserts on the GITHUB_OUTPUT file — not on
// the build exit code, because setOutput('name') fires in action-entry.js BEFORE
// index.js runs the build, so the output file is written regardless of how the
// build itself ends (e.g. it may fail on the compiler fetch with --no-fetch).
//
// Usage: node scripts/smoke-test.js   (run after `npm run bundle`)

const path    = require('path');
const os      = require('os');
const fs      = require('fs');
const { spawnSync } = require('child_process');

const distEntry = path.join(__dirname, '..', 'dist', 'index.js');
if (!fs.existsSync(distEntry)) {
  console.error(`dist/index.js not found at ${distEntry}`);
  console.error('Run `npm run bundle` first.');
  process.exit(1);
}

const tmp       = fs.mkdtempSync(path.join(os.tmpdir(), 'amxb-smoke-'));
const outFile   = path.join(tmp, 'output.txt');
const buildDir  = path.join(tmp, 'build');
const manifestPath = path.join(tmp, 'amxbuild.smoke.yml');

fs.writeFileSync(manifestPath, [
  'name: SmokeTest',
  'version: "1.0.0"',
  'amxmodx:',
  '  version: "1.10.5428"',
  '',
].join('\n'));
fs.writeFileSync(outFile, ''); // runner pre-creates GITHUB_OUTPUT

const env = {
  ...process.env,
  GITHUB_OUTPUT: outFile,
  INPUT_MANIFEST: manifestPath,
  INPUT_BUILD_DIR: buildDir,
  'INPUT_NO-FETCH': 'true',
  'INPUT_NO-ARCHIVE': 'true',
};

const res = spawnSync(process.execPath, [distEntry], { env, encoding: 'utf8', timeout: 120000 });
if (res.error) throw res.error;

const out = fs.readFileSync(outFile, 'utf8');
if (!/^name<<ghadelimiter_/m.test(out)) {
  console.error('FAIL: name output not written to GITHUB_OUTPUT');
  console.error('--- GITHUB_OUTPUT ---\n' + out);
  console.error('--- build stdout tail ---\n' + String(res.stdout).split('\n').slice(-10).join('\n'));
  console.error('--- build stderr tail ---\n' + String(res.stderr).split('\n').slice(-10).join('\n'));
  process.exit(1);
}
console.log('OK: name output written to GITHUB_OUTPUT');
