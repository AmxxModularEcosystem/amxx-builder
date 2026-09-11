'use strict';

/**
 * Tests for the `amxb init` manifest overwrite policy.
 *
 * The generated amxbuild.yml is exempt from a bare --force: an existing
 * manifest is only replaced when --with-manifest is passed as well.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI      = path.join(__dirname, '..', 'index.js');
const SENTINEL = 'name: Sentinel\n';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'amxb-init-'));
}

function manifestPath(dir) {
  return path.join(dir, 'amxbuild.yml');
}

function runInit(dir, args = []) {
  execFileSync(process.execPath, [CLI, 'init', ...args], {
    cwd: dir,
    stdio: 'pipe',
    env: { ...process.env, GITHUB_ACTIONS: 'true' },
  });
}

test('init: creates the manifest in a fresh directory', () => {
  const dir = makeTmpDir();
  runInit(dir);
  assert.match(fs.readFileSync(manifestPath(dir), 'utf8'), /^name: /m);
});

test('init: skips an existing manifest', () => {
  const dir = makeTmpDir();
  fs.writeFileSync(manifestPath(dir), SENTINEL);
  runInit(dir);
  assert.equal(fs.readFileSync(manifestPath(dir), 'utf8'), SENTINEL);
});

test('init --with-manifest alone: still skips an existing manifest', () => {
  const dir = makeTmpDir();
  fs.writeFileSync(manifestPath(dir), SENTINEL);
  runInit(dir, ['--with-manifest']);
  assert.equal(fs.readFileSync(manifestPath(dir), 'utf8'), SENTINEL);
});

test('init --force: keeps an existing manifest (needs --with-manifest)', () => {
  const dir = makeTmpDir();
  fs.writeFileSync(manifestPath(dir), SENTINEL);
  runInit(dir, ['--force']);
  assert.equal(fs.readFileSync(manifestPath(dir), 'utf8'), SENTINEL);
});

test('init --force --with-manifest: overwrites an existing manifest', () => {
  const dir = makeTmpDir();
  fs.writeFileSync(manifestPath(dir), SENTINEL);
  runInit(dir, ['--force', '--with-manifest']);
  const content = fs.readFileSync(manifestPath(dir), 'utf8');
  assert.notEqual(content, SENTINEL);
  assert.match(content, /^name: /m);
});
