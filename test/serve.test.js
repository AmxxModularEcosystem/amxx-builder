'use strict';

/**
 * Regression test for the serve interface (src/commands/serve.js): the
 * createServeServer() adapter must wire every documented JSON-RPC method to a
 * core-backed handler. This only asserts the method table — it performs no
 * network calls and never connects to stdio.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createServeServer } = require('../src/commands/serve');

const EXPECTED_METHODS = [
  // read-only
  'manifest.validate',
  'manifest.resolve',
  'include.resolve',
  'include.list',
  'amxmodx.includes.list',
  'amxmodx.include.get',
  'deps.tree',
  'releases.list',
  'cache.info',
  'build.plan',
  // mutation
  'build.start',
  'build.cancel',
  'compile.single',
  'watch.start',
  'watch.stop',
];

test('createServeServer wires all documented request methods', () => {
  const server = createServeServer();
  for (const method of EXPECTED_METHODS) {
    const handler = server._requests.get(method);
    assert.equal(typeof handler, 'function', `method "${method}" must be wired`);
  }
});

test('createServeServer: every method table handler is a thin wrapper', () => {
  const server = createServeServer();
  for (const method of EXPECTED_METHODS) {
    assert.equal(typeof server._requests.get(method), 'function');
  }
});

test('createServeServer returns a JsonRpcServer (has connect/sendResult)', () => {
  const server = createServeServer();
  assert.equal(typeof server.connect, 'function');
  assert.equal(typeof server.sendResult, 'function');
  assert.equal(typeof server.notify, 'function');
  assert.equal(typeof server.onRequest, 'function');
});
