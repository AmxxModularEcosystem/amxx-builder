const fs   = require('fs');
const yaml = require('js-yaml');
const path = require('path');

const { validateManifest: validateSchema } = require('./schema');
const { parsePluginRef } = require('./fungun-fetcher');
const { synthesizeLocalId, applyLocalOverrides } = require('./local-sources');

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

  const globalAmxDir  = (raw.amxmodx && raw.amxmodx.dir) || 'amxmodx';
  const globalDeps    = parseDepsLines(raw.deps || []);

  const repos  = (raw.repos || []).map((r) => parseRepoEntry(r, globalAmxDir));
  const output = raw.output || {};

  const manifest = {
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
    repos,
    assets:      parseAssets(raw.assets || {}),
    plugins:     parsePlugins(raw.plugins),
    // DEPRECATED (remove in v2): legacy raw ini inputs, kept verbatim for
    // detection/adaptation in finalizePluginConfig. Never derived.
    plugins_ini_postfix: raw.plugins_ini_postfix != null ? String(raw.plugins_ini_postfix) : null,
    docs:        parseDocEntries(raw.docs || []),
    skills:      parseSkillEntries(raw.skills || []),
    deploy:      parseDeploy(raw),
    output: {
      dir:          String(output.dir),
      archive_name: String(output.archive_name),
      amxmodx_path: String(output.amxmodx_path),
      assets_path:  output.assets_path != null ? String(output.assets_path) : '',
      readme:       Boolean(output.readme),
      // DEPRECATED (remove in v2): legacy raw input only — never derived.
      generate_ini: Boolean(output.generate_ini),
      pack:         Boolean(output.pack),
      on_conflict:  validateOnConflict(output.on_conflict),
    },
  };

  applyLocalOverrides(manifest, process.env);
  finalizePluginConfig(manifest);
  return manifest;
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

function parseRepoEntry(r, globalAmxDir) {
  // Shorthand: "owner/repo" or "owner/repo@ref"
  if (typeof r === 'string') {
    const atIdx = r.indexOf('@');
    const repo  = atIdx === -1 ? r.trim() : r.slice(0, atIdx).trim();
    const ref   = atIdx === -1 ? null     : r.slice(atIdx + 1).trim() || null;
    return makeRepo({ repo, ref }, globalAmxDir);
  }
  if (r && r.source === 'local') return makeRepo(r, globalAmxDir);
  if (!r.repo) throw new Error(`manifest: repo entry missing "repo" field: ${JSON.stringify(r)}`);
  return makeRepo(r, globalAmxDir);
}

