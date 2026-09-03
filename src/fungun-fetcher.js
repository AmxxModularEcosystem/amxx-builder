'use strict';

/**
 * Fungun dep source (fungun.net) — closed-source AMXX plugin shop.
 *
 * Plugins ship no archives and no direct file URLs. The only public artifact
 * is the plugin "show" page, which always embeds one Bootstrap modal per
 * shipped file (configs, lang, and — when the plugin exposes an API — exactly
 * the .inc include). Modal DOM ids are page-specific (`ModalText<number>`),
 * so a plugin is addressed by its page index and the .inc payload is located
 * by scanning every modal for a `modal-title` filename ending in `.inc`:
 *
 *   <div class="modal fade" id="ModalText267" ...>
 *     <div class="modal-body ...">
 *       <button ... close ...></button>
 *       <h3 class="modal-title">bonusmenu_rbs.inc</h3>
 *       <div class="border_text"></div>
 *       <pre class="language-cpp"><code>... include text ...</code></pre>
 *
 * Ownership (single source of truth for everything fungun):
 *   - id/url normalization and validation (parsePluginRef)
 *   - page fetch + modal extraction (fetchFungunPage, extractIncFiles)
 *   - on-disk cache: <CACHE_DIR>/fungun/<plugin-id>/ (sentinel `.fungun`)
 *
 * Manifest/dep parsing (`src/manifest.js`) and the fetch entry points in
 * deps-resolver / include-tree delegate here — no other module re-parses
 * fungun references or re-implements the extraction.
 */

const fs   = require('fs');
const path = require('path');
const axios = require('axios');

const logger = require('./logger');
const { getCacheDir } = require('./cache-dir');
const { withRetry } = require('./retry');

const FUNGUN_BASE_URL  = 'https://fungun.net';
const FUNGUN_SHOW_PATH = '/shop/?p=show&id=';

// fungun serves plain HTML to browsers; a bare axios UA may get a different
// (login/captcha) response. Keep a realistic browser UA on every request.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SENTINEL_FILE = '.fungun'; // content: plugin id — mirrors release-deps `.extracted`

// Fungun pages pin no version/ref — refetch the page cache daily (--no-fetch still uses the stale copy).
const FUNGUN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function pluginPageUrl(id) {
  return `${FUNGUN_BASE_URL}${FUNGUN_SHOW_PATH}${id}`;
}

/**
 * Normalize a fungun plugin reference.
 *
 * Accepts:
 *   - a positive integer id (number or numeric string) — `106`
 *   - a full plugin page URL — `https://fungun.net/shop/?p=show&id=106`
 *
 * Returns `{ id, url }` (id as a numeric string; url is the canonical page URL
 * for bare ids and the caller-provided URL otherwise). Throws on anything
 * else — this is the single validation point used by both manifest parsing
 * and the fetcher, so error messages are user-facing.
 *
 * @param {number|string} value
 * @returns {{ id: string, url: string }|null}
 */
function parsePluginRef(value) {
  if (value == null || value === '') return null;

  let str;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(
        `Invalid fungun plugin id: ${value} — expected a positive plugin index`
      );
    }
    str = String(value);
    return { id: str, url: pluginPageUrl(str) };
  }

  if (typeof value !== 'string') {
    throw new Error(
      `Invalid fungun plugin reference: ${JSON.stringify(value)} — expected a plugin id or fungun.net URL`
    );
  }
  str = value.trim();
  if (!str) return null;

  // Bare plugin index
  if (/^\d+$/.test(str)) return { id: str, url: pluginPageUrl(str) };

  // Full page URL
  if (/^https?:\/\//i.test(str)) {
    let hostname;
    try {
      hostname = new URL(str).hostname;
    } catch {
      throw new Error(`Invalid fungun plugin URL: "${str}"`);
    }
    if (hostname !== 'fungun.net' && !hostname.endsWith('.fungun.net')) {
      throw new Error(
        `Invalid fungun dep URL "${str}" — expected a fungun.net page (host: ${hostname})`
      );
    }
    const idMatch = str.match(/[?&]id=(\d+)/);
    if (!idMatch) {
      throw new Error(
        `Invalid fungun plugin URL "${str}" — missing "id=<index>" parameter`
      );
    }
    return { id: idMatch[1], url: str };
  }

  throw new Error(
    `Invalid fungun plugin reference "${str}" — ` +
    `expected a plugin index (e.g. 106) or a fungun.net page URL`
  );
}

