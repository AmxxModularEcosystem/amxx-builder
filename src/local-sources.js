/**
 * Local sources: let `repos:` / `deps:` entries be satisfied by a local
 * directory instead of GitHub, and let an env var redirect existing entries to
 * local dirs without editing the manifest.
 *
 * Two ways to point an entry at a local dir:
 *
 *   1. Declared in the manifest — a repo/dep entry with `source: local` carries
 *      `_localPathRaw` after parsing. `applyLocalOverrides` resolves it to an
 *      absolute `_localDir`.
 *   2. Redirected by env — `AMXB_LOCAL_SOURCES` maps an entry's logical id
 *      (`owner/repo` or `local/<name>`) to a path, overriding whatever the
 *      manifest declared. `AMXB_LOCAL_STRICT=1` turns an id with no matching
 *      entry from a warning into an error.
 *
 * Runtime discrimination is `entry._localDir` — consumers branch on it, not on
 * the `source` field. `_resolvedRef` is set to the sentinel `'local'` so the
 * shared dep-dedup / cache-key logic keeps working unchanged.
 *
 * Dependency-light on purpose: this module is imported by `./manifest`, so it
 * must NOT top-level require `./manifest` or `./deps-resolver` (cycle).
 */

const fs   = require('fs');
const path = require('path');

const logger = require('./logger');

const ENV_VAR        = 'AMXB_LOCAL_SOURCES';
const STRICT_VAR     = 'AMXB_LOCAL_STRICT';
const LOCAL_ID_PREFIX = 'local/';

/**
 * Normalize a logical id for map lookups. Local copy of deps-resolver's
 * `normalize` — a top-level require of that module would create a cycle.
 *
 * @param {*} id
 * @returns {string}
 */
function normalizeId(id) {
  return String(id).toLowerCase();
}

/**
 * True when an entry has been resolved to a local directory.
 *
 * @param {object} entry — a repo/dep config
 * @returns {boolean}
 */
function isLocal(entry) {
  return !!entry && typeof entry._localDir === 'string' && !!entry._localDir;
}

/**
 * The absolute local directory of an entry, or null when it is not local.
 *
 * @param {object} entry — a repo/dep config
 * @returns {string|null}
 */
function localDirOf(entry) {
  return (entry && entry._localDir) || null;
}

/**
 * Build the synthetic logical id for a local repo/dep. Uses the explicit
 * `name` when provided, otherwise the path's basename — mirroring how the
 * fungun parser synthesizes `fungun.net/<id>` so shared dedup/cache-key logic
 * keeps working.
 *
 * @param {*} name — explicit name (optional)
 * @param {string} rawPath — the local path
 * @returns {string}
 */
function synthesizeLocalId(name, rawPath) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed !== '') return LOCAL_ID_PREFIX + trimmed;
  return LOCAL_ID_PREFIX + path.basename(String(rawPath));
}

/**
 * Resolve a manifest-relative (or absolute) local path to an absolute,
 * normalized path.
 *
 * @param {string} manifestDir — directory containing the manifest
 * @param {string} p — path from the manifest / env
 * @returns {string}
 */
function resolveLocalPath(manifestDir, p) {
  const str = String(p);
  return path.isAbsolute(str) ? path.normalize(str) : path.resolve(manifestDir, str);
}

/**
 * Parse `AMXB_LOCAL_SOURCES` into an id → path map.
 *
 * Accepted shapes:
 *   - JSON object: `{"owner/repo": "path", ...}` (only when the trimmed value
 *     starts with `{`)
 *   - `id=path` pairs separated by `;` or newlines; blank lines and `#`
 *     comments are skipped.
 *
 * Invalid input is collected in `errors` — this function never throws.
 *
 * @param {object} [env] — environment map (default: process.env)
 * @returns {{ map: Map<string, string>, strict: boolean, errors: string[] }}
 */