function makeRepo(r, globalAmxDir) {
  const plugins = r.plugins != null ? parsePluginSettings(r.plugins) : null;
  // DEPRECATED (remove in v2): kept raw; the global plugins_ini_postfix is no
  // longer injected here — only the repo's own explicit value survives.
  const postfix = r.plugins_ini_postfix != null ? String(r.plugins_ini_postfix) : null;
  if (r.source === 'local') {
    if (typeof r.path !== 'string' || r.path.trim() === '') {
      throw new Error('manifest: repo entry source "local" requires "path"');
    }
    if (r.repo != null) throw new Error('manifest: repo entry source "local" does not support "repo"');
    if (r.ref  != null) throw new Error('manifest: repo entry source "local" does not support "ref"');
    return {
      repo:                synthesizeLocalId(r.name, r.path),
      ref:                 null,
      source:              'local',
      amxmodx_dir:         r.amxmodx_dir || globalAmxDir,
      plugins,
      plugins_ini_postfix: postfix,
      exclude:             r.exclude       || [],
      exclude_files:       r.exclude_files || [],
      deps_override:       r.deps_override ? parseDepsLines(r.deps_override) : null,
      _localPathRaw:       r.path,
    };
  }
  return {
    repo:                r.repo,
    ref:                 r.ref || null,
    amxmodx_dir:         r.amxmodx_dir || globalAmxDir,
    plugins,
    plugins_ini_postfix: postfix,
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
 * Parse a long-form dep object (manifest `deps` entries).
 *
 * git / release entries: `{ repo, ref, source?, include_path?, asset? }`
 * fungun entries:        `{ source: 'fungun', id: <index> }` or
 *                        `{ source: 'fungun', url: <page link> }`
 *
 * @param {object} line
 * @returns {{ repo: string, ref: string|null, include_path: string|null, source: string, asset: * }}
 */
function parseDepObject(line) {
  const source = line.source || 'git';

  if (source === 'local')  return parseLocalDepObject(line);
  if (source === 'fungun') return parseFungunDepObject(line);

  if (!['git', 'release'].includes(source)) {
    throw new Error(`Dep entry "source" must be "git", "release", "fungun" or "local": ${JSON.stringify(line)}`);
  }
  if (line.id != null || line.url != null) {
    throw new Error(`Dep entry "id"/"url" are only valid with "source: fungun": ${JSON.stringify(line)}`);
  }
  if (!line.repo) throw new Error(`Dep entry missing "repo": ${JSON.stringify(line)}`);
  if (!line.ref)  throw new Error(`Dep entry missing "ref": ${JSON.stringify(line)}`);
  return {
    repo:         String(line.repo).trim(),
    ref:          String(line.ref).trim(),
    include_path: line.include_path ? String(line.include_path).trim() : null,
    source,
    asset:        line.asset != null ? line.asset : null,
  };
}

/**
 * Parse a long-form local dep. The `.inc` files come from a directory next to
 * the manifest (or an absolute path) instead of GitHub. The parsed object
 * carries a synthetic stable `repo` (`local/<name>`) so shared dep-dedup /
 * dest-dir / cache-key logic in deps-resolver and include-tree keeps working
 * unchanged.
 */
function parseLocalDepObject(line) {
  if (typeof line.path !== 'string' || line.path.trim() === '') {
    throw new Error(`Dep entry source "local" requires "path": ${JSON.stringify(line)}`);
  }
  for (const field of ['repo', 'ref', 'id', 'url', 'asset']) {
    if (line[field] != null) {
      throw new Error(
        `Dep entry source "local" does not support "${field}": ${JSON.stringify(line)}`
      );
    }
  }
  return {
    repo:         synthesizeLocalId(line.name, line.path),
    ref:          null,
    source:       'local',
    include_path: line.include_path ? String(line.include_path).trim() : null,
    asset:        null,
    _localPathRaw: line.path,
  };
}

/**
 * Parse a long-form fungun dep. fungun.net plugins are closed-source and are
 * addressed by their shop page index (`id`) or page URL (`url`) — there is no
 * GitHub repo/ref. The parsed object carries a synthetic stable `repo`
 * (`fungun.net/<id>`) so shared dep-dedup / dest-dir / cache-key logic in
 * deps-resolver and include-tree keeps working unchanged.
 */
function parseFungunDepObject(line) {
  const rawId  = line.id  != null ? String(line.id).trim()  : '';
  const rawUrl = line.url != null ? String(line.url).trim() : '';
  const hasId  = rawId  !== '';
  const hasUrl = rawUrl !== '';

  if (hasId && hasUrl) {
    throw new Error(
      `Dep entry source "fungun" — give either "id" or "url", not both: ${JSON.stringify(line)}`
    );
  }
  if (!hasId && !hasUrl) {
    throw new Error(
      `Dep entry source "fungun" requires "id" (plugin index) or "url" (page link): ${JSON.stringify(line)}`
    );
  }
  if (line.include_path != null || line.asset != null) {
    throw new Error(
      `Dep entry source "fungun" does not support include_path/asset — ` +
      `the .inc files come from the plugin page: ${JSON.stringify(line)}`
    );
  }
  if (line.repo != null || line.ref != null) {
    throw new Error(
      `Dep entry source "fungun" does not support repo/ref — ` +
      `address the plugin by "id" or "url": ${JSON.stringify(line)}`
    );
  }

  let ref;
  try {
    ref = parsePluginRef(hasId ? rawId : rawUrl);
  } catch (err) {
    throw new Error(`Dep entry source "fungun": ${err.message}`);
  }

  return {
    repo:         `fungun.net/${ref.id}`,
    ref:          null,
    source:       'fungun',
    id:           ref.id,
    url:          ref.url,
    include_path: null,
    asset:        null,
  };
}

function defaultName(p) {
  return path.basename(p, path.extname(p));
}

function parseEntryDescription(val) {
  if (val == null) return null;
  const s = String(val).trim();
  return s === '' ? null : s;
}

/**
 * Normalize top-level `docs` entries.
 *
 * Each entry: `{ file, name?, description? }` — `file` is required; `name`
 * defaults to the file basename without extension; `description` → trimmed
 * string or null.
 *
 * @param {*} arr
 * @returns {{ file: string, name: string, description: string|null }[]}
 */
function parseDocEntries(arr) {
  if (!Array.isArray(arr)) throw new Error('manifest: "docs" must be an array');
  return arr.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`docs[${i}]: must be an object`);
    }
    if (entry.file == null || String(entry.file).trim() === '') {
      throw new Error(`docs[${i}]: missing "file"`);
    }
    const file = String(entry.file).trim();
    const name = entry.name != null && String(entry.name).trim() !== ''
      ? String(entry.name).trim()
      : defaultName(file);
    return { file, name, description: parseEntryDescription(entry.description) };
  });
}