/**
 * Fetch a fungun plugin page. `ref` is the output of parsePluginRef.
 *
 * @param {{ id: string, url: string }} ref
 * @returns {Promise<string>} page HTML (UTF-8)
 */
async function fetchFungunPage(ref) {
  const url = ref.url || pluginPageUrl(ref.id);
  const response = await withRetry(
    () => axios.get(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml',
      },
      responseType: 'text',
      timeout: 30000,
      maxRedirects: 5,
    }),
    { label: `fungun plugin #${ref.id}` }
  );

  if (response.status !== 200) {
    throw new Error(`Failed to fetch fungun plugin page #${ref.id} — HTTP ${response.status}`);
  }
  return String(response.data);
}

// ─── HTML extraction ──────────────────────────────────────────────────────────
// Deliberately regex-based: the target markup is a fixed two-level shape
// (modal div → h3.modal-title + pre > code) inside page-generated ids.
// No HTML parser dependency is needed to stay correct on Node 18 + offline CI.

/**
 * Parse every "file modal" out of a plugin page. Returns entries in page
 * order: `{ modalId, filename, content }` (entities decoded, content trimmed).
 * Modals without an h3 filename or a code block are skipped.
 *
 * @param {string} html
 * @returns {Array<{ modalId: string, filename: string, content: string }>}
 */
function extractIncModals(html) {
  const opens = [];
  const modalRe = /<div[^>]*\sid="(ModalText[^"]+)"[^>]*>/g;
  let m;
  while ((m = modalRe.exec(html))) opens.push({ id: m[1], start: m.index });

  const modals = [];
  for (let i = 0; i < opens.length; i++) {
    const end = i + 1 < opens.length ? opens[i + 1].start : html.length;
    const seg = html.slice(opens[i].start, end);

    const filename = matchModalFilename(seg);
    const content  = matchModalCode(seg);
    if (!filename || content === null) continue;

    modals.push({ modalId: opens[i].id, filename, content: content.trim() });
  }
  return modals;
}

function matchModalFilename(seg) {
  const m = seg.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
  return m ? decodeEntities(m[1]).trim() : null;
}

function matchModalCode(seg) {
  const m = seg.match(/<pre[^>]*>[\s\S]*?<code[^>]*>([\s\S]*?)<\/code>[\s\S]*?<\/pre>/);
  return m ? decodeEntities(m[1]) : null;
}

/**
 * Extract the include files (.inc modals) from a plugin page.
 *
 * @param {string} html
 * @returns {Array<{ modalId: string, filename: string, content: string }>}
 */
function extractIncFiles(html) {
  return extractIncModals(html).filter((m) => m.filename.toLowerCase().endsWith('.inc'));
}

