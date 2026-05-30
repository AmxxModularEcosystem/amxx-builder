'use strict';

const fs   = require('fs');
const path = require('path');

// Matches: #include <file>  #include "file"  #tryinclude variants
const RE_INCLUDE = /^[ \t]*#(?:try)?include[ \t]+([<"])([^>"]+)[>"][ \t]*(?:\/\/.*)?$/gm;

function extractIncludes(filePath) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return []; }
  const result = [];
  let m;
  RE_INCLUDE.lastIndex = 0;
  while ((m = RE_INCLUDE.exec(content)) !== null) {
    result.push({ name: m[2].trim(), isAngle: m[1] === '<' });
  }
  return result;
}

class DepGraph {
  constructor(includeDirs) {
    // includeDirs: ordered list of dirs to search for <angle> includes
    this._includeDirs = includeDirs;
    // absPath → Set<absPath>: direct includes of each file
    this._deps = new Map();
    this._parsed = new Set();
  }

  // Parse a file and all its includes recursively. Safe to call multiple times.
  parseFile(absPath) {
    if (this._parsed.has(absPath)) return;
    this._parsed.add(absPath);
    if (!fs.existsSync(absPath)) return;

    const directs = new Set();
    for (const { name, isAngle } of extractIncludes(absPath)) {
      const resolved = this._resolve(absPath, name, isAngle);
      if (resolved) {
        directs.add(resolved);
        this.parseFile(resolved);
      }
    }
    this._deps.set(absPath, directs);
  }

  // Re-parse a changed file (drops stale edges, keeps the rest of the graph).
  update(absPath) {
    this._parsed.delete(absPath);
    this._deps.delete(absPath);
    this.parseFile(absPath);
  }

  // Returns Set<absPath> of .sma files that transitively depend on incPath.
  getSmasDependingOn(incPath) {
    const smas    = new Set();
    const visited = new Set();

    const visit = (target) => {
      if (visited.has(target)) return;
      visited.add(target);
      for (const [file, deps] of this._deps) {
        if (!deps.has(target)) continue;
        if (file.endsWith('.sma')) smas.add(file);
        else visit(file); // .inc depending on .inc — traverse upward
      }
    };

    visit(incPath);
    return smas;
  }

  _resolve(fromFile, name, isAngle) {
    const withExt = /\.inc$/i.test(name) ? name : name + '.inc';

    if (!isAngle) {
      // "quoted" → relative to current file's directory first
      const rel = path.resolve(path.dirname(fromFile), withExt);
      if (fs.existsSync(rel)) return rel;
    }

    // <angle> or fallback: search include dirs in order
    for (const dir of this._includeDirs) {
      const full = path.join(dir, withExt);
      if (fs.existsSync(full)) return full;
    }

    return null; // system / external include — not tracked
  }
}

module.exports = { DepGraph };
