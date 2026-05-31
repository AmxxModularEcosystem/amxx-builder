const fs   = require('fs');
const yaml = require('js-yaml');
const path = require('path');

const DEFAULTS_PATH = path.join(__dirname, '..', 'defaults', 'amxbuild.defaults.yml');

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

function parseManifest(manifestPath) {
  const absPath = path.resolve(manifestPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Manifest not found: ${absPath}\n  → Run "amxb init" to create one`);
  }

  const projectRaw = yaml.load(fs.readFileSync(absPath, 'utf8'));
  const raw = deepMerge(loadDefaultsRaw(), projectRaw);

  if (!raw.name) throw new Error('manifest: missing required field "name"');

  const platform = parsePlatform(raw.platform);
  const gh       = raw.github || {};
  const tokenEnv = gh.token_env || 'GITHUB_TOKEN';
  const token    = process.env[tokenEnv] || null;
  const ssh      = !!gh.ssh;

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
    github: { token_env: tokenEnv, token, ssh },
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

function parseDepsLines(lines) {
  const result = [];
  for (const line of lines) {
    // Long-form object (manifest only — DEPS_LIST files are always strings)
    if (line && typeof line === 'object') {
      if (!line.repo) throw new Error(`Dep entry missing "repo": ${JSON.stringify(line)}`);
      if (!line.ref)  throw new Error(`Dep entry missing "ref": ${JSON.stringify(line)}`);
      const source = line.source || 'git';
      if (!['git', 'release'].includes(source)) {
        throw new Error(`Dep entry "source" must be "git" or "release": ${JSON.stringify(line)}`);
      }
      result.push({
        repo:         String(line.repo).trim(),
        ref:          String(line.ref).trim(),
        include_path: line.include_path ? String(line.include_path).trim() : null,
        source,
        asset:        line.asset != null ? line.asset : null,
      });
      continue;
    }
    // Short-form string: "owner/repo@ref[:include_path]"  (always git)
    const trimmed = String(line).trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([^@]+)@([^:]+)(?::(.+))?$/);
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

module.exports = { parseManifest, parseDepsLines };
