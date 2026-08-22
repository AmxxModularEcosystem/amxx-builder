'use strict';

const logger = require('../logger');
const { parseManifest, applyOverrides } = require('../manifest');
const { resolveManifestPath, loadEnv } = require('./shared');
const { printDryRun } = require('./dry-run');
const { subscribeCompiledRendering } = require('./compile-renderer');
const { runBuild } = require('../build-service');
const { on, EVENTS } = require('../events');

// Render compiler 'compiled' events (previously direct stdout/stderr writes).
subscribeCompiledRendering();

// Render build-service 'done' events (previously a direct logger.success at the
// end of the CLI runBuild). Keeps the final `Done in Xs` message byte-identical.
let doneSubscribed = false;
function subscribeDoneRendering() {
  if (doneSubscribed) return;
  doneSubscribed = true;
  on(EVENTS.DONE, (payload) => {
    if (payload && payload.ok && payload.message) logger.success(payload.message);
  });
}
subscribeDoneRendering();

async function runBuildCLI(options) {
  if (options.verbose) logger.setVerbose(true);

  const manifestPath = resolveManifestPath(options.manifest);
  loadEnv(manifestPath);

  const manifest = parseManifest(manifestPath);
  if (options.set?.length)    applyOverrides(manifest, options.set);
  if (options.define?.length) manifest.amxmodx.defines.push(...options.define);
  logger.info(`Manifest: ${manifest.name} v${manifest.version}`);

  if (options.dryRun) {
    printDryRun(manifest);
    return;
  }

  await runBuild(manifest, {
    buildDir: options.buildDir,
    fetch:    options.fetch,
    archive:  options.archive,
  });
}

module.exports = { runBuild: runBuildCLI };
