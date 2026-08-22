'use strict';

/**
 * Regression tests for the event-bus / renderer contract established by the
 * refactor: logger and progress forward structured events onto the shared
 * core bus (src/events.js), which interface layers subscribe to.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const events = require('../src/events');
const { on, off, EVENTS } = events;
const logger = require('../src/logger');
const progress = require('../src/progress');

test('logger.info emits EVENTS.LOG with { level, message }', () => {
  const received = [];
  const handler = (p) => received.push(p);
  on(EVENTS.LOG, handler);
  try {
    logger.info('hello world');
  } finally {
    off(EVENTS.LOG, handler);
  }
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], { level: 'info', message: 'hello world' });
});

test('logger.warn/error/step emit matching levels', () => {
  const levels = [];
  const handler = (p) => levels.push(p.level);
  on(EVENTS.LOG, handler);
  try {
    logger.warn('w');
    logger.error('e');
    logger.step('s');
    logger.dim('d');
    logger.skip('k');
  } finally {
    off(EVENTS.LOG, handler);
  }
  assert.deepEqual(levels, ['warn', 'error', 'step', 'dim', 'skip']);
});

test('logger.verbose only emits when verbose is enabled', () => {
  logger.setVerbose(false);
  let n = 0;
  const handler = (p) => { if (p.level === 'verbose') n++; };
  on(EVENTS.LOG, handler);
  try {
    logger.verbose('hidden');
  } finally {
    off(EVENTS.LOG, handler);
  }
  assert.equal(n, 0);

  logger.setVerbose(true);
  on(EVENTS.LOG, handler);
  try {
    logger.verbose('shown');
  } finally {
    off(EVENTS.LOG, handler);
    logger.setVerbose(false);
  }
  assert.equal(n, 1);
});

test('logger.rawError writes verbatim to stderr and emits EVENTS.LOG', () => {
  const origWrite = process.stderr.write;
  let written = '';
  process.stderr.write = (chunk, ...rest) => {
    written += chunk;
    return origWrite.call(process.stderr, '', ...rest); // no visible output
  };

  const received = [];
  const handler = (p) => received.push(p);
  on(EVENTS.LOG, handler);
  try {
    logger.rawError('EXACT_VERBATIM_TEXT');
  } finally {
    process.stderr.write = origWrite;
    off(EVENTS.LOG, handler);
  }

  assert.equal(written, 'EXACT_VERBATIM_TEXT');
  assert.equal(received.length, 1);
  assert.equal(received[0].level, 'rawError');
  assert.equal(received[0].message, 'EXACT_VERBATIM_TEXT');
});

test('progress.createBar emits EVENTS.PROGRESS on update and stop', () => {
  const received = [];
  const handler = (p) => received.push(p);
  on(EVENTS.PROGRESS, handler);
  try {
    const bar = progress.createBar(100, 'dl');
    bar.update(50);
    bar.stop();
  } finally {
    off(EVENTS.PROGRESS, handler);
  }

  // createBar emits an initial { current: 0 }, then update(50), then stop.
  assert.ok(received.length >= 3);
  assert.equal(received[0].current, 0);
  assert.equal(received[0].total, 100);
  assert.equal(received[0].label, 'dl');
  const upd = received.find((p) => p.current === 50);
  assert.ok(upd, 'update(50) event received');
  const done = received[received.length - 1];
  assert.equal(done.current, 100);
  assert.equal(done.done, true);
});

test('progress emits nothing when disabled', () => {
  progress.setEnabled(false);
  const received = [];
  const handler = (p) => received.push(p);
  on(EVENTS.PROGRESS, handler);
  try {
    const bar = progress.createBar(100, 'dl');
    bar.update(50);
    bar.stop();
  } finally {
    off(EVENTS.PROGRESS, handler);
    progress.setEnabled(true);
  }
  assert.equal(received.length, 0);
});
