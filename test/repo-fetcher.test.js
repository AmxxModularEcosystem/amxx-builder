'use strict';

/**
 * Unit tests for src/repo-fetcher.js — the no-network paths: isCacheValid
 * and fetchRepo cache hits / --no-fetch rejection.
 *
 * Since the clone cache is keyed on the resolved commit SHA for moving refs
 * (branch/null/tag), a pre-seeded cache hit for such a ref needs a matching
 * .ref-heads.json resolution entry; pinned SHA refs skip resolution and hit
 * the cache purely on the ref.
 *
 * Offline + deterministic: no network, no git clones, no tarball downloads.
 * AMXX_BUILDER_CACHE points at a fresh temp dir per test (cache-dir.js reads
 * the env var on every call, so setting it after require is fine).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { fetchRepo, getRepoCacheDir, isCacheValid } = require('../src/repo-fetcher');

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withCacheDir(t) {
  const dir = makeTmpDir('amxb-rf-cache-');
  const prev = process.env.AMXX_BUILDER_CACHE;
  process.env.AMXX_BUILDER_CACHE = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.AMXX_BUILDER_CACHE;
    else process.env.AMXX_BUILDER_CACHE = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function sha(n) {
  return n.toString(16).padStart(40, '0');
}

// Seed a fresh .ref-heads.json resolution entry (same key layout as the core).
function writeRefHead(cacheRoot, repo, ref, shaValue) {
  const file = path.join(cacheRoot, '.ref-heads.json');
  let index = {};
  try { index = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  index[`${repo.toLowerCase()}@${ref || 'HEAD'}`] = { sha: shaValue, at: Date.now() };
  fs.writeFileSync(file, JSON.stringify(index));
}

// ─── isCacheValid (non-git) ─────────────────────────────────────────────────

test('isCacheValid: sentinel .extracted → true', async (t) => {
  withCacheDir(t);
  const dir = getRepoCacheDir('org/repo', 'v1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.extracted'), 'v1');

  assert.equal(await isCacheValid(dir, 'v1'), true);
});

test('isCacheValid: legacy .git dir → true (old clones stay valid)', async (t) => {
  withCacheDir(t);
  const dir = getRepoCacheDir('org/repo', 'v1');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });

  assert.equal(await isCacheValid(dir, 'v1'), true);
});

test('isCacheValid: empty dir → false', async (t) => {
  withCacheDir(t);
  const dir = getRepoCacheDir('org/repo', 'v1');
  fs.mkdirSync(dir, { recursive: true });

  assert.equal(await isCacheValid(dir, 'v1'), false);
});

// ─── fetchRepo cache / noFetch (no network) ─────────────────────────────────

test('fetchRepo: pinned SHA pre-seeded cache returns cacheDir without network', async (t) => {
  const cacheRoot = withCacheDir(t);
  const pinnedSha = sha(1);
  const dir = getRepoCacheDir('org/repo', pinnedSha);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.extracted'), pinnedSha);

  const result = await fetchRepo('org/repo', pinnedSha, null, false);

  assert.equal(result, dir);
  // Cache untouched — the sentinel is still the only marker, no .tmp dirs
  // were created (i.e. no fetch attempt happened). SHA refs skip resolution,
  // so no .ref-heads.json is written either.
  assert.equal(fs.existsSync(path.join(dir, '.extracted')), true);
  assert.deepEqual(fs.readdirSync(cacheRoot), ['repos']);
});

test('fetchRepo: moving ref pre-seeded cache (resolved SHA dir) returns it without network', async (t) => {
  const cacheRoot = withCacheDir(t);
  const headSha = sha(2);
  writeRefHead(cacheRoot, 'org/repo', 'v1', headSha);
  const dir = getRepoCacheDir('org/repo', headSha);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.extracted'), headSha);

  const result = await fetchRepo('org/repo', 'v1', null, false);

  assert.equal(result, dir);
  // A fresh resolution entry short-circuits before any network call; the only
  // cache-root artifact besides repos/ is the seeded index itself.
  assert.equal(fs.existsSync(path.join(dir, '.extracted')), true);
  assert.deepEqual(fs.readdirSync(cacheRoot).sort(), ['.ref-heads.json', 'repos']);
});

test('fetchRepo: noFetch with missing cache rejects with --no-fetch hint', async (t) => {
  withCacheDir(t);

  await assert.rejects(
    fetchRepo('org/repo', 'v1', null, true),
    /--no-fetch/
  );
});
