const fs   = require('fs');
const yaml = require('js-yaml');
const path = require('path');

function parseManifest(manifestPath) {
  const absPath = path.resolve(manifestPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Manifest not found: ${absPath}`);
  }

  const raw = yaml.load(fs.readFileSync(absPath, 'utf8'));

  if (!raw.name) throw new Error('manifest: missing required field "name"');

  const tokenEnv = (raw.github && raw.github.token_env) || 'GITHUB_TOKEN';
  const token    = process.env[tokenEnv] || null;
  const ssh      = !!(raw.github && raw.github.ssh);

  const globalPostfix  = raw.plugins_ini_postfix != null ? String(raw.plugins_ini_postfix) : '';
  const globalAmxDir   = (raw.amxmodx && raw.amxmodx.dir) || 'amxmodx';
  const globalDeps     = parseDepsLines(raw.deps || []);

  const repos = (raw.repos || []).map((r) => parseRepoEntry(r, globalPostfix, globalAmxDir));

  const output = raw.output || {};
  return {
    _path:   absPath,
    name:    raw.name,
    version: String(raw.version || '1.0.0'),
    amxmodx: {
      version: (raw.amxmodx && raw.amxmodx.version) ? String(raw.amxmodx.version) : null,
      dir:     globalAmxDir,
    },
    github: { token_env: tokenEnv || null, token, ssh },
    globalDeps,
    globalPostfix,
    repos,
    output: {
      dir:          output.dir || './dist',
      archive_name: output.archive_name || '{name}-{version}.zip',
      amxmodx_path: output.amxmodx_path || 'addons/amxmodx',
      assets_path:  output.assets_path  != null ? String(output.assets_path) : '',
      readme:       output.readme       || false,
      generate_ini: output.generate_ini != null ? Boolean(output.generate_ini) : true,
      on_conflict:  validateOnConflict(output.on_conflict),
    },
  };
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

module.exports = { parseManifest, parseDepsLines };
