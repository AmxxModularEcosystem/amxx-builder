'use strict';

const { emit, EVENTS } = require('./events');

const BAR_LEN = 20;

function formatBar(ratio) {
  const filled = Math.round(ratio * BAR_LEN);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(BAR_LEN - filled);
}

function formatPct(ratio) {
  const pct = Math.round(ratio * 100);
  return `${pct}%`.padStart(4);
}

let _enabled = true;

/**
 * Disable progress bars entirely — createBar() returns a noop.
 * Used by the MCP server: bars write \r/control chars to stdout,
 * which would corrupt the JSON-RPC stream.
 */
function setEnabled(v) {
  _enabled = !!v;
}

/**
 * Simple in-place progress bar using only \r (carriage return).
 * Works in all terminals — no ANSI escape sequences.
 *
 * Designed for downloads and archiving where there is no
 * interleaved stdout output. Each update overwrites the same line.
 */
function createBar(total, label) {
  if (!_enabled) return { update() {}, stop() {} };

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

    emit(EVENTS.PROGRESS, { label, current: val, total });
  }

  writeLine(0);

  return {
    update(val) { writeLine(val); },
    stop() {
      if (lastLen > 0) stream.write('\r' + ' '.repeat(lastLen) + '\r');
      stream.write('\n');
      emit(EVENTS.PROGRESS, { label, current: total, total, done: true });
    },
  };
}

module.exports = { createBar, setEnabled };
