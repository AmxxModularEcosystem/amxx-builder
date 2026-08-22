'use strict';

const path = require('path');

/**
 * Load .env from the manifest's directory.
 *
 * @param {string} manifestPath - Path to the manifest (absolute or relative).
 * @param {object} [options] - Extra dotenv config options merged over the defaults
 *   ({ override: true }). Callers needing different semantics (e.g. the MCP
 *   build_plan tool's non-overriding quiet load) pass them here.
 */
function loadEnv(manifestPath, options = {}) {
  const manifestDir = path.dirname(path.resolve(manifestPath));
  require('dotenv').config({ path: path.join(manifestDir, '.env'), override: true, ...options });
}

module.exports = { loadEnv };
