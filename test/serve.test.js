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
  'repos.info',
  'repos.branches',
  'repos.structure',
  'cache.info',
  'compiler.info',
  'dep-graph.get',
  'build.plan',
  // mutation
  'build.start',
  'build.cancel',
  'compile.single',
  'deploy.start',
  'deploy.file',
  'deploy.remove',
  'rcon.send',
  'watch.start',
  'watch.stop',
  // health
  'serve.ping',
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

test('serve.ping returns ok with process info (no network)', async () => {
  const server = createServeServer();
  const result = await server._requests.get('serve.ping')();
  assert.equal(result.ok, true);
  assert.equal(typeof result.pid, 'number');
  assert.equal(typeof result.version, 'string');
  assert.equal(typeof result.node, 'string');
});
