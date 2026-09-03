'use strict';

const fs   = require('fs');
const path = require('path');

const { fetchRepo, resolveRefIfLatest } = require('./repo-fetcher');
const { fetchReleaseDep } = require('./release-fetcher');
const { fetchDepRoot }    = require('./deps-resolver');
const { parseDepString, parseDepObject } = require('./manifest');

// Fallback doc files a dependency repo may ship when it declares no explicit
// `docs:` paths. Checked in order at the repo root.
// Deliberately NOT AGENTS.md: that file is instructions for agents working
// INSIDE the repo (build commands, contribution rules), not consumer-facing
// API docs — feeding it to an outside agent leaks the wrong context.
const DOCS_CONVENTIONS = ['docs/API.md', 'API.md'];

/**
 * Normalize a raw dep value (string or dep object) into a parsed dep object.
 * @param {string|object} raw
 * @returns {object} parsed dep object
 */
function normalizeDep(raw) {
  if (typeof raw === 'string') return parseDepString(raw);
  if (raw && typeof raw === 'object') return parseDepObject(raw);
  throw new Error('Dep must be a string or an object');
}

/**
 * Resolve which agent-facing doc files exist for a dependency inside rootDir.
 * Declared `dep.docs` paths come first (in array order), then convention
 * candidates that exist on disk. Deduped by rel path — declared wins.
 *
 * @param {object} dep - parsed dep object ({ docs: string[]|null, ... })
 * @param {string} rootDir - local root of the fetched repo/asset
 * @returns {{ files: Array<{ rel: string, abs: string, origin: 'declared'|'convention' }>, missing: string[] }}
 */
function resolveDepDocs(dep, rootDir) {
  const files   = [];
  const missing = [];
  const seen    = new Set();

  const declared = Array.isArray(dep.docs) ? dep.docs : [];

  for (const rel of declared) {
    const abs = path.resolve(rootDir, rel);
    if (abs !== rootDir && !abs.startsWith(rootDir + path.sep)) {
      throw new Error(`docs path escapes the repo root: "${rel}"`);
    }
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      files.push({ rel, abs, origin: 'declared' });
    } else {
      missing.push(rel);
    }
  }

  for (const rel of DOCS_CONVENTIONS) {
    if (seen.has(rel)) continue;
    const abs = path.join(rootDir, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      seen.add(rel);
      files.push({ rel, abs, origin: 'convention' });
    }
  }

  return { files, missing };
}

/**
 * UTF-8 read that never throws: binary files and read errors are returned as
 * descriptive placeholder strings instead.
 * @param {string} abs - absolute file path
 * @returns {string}
 */
function safeRead(abs) {
  try {
    const buf = fs.readFileSync(abs);
    try {
      const text = buf.toString('utf8');
      if (text.includes('\u0000')) return `[binary file, ${buf.length} bytes]`;
      return text;
    } catch (_) {
      return `[binary file, ${buf.length} bytes]`;
    }
  } catch (err) {
    return `[error reading file: ${err.message}]`;
  }
}

/**
 * Fetch a dependency and collect its agent-facing doc files with contents.
 * `fetchRoot` is a test seam — defaults to the core fetchDepRoot.
 *
 * @param {object} dep - parsed dep object
 * @param {object} [opts]
 * @param {string} [opts.token]
 * @param {boolean} [opts.noFetch]
 * @param {boolean} [opts.ssh]
 * @param {Function} [opts.fetchRoot] - ({ dep, ... }) => Promise<{ rootDir, label }>
 * @returns {Promise<{ label: string, files: Array<{ rel: string, content: string, origin: string }>, missing: string[] }>}
 */
async function collectDepDocs(dep, { token, noFetch, ssh, fetchRoot } = {}) {
  const fetch = fetchRoot || fetchDepRoot;
  const { rootDir, label } = await fetch(dep, { token, noFetch, ssh });
  const { files, missing } = resolveDepDocs(dep, rootDir);
  return {
    label,
    files: files.map((f) => ({ rel: f.rel, content: safeRead(f.abs), origin: f.origin })),
    missing,
  };
}

module.exports = { DOCS_CONVENTIONS, resolveDepDocs, collectDepDocs, normalizeDep };
