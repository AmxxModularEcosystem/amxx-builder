'use strict';

const chalk  = require('chalk');
const logger = require('../logger');
const { on, EVENTS } = require('../events');

let subscribed = false;

function dots(filename) {
  return chalk.dim(' ' + '.'.repeat(Math.max(1, 42 - filename.length)) + ' ');
}

/**
 * Renders a single EVENTS.COMPILED payload exactly as src/compiler.js used to
 * write it directly:
 *  - ok:    `[amxx-builder]   <baseName> <dots> OK` on stdout
 *           (logger.info adds the `[amxx-builder] ` prefix + trailing newline;
 *            the leading `  ` yields the original 3-space gap)
 *  - !ok:   `[amxx-builder] FAILED: <baseName>` + verbatim compiler output on stderr
 */
function renderCompiled(payload) {
  const { baseName, ok, output } = payload;
  if (ok) {
    logger.info(`  ${baseName} ${dots(baseName)} ${chalk.green('OK')}`);
  } else {
    logger.error(`FAILED: ${baseName}`);
    const out = (output || '').trim();
    if (out) logger.rawError(out + '\n');
  }
}

function subscribeCompiledRendering() {
  if (subscribed) return;
  subscribed = true;
  on(EVENTS.COMPILED, renderCompiled);
}

module.exports = { subscribeCompiledRendering, renderCompiled, dots };
