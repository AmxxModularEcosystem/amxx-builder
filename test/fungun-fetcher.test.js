'use strict';

/**
 * Unit tests for src/fungun-fetcher.js.
 *
 * Offline + deterministic: axios.get is stubbed, no network traffic.
 * Caching tests redirect AMXX_BUILDER_CACHE to a temp dir.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const axios = require('axios');

const {
  parsePluginRef,
  extractIncModals,
  extractIncFiles,
  fetchFungunDep,
} = require('../src/fungun-fetcher');
const { setEnabled } = require('../src/progress');

setEnabled(false); // keep test output clean — no \r progress bars

const CANONICAL_106 = 'https://fungun.net/shop/?p=show&id=106';

// Mirrors the real fungun.net markup: one modal per shipped file, page-specific
// ModalText ids, filename in the first h3, content inside pre > code.
function pageHtml(entries) {
  return entries.map((e, i) => `
    <div class="modal fade" id="ModalText${100 + i}" ...>
      <div class="modal-body modal-dark2 p-2 p-md-3">
        <button type="button" class="close"></button>
        <h3 class="modal-title">${e.filename}</h3><div class="border_text"></div>
        <pre class="language-cpp"><code>${e.content}</code></pre>
      </div>
    </div>`).join('\n');
}

const INC_CONTENT = '/* RU: test include */\n\nnative fg_test(id);\n';
const CFG_CONTENT = 'fg_cvar "1" &amp; &quot;quoted&quot;\n';

// ─── parsePluginRef ───────────────────────────────────────────────────────────

test('parsePluginRef: accepts numeric id', () => {
  assert.deepEqual(parsePluginRef(106), { id: '106', url: CANONICAL_106 });
  assert.deepEqual(parsePluginRef('106'), { id: '106', url: CANONICAL_106 });
});

test('parsePluginRef: accepts full page URL', () => {
  assert.deepEqual(parsePluginRef(CANONICAL_106), { id: '106', url: CANONICAL_106 });
});

test('parsePluginRef: returns null for empty input', () => {
  assert.equal(parsePluginRef(null), null);
  assert.equal(parsePluginRef(undefined), null);
  assert.equal(parsePluginRef(''), null);
  assert.equal(parsePluginRef('   '), null);
});

test('parsePluginRef: rejects non-positive numbers', () => {
  assert.throws(() => parsePluginRef(0), /positive plugin index/);
  assert.throws(() => parsePluginRef(-5), /positive plugin index/);
  assert.throws(() => parsePluginRef(1.5), /positive plugin index/);
});

test('parsePluginRef: rejects non-numeric strings', () => {
  assert.throws(() => parsePluginRef('abc'), /Invalid fungun plugin reference/);
  assert.throws(() => parsePluginRef('-1'), /Invalid fungun plugin reference/);
});

test('parsePluginRef: rejects non-fungun hosts', () => {
  assert.throws(
    () => parsePluginRef('https://evil.example/shop/?p=show&id=106'),
    /expected a fungun\.net page/
  );
});

test('parsePluginRef: rejects URLs without id param', () => {
  assert.throws(
    () => parsePluginRef('https://fungun.net/shop/?p=show'),
    /missing "id=<index>" parameter/
  );
});

// ─── extractIncModals / extractIncFiles ───────────────────────────────────────

test('extractIncFiles: picks only the .inc modal and decodes entities', () => {
  const html = pageHtml([
    { filename: 'plug.cfg', content: CFG_CONTENT },
    { filename: 'plug.txt', content: '[ru]\nMSG = hello' },
    { filename: 'plug.inc', content: INC_CONTENT },
  ]);
  const incs = extractIncFiles(html);
  assert.equal(incs.length, 1);
  assert.equal(incs[0].filename, 'plug.inc');
  assert.equal(incs[0].content, INC_CONTENT.trim());
});