function decodeEntities(str) {
  return String(str)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => codePointToString(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => codePointToString(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function codePointToString(cp) {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '\uFFFD';
  }
}

/**
 * Fetch the .inc payload of a fungun plugin into the local cache.
 *
 * Cache: <CACHE_DIR>/fungun/<plugin-id>/ — one file per .inc modal, named
 * after the modal title (path traversal is stripped via basename). The
 * sentinel `.fungun` marks a complete fetch. Because fungun pages have no
 * version to pin, the cache expires after FUNGUN_CACHE_TTL_MS and is
 * refetched on the next build. A refetch that fails (network, or the page
 * no longer exposing the include) falls back to the last known-good copy,
 * so an expired cache never breaks a build by itself.
 *
 * @param {object|number|string} dep - parsed fungun dep ({ id } / { url }) or a raw reference
 * @param {boolean} [noFetch=false] - only use the cache, skip network
 * @returns {Promise<string>} cache directory containing the .inc file(s)
 */
async function fetchFungunDep(dep, noFetch = false) {
  if (dep && typeof dep === 'object' && dep.id == null && dep.url == null) {
    throw new Error(
      `Fungun dep entry missing a plugin reference (expected "id" or "url"): ${JSON.stringify(dep)}`
    );
  }
  const raw = (dep && dep.id != null) ? dep.id
    : (dep && dep.url != null) ? dep.url
    : dep;
  const ref = parsePluginRef(raw);
  if (!ref) {
    throw new Error(
      `Fungun dep entry missing a plugin reference (expected "id" or "url"): ${JSON.stringify(dep)}`
    );
  }

  const cacheDir     = path.join(getCacheDir(), 'fungun', ref.id);
  const sentinelFile = path.join(cacheDir, SENTINEL_FILE);

  if (fs.existsSync(sentinelFile) && isFreshSentinel(sentinelFile)) {
    logger.dim(`  fungun.net plugin #${ref.id} (cached)`);
    return cacheDir;
  }

  const staleCache = fs.existsSync(sentinelFile);

  if (noFetch) {
    if (staleCache) {
      // CI reuse: a day-old include is still a valid include.
      logger.dim(`  fungun.net plugin #${ref.id} (cached, stale — --no-fetch)`);
      return cacheDir;
    }
    throw new Error(
      `Fungun dep cache missing for plugin #${ref.id} and --no-fetch is set.\n` +
      `Run without --no-fetch to populate the cache.`
    );
  }

  if (staleCache) {
    logger.dim(`  fungun.net plugin #${ref.id}: cache expired, refetching...`);
  }
  logger.step(`Fungun dep: plugin #${ref.id} @ ${ref.url || pluginPageUrl(ref.id)}`);

  try {
    const html = await fetchFungunPage(ref);
    const incs = extractIncFiles(html);

    if (incs.length === 0) {
      const pageUrl = ref.url || pluginPageUrl(ref.id);
      const titles  = extractIncModals(html).map((m) => m.filename);
      throw new Error(
        `No .inc include found on fungun.net plugin page #${ref.id} (${pageUrl}).\n` +
        `Shipped file modals: ${titles.length ? titles.join(', ') : 'none'} — this plugin exposes no include file.`
      );
    }

    fs.mkdirSync(cacheDir, { recursive: true });
    for (const inc of incs) {
      fs.writeFileSync(path.join(cacheDir, safeFileName(inc.filename)), inc.content, 'utf8');
    }
    touchSentinel(sentinelFile, ref.id);

    logger.info(`Fungun dep: plugin #${ref.id} ready (${incs.map((f) => f.filename).join(', ')})`);
    return cacheDir;
  } catch (err) {
    if (staleCache) {
      // Refetch failed but the previous copy is still on disk — keep the build
      // green and reset freshness so we don't hammer the site on every build.
      logger.warn(`Fungun dep: refetch of plugin #${ref.id} failed (${err.message}) — using cached copy`);
      touchSentinel(sentinelFile, ref.id);
      return cacheDir;
    }
    throw err;
  }
}

function isFreshSentinel(sentinelFile) {
  try {
    return Date.now() - fs.statSync(sentinelFile).mtimeMs < FUNGUN_CACHE_TTL_MS;
  } catch {
    return false;
  }
}

function touchSentinel(sentinelFile, id) {
  fs.mkdirSync(path.dirname(sentinelFile), { recursive: true });
  const sentinelTmp = sentinelFile + '.tmp';
  fs.writeFileSync(sentinelTmp, id, 'utf8');
  fs.renameSync(sentinelTmp, sentinelFile);
}

function safeFileName(filename) {
  const base = path.basename(String(filename || '').trim());
  if (!base || base === '.' || base === '..') {
    throw new Error(`Unsafe filename in fungun modal: ${JSON.stringify(filename)}`);
  }
  return base;
}

module.exports = {
  FUNGUN_BASE_URL,
  pluginPageUrl,
  parsePluginRef,
  fetchFungunPage,
  extractIncModals,
  extractIncFiles,
  fetchFungunDep,
};
