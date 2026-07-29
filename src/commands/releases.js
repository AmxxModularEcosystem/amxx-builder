'use strict';

const logger = require('../logger');
const { listReleases, listTags } = require('../release-lister');

async function runReleases(repo, options) {
  require('dotenv').config({ override: true });
  const token = process.env.GITHUB_TOKEN || null;
  const limit = options.limit || 10;
  const asJson = options.json || false;

  let entries;
  if (options.tags) {
    entries = await listTags(repo, { token, limit });
  } else {
    entries = await listReleases(repo, { token, limit, includeAssets: options.assets });
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(entries, null, 2) + '\n');
    return;
  }

  if (entries.length === 0) {
    logger.info(`No ${options.tags ? 'tags' : 'releases'} found for ${repo}`);
    return;
  }

  const label = options.tags ? 'Tags' : 'Releases';
  logger.info(`${label} for ${repo} (${entries.length}):`);
  for (const e of entries) {
    const line = options.tags
      ? `  ${e.name}`
      : `  ${e.tagName}  ${e.prerelease ? '(pre) ' : ''}${e.publishedAt ? `— ${e.publishedAt.slice(0, 10)}` : ''}`;
    logger.dim(line);

    if (e.assets && e.assets.length > 0) {
      for (const a of e.assets) {
        logger.dim(`    └ assets/${a.name}  (${(a.size / 1024).toFixed(0)} KB)`);
      }
    }
  }
}

module.exports = { runReleases };
