'use strict';

/**
 * Tests for `amxb init --gitignore`.
 *
 * The generated .gitignore is rendered from templates/init-gitignore — the same
 * template the amxb-migration skill reuses as its step 6 basis — so the file is
 * asserted byte-for-byte against the template, plus a few entry spot-checks to
 * catch an entry being dropped from the template itself.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI          = path.join(__dirname, '..', 'index.js');
const TEMPLATE     = fs.readFileSync(path.join(__dirname, '..', 'templates', 'init-gitignore'), 'utf8');
const SENTINEL     = '# my own rules\n';
const REQUIRED     = ['*.amxx', '*.zip', 'build/', 'dist/', 'plugins-*.ini', '.build',
                      '.env', '.env.local', '.amxb-cache/', '.omo/', '.codegraph/',
                      '.vscode/*', '!.vscode/extensions.json', '.claude/', 'node_modules/'];

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'amxb-init-gitignore-'));
}

function gitignorePath(dir) {
  return path.join(dir, '.gitignore');
}

function runInit(dir, args = []) {
  execFileSync(process.execPath, [CLI, 'init', ...args], {
    cwd: dir,
    stdio: 'pipe',
    env: { ...process.env, GITHUB_ACTIONS: 'true' },
  });
}

test('init --gitignore: creates .gitignore from the template', () => {
  const dir = makeTmpDir();
  runInit(dir, ['--gitignore']);
  assert.equal(fs.readFileSync(gitignorePath(dir), 'utf8'), TEMPLATE);
});

test('init --gitignore: template covers every expected entry', () => {
  for (const entry of REQUIRED) {
    assert.equal(TEMPLATE.split('\n').includes(entry), true, `missing entry: ${entry}`);
  }
});

test('init --gitignore: template has no unrendered placeholders', () => {
  assert.doesNotMatch(TEMPLATE, /\{\{\w+\}\}/);
});

test('init without --gitignore: does not create .gitignore', () => {
  const dir = makeTmpDir();
  runInit(dir);
  assert.equal(fs.existsSync(gitignorePath(dir)), false);
});

test('init --gitignore: keeps an existing .gitignore (needs --force)', () => {
  const dir = makeTmpDir();
  fs.writeFileSync(gitignorePath(dir), SENTINEL);
  runInit(dir, ['--gitignore']);
  assert.equal(fs.readFileSync(gitignorePath(dir), 'utf8'), SENTINEL);
});

test('init --gitignore --force: overwrites an existing .gitignore', () => {
  const dir = makeTmpDir();
  fs.writeFileSync(gitignorePath(dir), SENTINEL);
  runInit(dir, ['--gitignore', '--force']);
  assert.equal(fs.readFileSync(gitignorePath(dir), 'utf8'), TEMPLATE);
});
