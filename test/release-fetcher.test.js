'use strict';

/**
 * Unit tests for src/release-fetcher.js downloadAsset — header handling only.
 *
 * Regression for the 415 "Unsupported Media Type" failure on private repos:
 * downloadAsset must NOT clobber a caller-provided Accept header with
 * application/octet-stream, because the GitHub API tarball endpoint
 * (api.github.com/repos/{repo}/tarball/{ref}) rejects octet-stream with 415
 * and requires application/vnd.github+json.
 *
 * Offline + deterministic: axios.get is stubbed; no network traffic.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const axios = require('axios');
const { downloadAsset } = require('../src/release-fetcher');
const { setEnabled } = require('../src/progress');

setEnabled(false); // keep test output clean — no \r progress bars

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'amxb-dl-'));
}

function stubAxiosGet(capture) {
  const orig = axios.get;
  axios.get = async (url, cfg) => {
    capture({ url, cfg });
    return { data: Buffer.from('payload'), headers: { 'content-type': 'application/x-gzip' } };
  };
  return () => { axios.get = orig; };
}

test('downloadAsset: preserves caller-provided Accept header (API tarball fallback)', async (t) => {
  const tmpDir = makeTmpDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const seen = [];
  const restore = stubAxiosGet((s) => seen.push(s));
  t.after(restore);

  await downloadAsset(
    'https://api.github.com/repos/ArKaNeMaN/amxx-CharactersSystem/tarball/1.0.0',
    path.join(tmpDir, 'repo.tar.gz'),
    { Accept: 'application/vnd.github+json', Authorization: 'Bearer test-token' }
  );

  assert.equal(seen.length, 1);
  assert.equal(seen[0].cfg.headers.Accept, 'application/vnd.github+json');
  assert.equal(seen[0].cfg.headers.Authorization, 'Bearer test-token');
});

test('downloadAsset: defaults Accept to octet-stream when caller gives none', async (t) => {
  const tmpDir = makeTmpDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const seen = [];
  const restore = stubAxiosGet((s) => seen.push(s));
  t.after(restore);

  await downloadAsset(
    'https://codeload.github.com/org/repo/tar.gz/v1',
    path.join(tmpDir, 'repo.tar.gz'),
    {}
  );

  assert.equal(seen.length, 1);
  assert.equal(seen[0].cfg.headers.Accept, 'application/octet-stream');
});
