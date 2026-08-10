'use strict';

/**
 * Symbol index for AMXX include/source files.
 * Extracts declarations (native, stock, forward, public, #define, enum members,
 * const, plain functions) for search_symbol.
 *
 * No caching: parsing the whole AMXX stdlib takes ~20ms, so the index is
 * rebuilt on every call. Network fetches (clones, releases, compiler) have
 * their own cache in src/.
 */

const fs   = require('fs');
const path = require('path');
const glob = require('fast-glob');

const KEYWORDS = new Set([
  'assert', 'break', 'case', 'continue', 'default', 'do', 'else', 'emit',
  'exit', 'for', 'goto', 'if', 'new', 'return', 'sizeof', 'sleep', 'state',
  'switch', 'typedef', 'while',
]);

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, '');
}

function collectEnumMembers(chunk, lineNo, found) {
  for (const item of chunk.split(',')) {
    const m = item.match(/([A-Za-z_]\w*)/);
    if (m) found.push({ name: m[1], kind: 'enum', line: lineNo, signature: 'enum member' });
  }
}

/**
 * Parse .sma/.inc source text into symbol declarations.
 * Heuristic line-based parser covering AMXX declaration forms:
 * tags (Float:), operator overloads, stacked modifiers (public stock const),
 * functag, const arrays, multi-line enums.
 */
function parseInclude(text) {
  const clean = stripComments(text);
  const lines = clean.split('\n');
  const found = [];
  let inEnum = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;

    if (inEnum) {
      const closeIdx = raw.indexOf('}');
      collectEnumMembers(closeIdx === -1 ? raw : raw.slice(0, closeIdx), lineNo, found);
      if (closeIdx !== -1) inEnum = null;
      continue;
    }

    // operator overloads: native Float:operator*(...) = floatmul;
    let m = raw.match(/^\s*(native|stock|forward|public)\s+(?:const\s+)?(?:[A-Za-z_]\w*\s*:)?operator\s*([*+\-/%=!<>^&|~]+)/);
    if (m) {
      found.push({ name: 'operator' + m[2], kind: m[1], line: lineNo, signature: raw.trim() });
      continue;
    }

    m = raw.match(/^\s*(native|forward|public)\s+(?:(?:const|stock)\s+)*(?:[A-Za-z_]\w*\s*:)?(\w+)/);
    if (m) {
      found.push({ name: m[2], kind: m[1], line: lineNo, signature: raw.trim() });
      continue;
    }

    m = raw.match(/^\s*stock\s+(?:const\s+)?(?:[A-Za-z_]\w*\s*:)?(\w+)/);
    if (m) {
      const kind = /\(/.test(raw) ? 'stock' : 'stock const';
      found.push({ name: m[1], kind, line: lineNo, signature: raw.trim() });
      continue;
    }

    m = raw.match(/^\s*functag\s+(?:(?:public|native)\s+)?(\w+)/);
    if (m) {
      found.push({ name: m[1], kind: 'functag', line: lineNo, signature: raw.trim() });
      continue;
    }

    m = raw.match(/^\s*#define\s+(\w+)/);
    if (m) {
      found.push({ name: m[1], kind: 'define', line: lineNo, signature: raw.trim() });
      continue;
    }

    m = raw.match(/^\s*enum\s*(?:\(\s*[+\-*/=]+\s*\))?\s*(\w*)\s*\{/);
    if (m) {
      const name = m[1];
      const rest = raw.slice(raw.indexOf('{') + 1);
      const closeIdx = rest.indexOf('}');
      if (name) found.push({ name, kind: 'enum', line: lineNo, signature: raw.trim() });
      collectEnumMembers(closeIdx === -1 ? rest : rest.slice(0, closeIdx), lineNo, found);
      if (closeIdx === -1) inEnum = { name, lineNo };
      continue;
    }

    m = raw.match(/^\s*const\s+(\w+)(?:\[[^\]]*\])*\s*=/);
    if (m) {
      found.push({ name: m[1], kind: 'const', line: lineNo, signature: raw.trim() });
      continue;
    }

    m = raw.match(/^([A-Za-z_]\w*(?:\s*:\s*[A-Za-z_]\w*)?)\s*\([^)]*\)\s*\{/);
    if (m) {
      const name = m[1].split(':').pop().trim();
      if (name && !KEYWORDS.has(name)) {
        found.push({ name, kind: 'function', line: lineNo, signature: raw.trim() });
      }
    }
  }

  return found;
}

/**
 * Scan dirs and build { symbols: Map<name, [{file, line, kind, signature}]>, fileCount }.
 */
async function buildIndex(dirs, pattern = '**/*.{inc,sma}') {
  const symbolMap = new Map();
  let fileCount = 0;

  for (const dir of dirs) {
    let files;
    try {
      files = await glob(pattern, { cwd: dir, dot: false });
    } catch (_) {
      continue;
    }
    for (const rel of files) {
      fileCount++;
      let text;
      try {
        text = fs.readFileSync(path.join(dir, rel), 'utf8');
      } catch (_) {
        continue;
      }
      for (const s of parseInclude(text)) {
        const entry = { file: rel, line: s.line, kind: s.kind, signature: s.signature };
        if (!symbolMap.has(s.name)) symbolMap.set(s.name, []);
        symbolMap.get(s.name).push(entry);
      }
    }
  }

  return { symbols: symbolMap, fileCount };
}

/**
 * Search an index for a symbol.
 * Exact (case-sensitive) by default; `partial` does case-insensitive substring.
 */
function searchIndex(index, query, { partial = false } = {}) {
  const results = [];
  if (partial) {
    const q = query.toLowerCase();
    for (const [name, matches] of index.symbols) {
      if (name.toLowerCase().includes(q)) results.push({ name, matches });
    }
  } else if (index.symbols.has(query)) {
    results.push({ name: query, matches: index.symbols.get(query) });
  }
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

module.exports = { parseInclude, buildIndex, searchIndex };
