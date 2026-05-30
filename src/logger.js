const chalk = require('chalk');

// Respect NO_COLOR env var (https://no-color.org/) and --no-color CLI flag
const noColor = process.env.NO_COLOR !== undefined
  || process.argv.includes('--no-color');

if (noColor) chalk.level = 0;

const PREFIX = chalk.bold.white('[amxx-builder]');

let _verbose = false;

const logger = {
  setVerbose:  (v) => { _verbose = v; },
  isVerbose:   ()  => _verbose,

  info:    (msg) => console.log(`${PREFIX} ${msg}`),
  success: (msg) => console.log(`${PREFIX} ${chalk.green(msg)}`),
  warn:    (msg) => console.log(`${PREFIX} ${chalk.yellow(msg)}`),
  error:   (msg) => console.error(`${PREFIX} ${chalk.red(msg)}`),
  step:    (msg) => console.log(`${PREFIX} ${chalk.cyan(msg)}`),
  skip:    (msg) => console.log(`${PREFIX} ${chalk.gray(msg)}`),
  dim:     (msg) => console.log(`${PREFIX} ${chalk.dim(msg)}`),
  verbose: (msg) => { if (_verbose) console.log(`${PREFIX} ${chalk.dim(msg)}`); },
};

module.exports = logger;