/**
 * Normalize top-level `skills` entries.
 *
 * Each entry: `{ file, dir, name?, description? }` — exactly one of `file` /
 * `dir` is required; `name` defaults to the file basename without extension
 * (`file`) or the directory basename (`dir`).
 *
 * @param {*} arr
 * @returns {{ file: string|null, dir: string|null, name: string, description: string|null }[]}
 */
function parseSkillEntries(arr) {
  if (!Array.isArray(arr)) throw new Error('manifest: "skills" must be an array');
  return arr.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`skills[${i}]: must be an object`);
    }
    const file   = entry.file != null ? String(entry.file).trim() : '';
    const dir    = entry.dir  != null ? String(entry.dir).trim()  : '';
    const hasFile = file !== '';
    const hasDir  = dir  !== '';
    if (hasFile === hasDir) {
      throw new Error(`skills[${i}]: exactly one of "file" or "dir" is required`);
    }
    const name = entry.name != null && String(entry.name).trim() !== ''
      ? String(entry.name).trim()
      : (hasFile ? defaultName(file) : path.basename(dir));
    return {
      file: hasFile ? file : null,
      dir:  hasDir  ? dir  : null,
      name,
      description: parseEntryDescription(entry.description),
    };
  });
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

/**
 * Single ini normaliser (source of truth) for defaults, rules, repos and
 * post-`--set` values.
 *
 *   undefined|null -> null  (inherit the parent layer)
 *   false          -> false (compile, exclude from every INI)
 *   true           -> ''    (plugins.ini)
 *   anything else  -> String(v)  (also coerces numeric --set values)
 *
 * @param {*} v
 * @returns {null|false|string}
 */
function normalizeIni(v) {
  if (v === undefined || v === null) return null;
  if (v === false) return false;
  if (v === true)  return '';
  return String(v);
}

function emptyPluginSettings() {
  return { ini: null, debug: null };
}

/**
 * Parse the local-only `AMXB_PLUGINS_DEBUG` override (trimmed,
 * case-insensitive):
 *
 *   unset / empty / other   -> null  (no override)
 *   1 | true | yes | on     -> true  (force ` debug` on every compiled plugin)
 *   0 | false | no | off    -> false (force ` debug` off)
 *
 * Lives in core so every interface resolves the override the same way.
 *
 * @param {object} [env=process.env]
 * @returns {boolean|null}
 */
function parsePluginsDebugEnv(env = process.env) {
  const raw = env ? env.AMXB_PLUGINS_DEBUG : null;
  if (raw == null) return null;
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value))   return true;
  if (['0', 'false', 'no', 'off'].includes(value))  return false;
  return null;
}

function parsePluginSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`manifest: plugin settings must be an object: ${JSON.stringify(raw)}`);
  }
  return {
    ini:   normalizeIni(raw.ini),
    debug: raw.debug == null ? null : Boolean(raw.debug),
  };
}

function parsePluginRules(rules) {
  if (rules == null) return [];
  if (!Array.isArray(rules)) {
    throw new Error('manifest: "plugins.rules" must be an array');
  }
  return rules.map((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      throw new Error(`plugins.rules[${i}]: must be an object`);
    }
    if (!r.match) throw new Error(`plugins.rules[${i}]: missing "match" field`);
    return {
      match:   String(r.match),
      enabled: r.enabled !== false,
      ini:     normalizeIni(r.ini),
      debug:   r.debug == null ? null : Boolean(r.debug),
    };
  });
}

/**
 * Parse top-level `plugins` — canonical object form `{ defaults, rules }` or
 * the legacy array form (rules only). All sentinels are explicit `null`.
 *
 * @param {*} raw
 * @returns {{ defaults: {ini: null|false|string, debug: null|boolean},
 *             rules: {match: string, enabled: boolean, ini: null|false|string, debug: null|boolean}[] }}
 */
function parsePlugins(raw) {
  if (Array.isArray(raw)) {
    return { defaults: emptyPluginSettings(), rules: parsePluginRules(raw) };
  }
  if (raw != null) {
    if (typeof raw !== 'object') {
      throw new Error('manifest: "plugins" must be an array or an object with "defaults"/"rules"');
    }
    return {
      defaults: raw.defaults != null ? parsePluginSettings(raw.defaults) : emptyPluginSettings(),
      rules:    parsePluginRules(raw.rules),
    };
  }
  return { defaults: emptyPluginSettings(), rules: [] };
}

