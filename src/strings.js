'use strict';

/**
 * Dependency-free string helpers (leaf module — imports nothing).
 *
 * Single source of truth for repo / logical-id normalization. Hoisted out of
 * `deps-resolver` so modules that must stay dependency-light (e.g.
 * `local-sources`, which `./manifest` imports) can share it without creating a
 * require cycle.
 */

/**
 * Case-fold a repo / dep logical id (`owner/repo`, `local/<name>`,
 * `fungun.net/<id>`). `String()` coercion keeps the previous local copy's
 * null/undefined tolerance.
 *
 * @param {*} repo
 * @returns {string}
 */
function normalizeRepoName(repo) {
  return String(repo).toLowerCase();
}

module.exports = { normalizeRepoName };
