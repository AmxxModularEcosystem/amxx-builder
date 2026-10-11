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

/**
 * Parse a boolean-ish env value → true|false|null. 1/true/yes/on, 0/false/no/off.
 *
 * Case-insensitive and trimmed; anything else (including unset) → null.
 * Note: this is the wide token set for `AMXB_PLUGINS_DEBUG`/`AMXB_RPC_ENABLED`;
 * `AMXB_LOCAL_STRICT` intentionally keeps its own narrow `['1', 'true']` check.
 *
 * @param {*} value - Raw env value (any type; coerced via String()).
 * @returns {boolean|null}
 */
function parseEnvBool(value) {
  if (value == null) return null;
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v))  return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return null;
}

/**
 * Load `<cwd>/.env` (stdio-safe variant used by serve/MCP). Existing
 * process.env vars win (no `override`); extra options pass through to dotenv.
 *
 * @param {object} [options] - Extra dotenv config options (e.g. { quiet: true }).
 */
function loadCwdEnv(options = {}) {
  require('dotenv').config({ path: path.join(process.cwd(), '.env'), ...options });
}

module.exports = { loadEnv, parseEnvBool, loadCwdEnv };
