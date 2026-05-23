const chalk = require('chalk');

const PREFIX = chalk.bold.white('[amxx-builder]');

module.exports = {
  info:    (msg) => console.log(`${PREFIX} ${msg}`),
  success: (msg) => console.log(`${PREFIX} ${chalk.green(msg)}`),
  warn:    (msg) => console.log(`${PREFIX} ${chalk.yellow(msg)}`),
  error:   (msg) => console.error(`${PREFIX} ${chalk.red(msg)}`),
  step:    (msg) => console.log(`${PREFIX} ${chalk.cyan(msg)}`),
  skip:    (msg) => console.log(`${PREFIX} ${chalk.gray(msg)}`),
  dim:     (msg) => console.log(`${PREFIX} ${chalk.dim(msg)}`),
};