function parseLocalSourcesEnv(env = process.env) {
  const map    = new Map();
  const errors = [];
  const value  = env[ENV_VAR] == null ? '' : String(env[ENV_VAR]);
  const trimmed = value.trim();

  if (trimmed !== '') {
    if (trimmed.startsWith('{')) {
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        errors.push(`Invalid JSON in ${ENV_VAR}: ${err.message}`);
      }
      if (parsed !== undefined) {
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          errors.push(`${ENV_VAR}: JSON value must be an object of "id": "path" pairs`);
        } else {
          for (const [key, val] of Object.entries(parsed)) {
            const id = normalizeId(key).trim();
            if (id === '') {
              errors.push(`${ENV_VAR}: entry has an empty id`);
              continue;
            }
            if (typeof val !== 'string' || val.trim() === '') {
              errors.push(`${ENV_VAR}: value for "${key}" must be a non-empty string path`);
              continue;
            }
            map.set(id, val.trim());
          }
        }
      }
    } else {
      for (const rawEntry of trimmed.split(/\n|;/)) {
        const entry = rawEntry.trim();
        if (entry === '' || entry.startsWith('#')) continue;
        const eqIdx = entry.indexOf('=');
        if (eqIdx === -1) {
          errors.push(`${ENV_VAR}: invalid entry "${entry}" (expected id=path)`);
          continue;
        }
        const id = normalizeId(entry.slice(0, eqIdx)).trim();
        const p  = entry.slice(eqIdx + 1).trim();
        if (id === '' || p === '') {
          errors.push(`${ENV_VAR}: invalid entry "${entry}" (id and path must be non-empty)`);
          continue;
        }
        map.set(id, p);
      }
    }
  }

  const strict = ['1', 'true'].includes(String(env[STRICT_VAR]).toLowerCase());
  return { map, strict, errors };
}

/**
 * Throw a uniform error when a resolved local path is missing or not a dir.
 *
 * @param {string} absPath
 * @param {string} id
 * @param {string} context — human-readable note appended to the message
 */
function assertLocalDir(absPath, id, context) {
  let stat = null;
  try { stat = fs.statSync(absPath); } catch { /* missing */ }
  if (!stat || !stat.isDirectory()) {
    throw new Error(
      `Local source for "${id}" not found or not a directory: ${absPath} ${context}`
    );
  }
}

/**
 * Collect every repo/dep entry that can carry a local path: manifest repos,
 * manifest global deps, and each repo's `deps_override` entries. `makeRepo`
 * parses `deps_override` through `parseDepsLines` → `parseLocalDepObject`, so a
 * local dep there carries `_localPathRaw` exactly like a global one — it must be
 * resolved too, or consumers fall through to the git branch.
 *
 * `DEPS_LIST` files are string-only and git-only — deliberately not included.
 *
 * @param {object} manifest
 * @returns {object[]}
 */
function localCandidateEntries(manifest) {
  const repos = Array.isArray(manifest.repos) ? manifest.repos : [];
  const entries = [
    ...repos,
    ...(Array.isArray(manifest.globalDeps) ? manifest.globalDeps : []),
  ];
  for (const repo of repos) {
    if (repo && Array.isArray(repo.deps_override)) entries.push(...repo.deps_override);
  }
  return entries;
}

/**
 * Resolve a parsed entry's declared `_localPathRaw` against `baseDir`, assert
 * the directory exists, and mark it local. Idempotent: an entry already local
 * (`_localDir` set) is returned untouched, and an entry with no declared path is
 * a no-op.
 *
 * Single source of truth for interfaces (MCP, serve) that receive an ad-hoc dep
 * object with `source: local` + `path` — they must not re-implement path handling.
 *
 * @param {object} entry — a parsed repo/dep config (may carry `_localPathRaw`)
 * @param {string} baseDir — directory the raw path is relative to
 * @returns {object} the same entry
 */
function resolveLocalEntry(entry, baseDir) {
  if (!entry || entry._localPathRaw == null || isLocal(entry)) return entry;
  const absPath = resolveLocalPath(baseDir, entry._localPathRaw);
  assertLocalDir(absPath, entry.repo, '(local source)');
  entry._localDir    = absPath;
  entry._resolvedRef = 'local';
  return entry;
}

/**
 * Throw when one logical id is claimed by two local entries pointing at
 * DIFFERENT directories. Two entries resolving to the same directory are a
 * harmless dedup (the build treats them as one source); different dirs mean one
 * source would be silently dropped — the synthetic `local/<name>` id collided,
 * so the user must give one a unique `name`.
 *
 * @param {object[]} entries
 */
