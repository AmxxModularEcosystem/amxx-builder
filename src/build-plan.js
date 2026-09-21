'use strict';

const fs   = require('fs');
const path = require('path');
const glob = require('fast-glob');
const { isLocal } = require('./local-sources');

/**
 * Structured build plan — mirrors what printDryRun shows, but as data.
 * Single source of truth for the CLI dry-run command and the MCP build_plan /
 * resolve_assets tools.
 *
 * @param {object} manifest - fully resolved manifest (parseManifest output)
 * @param {object} [options]
 * @param {boolean} [options.detailedAssets=false] - when true, `assets` entries
 *   carry the richer per-source shape ({ type, map, source, cache }, plus a
 *   glob-listed `files` set for local sources) needed by resolve_assets.
 *   Default keeps the compact CLI dry-run / build_plan shape.
 * @param {boolean} [options.listLocal=true] - when detailedAssets and listLocal
 *   are true, local sources get a `files` array listing the assets/ contents.
 */
function buildPlanData(manifest, options = {}) {
  const detailed  = options.detailedAssets === true;
  const listLocal = options.listLocal !== false;
  const out = manifest.output;
  const expand = (tpl) => tpl.replaceAll('{name}', manifest.name).replaceAll('{version}', manifest.version);

  return {
    name: manifest.name,
    version: manifest.version,
    compiler: {
      version: manifest.amxmodx.version || 'latest',
      dir: manifest.amxmodx.dir,
      platform: manifest.platform || null,
      defines: manifest.amxmodx.defines,
    },
    repos: manifest.repos.map((r) => ({
      repo: r.repo,
      source: isLocal(r) ? 'local' : (r.source || 'git'),
      ref: isLocal(r) ? null : (r.ref || 'default branch'),
      amxmodx_dir: r.amxmodx_dir,
      deps_override: r.deps_override || null,
      local_dir: r._localDir || null,
      ...(r.ref_ttl !== undefined ? { ref_ttl: r.ref_ttl } : {}),
    })),
    globalDeps: manifest.globalDeps.map((d) => ({
      source: isLocal(d) ? 'local' : d.source,
      repo: isLocal(d) ? d.repo : (d.source === 'fungun' ? null : d.repo),
      ref: isLocal(d) ? null : d.ref,
      id: d.id ?? null,
      url: d.url ?? null,
      include_path: d.include_path || null,
      asset: d.asset ?? null,
      local_dir: d._localDir || null,
      ...(d.ref_ttl !== undefined ? { ref_ttl: d.ref_ttl } : {}),
    })),
    assets: manifest.assets.sources.map((s) => {
      if (detailed) {
        if (s.type === 'amxmodx') {
          return {
            type: 'amxmodx',
            map: s.map,
            source: `amxmodx ${manifest.amxmodx.version || 'latest'} (${manifest.platform || 'host'})`,
          };
        }
        if (s.type === 'release') {
          return {
            type: 'release',
            map: s.map,
            source: `${s.repo}@${s.ref}`,
            asset: s.asset ?? null,
            cache: 'global',
          };
        }
        if (s.type === 'local') {
          const entry = { type: 'local', map: s.map, source: 'assets/ (next to manifest)' };
          if (listLocal) {
            const dir = path.join(path.dirname(manifest._path), 'assets');
            entry.files = fs.existsSync(dir)
              ? glob.sync('**/*', { cwd: dir, dot: false }).sort()
              : [];
          }
          return entry;
        }
        return { type: 'url', map: s.map, source: s.url, cache: s.cache || 'none' };
      }
      if (s.type === 'amxmodx') {
        return { type: 'amxmodx', version: manifest.amxmodx.version || 'latest', platform: manifest.platform || 'host' };
      }
      if (s.type === 'release') {
        return { type: 'release', repo: s.repo, ref: s.ref, asset: s.asset ?? null, cache: s.cache || 'global' };
      }
      if (s.type === 'local') return { type: 'local', source: 'assets/' };
      return { type: 'url', url: s.url, cache: s.cache || 'none' };
    }),
    output: {
      pack: out.pack,
      target: out.pack === false
        ? `${path.join(path.resolve(out.dir), expand(out.amxmodx_path))}/`
        : path.join(path.resolve(out.dir), expand(out.archive_name)),
      amxmodx_path: expand(out.amxmodx_path) + '/',
      assets_path: out.assets_path ? expand(out.assets_path) + '/' : null,
      // `pluginIni` is the resolved source of truth; hand-built fixtures
      // (tests, external callers) may not carry it → fall back to the legacy
      // raw output flag.
      generate_ini: manifest.pluginIni ? manifest.pluginIni.enabled : Boolean(out.generate_ini),
      plugins_ini: manifest.pluginIni
        ? {
            enabled: manifest.pluginIni.enabled,
            default: manifest.pluginIni.defaultIni,
            debug: manifest.pluginIni.defaultDebug,
            force_debug: manifest.pluginIni.forceDebug,
          }
        : null,
      on_conflict: out.on_conflict,
    },
  };
}

module.exports = { buildPlanData };
