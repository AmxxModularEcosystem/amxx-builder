const fs   = require('fs');
const yaml = require('js-yaml');
const path = require('path');

const { validateManifest: validateSchema } = require('./schema');

const DEFAULTS_PATH  = path.join(__dirname, '..', 'defaults', 'amxbuild.defaults.yml');

function loadDefaultsRaw() {
  if (!fs.existsSync(DEFAULTS_PATH)) return {};
  return yaml.load(fs.readFileSync(DEFAULTS_PATH, 'utf8')) || {};
}

function deepMerge(base, overlay) {
  if (overlay === null || overlay === undefined) return base;
  if (base  === null || base  === undefined) return overlay;
  if (Array.isArray(overlay)) return overlay;
  if (typeof overlay === 'object' && typeof base === 'object') {
    const result = { ...base };
    for (const [k, v] of Object.entries(overlay)) {
      result[k] = deepMerge(base[k], v);
    }
    return result;
  }
  return overlay;
}

function validateManifest(raw) {
  const result = validateSchema(raw);
  if (!result.valid) {
    const errors = result.errors.map(e => `  ${e.path}: ${e.message}`);
    throw new Error(`Manifest validation failed:\n${errors.join('\n')}`);
  }
}

function parseManifest(manifestPath) {
  const absPath = path.resolve(manifestPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Manifest not found: ${absPath}\n  → Run "amxb init" to create one`);
  }

  const projectRaw = yaml.load(fs.readFileSync(absPath, 'utf8'));
  const raw = deepMerge(loadDefaultsRaw(), projectRaw);
  validateManifest(raw);

  if (!raw.name) throw new Error('manifest: missing required field "name"');

  const platform = parsePlatform(raw.platform);
  const gh       = raw.github || {};
  const tokenEnv = gh.token_env || 'GITHUB_TOKEN';
  const token    = process.env[tokenEnv] || null;
  const ssh      = !!gh.ssh;
  const tokens   = parseTokenMap(gh.tokens);

  const globalPostfix = raw.plugins_ini_postfix != null ? String(raw.plugins_ini_postfix) : '';
  const globalAmxDir  = (raw.amxmodx && raw.amxmodx.dir) || 'amxmodx';
  const globalDeps    = parseDepsLines(raw.deps || []);

  const repos  = (raw.repos || []).map((r) => parseRepoEntry(r, globalPostfix, globalAmxDir));
  const output = raw.output || {};

  return {
    _path:    absPath,
    name:     raw.name,
    version:  parseVersion(raw.version),
    platform,
    amxmodx: {
      version: (raw.amxmodx && raw.amxmodx.version) ? String(raw.amxmodx.version) : null,
      dir:     globalAmxDir,
      defines: (raw.amxmodx && Array.isArray(raw.amxmodx.defines))
        ? raw.amxmodx.defines.map(String)
        : [],
    },
    github: { token_env: tokenEnv, tokens, token, ssh },
    globalDeps,
    globalPostfix,
    repos,
    assets:      parseAssets(raw.assets || {}),
    pluginRules: parsePluginRules(raw.plugins || []),
    deploy:      parseDeploy(raw),
    output: {
      dir:          String(output.dir),
      archive_name: String(output.archive_name),
      amxmodx_path: String(output.amxmodx_path),
      assets_path:  output.assets_path != null ? String(output.assets_path) : '',
      readme:       Boolean(output.readme),
      generate_ini: Boolean(output.generate_ini),
      pack:         Boolean(output.pack),
      on_conflict:  validateOnConflict(output.on_conflict),
    },
  };
}

function parseVersion(val) {
  if (typeof val !== 'string') {
    throw new Error(`manifest: "version" must be a string — wrap it in quotes: version: "${val}"`);
  }
  return val;
}

function validateOnConflict(val) {
  const valid = ['last_wins', 'first_wins', 'error'];
  if (val == null) return 'last_wins';
  if (!valid.includes(val)) {
    throw new Error(`manifest: output.on_conflict must be one of: ${valid.join(', ')}`);
  }
  return val;
}

function parseTokenMap(map) {
  if (map == null) return {};
  if (typeof map !== 'object' || Array.isArray(map)) {
    throw new Error(`manifest: github.tokens must be a map of owner → env var name`);
  }
  const result = {};
  for (const [owner, envName] of Object.entries(map)) {
    if (envName == null || String(envName).trim() === '') {
      throw new Error(`manifest: github.tokens.${owner} must name an env variable`);
    }
    result[String(owner).trim()] = interpolateEnv(String(envName).trim());
  }
  return result;
}

/**
 * Resolve the GitHub token for a specific "owner/repo" path.
 *
 * Priority:
 *   1. github.tokens[owner]   — per-owner env var (e.g. GITHUB_TOKEN_ORGA)
 *   2. github.token_env       — global token env var (default "GITHUB_TOKEN")
 *   3. null                   — anonymous (public repos)
 *
 * @param {object} manifest — parsed manifest
 * @param {string} repoPath — "owner/repo" or any string starting with the owner
 * @returns {string|null}
 */
function resolveGithubToken(manifest, repoPath) {
  const gh     = manifest.github || {};
  const owner  = String(repoPath || '').split('/')[0];
  const envName = (gh.tokens && gh.tokens[owner]) || gh.token_env || 'GITHUB_TOKEN';
  return process.env[envName] || null;
}

function parseRepoEntry(r, globalPostfix, globalAmxDir) {
  // Shorthand: "owner/repo" or "owner/repo@ref"
  if (typeof r === 'string') {
    const atIdx = r.indexOf('@');
    const repo  = atIdx === -1 ? r.trim() : r.slice(0, atIdx).trim();
    const ref   = atIdx === -1 ? null     : r.slice(atIdx + 1).trim() || null;
    return makeRepo({ repo, ref }, globalPostfix, globalAmxDir);
  }
  if (!r.repo) throw new Error(`manifest: repo entry missing "repo" field: ${JSON.stringify(r)}`);
  return makeRepo(r, globalPostfix, globalAmxDir);
}

function makeRepo(r, globalPostfix, globalAmxDir) {
  return {
    repo:                r.repo,
    ref:                 r.ref || null,
    amxmodx_dir:         r.amxmodx_dir || globalAmxDir,
    plugins_ini_postfix: r.plugins_ini_postfix != null ? String(r.plugins_ini_postfix) : globalPostfix,
    exclude:             r.exclude       || [],
    exclude_files:       r.exclude_files || [],
    deps_override:       r.deps_override ? parseDepsLines(r.deps_override) : null,
  };
}

/**
 * Dep string shorthand: "owner/repo@ref[:include_path]".
 * Strict — rejects internal whitespace in the repo and ref parts.
 */
const DEP_STRING_RE = /^([^@\s]+)@([^:\s]+)(?::(.+))?$/;

/**
 * Normalize a `docs` value (long-form dep entries only) to an array of
 * trimmed, non-empty doc paths, or null when nothing is specified.
 *
 * @param {*} val
 * @returns {string[]|null}
 */
function normalizeDocs(val) {
  if (val == null) return null;
  const list = Array.isArray(val) ? val.map(String) : [String(val)];
  const trimmed = list.map((s) => s.trim()).filter(Boolean);
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parse a long-form dep object (manifest `deps` entries).
 *
 * @param {object} line
 * @returns {{ repo: string, ref: string, include_path: string|null, source: string, asset: *, docs: string[]|null }}
 */
function parseDepObject(line) {
  if (!line.repo) throw new Error(`Dep entry missing "repo": ${JSON.stringify(line)}`);
  if (!line.ref)  throw new Error(`Dep entry missing "ref": ${JSON.stringify(line)}`);
  const source = line.source || 'git';
  if (!['git', 'release'].includes(source)) {
    throw new Error(`Dep entry "source" must be "git" or "release": ${JSON.stringify(line)}`);
  }
  return {
    repo:         String(line.repo).trim(),
    ref:          String(line.ref).trim(),
    include_path: line.include_path ? String(line.include_path).trim() : null,
    source,
    asset:        line.asset != null ? line.asset : null,
    docs:         normalizeDocs(line.docs),
  };
}

/**
 * Strict parse of a SINGLE dep string: "owner/repo@ref[:include_path]".
 *
 * @param {string} str
 * @returns {{ repo: string, ref: string, include_path: string|null, source: string, asset: null }}
 */
function parseDepString(str) {
  const trimmed = String(str).trim();
  const match = trimmed.match(DEP_STRING_RE);
  if (!trimmed || !match) {
    throw new Error(
      `Invalid dep string: "${trimmed}". Expected format: "owner/repo@ref" or "owner/repo@ref:include_path"`
    );
  }
  const [, repo, ref, includePath] = match;
  return {
    repo:         repo.trim(),
    ref:          ref.trim(),
    include_path: includePath ? includePath.trim() : null,
    source:       'git',
    asset:        null,
  };
}

function parseDepsLines(lines) {
  const result = [];
  for (const line of lines) {
    // Long-form object (manifest only — DEPS_LIST files are always strings)
    if (line && typeof line === 'object') {
      result.push(parseDepObject(line));
      continue;
    }
    // Short-form string: "owner/repo@ref[:include_path]"  (always git)
    const trimmed = String(line).trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(DEP_STRING_RE);
    if (!match) throw new Error(`Invalid dep entry: "${trimmed}"`);
    const [, repoPath, ref, includePath] = match;
    result.push({
      repo:         repoPath.trim(),
      ref:          ref.trim(),
      include_path: includePath ? includePath.trim() : null,
      source:       'git',
      asset:        null,
    });
  }
  return result;
}

function parsePlatform(val) {
  const valid = ['linux', 'windows', 'mac'];
  if (val == null) return null; // null = auto-detect host at runtime
  if (!valid.includes(val)) throw new Error(`manifest: platform must be one of: ${valid.join(', ')}`);
  return val;
}

function parseAssets(raw) {
  const valid = ['last_wins', 'first_wins'];
  const onConflict = raw.on_conflict || 'last_wins';
  if (!valid.includes(onConflict)) {
    throw new Error(`manifest: assets.on_conflict must be one of: ${valid.join(', ')}`);
  }
  return {
    on_conflict: onConflict,
    sources: (raw.sources || []).map(parseAssetSource),
  };
}

function parseAssetSource(s) {
  if (s.source === 'local') {
    return { type: 'local', map: parseAssetMap(s) };
  }
  if (s.source === 'amxmodx') {
    return { type: 'amxmodx', map: parseAssetMap(s), cache: parseAssetCache(s.cache) };
  }
  if (s.source === 'release') {
    if (!s.repo) throw new Error(`asset source: release requires "repo": ${JSON.stringify(s)}`);
    if (!s.ref)  throw new Error(`asset source: release requires "ref": ${JSON.stringify(s)}`);
    return {
      type:  'release',
      repo:  String(s.repo).trim(),
      ref:   String(s.ref).trim(),
      asset: s.asset != null ? s.asset : null,
      map:   parseAssetMap(s),
    };
  }
  if (!s.url) throw new Error(`asset source missing "url" or "source": ${JSON.stringify(s)}`);
  return { type: 'url', url: s.url, map: parseAssetMap(s), cache: parseAssetCache(s.cache) };
}

function parseAssetMap(s) {
  if (s.map) return s.map.map(e => ({ from: e.from || null, to: e.to || null }));
  return [{ from: s.from || null, to: s.to || null }];
}

function parseAssetCache(val) {
  const valid = ['none', 'local', 'global'];
  if (val == null) return 'none';
  if (!valid.includes(val)) throw new Error(`asset source cache must be one of: ${valid.join(', ')}`);
  return val;
}

function parsePluginRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules.map((r, i) => {
    if (!r.match) throw new Error(`plugins[${i}]: missing "match" field`);
    const ini = r.ini === false ? false : (r.ini != null ? String(r.ini) : null);
    return {
      match:   String(r.match),
      enabled: r.enabled !== false,
      ini,
    };
  });
}

function interpolateEnv(val) {
  if (typeof val !== 'string') return val;
  return val.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? '');
}

function parseDeploy(raw) {
  const d = raw.deploy || {};
  const r = d.rcon || {};
  return {
    path:              interpolateEnv(d.path)         || process.env.AMXB_DEPLOY_PATH         || null,
    amxmodx_path:      interpolateEnv(d.amxmodx_path) || null,
    assets_path:       interpolateEnv(d.assets_path)  ?? null,
    watch_debounce_ms: Number(d.watch_debounce_ms),
    exclude:           Array.isArray(d.exclude) ? d.exclude.map(String) : [],
    rcon: {
      host:     interpolateEnv(r.host)     || process.env.AMXB_DEPLOY_RCON_HOST     || null,
      port:     Number(r.port || process.env.AMXB_DEPLOY_RCON_PORT),
      password: interpolateEnv(r.password) || process.env.AMXB_DEPLOY_RCON_PASSWORD || null,
      command:  interpolateEnv(r.command)  || process.env.AMXB_DEPLOY_RCON_CMD      || null,
    },
  };
}

// ─── Manifest overrides ────────────────────────────────────────────────────────

function applyOverrides(manifest, pairs) {
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) throw new Error(`--set: invalid format "${pair}" (expected key=value)`);
    const keys  = pair.slice(0, eqIdx).trim().split('.');
    const value = parseOverrideValue(pair.slice(eqIdx + 1));
    let node = manifest;
    for (let i = 0; i < keys.length - 1; i++) {
      if (node[keys[i]] == null) node[keys[i]] = {};
      node = node[keys[i]];
    }
    node[keys[keys.length - 1]] = value;
  }
}

function parseOverrideValue(str) {
  if (str === 'true')  return true;
  if (str === 'false') return false;
  if (str === 'null')  return null;
  if (/^\d+$/.test(str)) return parseInt(str, 10);
  return str;
}

function resolveManifest(manifestPath, options = {}) {
  const manifest = parseManifest(manifestPath);

  if (options.set && options.set.length > 0) {
    applyOverrides(manifest, options.set);
  }

  if (options.define && options.define.length > 0) {
    manifest.amxmodx.defines.push(...options.define);
  }

  return manifest;
}

module.exports = { parseManifest, parseDepsLines, parseDepString, parseDepObject, normalizeDocs, applyOverrides, parseOverrideValue, resolveManifest, resolveGithubToken, loadDefaultsRaw, deepMerge };