function assertUniqueLocalIds(entries) {
  const byId = new Map();
  for (const entry of entries) {
    if (!entry || !entry.repo || !isLocal(entry)) continue;
    const id = normalizeId(entry.repo);
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(entry);
  }
  for (const [id, group] of byId) {
    const dirs = [...new Set(group.map((e) => e._localDir))].sort();
    if (dirs.length > 1) {
      throw new Error(
        `Duplicate local source id "${id}": ${dirs.map((d) => `"${d}"`).join(' and ')} ` +
        `are different directories — set a unique "name" on one of them.`
      );
    }
  }
}

/**
 * Resolve declared local paths to absolute `_localDir`s and apply env
 * redirects. Mutates `manifest` in place and returns it.
 *
 * Precedence (highest first):
 *   1. `AMXB_LOCAL_SOURCES` redirect for the entry's logical id
 *   2. the entry's own declared `_localPathRaw`
 *
 * Env is parsed before resolution so a redirect can rescue a stale/missing
 * declared path. Unknown env ids are fatal under `AMXB_LOCAL_STRICT=1` (a
 * warning otherwise), and duplicate synthetic ids pointing at different dirs
 * are rejected.
 *
 * @param {object} manifest — parsed manifest (must carry `_path`)
 * @param {object} [env] — environment map (default: process.env)
 * @returns {object} the same manifest
 */
function applyLocalOverrides(manifest, env = process.env) {
  const manifestDir = path.dirname(manifest._path);
  const entries = localCandidateEntries(manifest);

  // Parse env first: a redirect must win over (and thus avoid asserting) a
  // declared path that no longer exists.
  const { map, strict, errors } = parseLocalSourcesEnv(env);
  for (const message of errors) logger.warn(message);

  // Unknown env ids keep their strict/warn behaviour. Known ids are collected
  // from every repo/dep entry, including deps_override.
  const knownIds = new Set();
  for (const entry of entries) {
    if (entry && entry.repo) knownIds.add(normalizeId(entry.repo));
  }
  for (const id of map.keys()) {
    if (knownIds.has(id)) continue;
    if (strict) {
      throw new Error(
        `No repo/dep with id "${id}" in this manifest (${STRICT_VAR} is set)`
      );
    }
    logger.warn(`no repo/dep with id ${id} in this manifest — ignored`);
  }

  // Resolve each entry: env redirect (highest precedence) over declared path.
  for (const entry of entries) {
    if (!entry || !entry.repo) continue;
    const id = normalizeId(entry.repo);

    const envPath = map.get(id);
    if (envPath != null) {
      const absPath = resolveLocalPath(manifestDir, envPath);
      assertLocalDir(absPath, id, `(${ENV_VAR})`);
      entry._localDir    = absPath;
      entry._resolvedRef = 'local';
      logger.warn(`${ENV_VAR}: ${id} -> ${absPath} (local override)`);
      continue;
    }

    if (entry._localPathRaw == null) continue;
    const absPath = resolveLocalPath(manifestDir, entry._localPathRaw);
    assertLocalDir(absPath, entry.repo, '(declared in manifest)');
    entry._localDir    = absPath;
    entry._resolvedRef = 'local';
  }

  assertUniqueLocalIds(entries);

  return manifest;
}

/**
 * Ensure an entry's directory exists locally and return its path.
 *
 * Local entries short-circuit to `_localDir` — no network, no `--no-fetch`
 * check. Non-local entries delegate to the repo fetcher (lazy-required to
 * avoid a cycle: repo-fetcher/deps-resolver import each other).
 *
 * @param {object} repoConfig — a repo/dep config
 * @param {object} [opts]
 * @param {string|null} [opts.token]
 * @param {boolean} [opts.noFetch]
 * @param {boolean} [opts.ssh]
 * @returns {Promise<string>} absolute directory path
 */
async function ensureRepoDir(repoConfig, { token, noFetch, ssh } = {}) {
  if (isLocal(repoConfig)) return repoConfig._localDir;

  // Lazy require: keep this module dependency-light and cycle-free.
  const { fetchRepo } = require('./repo-fetcher');
  const ref = repoConfig._resolvedRef ?? repoConfig.ref ?? null;
  return fetchRepo(repoConfig.repo, ref, token, noFetch, ssh);
}

module.exports = {
  ENV_VAR,
  STRICT_VAR,
  LOCAL_ID_PREFIX,
  normalizeId,
  isLocal,
  localDirOf,
  synthesizeLocalId,
  resolveLocalPath,
  resolveLocalEntry,
  parseLocalSourcesEnv,
  applyLocalOverrides,
  ensureRepoDir,
};
