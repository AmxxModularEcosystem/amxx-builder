'use strict';

const BAR_LEN = 20;

function formatBar(ratio) {
  const filled = Math.round(ratio * BAR_LEN);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(BAR_LEN - filled);
}

function formatPct(ratio) {
  const pct = Math.round(ratio * 100);
  return `${pct}%`.padStart(4);
}

/**
 * Simple in-place progress bar using only \r (carriage return).
 * Works in all terminals — no ANSI escape sequences.
 *
 * Designed for downloads and archiving where there is no
 * interleaved stdout output. Each update overwrites the same line.
 */
function createBar(total, label) {
  const stream = process.stdout;
  let lastLen = 0;

  function writeLine(val) {
    const ratio = val / total;
    const bar   = formatBar(ratio);
    const pct   = formatPct(ratio);
    const line  = `${label} ${bar} ${pct} (${val}/${total})`;

    if (lastLen > 0) stream.write('\r' + ' '.repeat(lastLen) + '\r');
    stream.write(line);
    lastLen = line.length;
  }

  writeLine(0);

  return {
    update(val) { writeLine(val); },
    stop() {
      if (lastLen > 0) stream.write('\r' + ' '.repeat(lastLen) + '\r');
      stream.write('\n');
    },
  };
}

module.exports = { createBar };
