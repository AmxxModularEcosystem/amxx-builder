'use strict';

/**
 * Tests for the optional RPC MCP tools (mcp/rpc-tools.js) and their gating in
 * mcp/registry.js.
 *
 * Every test spins up a local `net.createServer` speaking NDJSON JSON-RPC, so
 * there is no real network dependency. Servers, sockets and the module-level
 * client singleton are torn down in `t.after` so the runner can exit.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { listTools, callTool } = require('../mcp/registry');
const { RPC_TOOLS, __resetForTests } = require('../mcp/rpc-tools');

const TOKEN = 'test-token-16chars';
const RPC_NAMES = RPC_TOOLS.map((t) => t.name);
const ENV_KEYS = ['AMXB_RPC_HOST', 'AMXB_RPC_PORT', 'AMXB_RPC_TOKEN', 'AMXB_RPC_ENABLED'];

const ORIGINAL_ENV = {};
for (const key of ENV_KEYS) ORIGINAL_ENV[key] = process.env[key];

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
}

function configureEnv(port) {
  process.env.AMXB_RPC_HOST = '127.0.0.1';
  process.env.AMXB_RPC_PORT = String(port);
  process.env.AMXB_RPC_TOKEN = TOKEN;
  delete process.env.AMXB_RPC_ENABLED;
}

function startServer(onMessage) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (_) {
          continue;
        }
        onMessage(socket, msg);
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, sockets, port: server.address().port });
    });
  });
}

function send(socket, obj) {
  socket.write(JSON.stringify(obj) + '\n');
}

function sendResult(socket, id, result) {
  send(socket, { jsonrpc: '2.0', id, result });
}

function closeServer(server, sockets) {
  for (const socket of sockets) socket.destroy();
  return new Promise((resolve) => server.close(resolve));
}

const DEFAULT_RESULTS = {
  'rpc.ping': { pong: true },
  'rpc.version': { version: '1.2.3' },
  'rpc.methods': ['rpc.ping', 'rpc.version', 'server.exec'],
  'players.list': [{ index: 1, name: 'Alice' }],
  'fake.create': { index: 5, authid: 'STEAM_1:0:1' },
  'events.subscribe': { subscribed: true },
};

function defaultHandler(socket, msg) {
  if (msg.method === 'rpc.auth') {
    sendResult(socket, msg.id, { ok: true });
    return;
  }
  if (Object.prototype.hasOwnProperty.call(DEFAULT_RESULTS, msg.method)) {
    sendResult(socket, msg.id, DEFAULT_RESULTS[msg.method]);
    return;
  }
  send(socket, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
}

async function setup(t, onMessage = defaultHandler) {
  const { server, sockets, port } = await startServer(onMessage);
  configureEnv(port);
  t.after(async () => {
    __resetForTests();
    await closeServer(server, sockets);
    restoreEnv();
  });
  return { server, sockets, port };
}

function textOf(res) {
  return res.content[0].text;
}

beforeEach(() => {
  __resetForTests();
});

test('RPC tools are hidden from tools/list without a token', async (t) => {
  delete process.env.AMXB_RPC_TOKEN;
  delete process.env.AMXB_RPC_ENABLED;
  t.after(restoreEnv);

  const { tools } = listTools();
  const names = tools.map((tool) => tool.name);
  for (const name of RPC_NAMES) {
    assert.ok(!names.includes(name), `unexpected RPC tool in list: ${name}`);
  }

  const res = await callTool('rpc_call', { method: 'rpc.ping' });
  assert.equal(res.isError, true);
  assert.equal(res._meta.code, -32601);
});

test('RPC tools are listed when configured, without internal fields', async (t) => {
  configureEnv(1);
  t.after(restoreEnv);

  assert.equal(RPC_NAMES.length, 28);
  const { tools } = listTools();
  const names = tools.map((tool) => tool.name);
  for (const name of RPC_NAMES) {
    assert.ok(names.includes(name), `missing RPC tool: ${name}`);
  }

  const rpcCall = tools.find((tool) => tool.name === 'rpc_call');
  assert.equal(rpcCall.optional, undefined);
  assert.equal(rpcCall.group, undefined);
  assert.equal(rpcCall.handler, undefined);
});

test('rpc_call returns the mocked result', async (t) => {
  await setup(t);
  const res = await callTool('rpc_call', { method: 'rpc.ping' });
  assert.equal(res.isError, undefined);
  assert.match(textOf(res), /pong/);
});

test('players_list returns the mocked array', async (t) => {
  await setup(t);
  const res = await callTool('players_list', {});
  assert.deepEqual(JSON.parse(textOf(res)), [{ index: 1, name: 'Alice' }]);
});

test('fake_create returns the mocked index and authid', async (t) => {
  await setup(t);
  const res = await callTool('fake_create', { name: 'Bot1' });
  assert.deepEqual(JSON.parse(textOf(res)), { index: 5, authid: 'STEAM_1:0:1' });
});

test('fake_look without angles/at fails validation without a network call', async (t) => {
  configureEnv(1);
  t.after(restoreEnv);

  const res = await callTool('fake_look', { index: 1 });
  assert.equal(res.isError, true);
  assert.equal(res._meta.code, -32602);
});

test('RPC errors propagate with their code and data', async (t) => {
  await setup(t, (socket, msg) => {
    if (msg.method === 'rpc.auth') {
      sendResult(socket, msg.id, { ok: true });
      return;
    }
    send(socket, {
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32602, message: 'invalid params', data: { field: 'x' } },
    });
  });

  const res = await callTool('cvar_get', { name: 'sv_cheats' });
  assert.equal(res.isError, true);
  assert.equal(res._meta.code, -32602);
  assert.match(textOf(res), /invalid params/);
  assert.match(textOf(res), /field/);
});

test('unknown RPC method surfaces -32601', async (t) => {
  await setup(t);
  const res = await callTool('rpc_call', { method: 'does.not.exist' });
  assert.equal(res.isError, true);
  assert.equal(res._meta.code, -32601);
});

test('events_subscribe buffers a pushed notification for events_drain', async (t) => {
  let pushed = false;
  await setup(t, (socket, msg) => {
    if (msg.method === 'rpc.auth') {
      sendResult(socket, msg.id, { ok: true });
      return;
    }
    if (msg.method === 'events.subscribe') {
      if (!pushed) {
        pushed = true;
        send(socket, { jsonrpc: '2.0', method: 'player_death', params: { victim: 1 } });
      }
      sendResult(socket, msg.id, { subscribed: true });
      return;
    }
    sendResult(socket, msg.id, {});
  });

  const sub = await callTool('events_subscribe', { event: 'player_death' });
  assert.equal(sub.isError, undefined);

  const drain = await callTool('events_drain', {});
  const payload = JSON.parse(textOf(drain));
  assert.equal(payload.count, 1);
  assert.equal(payload.events[0].event, 'player_death');
  assert.deepEqual(payload.events[0].params, { victim: 1 });
});

test('events_drain honors limit and clear=false', async (t) => {
  let pushed = false;
  await setup(t, (socket, msg) => {
    if (msg.method === 'rpc.auth') {
      sendResult(socket, msg.id, { ok: true });
      return;
    }
    if (msg.method === 'events.subscribe') {
      if (!pushed) {
        pushed = true;
        send(socket, { jsonrpc: '2.0', method: 'e1', params: {} });
        send(socket, { jsonrpc: '2.0', method: 'e2', params: {} });
      }
      sendResult(socket, msg.id, { subscribed: true });
      return;
    }
    sendResult(socket, msg.id, {});
  });

  await callTool('events_subscribe', { event: 'e1' });

  const first = JSON.parse(textOf(await callTool('events_drain', { limit: 1, clear: false })));
  assert.equal(first.count, 1);
  assert.equal(first.events[0].event, 'e1');

  const second = JSON.parse(textOf(await callTool('events_drain', {})));
  assert.equal(second.count, 2);
});

test('rpc_methods filters by grep', async (t) => {
  await setup(t);
  const res = await callTool('rpc_methods', { grep: 'PING' });
  assert.deepEqual(JSON.parse(textOf(res)), ['rpc.ping']);
});

test('rpc_status returns version and ping', async (t) => {
  await setup(t);
  const res = await callTool('rpc_status', {});
  const payload = JSON.parse(textOf(res));
  assert.deepEqual(payload.version, { version: '1.2.3' });
  assert.deepEqual(payload.ping, { pong: true });
});

test('cvar_set without value fails validation with -32602', async (t) => {
  configureEnv(1);
  t.after(restoreEnv);

  const res = await callTool('cvar_set', { name: 'sv_cheats' });
  assert.equal(res.isError, true);
  assert.equal(res._meta.code, -32602);
});

test('bot_freeze requires a boolean frozen', async (t) => {
  configureEnv(1);
  t.after(restoreEnv);

  const res = await callTool('bot_freeze', { index: 1, frozen: 'yes' });
  assert.equal(res.isError, true);
  assert.equal(res._meta.code, -32602);
});

test('events_drain with limit keeps unreturned events', async (t) => {
  let pushed = false;
  await setup(t, (socket, msg) => {
    if (msg.method === 'rpc.auth') {
      sendResult(socket, msg.id, { ok: true });
      return;
    }
    if (msg.method === 'events.subscribe') {
      if (!pushed) {
        pushed = true;
        for (const event of ['e1', 'e2', 'e3']) {
          send(socket, { jsonrpc: '2.0', method: event, params: {} });
        }
      }
      sendResult(socket, msg.id, { subscribed: true });
      return;
    }
    sendResult(socket, msg.id, {});
  });

  await callTool('events_subscribe', { event: 'e1' });

  const first = JSON.parse(textOf(await callTool('events_drain', { limit: 2 })));
  assert.equal(first.count, 2);

  const rest = JSON.parse(textOf(await callTool('events_drain', {})));
  assert.equal(rest.count, 1);
  assert.equal(rest.events[0].event, 'e3');
});

test('events_subscribe subscribes exactly once on first connect', async (t) => {
  let subscribeCalls = 0;
  await setup(t, (socket, msg) => {
    if (msg.method === 'rpc.auth') {
      sendResult(socket, msg.id, { ok: true });
      return;
    }
    if (msg.method === 'events.subscribe') {
      subscribeCalls += 1;
      sendResult(socket, msg.id, { subscribed: true });
      return;
    }
    sendResult(socket, msg.id, {});
  });

  await callTool('events_subscribe', { event: 'player_death' });
  assert.equal(subscribeCalls, 1);
});