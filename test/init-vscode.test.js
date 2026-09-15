'use strict';

/**
 * Tests for `amxb init --vscode` / `--vsc`.
 *
 * The generated .vscode/extensions.json is merged into any existing file:
 * user recommendations are preserved, the amxb ones are only added when missing.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'index.js');

const AMXB_EXTENSIONS = [
  'Faktor.amxx-pawn-all-in',
  'amxx-modular-ecosystem.amxb-vscode',
];

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'amxb-init-vscode-'));
}

function extensionsPath(dir) {
  return path.join(dir, '.vscode', 'extensions.json');
}

function readExtensions(dir) {
  return JSON.parse(fs.readFileSync(extensionsPath(dir), 'utf8'));
}

function runInit(dir, args = []) {
  execFileSync(process.execPath, [CLI, 'init', ...args], {
    cwd: dir,
    stdio: 'pipe',
    env: { ...process.env, GITHUB_ACTIONS: 'true' },
  });
}

test('init --vscode: creates .vscode/extensions.json with the recommendations', () => {
  const dir = makeTmpDir();
  runInit(dir, ['--vscode']);
  assert.deepEqual(readExtensions(dir), { recommendations: AMXB_EXTENSIONS });
});

test('init --vsc: alias behaves like --vscode', () => {
  const dir = makeTmpDir();
  runInit(dir, ['--vsc']);
  assert.deepEqual(readExtensions(dir), { recommendations: AMXB_EXTENSIONS });
});

test('init without --vscode: does not create .vscode/extensions.json', () => {
  const dir = makeTmpDir();
  runInit(dir);
  assert.equal(fs.existsSync(extensionsPath(dir)), false);
});

test('init --vscode: merges into an existing file, preserving user recommendations', () => {
  const dir = makeTmpDir();
  fs.mkdirSync(path.join(dir, '.vscode'));
  fs.writeFileSync(extensionsPath(dir), JSON.stringify({
    recommendations: ['redhat.vscode-yaml'],
    unwantedRecommendations: ['ms-vscode.csharp'],
  }, null, 2));

  runInit(dir, ['--vscode']);

  assert.deepEqual(readExtensions(dir), {
    recommendations: ['redhat.vscode-yaml', ...AMXB_EXTENSIONS],
    unwantedRecommendations: ['ms-vscode.csharp'],
  });
});

test('init --vscode: is idempotent when the recommendations are present', () => {
  const dir = makeTmpDir();
  runInit(dir, ['--vscode']);
  const afterFirst = fs.readFileSync(extensionsPath(dir), 'utf8');

  runInit(dir, ['--vscode']);

  assert.equal(fs.readFileSync(extensionsPath(dir), 'utf8'), afterFirst);
});

test('init --vscode: leaves an invalid JSON file untouched', () => {
  const dir = makeTmpDir();
  fs.mkdirSync(path.join(dir, '.vscode'));
  fs.writeFileSync(extensionsPath(dir), '{ not json');

  runInit(dir, ['--vscode']);

  assert.equal(fs.readFileSync(extensionsPath(dir), 'utf8'), '{ not json');
});
