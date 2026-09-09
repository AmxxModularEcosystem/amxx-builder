'use strict';

/**
 * Tests for the moving-ref cache semantics of src/repo-fetcher.js:
 * a default-branch / branch / tag ref resolves to a commit SHA (cached 1h in
 * .ref-heads.json) and the clone cache is keyed on that SHA, so a branch that
 * moved upstream downloads into a fresh dir while the old dir stays put, a
 * TTL-expired resolution that returns the same SHA reuses the existing dir
 * without re-downloading, and --no-fetch / offline runs fall back to the
 * last-known head instead of failing.
 *
 * The ssh=true path is not covered: cloneViaGit drives the real `git` binary
 * over SSH and cannot be exercised without a live git host; its only new
 * behavior — receiving the resolved SHA instead of the branch name — routes to
 * the existing SHA fetch+checkout branch, which is unchanged. The API-shape
 * side of that routing (a 40-hex ref must not reach `--branch`) is enforced by
 * fetchRepo resolving moving refs to full SHAs, asserted throughout.
 *
 * Offline + deterministic: axios.get is stubbed (GitHub API JSON + codeload
 * tar.gz bytes); no network traffic.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { Readable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const zlib = require('node:zlib');

const axios = require('axios');
const { fetchRepo, getRepoCacheDir } = require('../src/repo-fetcher');
const { setEnabled } = require('../src/progress');

setEnabled(false); // keep test output clean — no \r progress bars

const ORIG_CACHE_ENV = process.env.AMXX_BUILDER_CACHE;

// Extraction goes through the real `tar` binary (src/fs-utils.js) — skip the
// download-heavy tests on hosts without it.
const HAS_TAR = (() => {
  try { return spawnSync('tar', ['--version'], { stdio: 'ignore' }).status === 0; }
  catch { return false; }
})();

// ─── helpers ────────────────────────────────────────────────────────────────

function sha(n) {
  return n.toString(16).padStart(40, '0');
}

function useTempCache(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amxb-rc-cache-'));
  process.env.AMXX_BUILDER_CACHE = dir;
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (ORIG_CACHE_ENV === undefined) delete process.env.AMXX_BUILDER_CACHE;
    else process.env.AMXX_BUILDER_CACHE = ORIG_CACHE_ENV;
  });
  return dir;
}

function readRefHeads(cacheRoot) {
  try { return JSON.parse(fs.readFileSync(path.join(cacheRoot, '.ref-heads.json'), 'utf8')); }
  catch { return {}; }
}

function writeRefHeads(cacheRoot, repo, ref, entry) {
  const file = path.join(cacheRoot, '.ref-heads.json');
  let index = {};
  try { index = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  index[`${repo.toLowerCase()}@${ref || 'HEAD'}`] = entry;
  fs.writeFileSync(file, JSON.stringify(index));
}

function seedCloneDir(repo, refSha, content) {
  const dir = getRepoCacheDir(repo, refSha);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.extracted'), refSha);
  if (content !== undefined) fs.writeFileSync(path.join(dir, 'hello.txt'), content);
  return dir;
}

// ─── tar fixture (hand-built, ~40 lines) ────────────────────────────────────

function tarHeader(name, size) {
  const buf = Buffer.alloc(512);
  buf.write(name, 0, 100, 'utf8');
  buf.write('0000644\0', 100, 'utf8');
  buf.write('0000000\0', 108, 'utf8');
  buf.write('0000000\0', 116, 'utf8');
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
  buf.write('00000000000\0', 136, 12, 'utf8');
  buf.write('        ', 148, 8, 'utf8'); // checksum placeholder: 8 spaces
  buf.write('0', 156, 1, 'utf8');        // typeflag: regular file
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
  return buf;
}

// Build a single-file tar.gz whose top-level dir (like a GitHub tarball) is
// stripped by fetchTarball's --strip-components=1.
function tarGz(topDir, relName, content) {
  const data = Buffer.from(content, 'utf8');
  const blocks = [
    tarHeader(`${topDir}/${relName}`, data.length),
    data,
    data.length % 512 ? Buffer.alloc(512 - (data.length % 512)) : Buffer.alloc(0),
    Buffer.alloc(1024), // end-of-archive marker
  ];
  return zlib.gzipSync(Buffer.concat(blocks));
}

function stubStream(buf) {
  const s = new Readable();
  s.push(buf);
  s.push(null);
  return s;
}

// Routes axios.get by URL against a per-test state object. Each URL family:
//   api.github.com/repos/{repo}               → { default_branch } (or failApi)
//   api.github.com/repos/{repo}/commits/{ref} → { sha } (or failApi)
//   codeload.github.com/{repo}/tar.gz/{ref}   → tar.gz stream from state.tarballs
function installFake(t, state) {
  const calls = [];
  const orig = axios.get;
  axios.get = async (url, cfg) => {
    calls.push({ url, cfg });
    let m;
    m = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)$/);
    if (m) {
      if (state.failApi) throw makeAxiosError('Request failed with status code ' + state.failApi, state.failApi);
      return { data: { default_branch: state.defaultBranch }, headers: {} };
    }
    m = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/commits\/(.+)$/);
    if (m) {
      if (state.failApi) throw makeAxiosError('Request failed with status code ' + state.failApi, state.failApi);
      const ref = m[2];
      if (!(ref in state.commits)) throw makeAxiosError('Request failed with status code 404', 404);
      return { data: { sha: state.commits[ref] }, headers: {} };
    }
    m = url.match(/^https:\/\/codeload\.github\.com\/([^/]+\/[^/]+)\/tar\.gz\/(.+)$/);
    if (m) {
      const buf = state.tarballs[m[2]];
      if (!buf) throw new Error('no tarball for ' + m[2]);
      return {
        data: stubStream(buf),
        headers: { 'content-type': 'application/x-gzip', 'content-length': String(buf.length) },
      };
    }
    throw new Error('unmocked URL: ' + url);
  };
  t.after(() => { axios.get = orig; });
  return calls;
}

function makeAxiosError(message, status = 500) {
  const err = new Error(message);
  err.response = { status, data: {} };
  return err;
}

function makeState() {
  return { defaultBranch: 'main', commits: {}, tarballs: {}, failApi: null };
}

const apiCalls = (calls) => calls.filter((c) => c.url.startsWith('https://api.github.com/'));
const dlCalls  = (calls) => calls.filter((c) => c.url.startsWith('https://codeload.github.com/'));

// ─── (a) default branch: resolve once, download by SHA, cache hits are free ─

test('default-branch (null ref): resolves default branch + SHA, second build does zero HTTP', async (t) => {
  if (!HAS_TAR) return t.skip('tar binary not available');
  const cacheRoot = useTempCache(t);
  const state = makeState();
  const calls = installFake(t, state);

  const repoA = 'org/alpha';
  const shaA  = sha(1);
  state.commits.main = shaA;
  state.tarballs[shaA] = tarGz('alpha-' + shaA, 'hello.txt', 'v1 default branch');

  const first = await fetchRepo(repoA, null, 'tok-secret', false);

  assert.equal(first, getRepoCacheDir(repoA, shaA), 'clone cached under the resolved SHA');
  assert.equal(fs.readFileSync(path.join(first, '.extracted'), 'utf8'), shaA, 'sentinel records the SHA');
  assert.equal(fs.readFileSync(path.join(first, 'hello.txt'), 'utf8'), 'v1 default branch');

  // First build: repo metadata (default branch) + commits/main + one download.
  assert.deepEqual(apiCalls(calls).map((c) => c.url), [
    'https://api.github.com/repos/org/alpha',
    'https://api.github.com/repos/org/alpha/commits/main',
  ]);
  assert.deepEqual(dlCalls(calls).map((c) => c.url), [
    'https://codeload.github.com/org/alpha/tar.gz/' + shaA,
  ]);
  // The resolution API calls carry the per-repo token.
  for (const c of apiCalls(calls)) assert.equal(c.cfg.headers.Authorization, 'Bearer tok-secret');

  // Second build: fresh resolution entry → no HTTP at all, same dir.
  calls.length = 0;
  const second = await fetchRepo(repoA, null, 'tok-secret', false);
  assert.equal(second, first);
  assert.equal(calls.length, 0);

  const entry = readRefHeads(cacheRoot)[`org/alpha@HEAD`];
  assert.equal(entry.sha, shaA);
  assert.equal(entry.branch, 'main', 'default branch name cached to skip the meta call next refresh');
});

// ─── (b) branch moves upstream after TTL expiry ─────────────────────────────

test('branch moved upstream: new SHA downloads into a new dir, old dir untouched', async (t) => {
  if (!HAS_TAR) return t.skip('tar binary not available');
  const cacheRoot = useTempCache(t);
  const state = makeState();
  const calls = installFake(t, state);

  const repoB = 'org/beta';
  const shaB1 = sha(2);
  const shaB2 = sha(3);
  state.commits.dev = shaB1;
  state.tarballs[shaB1] = tarGz('beta-' + shaB1, 'hello.txt', 'old head');
  state.tarballs[shaB2] = tarGz('beta-' + shaB2, 'hello.txt', 'new head');

  const dir1 = await fetchRepo(repoB, 'dev', null, false);
  assert.equal(dir1, getRepoCacheDir(repoB, shaB1));
  assert.equal(fs.readFileSync(path.join(dir1, 'hello.txt'), 'utf8'), 'old head');

  // Age the resolution entry past its 1h TTL, then move the branch upstream.
  writeRefHeads(cacheRoot, repoB, 'dev', { sha: shaB1, at: Date.now() - 2 * 3600 * 1000 });
  state.commits.dev = shaB2;

  calls.length = 0;
  const dir2 = await fetchRepo(repoB, 'dev', null, false);

  assert.equal(dir2, getRepoCacheDir(repoB, shaB2), 'new head cached under the new SHA');
  assert.notEqual(dir2, dir1);
  assert.equal(fs.readFileSync(path.join(dir2, 'hello.txt'), 'utf8'), 'new head');
  assert.equal(fs.readFileSync(path.join(dir2, '.extracted'), 'utf8'), shaB2);
  // Old dir is immutable — still present with its original content.
  assert.equal(fs.existsSync(dir1), true);
  assert.equal(fs.readFileSync(path.join(dir1, 'hello.txt'), 'utf8'), 'old head');

  // One resolution + one download; nothing re-fetched for the old SHA.
  assert.deepEqual(apiCalls(calls).map((c) => c.url), [
    'https://api.github.com/repos/org/beta/commits/dev',
  ]);
  assert.deepEqual(dlCalls(calls).map((c) => c.url), [
    'https://codeload.github.com/org/beta/tar.gz/' + shaB2,
  ]);
  assert.equal(readRefHeads(cacheRoot)[`org/beta@dev`].sha, shaB2);
});

// ─── (c) TTL expired but SHA unchanged: no re-download, entry timestamp extended ─

test('TTL-expired resolution returning the same SHA: reuse dir, extend entry, no download', async (t) => {
  if (!HAS_TAR) return t.skip('tar binary not available');
  const cacheRoot = useTempCache(t);
  const state = makeState();
  const calls = installFake(t, state);

  const repoC = 'org/gamma';
  const shaC  = sha(4);
  state.commits.dev = shaC;
  state.tarballs[shaC] = tarGz('gamma-' + shaC, 'hello.txt', 'stable');

  const first = await fetchRepo(repoC, 'dev', null, false);
  assert.equal(first, getRepoCacheDir(repoC, shaC));

  const aged = Date.now() - 2 * 3600 * 1000;
  writeRefHeads(cacheRoot, repoC, 'dev', { sha: shaC, at: aged });

  calls.length = 0;
  const second = await fetchRepo(repoC, 'dev', null, false);

  assert.equal(second, first, 'same dir reused');
  assert.equal(dlCalls(calls).length, 0, 'no re-download for an unchanged SHA');
  assert.equal(apiCalls(calls).length, 1, 'one re-resolution after TTL expiry');
  const entry = readRefHeads(cacheRoot)[`org/gamma@dev`];
  assert.equal(entry.sha, shaC);
  assert.ok(entry.at > aged + 3600 * 1000, 'resolution timestamp extended on same-SHA refresh');
});

// ─── (d) --no-fetch semantics ───────────────────────────────────────────────

test('--no-fetch with a stale cached resolution uses the existing dir, no network', async (t) => {
  const cacheRoot = useTempCache(t);
  const state = makeState();
  const calls = installFake(t, state);

  const repoD = 'org/delta';
  const shaD  = sha(5);
  writeRefHeads(cacheRoot, repoD, 'dev', { sha: shaD, at: Date.now() - 2 * 3600 * 1000 });
  const dir = seedCloneDir(repoD, shaD, 'stale but present');

  const result = await fetchRepo(repoD, 'dev', null, true);

  assert.equal(result, dir);
  assert.equal(calls.length, 0, 'no network under --no-fetch');
});

test('--no-fetch with no entry but an existing SHA dir adopts the newest clone', async (t) => {
  const cacheRoot = useTempCache(t);
  const calls = installFake(t, makeState());

  const repoD = 'org/delta2';
  const shaD  = sha(6);
  seedCloneDir(repoD, shaD, 'leftover from an earlier build');
  assert.equal(Object.keys(readRefHeads(cacheRoot)).length, 0, 'no resolution recorded');

  const result = await fetchRepo(repoD, 'dev', null, true);

  assert.equal(result, getRepoCacheDir(repoD, shaD));
  assert.equal(fs.readFileSync(path.join(result, 'hello.txt'), 'utf8'), 'leftover from an earlier build');
  assert.equal(calls.length, 0);
});

test('--no-fetch with no cache at all rejects with a --no-fetch hint', async (t) => {
  const cacheRoot = useTempCache(t);
  const calls = installFake(t, makeState());
  assert.equal(Object.keys(readRefHeads(cacheRoot)).length, 0);

  await assert.rejects(
    fetchRepo('org/delta3', 'dev', null, true),
    /Repo cache missing for org\/delta3@dev and --no-fetch is set/
  );
  assert.equal(calls.length, 0, 'no network attempted');
});

// ─── (e) offline resolution failure ─────────────────────────────────────────

test('offline head re-resolution (API 500) with cached SHA + dir: warn and reuse, no throw', async (t) => {
  const cacheRoot = useTempCache(t);
  const state = makeState();
  const calls = installFake(t, state);

  const repoE = 'org/epsilon';
  const shaE  = sha(7);
  writeRefHeads(cacheRoot, repoE, 'dev', { sha: shaE, at: Date.now() - 2 * 3600 * 1000 });
  const dir = seedCloneDir(repoE, shaE, 'last known good');
  state.failApi = 500;

  const result = await fetchRepo(repoE, 'dev', null, false);

  assert.equal(result, dir, 'fell back to the stale cached head');
  assert.equal(fs.readFileSync(path.join(result, 'hello.txt'), 'utf8'), 'last known good');
  assert.equal(dlCalls(calls).length, 0, 'no download attempt after a failed resolution');
});

test('offline head resolution (API 500) with empty cache throws the resolve hint', async (t) => {
  const state = makeState();
  installFake(t, state);
  useTempCache(t);
  state.failApi = 500;

  await assert.rejects(
    fetchRepo('org/epsilon2', 'dev', null, false),
    /Failed to resolve ref dev of org\/epsilon2/
  );
});

// ─── (f) explicit tag ref: stable across runs ───────────────────────────────

test('explicit tag ref fetches correctly and stays stable across runs (TTL extension)', async (t) => {
  if (!HAS_TAR) return t.skip('tar binary not available');
  const cacheRoot = useTempCache(t);
  const state = makeState();
  const calls = installFake(t, state);

  const repoF = 'org/zeta';
  const shaF  = sha(8);
  state.commits['v1.2.3'] = shaF;
  state.tarballs[shaF] = tarGz('zeta-' + shaF, 'hello.txt', 'tagged release');

  const first = await fetchRepo(repoF, 'v1.2.3', null, false);
  assert.equal(first, getRepoCacheDir(repoF, shaF));

  calls.length = 0;
  const second = await fetchRepo(repoF, 'v1.2.3', null, false);
  assert.equal(second, first, 'fresh entry reuses the same dir');
  assert.equal(calls.length, 0);

  // Age the entry and refresh: tag head unchanged → same dir, no download,
  // timestamp extended.
  writeRefHeads(cacheRoot, repoF, 'v1.2.3', { sha: shaF, at: Date.now() - 2 * 3600 * 1000 });
  calls.length = 0;
  const third = await fetchRepo(repoF, 'v1.2.3', null, false);
  assert.equal(third, first);
  assert.equal(dlCalls(calls).length, 0);
  assert.equal(apiCalls(calls).length, 1);
  assert.ok(readRefHeads(cacheRoot)[`org/zeta@v1.2.3`].at > Date.now() - 1000);
});

// ─── pinned SHA: immutable fast path, no resolution ─────────────────────────

test('pinned SHA ref skips resolution entirely and caches under that SHA', async (t) => {
  if (!HAS_TAR) return t.skip('tar binary not available');
  const state = makeState();
  const calls = installFake(t, state);
  useTempCache(t);

  const repoH = 'org/eta';
  const pinned = sha(9);
  state.tarballs[pinned] = tarGz('eta-' + pinned, 'hello.txt', 'pinned commit');

  const dir = await fetchRepo(repoH, pinned, null, false);

  assert.equal(dir, getRepoCacheDir(repoH, pinned));
  assert.equal(fs.readFileSync(path.join(dir, '.extracted'), 'utf8'), pinned);
  assert.equal(apiCalls(calls).length, 0, 'no GitHub API calls for a pinned SHA');
  assert.deepEqual(dlCalls(calls).map((c) => c.url), [
    'https://codeload.github.com/org/eta/tar.gz/' + pinned,
  ]);
});

// ─── (g) ssh=true ───────────────────────────────────────────────────────────
// cloneViaGit spawns the real `git` binary against git@github.com, so it is
// not exercisable offline. Its moving-ref behavior is exactly the existing
// explicit-SHA path (fetch + checkout, never --branch) — see the module
// docstring of the test file for why that is left to the real-git coverage.
