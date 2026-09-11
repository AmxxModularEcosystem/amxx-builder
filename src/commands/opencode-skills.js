'use strict';

const logger = require('../logger');
const { parseManifest, resolveGithubToken } = require('../manifest');
const { resolveManifestPath } = require('../manifest-path');
const { loadEnv } = require('../env');
const { buildOpencodeSkills } = require('../opencode-skills');
const { SKILLS_DIR } = require('./skills-dir');

/**
 * CLI adapter for the opencode skills bridge.
 *
 * stdout must stay pure and line-parseable (the bridge plugin reads it):
 *   line 1 = the bundled skills dir, line 2 (when any skills materialized) =
 *   the per-manifest container dir. All diagnostics go to stderr.
 *
 * A per-source fetch failure is non-fatal: it is warned to stderr and the
 * command still prints the paths it resolved. Only a genuinely unresolvable
 * manifest throws (the CLI wrapper renders it).
 *
 * @param {object} options - commander options (`manifest`, `fetch`)
 * @returns {Promise<void>}
 */
async function runOpencodeSkills(options = {}) {
  logger.setStderr(true);

  const manifestPath = resolveManifestPath(options.manifest).path;
  loadEnv(manifestPath, { quiet: true });
  const manifest = parseManifest(manifestPath);

  const result = await buildOpencodeSkills(manifest, {
    noFetch: options.fetch === false,
    ssh: manifest.github.ssh,
    tokenFor: (repo) => resolveGithubToken(manifest, repo),
  });

  process.stdout.write(SKILLS_DIR + '\n');
  if (result.count > 0) {
    process.stdout.write(result.containerDir + '\n');
  }

  for (const err of result.errors) {
    logger.warn(err);
  }
}

module.exports = { runOpencodeSkills };
