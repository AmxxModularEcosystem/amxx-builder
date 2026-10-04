'use strict';

/**
 * Tests for src/rpc-client.js — the amxx-rpc-module client.
 *
 * Every test spins up a local `net.createServer` that speaks the NDJSON
 * JSON-RPC protocol, so there is no real network dependency. Servers and
 * clients are torn down in `t.after` so the test runner can exit.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { RpcClient, RpcError } = require('../src/rpc-client');

const TOKEN = 'test-token-16chars';

/**
 * Start a mock RPC server on an ephemeral port. `onMessage(socket, msg)` is
 * called for every decoded NDJSON request/notification line.
 */
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

function makeClient(port, opts = {}) {
  return new RpcClient({ host: '127.0.0.1', port, token: TOKEN, ...opts });
}

test('RpcError carries code, message and data; defaults to -32603', () => {
  const err = new RpcError(-32002, 'service unavailable', { retry: true });
  assert.equal(err.name, 'RpcError');
  assert.equal(err.code, -32002);
  assert.equal(err.message, 'service unavailable');
  assert.deepEqual(err.data, { retry: true });

  const fallback = new RpcError();
  assert.equal(fallback.code, -32603);
});

test('RpcClient authenticates then resolves a call', async (t) => {
  const { server, sockets, port } = await startServer((socket, msg) => {
    if (msg.method === 'rpc.auth') {
      sendResult(socket, msg.id, { ok: true });
      return;
    }
    sendResult(socket, msg.id, { pong: true, params: msg.params });
  });
  const client = makeClient(port);
  t.after(async () => {
    client.close();
    await closeServer(server, sockets);
  });

  let connected = false;
  client.on('connected', () => { connected = true; });

  const result = await client.call('ping', { n: 1 });
  assert.deepEqual(result, { pong: true, params: { n: 1 } });
  assert.equal(connected, true);
  assert.equal(client.isConnected(), true);
});

test('RpcClient correlates concurrent responses by id', async (t) => {
  const { server, sockets, port } = await startServer((socket, msg) => {
    if (msg.method === 'rpc.auth') {
      sendResult(socket, msg.id, { ok: true });
      return;
    }
    if (msg.method === 'slow') {
      setTimeout(() => sendResult(socket, msg.id, { which: 'slow' }), 30);
    } else if (msg.method === 'fast') {
      setTimeout(() => sendResult(socket, msg.id, { which: 'fast' }), 5);
    }
  });
  const client = makeClient(port);
  t.after(async () => {
    client.close();
    await closeServer(server, sockets);
  });

  // Responses arrive out of order (fast before slow); ids must map each
  // result back to its own request.
  const [slow, fast] = await Promise.all([
    client.call('slow', {}),
    client.call('fast', {}),
  ]);
  assert.deepEqual(slow, { which: 'slow' });
  assert.deepEqual(fast, { which: 'fast' });
});

test('RpcClient: -32001 auth failure rejects and stays terminal', async (t) => {
  const { server, sockets, port } = await startServer((socket, msg) => {
    if (msg.method === 'rpc.auth') {
      send(socket, {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32001, message: 'not authenticated' },
      });
      socket.destroy();
    }
  });
  const client = makeClient(port);
  t.after(async () => {
    client.close();
    await closeServer(server, sockets);
  });

  await assert.rejects(
    () => client.connect(),
    (err) => {
      assert.ok(err instanceof RpcError);
      assert.equal(err.code, -32001);
      return true;
    }
  );

  // Terminal: a later call must not silently retry the handshake.
  await assert.rejects(
    () => client.call('ping', {}),
    (err) => err.code === -32001
  );
});