test('extractIncFiles: decodes HTML entities inside code', () => {
  const html = pageHtml([{ filename: 'cfg_demo.cfg', content: 'a &amp;&lt;&gt;&quot; &nbsp;b' }]);
  const modals = extractIncModals(html);
  assert.equal(modals.length, 1);
  assert.equal(modals[0].content, 'a &<>"  b');
});

test('extractIncFiles: page without .inc modal yields empty list', () => {
  const html = pageHtml([
    { filename: 'plug.cfg', content: CFG_CONTENT },
    { filename: 'plug.txt', content: 'text' },
  ]);
  assert.equal(extractIncFiles(html).length, 0);
});

test('extractIncModals: empty or modal-less html yields empty list', () => {
  assert.equal(extractIncModals('').length, 0);
  assert.equal(extractIncModals('<html><body>no modals</body></html>').length, 0);
});

test('extractIncModals: skips modals without a filename or code block', () => {
  const html = `
    <div class="modal fade" id="ModalTextVersion" ...>
      <h3 id="modal-label-version">Version info</h3>
    </div>
    <div class="modal fade" id="ModalText1" ...>
      <h3 class="modal-title">a.inc</h3><pre class="language-cpp"><code>x</code></pre>
    </div>`;
  const modals = extractIncModals(html);
  assert.equal(modals.length, 1);
  assert.equal(modals[0].filename, 'a.inc');
});

// ─── fetchFungunDep (cache + page fetch) ─────────────────────────────────────

function makeCacheDir(t) {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'amxb-fungun-cache-'));
  const prev = process.env.AMXX_BUILDER_CACHE;
  process.env.AMXX_BUILDER_CACHE = cache;
  t.after(() => {
    if (prev === undefined) delete process.env.AMXX_BUILDER_CACHE;
    else process.env.AMXX_BUILDER_CACHE = prev;
    fs.rmSync(cache, { recursive: true, force: true });
  });
  return cache;
}

function stubPageHtml(html, onCall) {
  const orig = axios.get;
  axios.get = async (url, cfg) => {
    onCall?.({ url, cfg });
    return { status: 200, data: html };
  };
  return () => { axios.get = orig; };
}

test('fetchFungunDep: fetches once, writes .inc file, then serves from cache', async (t) => {
  const cache = makeCacheDir(t);
  let calls = 0;
  const restore = stubPageHtml(pageHtml([{ filename: 'plug.inc', content: INC_CONTENT }]), () => calls++);
  t.after(restore);

  const dir1 = await fetchFungunDep({ id: '106' }, false);
  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(path.join(dir1, 'plug.inc'), 'utf8'), INC_CONTENT.trim());
  assert.ok(fs.existsSync(path.join(dir1, '.fungun')));

  const dir2 = await fetchFungunDep({ id: 106 }, false);
  assert.equal(calls, 1, 'second call must hit the cache — no HTTP request');
  assert.equal(dir2, dir1);
  assert.ok(dir2.startsWith(path.join(cache, 'fungun', '106')));
});

test('fetchFungunDep: url-only dep object also works', async (t) => {
  makeCacheDir(t);
  const restore = stubPageHtml(pageHtml([{ filename: 'plug.inc', content: INC_CONTENT }]));
  t.after(restore);

  const dir = await fetchFungunDep({ url: CANONICAL_106 }, false);
  assert.ok(fs.existsSync(path.join(dir, 'plug.inc')));
});

test('fetchFungunDep: noFetch with empty cache throws', async (t) => {
  makeCacheDir(t);
  await assert.rejects(() => fetchFungunDep({ id: '106' }, true), /--no-fetch is set/);
});

const DAY_MS = 24 * 60 * 60 * 1000;

function ageSentinel(sentinelFile, ageMs) {
  const past = new Date(Date.now() - ageMs);
  fs.utimesSync(sentinelFile, past, past);
}

