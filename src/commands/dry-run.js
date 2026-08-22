'use strict';

const path = require('path');
const logger = require('../logger');
const { buildPlanData } = require('../build-plan');

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
