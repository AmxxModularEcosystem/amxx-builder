const chalk = require('chalk');
const { emit, EVENTS } = require('./events');

// Respect NO_COLOR env var (https://no-color.org/) and --no-color CLI flag
const noColor = process.env.NO_COLOR !== undefined
  || process.argv.includes('--no-color');

if (noColor) chalk.level = 0;

const PREFIX = chalk.bold.white('[amxx-builder]');

let _verbose = false;
let _stderr  = false;

function out(msg) {
  if (_stderr) {
    console.error(`${PREFIX} ${msg}`);
  } else {
    console.log(`${PREFIX} ${msg}`);
  }
}

function emitLog(level, message) {
  emit(EVENTS.LOG, { level, message });
}

const logger = {
  setVerbose:  (v) => { _verbose = v; },
  isVerbose:   ()  => _verbose,

  // MCP: stdout is the JSON-RPC channel — logs must go to stderr
  setStderr:   (v = true) => { _stderr = !!v; },
  isStderr:    ()  => _stderr,

  info:    (msg) => { out(msg); emitLog('info', msg); },
  success: (msg) => { out(chalk.green(msg)); emitLog('success', msg); },
  warn:    (msg) => { out(chalk.yellow(msg)); emitLog('warn', msg); },
  error:   (msg) => { console.error(`${PREFIX} ${chalk.red(msg)}`); emitLog('error', msg); },
  step:    (msg) => { out(chalk.cyan(msg)); emitLog('step', msg); },
  skip:    (msg) => { out(chalk.gray(msg)); emitLog('skip', msg); },
  dim:     (msg) => { out(chalk.dim(msg)); emitLog('dim', msg); },
  verbose: (msg) => { if (_verbose) { out(chalk.dim(msg)); emitLog('verbose', msg); } },

  // Verbatim passthrough (compiler output): no [amxx-builder] prefix, no color,
  // no added newline. The CLI writes exactly what the producer emitted.
  raw:      (text) => { process.stdout.write(text); emitLog('raw', text); },
  rawError: (text) => { process.stderr.write(text); emitLog('rawError', text); },
};

module.exports = logger;
