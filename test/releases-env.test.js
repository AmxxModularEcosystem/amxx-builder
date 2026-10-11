'use strict';

/**
 * Regression test for the `amxb releases` .env policy (phase A, A5).
 *
 * `src/commands/releases.js` loads the manifest-dir `.env` with
 * `override:false`, so the operator's shell environment wins over a project
 * `.env` file. This test pins that exact call shape (offline, deterministic).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveManifestPath } = require('../src/manifest-path');
const { loadEnv } = require('../src/env');

test('releases env: manifest-dir .env with override:false — shell env wins, .env used when shell unset', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amxb-releases-env-'));
  fs.writeFileSync(path.join(tmp, '.env'), 'GITHUB_TOKEN=file-token\n');
  fs.writeFileSync(path.join(tmp, 'amxbuild.yml'), 'name: releases-env-fixture\n');

  const origCwd = process.cwd();
  const origToken = process.env.GITHUB_TOKEN;
  process.chdir(tmp);
  t.after(() => {
    process.chdir(origCwd);
    if (origToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = origToken;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // Shell env wins over the project .env.
  process.env.GITHUB_TOKEN = 'shell-token';
  loadEnv(resolveManifestPath().path, { override: false });
  assert.equal(process.env.GITHUB_TOKEN, 'shell-token');

  // With the shell var unset, the manifest-dir .env value is used.
  delete process.env.GITHUB_TOKEN;
  loadEnv(resolveManifestPath().path, { override: false });
  assert.equal(process.env.GITHUB_TOKEN, 'file-token');
});
