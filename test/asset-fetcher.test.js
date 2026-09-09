'use strict';

/**
 * Tests for src/download.js (shared streaming download helper) and
 * src/asset-fetcher.js url sources.
 *
 * downloadToFile must stream to disk (not buffer), enforce a byte cap, enforce
 * a real wall-clock deadline (not just socket idle) and retry transient
 * failures. asset url sources must be cached behind a .cached sentinel written
 * only after the content lands in place.
 *
 * Offline + deterministic: a local http server on 127.0.0.1 serves every body;
 * no external network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');

const AdmZip = require('adm-zip');

const { downloadToFile } = require('../src/download');
const { fetchAssets } = require('../src/asset-fetcher');
const { setEnabled } = require('../src/progress');

setEnabled(false); // keep test output clean — no \r progress bars

const ORIG_CACHE_ENV = process.env.AMXX_BUILDER_CACHE;

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function useTempCache(t) {
  const dir = makeTmpDir('amxb-af-cache-');
  process.env.AMXX_BUILDER_CACHE = dir;
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (ORIG_CACHE_ENV === undefined) delete process.env.AMXX_BUILDER_CACHE;
    else process.env.AMXX_BUILDER_CACHE = ORIG_CACHE_ENV;
  });
  return dir;
}

// ─── local http server helpers ──────────────────────────────────────────────

function startServer(handler) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: (p) => `http://127.0.0.1:${port}${p}`,
        hits: () => hits,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function readBody(dest) {
  return fs.readFileSync(dest, 'utf8');
}

// ─── downloadToFile: streams to disk + byte cap ─────────────────────────────

test('downloadToFile: streams the body to disk and leaves no .part file', async (t) => {
  const dir = makeTmpDir('amxb-dl-ok-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const payload = Buffer.from('x'.repeat(64 * 1024)); // 64 KiB
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(payload.length) });
    res.end(payload);
  });
  t.after(() => srv.close());

  const dest = path.join(dir, 'out.bin');
  const { headers } = await downloadToFile(srv.url('/file'), dest, { attempts: 1 });

  assert.equal(fs.readFileSync(dest).length, payload.length);
  assert.deepEqual(fs.readFileSync(dest), payload);
  assert.equal(headers['content-type'], 'application/octet-stream');
  assert.deepEqual(fs.readdirSync(dir), ['out.bin'], 'no .part leftover');
});

test('downloadToFile: enforces the byte cap mid-stream and does not retry an oversized body', async (t) => {
  const dir = makeTmpDir('amxb-dl-cap-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const srv = await startServer((req, res) => {
    res.on('error', () => {});
    res.writeHead(200, { 'content-type': 'application/octet-stream' }); // chunked, no content-length
    let i = 0;
    const iv = setInterval(() => {
      if (i++ >= 50) { clearInterval(iv); res.end(); return; }
      res.write('A'.repeat(4));
    }, 5);
    res.on('close', () => clearInterval(iv));
  });
  t.after(() => srv.close());

  const dest = path.join(dir, 'out.bin');
  await assert.rejects(
    downloadToFile(srv.url('/big'), dest, { maxBytes: 16, attempts: 3 }),
    (err) => err && err.code === 'MAX_BYTES_EXCEEDED'
  );
  assert.equal(srv.hits(), 1, 'an oversized body must not be re-downloaded');
  assert.equal(fs.existsSync(dest), false);
  assert.deepEqual(fs.readdirSync(dir), [], 'partial .part cleaned up');
});

// ─── downloadToFile: real wall-clock deadline ───────────────────────────────

test('downloadToFile: a trickling server trips the deadline, not the socket idle timeout', async (t) => {
  const dir = makeTmpDir('amxb-dl-deadline-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const srv = await startServer((req, res) => {
    res.on('error', () => {});
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    let i = 0;
    const iv = setInterval(() => {
      if (i++ >= 200) { clearInterval(iv); res.end(); return; }
      res.write('trickle'); // steady bytes → axios idle timeout never fires
    }, 20);
    res.on('close', () => clearInterval(iv));
  });
  t.after(() => srv.close());

  const dest = path.join(dir, 'out.bin');
  const started = Date.now();
  await assert.rejects(
    downloadToFile(srv.url('/trickle'), dest, { deadlineMs: 80, timeoutMs: 60000, attempts: 1 }),
    (err) => err && err.code === 'DOWNLOAD_TIMEOUT'
  );
  assert.ok(Date.now() - started < 5000, 'deadline must fire in wall-clock time');
  assert.equal(fs.existsSync(dest), false);
});

test('downloadToFile: transient HTTP failure is retried with a fresh request', async (t) => {
  const dir = makeTmpDir('amxb-dl-retry-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let served = 0;
  const srv = await startServer((req, res) => {
    served++;
    if (served === 1) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('busy');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '5' });
    res.end('hello');
  });
  t.after(() => srv.close());

  const dest = path.join(dir, 'out.bin');
  await downloadToFile(srv.url('/flaky'), dest, { attempts: 2 });
  assert.equal(served, 2, 'transient 503 must be retried');
  assert.equal(readBody(dest), 'hello');
});

// ─── fetchAssets: url sources over a local server ───────────────────────────

function makeManifest(workDir, sources) {
  return {
    _path: path.join(workDir, 'amxbuild.yml'),
    assets: { sources, on_conflict: 'last_wins' },
  };
}

function urlSource(url, extra = {}) {
  return { type: 'url', url, map: [{ from: null, to: null }], cache: 'none', ...extra };
}

test('fetchAssets: url asset is downloaded once, mapped into assets/ and cached behind .cached', async (t) => {
  const cacheRoot = useTempCache(t);
  const workDir = makeTmpDir('amxb-af-work-');
  const buildDir = path.join(workDir, 'build');
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '9' });
    res.end('ASSETDATA');
  });
  t.after(() => srv.close());

  const url = srv.url('/pack.bin');
  const manifest = makeManifest(workDir, [urlSource(url, { cache: 'global' })]);

  await fetchAssets(manifest, buildDir, false);
  await fetchAssets(manifest, buildDir, false); // second run hits the sentinel

  assert.equal(srv.hits(), 1, 'cached asset must not be re-downloaded');
  assert.equal(fs.readFileSync(path.join(buildDir, 'assets', 'pack.bin'), 'utf8'), 'ASSETDATA');

  const hashDirs = fs.readdirSync(path.join(cacheRoot, 'assets'));
  assert.equal(hashDirs.length, 1);
  const cacheEntries = fs.readdirSync(path.join(cacheRoot, 'assets', hashDirs[0])).sort();
  assert.deepEqual(cacheEntries, ['.cached', 'pack.bin']);
});

test('fetchAssets: extensionless zip (content-type + PK magic) is extracted into assets/', async (t) => {
  const workDir = makeTmpDir('amxb-af-zip-');
  const buildDir = path.join(workDir, 'build');
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const zip = new AdmZip();
  zip.addFile('models/weapon.mdl', Buffer.from('MDL-BYTES'));
  const bytes = zip.toBuffer();

  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(bytes.length) });
    res.end(bytes);
  });
  t.after(() => srv.close());

  const manifest = makeManifest(workDir, [urlSource(srv.url('/archive'))]);
  await fetchAssets(manifest, buildDir, false);

  assert.equal(fs.readFileSync(path.join(buildDir, 'assets', 'models', 'weapon.mdl'), 'utf8'), 'MDL-BYTES');
  const dlDirs = fs.readdirSync(path.join(buildDir, '_assets_dl'));
  assert.equal(dlDirs.length, 1, 'cache dir');
  assert.deepEqual(
    fs.readdirSync(path.join(buildDir, '_assets_dl', dlDirs[0])).sort(),
    ['.cached', 'models'],
    'archive file removed after extraction, sentinel in place, no temp dirs'
  );
});
