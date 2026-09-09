'use strict';

/**
 * Unit tests for src/release-fetcher.js — downloadAsset header handling and the
 * atomic release-dep cache path.
 *
 * - downloadAsset must NOT clobber a caller-provided Accept header with
 *   application/octet-stream, because the GitHub API tarball endpoint
 *   (api.github.com/repos/{repo}/tarball/{ref}) rejects octet-stream with 415
 *   and requires application/vnd.github+json.
 * - Release deps are downloaded + extracted into a unique sibling temp dir and
 *   renamed into place, so a killed run only leaves an ignored temp dir and a
 *   marker-less partial cache is replaced instead of reused.
 *
 * Offline + deterministic: axios.get is stubbed (release API → JSON, asset →
 * real zip bytes over a readable stream); no network traffic.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { Readable } = require('node:stream');

const axios = require('axios');
const AdmZip = require('adm-zip');
const { downloadAsset, fetchReleaseDep } = require('../src/release-fetcher');
const { publishDir } = require('../src/fs-utils');
const { normalize } = require('../src/deps-resolver');
const { setEnabled } = require('../src/progress');

setEnabled(false); // keep test output clean — no \r progress bars

const ORIG_CACHE_ENV = process.env.AMXX_BUILDER_CACHE;

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'amxb-dl-'));
}

function useTempCache(t) {
  const dir = makeTmpDir();
  process.env.AMXX_BUILDER_CACHE = dir;
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (ORIG_CACHE_ENV === undefined) delete process.env.AMXX_BUILDER_CACHE;
    else process.env.AMXX_BUILDER_CACHE = ORIG_CACHE_ENV;
  });
  return dir;
}

function writeFile(dir, rel, content = '') {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function makeZipBuffer() {
  const zip = new AdmZip();
  zip.addFile('addons/amxmodx/scripting/include/test.inc', Buffer.from('// v1 include\n'));
  zip.addFile('addons/amxmodx/scripting/amxxpc', Buffer.from('#!/bin/sh\necho mock\n'));
  return zip.toBuffer();
}

function stubStreamBody(buf) {
  const s = new Readable();
  s.push(buf);
  s.push(null);
  return s;
}

function releaseCacheDirFor(repo, ref) {
  const key = normalize(repo).replace('/', '__') + '__' + ref;
  return path.join(process.env.AMXX_BUILDER_CACHE, 'release-deps', key);
}

// ─── downloadAsset: header handling ─────────────────────────────────────────

function stubAxiosGet(capture) {
  const orig = axios.get;
  axios.get = async (url, cfg) => {
    capture({ url, cfg });
    const buf = Buffer.from('payload');
    return {
      data: stubStreamBody(buf),
      headers: { 'content-type': 'application/x-gzip', 'content-length': String(buf.length) },
    };
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

// ─── publishDir (shared atomic cache publish) ───────────────────────────────

test('publishDir: a valid existing cache wins over a duplicate (concurrent run) and tmp is dropped', (t) => {
  const base = makeTmpDir();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const finalDir = path.join(base, 'final');
  const tmpDir  = path.join(base, 'final.tmp-1-aaaa');
  writeFile(finalDir, '.extracted', 'v1');
  writeFile(finalDir, 'keep.txt', 'original');
  writeFile(tmpDir,  'new.txt', 'duplicate');

  publishDir(tmpDir, finalDir, () => fs.existsSync(path.join(finalDir, '.extracted')));

  assert.equal(fs.existsSync(path.join(finalDir, 'keep.txt')), true, 'first writer content kept');
  assert.equal(fs.existsSync(path.join(finalDir, 'new.txt')), false, 'duplicate tmp dropped');
  assert.equal(fs.existsSync(tmpDir), false);
});

test('publishDir: marker-less stale junk is replaced atomically by the fresh dir', (t) => {
  const base = makeTmpDir();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const finalDir = path.join(base, 'final');
  const tmpDir  = path.join(base, 'final.tmp-2-bbbb');
  writeFile(finalDir, 'partial.inc', 'stale from a killed extract');
  writeFile(tmpDir,  '.extracted', 'v1');
  writeFile(tmpDir,  'fresh.inc', 'fresh');

  publishDir(tmpDir, finalDir, () => fs.existsSync(path.join(finalDir, '.extracted')));

  assert.equal(fs.existsSync(path.join(finalDir, 'partial.inc')), false, 'stale junk replaced');
  assert.equal(fs.readFileSync(path.join(finalDir, 'fresh.inc'), 'utf8'), 'fresh');
  assert.equal(fs.readFileSync(path.join(finalDir, '.extracted'), 'utf8'), 'v1');
  assert.equal(fs.existsSync(tmpDir), false);
});

// ─── fetchReleaseDep: crash-safe cache path ─────────────────────────────────

test('fetchReleaseDep: repopulates a marker-less partial cache and ignores a leftover temp dir', async (t) => {
  useTempCache(t);

  const calls = [];
  const orig = axios.get;
  axios.get = async (url, cfg) => {
    calls.push(url);
    if (url.startsWith('https://api.github.com/')) {
      return { data: { assets: [{ name: 'pack.zip', browser_download_url: 'https://example.com/pack.zip' }] }, headers: {} };
    }
    const buf = makeZipBuffer();
    return {
      data: stubStreamBody(buf),
      headers: { 'content-type': 'application/zip', 'content-length': String(buf.length) },
    };
  };
  t.after(() => { axios.get = orig; });

  const dep      = { repo: 'org/amxx-pack', ref: 'v1.2.3' };
  const cacheDir = releaseCacheDirFor(dep.repo, dep.ref);

  const first = await fetchReleaseDep(dep, null, false);
  assert.ok(first.endsWith(path.join('addons', 'amxmodx', 'scripting', 'include')), 'auto-detected include path');
  assert.equal(fs.readFileSync(path.join(first, 'test.inc'), 'utf8'), '// v1 include\n');
  assert.equal(fs.existsSync(path.join(cacheDir, '.extracted')), true);

  // Simulate a killed extraction: cache dir holds marker-less junk and a stray
  // sibling temp dir from the interrupted run is left behind.
  fs.rmSync(cacheDir, { recursive: true, force: true });
  writeFile(cacheDir, 'include/partial.inc', 'stale');
  writeFile(`${cacheDir}.tmp-999-deadbeef`, 'junk.bin', 'partial');

  const second = await fetchReleaseDep(dep, null, false);
  assert.ok(!second.includes('.tmp-'), 'returned dir must not be a temp dir');
  assert.equal(fs.readFileSync(path.join(second, 'test.inc'), 'utf8'), '// v1 include\n');
  assert.equal(fs.existsSync(path.join(cacheDir, '.extracted')), true);
  assert.equal(fs.existsSync(path.join(cacheDir, 'include', 'partial.inc')), false, 'stale content replaced');
  assert.equal(fs.existsSync(`${cacheDir}.tmp-999-deadbeef`), true, 'other process temp dir left alone');
  const leftovers = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.part'));
  assert.deepEqual(leftovers, [], 'no .part files left in the cache dir');
});
