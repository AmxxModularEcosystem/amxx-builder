'use strict';

const path = require('path');
const logger = require('../logger');

/**
 * Structured build plan — mirrors what printDryRun shows, but as data.
 * Used by the MCP build_plan tool.
 */
function buildPlanData(manifest) {
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
      ref: r.ref || 'default branch',
      amxmodx_dir: r.amxmodx_dir,
      deps_override: r.deps_override || null,
    })),
    globalDeps: manifest.globalDeps.map((d) => ({
      source: d.source,
      repo: d.repo,
      ref: d.ref,
      include_path: d.include_path || null,
      asset: d.asset ?? null,
    })),
    assets: manifest.assets.sources.map((s) => {
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
        ? `${path.resolve(out.dir)}/${expand(out.amxmodx_path)}/`
        : `${path.resolve(out.dir)}/${expand(out.archive_name)}`,
      amxmodx_path: expand(out.amxmodx_path) + '/',
      assets_path: out.assets_path ? expand(out.assets_path) + '/' : null,
      generate_ini: out.generate_ini,
      on_conflict: out.on_conflict,
    },
  };
}

function printDryRun(manifest) {
  const out = manifest.output;
  const expand = (tpl) => tpl.replaceAll('{name}', manifest.name).replaceAll('{version}', manifest.version);

  logger.info(`=== DRY RUN: ${manifest.name} v${manifest.version} ===`);

  logger.info(`\nCompiler:`);
  logger.dim(`  amxxpc ${manifest.amxmodx.version || 'latest'} — dir: ${manifest.amxmodx.dir}`);
  if (manifest.platform) logger.dim(`  target platform: ${manifest.platform}`);
  if (manifest.amxmodx.defines.length) {
    logger.dim(`  defines: ${manifest.amxmodx.defines.map(d => `-D${d}`).join(' ')}`);
  }

  if (manifest.repos.length) {
    logger.info(`\nRepos (${manifest.repos.length}):`);
    for (const r of manifest.repos) {
      const ref = r.ref || 'default branch';
      logger.dim(`  ${r.repo} @ ${ref}  [dir: ${r.amxmodx_dir}]`);
    }
  }

  if (manifest.globalDeps.length) {
    logger.info(`\nGlobal deps (${manifest.globalDeps.length}):`);
    for (const d of manifest.globalDeps) {
      const src = d.source === 'release' ? 'release' : 'git';
      logger.dim(`  [${src}] ${d.repo}@${d.ref}${d.include_path ? ':' + d.include_path : ''}`);
    }
  }

  if (manifest.assets.sources.length) {
    logger.info(`\nAsset sources (${manifest.assets.sources.length}):`);
    for (const s of manifest.assets.sources) {
      if (s.type === 'amxmodx') {
        logger.dim(`  [amxmodx] ${manifest.amxmodx.version || 'latest'} (${manifest.platform || 'host'})`);
      } else if (s.type === 'release') {
        logger.dim(`  [release] ${s.repo}@${s.ref}  cache: ${s.cache || 'global'}`);
      } else if (s.type === 'local') {
        logger.dim(`  [local] assets/`);
      } else {
        logger.dim(`  [url] ${s.url}  cache: ${s.cache || 'none'}`);
      }
    }
  }

  logger.info(`\nOutput:`);
  if (out.pack === false) {
    logger.dim(`  copy → ${path.resolve(out.dir)}/${expand(out.amxmodx_path)}/`);
  } else {
    logger.dim(`  archive → ${path.resolve(out.dir)}/${expand(out.archive_name)}`);
    logger.dim(`  amxmodx path in archive: ${expand(out.amxmodx_path)}/`);
  }
  if (out.assets_path) logger.dim(`  assets path: ${expand(out.assets_path)}/`);
  logger.dim(`  generate_ini: ${out.generate_ini}  |  on_conflict: ${out.on_conflict}`);

  logger.info(`\n=== END DRY RUN ===`);
}

module.exports = { printDryRun, buildPlanData };
