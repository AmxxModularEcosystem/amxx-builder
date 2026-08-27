'use strict';

/**
 * Regression tests for the generic JSON-RPC 2.0 transport (src/jsonrpc-transport.js).
 *
 * The dispatch logic (_handleMessage) is tested directly by overriding
 * sendResult/sendError on a constructed instance — no subprocess, no stdio.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { JsonRpcServer } = require('../src/jsonrpc-transport');

function makeHarness() {
  const server = new JsonRpcServer();
  const results = [];
  const errors = [];
  server.sendResult = (id, result) => results.push({ id, result });
  server.sendError = (id, code, message, data) => errors.push({ id, code, message, data });
  return { server, results, errors };
}

test('JsonRpcServer dispatches a successful request', async () => {
  const { server, results, errors } = makeHarness();
  server.onRequest('ping', () => ({}));
  await server._handleMessage({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 1);
  assert.deepEqual(results[0].result, {});
  assert.equal(errors.length, 0);
});

test('JsonRpcServer passes params to the handler and returns its value', async () => {
  const { server, results } = makeHarness();
  server.onRequest('echo', (params) => ({ value: params.value }));
  await server._handleMessage({ jsonrpc: '2.0', id: 7, method: 'echo', params: { value: 'x' } });
  assert.deepEqual(results[0].result, { value: 'x' });
});

test('JsonRpcServer supports async handlers', async () => {
  const { server, results } = makeHarness();
  server.onRequest('slow', async (params) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { ok: true, params };
  });
  await server._handleMessage({ jsonrpc: '2.0', id: 2, method: 'slow', params: { n: 1 } });
  assert.deepEqual(results[0].result, { ok: true, params: { n: 1 } });
});

test('JsonRpcServer: thrown Error with numeric .code is sent verbatim', async () => {
  const { server, results, errors } = makeHarness();
  server.onRequest('fail', () => {
    const err = new Error('nope');
    err.code = -32000;
    throw err;
  });
  await server._handleMessage({ jsonrpc: '2.0', id: 2, method: 'fail' });
  assert.equal(results.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].id, 2);
  assert.equal(errors[0].code, -32000);
  assert.equal(errors[0].message, 'nope');
});

test('JsonRpcServer: thrown Error with numeric .code and .data forwards data', async () => {
  const { server, results, errors } = makeHarness();
  server.onRequest('gh', () => {
    const err = new Error('Not Found');
    err.code = -32603;
    err.data = { status: 404, repo: 'a/b', message: 'Not Found' };
    throw err;
  });
  await server._handleMessage({ jsonrpc: '2.0', id: 4, method: 'gh' });
  assert.equal(results.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].id, 4);
  assert.equal(errors[0].code, -32603);
  assert.equal(errors[0].message, 'Not Found');
  assert.deepEqual(errors[0].data, { status: 404, repo: 'a/b', message: 'Not Found' });
});

test('JsonRpcServer: thrown Error with .code but no .data keeps data undefined', async () => {
  const { server, errors } = makeHarness();
  server.onRequest('plain', () => {
    const err = new Error('nope');
    err.code = -32000;
    throw err;
  });
  await server._handleMessage({ jsonrpc: '2.0', id: 8, method: 'plain' });
  assert.equal(errors[0].data, undefined);
});

test('JsonRpcServer: thrown Error without .code maps to -32603', async () => {
  const { server, errors } = makeHarness();
  server.onRequest('boom', () => { throw new Error('kaboom'); });
  await server._handleMessage({ jsonrpc: '2.0', id: 5, method: 'boom' });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].id, 5);
  assert.equal(errors[0].code, -32603);
  assert.match(errors[0].message, /kaboom/);
});

test('JsonRpcServer: unknown method → -32601 Method not found', async () => {
  const { server, results, errors } = makeHarness();
  await server._handleMessage({ jsonrpc: '2.0', id: 3, method: 'nope' });
  assert.equal(results.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].id, 3);
  assert.equal(errors[0].code, -32601);
  assert.match(errors[0].message, /Method not found: nope/);
});

test('JsonRpcServer: notification (no id) produces NO response line', async () => {
  const { server, results, errors } = makeHarness();
  server.onNotification('x', () => {});
  await server._handleMessage({ jsonrpc: '2.0', method: 'x', params: {} });
  assert.equal(results.length, 0);
  assert.equal(errors.length, 0);
});

test('JsonRpcServer: notification without a registered handler is ignored silently', async () => {
  const { server, results, errors } = makeHarness();
  await server._handleMessage({ jsonrpc: '2.0', method: 'unregistered' });
  assert.equal(results.length, 0);
  assert.equal(errors.length, 0);
});

test('JsonRpcServer: message without a method is ignored', async () => {
  const { server, results, errors } = makeHarness();
  await server._handleMessage({ jsonrpc: '2.0', id: 9 });
  await server._handleMessage(null);
  await server._handleMessage('not an object');
  assert.equal(results.length, 0);
  assert.equal(errors.length, 0);
});

test('JsonRpcServer: notification handler errors are swallowed (no reply, no crash)', async () => {
  const { server, results, errors } = makeHarness();
  server.onNotification('bad', () => { throw new Error('notification boom'); });
  await server._handleMessage({ jsonrpc: '2.0', method: 'bad' });
  assert.equal(results.length, 0);
  assert.equal(errors.length, 0);
});

test('JsonRpcServer: handler registration is chainable', () => {
  const server = new JsonRpcServer();
  const ret = server.onRequest('a', () => {}).onNotification('b', () => {});
  assert.equal(ret, server);
});