test('RpcClient: server error response rejects with code/message/data', async (t) => {
  const { server, sockets, port } = await startServer((socket, msg) => {
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
  const client = makeClient(port);
  t.after(async () => {
    client.close();
    await closeServer(server, sockets);
  });

  await assert.rejects(
    () => client.call('bad', {}),
    (err) => {
      assert.ok(err instanceof RpcError);
      assert.equal(err.code, -32602);
      assert.equal(err.message, 'invalid params');
      assert.deepEqual(err.data, { field: 'x' });
      return true;
    }
  );
});

test('RpcClient: notifications are emitted, not matched to pending calls', async (t) => {
  const { server, sockets, port } = await startServer((socket, msg) => {
    if (msg.method === 'rpc.auth') {
      sendResult(socket, msg.id, { ok: true });
      return;
    }
    // Push a notification (no id) before the actual response.
    send(socket, { jsonrpc: '2.0', method: 'server.event', params: { n: 1 } });
    sendResult(socket, msg.id, { done: true });
  });
  const client = makeClient(port);
  t.after(async () => {
    client.close();
    await closeServer(server, sockets);
  });

  const notifications = [];
  client.on('notification', (method, params) => {
    notifications.push({ method, params });
  });

  const result = await client.call('sub', {});
  assert.deepEqual(result, { done: true });
  assert.deepEqual(notifications, [{ method: 'server.event', params: { n: 1 } }]);
});

test('RpcClient: a call with no reply rejects with -32005 on timeout', async (t) => {
  const { server, sockets, port } = await startServer((socket, msg) => {
    if (msg.method === 'rpc.auth') sendResult(socket, msg.id, { ok: true });
    // Deliberately never reply to any other method.
  });
  const client = makeClient(port, { timeoutMs: 40 });
  t.after(async () => {
    client.close();
    await closeServer(server, sockets);
  });

  await assert.rejects(
    () => client.call('never', {}),
    (err) => {
      assert.ok(err instanceof RpcError);
      assert.equal(err.code, -32005);
      assert.equal(err.message, 'Request timeout');
      return true;
    }
  );
});

test('RpcClient: server closing the socket rejects pending calls', async (t) => {
  const { server, sockets, port } = await startServer((socket, msg) => {
    if (msg.method === 'rpc.auth') {
      sendResult(socket, msg.id, { ok: true });
      return;
    }
    socket.destroy(); // drop the connection mid-request
  });
  const client = makeClient(port);
  t.after(async () => {
    client.close();
    await closeServer(server, sockets);
  });

  await assert.rejects(
    () => client.call('hang', {}),
    (err) => {
      assert.ok(err instanceof RpcError);
      assert.equal(err.code, -32003);
      return true;
    }
  );
});

test('RpcClient.close rejects pending calls', async (t) => {
  const { server, sockets, port } = await startServer((socket, msg) => {
    if (msg.method === 'rpc.auth') sendResult(socket, msg.id, { ok: true });
  });
  const client = makeClient(port);
  t.after(async () => {
    client.close();
    await closeServer(server, sockets);
  });

  const pending = client.call('hang', {});
  // Give the lazy connect + request write a moment to land, then close.
  await new Promise((resolve) => setTimeout(resolve, 20));
  client.close();

  await assert.rejects(
    pending,
    (err) => {
      assert.ok(err instanceof RpcError);
      assert.equal(err.code, -32003);
      return true;
    }
  );
});

test('RpcClient: connect() is idempotent while connected', async (t) => {
  const { server, sockets, port } = await startServer((socket, msg) => {
    if (msg.method === 'rpc.auth') sendResult(socket, msg.id, { ok: true });
  });
  const client = makeClient(port);
  t.after(async () => {
    client.close();
    await closeServer(server, sockets);
  });

  const first = await client.connect();
  const second = await client.connect();
  assert.equal(first, client);
  assert.equal(second, client);
  assert.equal(client.isConnected(), true);
});

test('RpcClient: close() then call() reconnects without a stale-close clobber', async (t) => {
  const { server, sockets, port } = await startServer((socket, msg) => {
    if (msg.method === 'rpc.auth') {
      sendResult(socket, msg.id, { ok: true });
      return;
    }
    sendResult(socket, msg.id, { pong: true });
  });
  const client = makeClient(port);
  t.after(async () => {
    client.close();
    await closeServer(server, sockets);
  });

  assert.deepEqual(await client.call('rpc.ping', {}), { pong: true });

  client.close();
  assert.deepEqual(await client.call('rpc.ping', {}), { pong: true });
  assert.equal(client.isConnected(), true);
});

test('RpcClient decodes a multi-byte character split across TCP chunks', async (t) => {
  const name = 'Ünïcödé';
  const { server, sockets, port } = await startServer((socket, msg) => {
    if (msg.method === 'rpc.auth') sendResult(socket, msg.id, { ok: true });
  });
  const client = makeClient(port);
  t.after(async () => {
    client.close();
    await closeServer(server, sockets);
  });

  const received = [];
  client.on('notification', (method, params) => received.push(params));
  await client.connect();

  // Feed the line in two byte slices split inside a multi-byte sequence.
  const line = JSON.stringify({ jsonrpc: '2.0', method: 'player', params: { name } }) + '\n';
  const bytes = Buffer.from(line, 'utf8');
  const cut = bytes.indexOf(Buffer.from('Ü', 'utf8')) + 1;
  client._onData(bytes.subarray(0, cut));
  client._onData(bytes.subarray(cut));

  assert.deepEqual(received, [{ name }]);
});

test('RpcClient: connect() times out instead of hanging', async (t) => {
  const realCreateConnection = net.createConnection;
  net.createConnection = () => new net.Socket();
  t.after(() => { net.createConnection = realCreateConnection; });

  const client = makeClient(1, { timeoutMs: 60 });
  t.after(() => client.close());

  await assert.rejects(
    () => client.connect(),
    (err) => {
      assert.ok(err instanceof RpcError);
      assert.equal(err.code, -32003);
      assert.match(err.message, /timed out/i);
      return true;
    }
  );
});