/**
 * Recompute the resolved plugin-ini state on a manifest. Idempotent; mutates
 * `manifest`. Must run at the end of parseManifest and at the end of
 * resolveManifest (after --set), so overridden values are normalised and the
 * legacy adaptation/warnings reflect what was actually requested.
 *
 * Sets `manifest.pluginIni` (including `forceDebug` from `env`),
 * `manifest.repos[i]._pluginSettings` and `manifest._deprecations`; never
 * replaces `manifest.repos[i].plugins`.
 *
 * @param {object} manifest — parsed (and possibly overridden) manifest
 * @param {object} [env=process.env] — env source for AMXB_PLUGINS_DEBUG
 * @returns {void}
 */
function finalizePluginConfig(manifest, env = process.env) {
  manifest._deprecations = [];

  const cfg = manifest.plugins || (manifest.plugins = { defaults: emptyPluginSettings(), rules: [] });
  if (!cfg.defaults || typeof cfg.defaults !== 'object') cfg.defaults = emptyPluginSettings();
  if (!Array.isArray(cfg.rules)) cfg.rules = [];
  const repos = Array.isArray(manifest.repos) ? manifest.repos : (manifest.repos = []);

  // Normalise every layer (covers --set values that bypass parsePlugins).
  cfg.defaults.ini   = normalizeIni(cfg.defaults.ini);
  cfg.defaults.debug = cfg.defaults.debug == null ? null : Boolean(cfg.defaults.debug);
  for (const rule of cfg.rules) {
    rule.ini   = normalizeIni(rule.ini);
    rule.debug = rule.debug == null ? null : Boolean(rule.debug);
  }
  for (const repo of repos) {
    if (!repo.plugins) continue;
    repo.plugins.ini   = normalizeIni(repo.plugins.ini);
    repo.plugins.debug = repo.plugins.debug == null ? null : Boolean(repo.plugins.debug);
  }

  // Legacy global adaptation: output.generate_ini === true enables generation,
  // but only when the project did not set plugins.defaults.ini itself.
  let defaultsIni = cfg.defaults.ini;
  if (manifest.output && manifest.output.generate_ini === true && defaultsIni === null) {
    defaultsIni = normalizeIni(manifest.plugins_ini_postfix);
    if (defaultsIni === null) defaultsIni = '';
  }

  // Effective per-repo settings; repo.plugins stays untouched user data.
  for (const repo of repos) {
    if (repo.plugins != null) {
      repo._pluginSettings = { ini: repo.plugins.ini, debug: repo.plugins.debug };
    } else if (repo.plugins_ini_postfix != null) {
      repo._pluginSettings = { ini: normalizeIni(repo.plugins_ini_postfix), debug: null };
    } else {
      repo._pluginSettings = { ini: null, debug: null };
    }
  }

  const isSet = (v) => v !== null && v !== undefined && v !== false;
  const enabled = isSet(defaultsIni)
    || cfg.rules.some((r) => isSet(r.ini))
    || repos.some((r) => isSet(r._pluginSettings.ini));

  manifest.pluginIni = {
    enabled,
    defaultIni: !enabled ? false : (defaultsIni !== null ? defaultsIni : ''),
    defaultDebug: cfg.defaults.debug === true,
    forceDebug: parsePluginsDebugEnv(env),
  };

  // Deprecations are detected on the legacy raw fields only.
  const deprecations = [];
  if (manifest.output && manifest.output.generate_ini === true) {
    deprecations.push('[DEPRECATED] output.generate_ini — use plugins.defaults.ini instead');
  }
  if (manifest.plugins_ini_postfix != null) {
    deprecations.push('[DEPRECATED] plugins_ini_postfix — use plugins.defaults.ini instead');
  }
  for (const repo of repos) {
    if (repo.plugins_ini_postfix != null) {
      deprecations.push(`[DEPRECATED] repos[].plugins_ini_postfix (${repo.repo}) — use repos[].plugins.ini instead`);
    }
  }
  manifest._deprecations = [...new Set(deprecations)];
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

  finalizePluginConfig(manifest);
  return manifest;
}

module.exports = { parseManifest, parseDepsLines, parseDepString, parseDepObject, parseDocEntries, parseSkillEntries, applyOverrides, parseOverrideValue, resolveManifest, resolveGithubToken, loadDefaultsRaw, deepMerge, normalizeIni, finalizePluginConfig, parsePluginsDebugEnv };
