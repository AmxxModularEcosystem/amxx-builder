'use strict';

const fs   = require('fs');
const path = require('path');
const glob = require('fast-glob');
const yaml = require('js-yaml');

const { fetchDepRoot }  = require('./deps-resolver');
const { parseDocEntries, parseSkillEntries } = require('./manifest');
const { findManifestInDir } = require('./manifest-path');

/**
 * UTF-8 read that never throws. Binary files (NUL byte) and read errors are
 * returned as descriptive placeholder strings instead.
 *
 * @param {string} abs - absolute file path
 * @returns {string}
 */
function safeRead(abs) {
  try {
    const buf = fs.readFileSync(abs);
    const text = buf.toString('utf8');
    if (text.includes('\u0000')) return `[binary file, ${buf.length} bytes]`;
    return text;
  } catch (err) {
    return `[error reading file: ${err.message}]`;
  }
}

/**
 * Resolve a repo-relative path against the repo root, rejecting traversal.
 *
 * @param {string} rootDir - repo root (absolute)
 * @param {string} rel - declared relative path
 * @returns {string} absolute path
 */
function safeResolve(rootDir, rel) {
  const abs = path.resolve(rootDir, rel);
  if (abs !== rootDir && !abs.startsWith(rootDir + path.sep)) {
    throw new Error(`docs path escapes the repo root: "${rel}"`);
  }
  return abs;
}

function sortBundleFiles(files) {
  return files.sort((a, b) => {
    if (a === 'SKILL.md') return b === 'SKILL.md' ? 0 : -1;
    if (b === 'SKILL.md') return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * Resolve declared docs/skills against a repo root without reading content.
 *
 * Docs and single-file skills that do not exist land in `missing` (no throw);
 * directory skills are enumerated recursively (SKILL.md first). Paths that
 * escape rootDir throw.
 *
 * @param {{ docs?: Array<object>, skills?: Array<object> }} assets
 * @param {string} rootDir - absolute repo root
 * @returns {{ docs: Array<object>, skills: Array<object>, missing: string[] }}
 */
function resolveAssets({ docs, skills }, rootDir) {
  const docInputs   = Array.isArray(docs) ? docs : [];
  const skillInputs = Array.isArray(skills) ? skills : [];
  const outDocs     = [];
  const outSkills   = [];
  const missing     = [];

  for (const d of docInputs) {
    const abs = safeResolve(rootDir, d.file);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      outDocs.push({ name: d.name, description: d.description, file: d.file, abs });
    } else {
      missing.push(d.file);
    }
  }

  for (const s of skillInputs) {
    if (s.file) {
      const abs = safeResolve(rootDir, s.file);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        outSkills.push({ name: s.name, description: s.description, kind: 'file', file: s.file, dir: null, abs });
      } else {
        missing.push(s.file);
      }
      continue;
    }

    const abs = safeResolve(rootDir, s.dir);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      const files = sortBundleFiles(glob.sync('**/*', { cwd: abs, dot: false, onlyFiles: true }));
      outSkills.push({
        name: s.name,
        description: s.description,
        kind: 'dir',
        file: null,
        dir: s.dir,
        abs,
        files: files.map((rel) => ({ rel, abs: path.join(abs, rel) })),
      });
    } else {
      missing.push(s.dir);
    }
  }

  return { docs: outDocs, skills: outSkills, missing };
}

/**
 * Attach file contents to a resolved assets object.
 *
 * @param {{ docs: Array<object>, skills: Array<object>, missing: string[] }} resolved
 * @returns {{ docs: Array<object>, skills: Array<object>, missing: string[] }}
 */
function readAssets(resolved) {
  return {
    docs: resolved.docs.map((d) => ({ ...d, content: safeRead(d.abs) })),
    skills: resolved.skills.map((s) => {
      if (s.kind === 'dir') {
        return { ...s, files: s.files.map((f) => ({ rel: f.rel, content: safeRead(f.abs) })) };
      }
      return { ...s, content: safeRead(s.abs) };
    }),
    missing: resolved.missing,
  };
}

/**
 * Fetch a dependency and read its own manifest, if any.
 *
 * Lenient: absence or unparseable YAML yields `manifestPath: null, raw: null`
 * rather than throwing. `fetchRoot` is a test seam.
 *
 * @param {object} dep - parsed dep object
 * @param {object} [opts]
 * @param {string} [opts.token]
 * @param {boolean} [opts.noFetch]
 * @param {boolean} [opts.ssh]
 * @param {Function} [opts.fetchRoot]
 * @returns {Promise<{ label: string, rootDir: string, manifestPath: string|null, raw: object|null }>}
 */
async function readDepManifest(dep, { token, noFetch, ssh, fetchRoot } = {}) {
  const fetch = fetchRoot || fetchDepRoot;
  const { rootDir, label } = await fetch(dep, { token, noFetch, ssh });

  const manifestPath = findManifestInDir(rootDir);
  let raw = null;
  if (manifestPath) {
    try {
      raw = yaml.load(fs.readFileSync(manifestPath, 'utf8')) || null;
    } catch (_) {
      raw = null;
    }
  }
  return { label, rootDir, manifestPath, raw };
}

/**
 * Fetch a dependency and collect its declared agent docs/skills with content.
 *
 * @param {object} dep - parsed dep object
 * @param {object} [opts] - same options as readDepManifest
 * @returns {Promise<{ label: string, manifestPath: string|null, manifestName: string|null, docs: Array<object>, skills: Array<object>, missing: string[] }>}
 */
async function collectDepAssets(dep, opts) {
  const m = await readDepManifest(dep, opts);
  if (!m.raw) {
    return { label: m.label, manifestPath: null, manifestName: null, docs: [], skills: [], missing: [] };
  }

  let docs;
  let skills;
  try { docs = parseDocEntries(m.raw.docs || []); } catch (_) { docs = []; }
  try { skills = parseSkillEntries(m.raw.skills || []); } catch (_) { skills = []; }

  const read = readAssets(resolveAssets({ docs, skills }, m.rootDir));
  return {
    label: m.label,
    manifestPath: m.manifestPath,
    manifestName: m.raw.name || null,
    docs: read.docs,
    skills: read.skills,
    missing: read.missing,
  };
}

/**
 * Collect the local project's declared agent docs/skills with content.
 *
 * @param {object} manifest - parsed manifest (uses `manifest._path` for the root)
 * @returns {{ docs: Array<object>, skills: Array<object>, missing: string[] }}
 */
function collectLocalAssets(manifest) {
  const rootDir = path.dirname(manifest._path);
  return readAssets(resolveAssets({ docs: manifest.docs, skills: manifest.skills }, rootDir));
}

module.exports = {
  resolveAssets,
  readAssets,
  readDepManifest,
  collectDepAssets,
  collectLocalAssets,
};