function stubAxios(handler) {
  const orig = axios.get;
  axios.get = handler;
  return () => { axios.get = orig; };
}

test('fetchFungunDep: cache older than one day is refetched', async (t) => {
  makeCacheDir(t);
  let calls = 0;
  let html = pageHtml([{ filename: 'plug.inc', content: INC_CONTENT }]);
  const restore = stubAxios(async () => { calls++; return { status: 200, data: html }; });
  t.after(restore);

  const dir = await fetchFungunDep({ id: '106' }, false);
  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'plug.inc'), 'utf8'), INC_CONTENT.trim());

  html = pageHtml([{ filename: 'plug.inc', content: '/* v2 */\n' }]);
  ageSentinel(path.join(dir, '.fungun'), DAY_MS + 60 * 1000);

  const dir2 = await fetchFungunDep({ id: '106' }, false);
  assert.equal(calls, 2, 'expired cache must be refetched');
  assert.equal(dir2, dir);
  assert.equal(fs.readFileSync(path.join(dir, 'plug.inc'), 'utf8'), '/* v2 */');
});

test('fetchFungunDep: noFetch uses a stale cache without network', async (t) => {
  makeCacheDir(t);
  let calls = 0;
  const restore = stubAxios(async () => {
    calls++;
    return { status: 200, data: pageHtml([{ filename: 'plug.inc', content: INC_CONTENT }]) };
  });
  t.after(restore);

  const dir = await fetchFungunDep({ id: '106' }, false);
  assert.equal(calls, 1);
  ageSentinel(path.join(dir, '.fungun'), DAY_MS + 60 * 1000);

  const dir2 = await fetchFungunDep({ id: '106' }, true);
  assert.equal(calls, 1, 'noFetch must not hit the network for a stale cache');
  assert.equal(dir2, dir);
});

test('fetchFungunDep: failed refetch falls back to the stale cache', async (t) => {
  makeCacheDir(t);
  let failNext = false;
  const restore = stubAxios(async () => {
    if (failNext) {
      const err = new Error('Request failed with status code 404');
      err.response = { status: 404 };
      throw err;
    }
    return { status: 200, data: pageHtml([{ filename: 'plug.inc', content: INC_CONTENT }]) };
  });
  t.after(restore);

  const dir = await fetchFungunDep({ id: '106' }, false);
  assert.equal(fs.existsSync(path.join(dir, 'plug.inc')), true);
  ageSentinel(path.join(dir, '.fungun'), DAY_MS + 60 * 1000);

  failNext = true;
  const dir2 = await fetchFungunDep({ id: '106' }, false);
  assert.equal(dir2, dir, 'must keep the cached copy when the refetch fails');
  assert.equal(fs.readFileSync(path.join(dir, 'plug.inc'), 'utf8'), INC_CONTENT.trim());
});

test('fetchFungunDep: page without .inc modal throws a descriptive error', async (t) => {
  makeCacheDir(t);
  const restore = stubPageHtml(pageHtml([
    { filename: 'plug.cfg', content: CFG_CONTENT },
    { filename: 'plug.txt', content: 'text' },
  ]));
  t.after(restore);

  await assert.rejects(
    () => fetchFungunDep({ id: '106' }, false),
    /No \.inc include found on fungun\.net plugin page #106/
  );
});

test('fetchFungunDep: missing plugin reference throws', async (t) => {
  makeCacheDir(t);
  await assert.rejects(() => fetchFungunDep({ source: 'fungun' }, false), /missing a plugin reference/);
});

test('fetchFungunDep: HTTP error is not retried and surfaces', async (t) => {
  makeCacheDir(t);
  const orig = axios.get;
  axios.get = async () => {
    const err = new Error('Request failed with status code 404');
    err.response = { status: 404 };
    throw err;
  };
  t.after(() => { axios.get = orig; });

  await assert.rejects(() => fetchFungunDep({ id: '106' }, false), /404/);
});
