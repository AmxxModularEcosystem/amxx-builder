'use strict';

const path = require('path');

const logger = require('../logger');
const { validateManifestFile } = require('../validate');
const { resolveManifestPath } = require('./shared');

async function runValidate(options) {
  const manifestPath = options.manifest ? path.resolve(options.manifest) : resolveManifestPath(undefined);
  const result = validateManifestFile(manifestPath);

  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.valid) process.exitCode = 1;
    return;
  }

  if (result.valid) {
    logger.success('Manifest is valid');
    return;
  }

  logger.error(`Manifest has ${result.errors.length} error(s) and ${result.warnings.length} warning(s):`);
  for (const err of result.errors) {
    logger.dim(`  ${err.path}: ${err.message}`);
  }
  for (const warn of result.warnings) {
    logger.warn(`  ${warn.path}: ${warn.message}`);
  }
  process.exitCode = 1;
}

module.exports = { runValidate };
