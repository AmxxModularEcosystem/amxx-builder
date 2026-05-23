const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');

function parseManifest(manifestPath) {
  const absPath = path.resolve(manifestPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Manifest not found: ${absPath}`);
  }

  const raw = yaml.load(fs.readFileSync(absPath, 'utf8'));

  // Validate required fields
  if (!raw.name)                 throw new Error('manifest: missing required field "name"');
  if (!raw.amxmodx)              throw new Error('manifest: missing required field "amxmodx"');
  if (!raw.amxmodx.version)      throw new Error('manifest: missing required field "amxmodx.version"');
  if (!raw.repos || !raw.repos.length) throw new Error('manifest: at least one entry in "repos" is required');

  // Resolve GitHub token
  const tokenEnv = raw.github && raw.github.token_env;
  const token = tokenEnv ? (process.env[tokenEnv] || null) : null;

  // Normalize global postfix
  const globalPostfix = raw.plugins_ini_postfix != null ? String(raw.plugins_ini_postfix) : '';

  // Normalize global deps
  const globalDeps = parseDepsLines(raw.deps || []);

  // Normalize repos
  const repos = (raw.repos || []).map((r) => {
    if (!r.repo) throw new Error('manifest: each repo entry must have a "repo" field');

    const repoPostfix = r.plugins_ini_postfix != null ? String(r.plugins_ini_postfix) : globalPostfix;

    const plugins = r.plugins
      ? r.plugins.map((p) => ({
          src: p.src,
          ini_comment: p.ini_comment || null,
          plugins_ini_postfix: p.plugins_ini_postfix != null
            ? String(p.plugins_ini_postfix)
            : repoPostfix,
        }))
      : null;

    return {
      repo:             r.repo,
      ref:              r.ref || null,
      deps_override:    r.deps_override ? parseDepsLines(r.deps_override) : null,
      scripting_dir:    r.scripting_dir || 'scripting',
      local_include_dir: r.local_include_dir || 'scripting/include',
      plugins_ini_postfix: repoPostfix,
      exclude:          r.exclude || [],
      plugins,
      extras:           (r.extras || []).map((e) => ({ src: e.src, dst: e.dst })),
      store_readme:     r.store_readme || false,
    };
  });

  const output = raw.output || {};
  return {
    name:    raw.name,
    version: String(raw.version || '1.0.0'),
    amxmodx: {
      version: String(raw.amxmodx.version),
    },
    github: {
      token_env: tokenEnv || null,
      token,
    },
    globalDeps,
    globalPostfix,
    repos,
    output: {
      dir:          output.dir || './dist',
      archive_name: output.archive_name || '{name}-{version}.zip',
      layout: {
        plugins:  (output.layout && output.layout.plugins)  || 'addons/amxmodx/plugins/',
        configs:  (output.layout && output.layout.configs)  || 'addons/amxmodx/configs/',
        lang:     (output.layout && output.layout.lang)     || 'addons/amxmodx/lang/',
        includes: (output.layout && output.layout.includes) || 'addons/amxmodx/scripting/include/',
      },
    },
  };
}

function parseDepsLines(lines) {
  const result = [];
  for (const line of lines) {
    const trimmed = String(line).trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // owner/repo@ref[:include_path]
    const match = trimmed.match(/^([^@]+)@([^:]+)(?::(.+))?$/);
    if (!match) {
      throw new Error(`Invalid dep entry: "${trimmed}"`);
    }
    const [, repoPath, ref, includePath] = match;
    result.push({
      repo:         repoPath.trim(),
      ref:          ref.trim(),
      include_path: includePath ? includePath.trim() : null,
    });
  }
  return result;
}

module.exports = { parseManifest, parseDepsLines };
