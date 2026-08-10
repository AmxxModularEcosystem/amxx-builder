const chalk = require('chalk');

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

const logger = {
  setVerbose:  (v) => { _verbose = v; },
  isVerbose:   ()  => _verbose,

  // MCP: stdout is the JSON-RPC channel — logs must go to stderr
  setStderr:   (v = true) => { _stderr = !!v; },
  isStderr:    ()  => _stderr,

  info:    (msg) => out(msg),
  success: (msg) => out(chalk.green(msg)),
  warn:    (msg) => out(chalk.yellow(msg)),
  error:   (msg) => console.error(`${PREFIX} ${chalk.red(msg)}`),
  step:    (msg) => out(chalk.cyan(msg)),
  skip:    (msg) => out(chalk.gray(msg)),
  dim:     (msg) => out(chalk.dim(msg)),
  verbose: (msg) => { if (_verbose) out(chalk.dim(msg)); },
};

module.exports = logger;
