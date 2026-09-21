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

const { fetchRepo, getRepoCacheDir, isCacheValid, refTtlMs, applicableRefTtl } = require('../src/repo-fetcher');
const logger = require('../src/logger');

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

// ─── ref_ttl policy ─────────────────────────────────────────────────────────

function captureWarnings(fn) {
  const warnings = [];
  const origWarn = logger.warn;
  logger.warn = (msg) => warnings.push(msg);
  return fn()
    .then((value) => ({ value, warnings }))
    .finally(() => { logger.warn = origWarn; });
}

test('refTtlMs: explicit ref_ttl wins, tag defaults to forever, branch to 1h', () => {
  const hour = 60 * 60 * 1000;
  assert.equal(refTtlMs(undefined, 'tag'), Infinity);
  assert.equal(refTtlMs(undefined, 'branch'), hour);
  assert.equal(refTtlMs(undefined, undefined), hour);
  assert.equal(refTtlMs(undefined, null), hour);
  assert.equal(refTtlMs('never', 'branch'), Infinity);
  assert.equal(refTtlMs(60000, 'tag'), 60000);
  assert.equal(refTtlMs(60000, undefined), 60000);
});

test('applicableRefTtl: named refs pass through, others warn once and yield undefined', async () => {
  const { warnings } = await captureWarnings(async () => {
    assert.equal(applicableRefTtl('v1.2.3', 'never'), 'never');
    assert.equal(applicableRefTtl('feature/x', 60000), 60000);
    assert.equal(applicableRefTtl('v1', undefined), undefined);
    assert.equal(applicableRefTtl(null, 60000), undefined);
    assert.equal(applicableRefTtl(undefined, 60000), undefined);
    assert.equal(applicableRefTtl('latest', 60000), undefined);
    assert.equal(applicableRefTtl(sha(3), 60000), undefined);
  });

  assert.equal(warnings.length, 4, 'one warning per inapplicable ref with a configured ttl');
  for (const w of warnings) assert.match(w, /ref_ttl does not apply/);
});

test('fetchRepo: ref_ttl on a pinned SHA is ignored with a warning (no network)', async (t) => {
  withCacheDir(t);
  const pinnedSha = sha(4);
  const dir = getRepoCacheDir('org/repo', pinnedSha);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.extracted'), pinnedSha);

  const { value: result, warnings } = await captureWarnings(
    () => fetchRepo('org/repo', pinnedSha, null, false, false, 'never')
  );

  assert.equal(result, dir);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ref_ttl does not apply/);
});

// ─── URL path-traversal guard (no network) ───────────────────────────────────

test('fetchRepo: unsafe ref path segments are rejected before any network call', async (t) => {
  const cacheRoot = withCacheDir(t);

  await assert.rejects(
    fetchRepo('org/repo', '../../../tarball/main', null, false),
    /Unsafe ref "\.\.\/\.\.\/\.\.\/tarball\/main" — refs must not contain empty, "\." or "\.\." path segments/
  );
  await assert.rejects(fetchRepo('org/repo', 'feature//x', null, false), /Unsafe ref/);
  await assert.rejects(fetchRepo('org/repo', 'a/./b', null, false), /Unsafe ref/);

  // Rejected before resolution: nothing was fetched into the cache root.
  assert.deepEqual(fs.readdirSync(cacheRoot), []);
});

test('fetchRepo: invalid repo string is rejected before any network call', async (t) => {
  withCacheDir(t);

  await assert.rejects(
    fetchRepo('just-a-name', 'main', null, false),
    /Invalid repo "just-a-name" — expected "owner\/repo"/
  );
  await assert.rejects(
    fetchRepo('a/../b', 'main', null, false),
    /Invalid repo "a\/\.\.\/b" — expected "owner\/repo"/
  );
});
