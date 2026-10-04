'use strict';

/**
 * Client for the amxx-rpc-module game-server RPC protocol.
 *
 * Transport: plain TCP, NDJSON — exactly one JSON object per `\n`-terminated
 * UTF-8 line (a trailing `\r` is stripped). Messages are JSON-RPC 2.0.
 *
 * The first message on a fresh connection must be `rpc.auth` with
 * `{ token }`; a wrong token (or any non-auth first message) yields error
 * code -32001 and the server closes the socket — that code is terminal.
 *
 * Server→client notifications (objects with `method` and no `id`) are emitted
 * as `'notification'` events and never matched against pending calls.
 *
 * No external dependencies; Node 18+ only.
 *
 * Usage:
 *   const { RpcClient } = require('./rpc-client');
 *   const client = new RpcClient({ host, port, token, timeoutMs });
 *   client.on('notification', (method, params) => { … });
 *   const result = await client.call('server.status', {});
 *   client.close();
 */

const net = require('net');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');

const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 27016,
  timeoutMs: 15000,
});

/**
 * JSON-RPC error surfaced to callers. `.code` is the protocol error code
 * (default -32603 internal), `.data` carries optional structured details.
 */
class RpcError extends Error {
  constructor(code = -32603, message = '', data) {
    super(message || `RPC error ${code}`);
    this.name = 'RpcError';
    this.code = code == null ? -32603 : code;
    this.data = data;
  }
}

class RpcClient extends EventEmitter {
  /**
   * @param {object} [config]
   * @param {string} [config.host]
   * @param {number} [config.port]
   * @param {string} [config.token]
   * @param {number} [config.timeoutMs]
   */
  constructor(config = {}) {
    super();
    this.host = config.host || DEFAULTS.host;
    this.port = config.port || DEFAULTS.port;
    this.token = config.token || '';
    this.timeoutMs = config.timeoutMs || DEFAULTS.timeoutMs;

    this._socket = null;
    this._buffer = '';
    this._decoder = new StringDecoder('utf8');
    this._nextId = 1;
    this._pending = new Map();
    this._connected = false;
    this._terminal = false;
    this._connectPromise = null;

    // A default listener keeps a socket/parse 'error' event from crashing the
    // process when the consumer has not attached one. Consumers may add theirs.
    this.on('error', () => {});
  }

  isConnected() {
    return this._connected && !!this._socket && !this._socket.destroyed;
  }

  /**
   * Connect, authenticate and resolve once the server accepted the token.
   * Idempotent: resolves immediately when already connected.
   *
   * @returns {Promise<RpcClient>}
   */
  connect() {
    if (this.isConnected()) return Promise.resolve(this);
    if (this._terminal) {
      return Promise.reject(
        new RpcError(-32001, 'RPC connection is terminal after a previous authentication failure')
      );
    }
    if (this._connectPromise) return this._connectPromise;

    this._connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      let connectTimer = null;

      const clearConnectTimer = () => {
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
      };

      // A TCP connect can hang far past request timeout when SYNs are dropped
      // (e.g. WSL -> Windows with a filtered port), so the handshake needs its
      // own deadline; otherwise call() would never settle.
      connectTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        connectTimer = null;
        this._destroySocket();
        reject(new RpcError(-32003, `Connection timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      const failConnect = (err) => {
        if (settled) return;
        settled = true;
        clearConnectTimer();
        reject(err instanceof RpcError ? err : new RpcError(-32003, `Connection failed: ${err.message}`));
      };

      const socket = net.createConnection({ host: this.host, port: this.port });
      this._socket = socket;
      socket.setNoDelay(true);

      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('error', (err) => {
        this.emit('error', err);
        failConnect(err);
      });
      socket.on('close', () => this._onSocketClosed(socket));

      socket.once('connect', () => {
        this._sendRequest('rpc.auth', { token: this.token }, this.timeoutMs)
          .then(() => {
            settled = true;
            clearConnectTimer();
            this._connected = true;
            this.emit('connected');
            resolve(this);
          })
          .catch((err) => {
            settled = true;
            clearConnectTimer();
            if (err && err.code === -32001) this._terminal = true;
            this._destroySocket();
            reject(err);
          });
      });
    });

    // Drop the cached promise once it settles so a later call() can reconnect.
    this._connectPromise.then(
      () => { this._connectPromise = null; },
      () => { this._connectPromise = null; }
    );

    return this._connectPromise;
  }

  /**
   * Invoke a JSON-RPC method, connecting (and authenticating) lazily.
   *
   * @param {string} method
   * @param {object|Array} [params]
   * @param {{timeoutMs?: number}} [opts]
   * @returns {Promise<*>} resolves with the `result` field
   */
  async call(method, params, opts = {}) {
    if (!this.isConnected()) {
      await this.connect();
    }
    const timeoutMs =
      opts && opts.timeoutMs != null ? opts.timeoutMs : this.timeoutMs;
    return this._sendRequest(method, params, timeoutMs);
  }

  /**
   * Destroy the socket and reject every pending call. The client can still be
   * reused afterwards — the next call() reconnects lazily.
   */
  close() {
    this._rejectAllPending(new RpcError(-32003, 'RPC client closed'));
    this._connected = false;
    this._connectPromise = null;
    this._destroySocket();
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  _sendRequest(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const socket = this._socket;
      if (!socket || socket.destroyed) {
        reject(new RpcError(-32003, 'RPC socket is not connected'));
        return;
      }

      const id = this._nextId++;
      const entry = { resolve, reject, timer: null };
      this._pending.set(id, entry);

      const effectiveTimeout = timeoutMs == null ? this.timeoutMs : timeoutMs;
      if (effectiveTimeout > 0) {
        entry.timer = setTimeout(() => {
          if (!this._pending.has(id)) return;
          this._pending.delete(id);
          reject(new RpcError(-32005, 'Request timeout'));
        }, effectiveTimeout);
        if (typeof entry.timer.unref === 'function') entry.timer.unref();
      }

      const message = { jsonrpc: '2.0', id, method };
      if (params !== undefined) message.params = params;

      try {
        socket.write(JSON.stringify(message) + '\n');
      } catch (err) {
        if (entry.timer) clearTimeout(entry.timer);
        this._pending.delete(id);
        reject(new RpcError(-32003, `Failed to write request: ${err.message}`));
      }
    });
  }

  _onData(chunk) {
    // StringDecoder buffers partial multi-byte UTF-8 sequences across chunks.
    this._buffer += this._decoder.write(chunk);

    let newlineIndex;
    while ((newlineIndex = this._buffer.indexOf('\n')) !== -1) {
      let line = this._buffer.slice(0, newlineIndex);
      this._buffer = this._buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;
      this._onLine(line);
    }
  }

  _onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (err) {
      // Malformed line: never crash the reader, just surface it.
      this.emit('error', new RpcError(-32700, `Parse error: ${err.message}`));
      return;
    }

    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.emit('error', new RpcError(-32603, 'Malformed JSON-RPC message'));
      return;
    }

    // Notification: a method with no id — emit, never resolve a pending call.
    if (message.id == null) {
      if (typeof message.method === 'string') {
        this.emit('notification', message.method, message.params);
      }
      return;
    }

    const entry = this._pending.get(message.id);
    if (!entry) return; // unknown id — ignore

    this._pending.delete(message.id);
    if (entry.timer) clearTimeout(entry.timer);

    if (message.error) {
      const code = typeof message.error.code === 'number' ? message.error.code : -32603;
      const text = typeof message.error.message === 'string' ? message.error.message : 'RPC error';
      const error = new RpcError(code, text, message.error.data);
      entry.reject(error);
      if (code === -32001) {
        this._terminal = true;
        this._destroySocket();
      }
      return;
    }

    entry.resolve(message.result);
  }

  _onSocketClosed(socket) {
    // A newer socket has already replaced this one — ignore its stale close so
    // it cannot null the current socket or reject the current connection's
    // pending calls (e.g. close() followed immediately by call()).
    if (this._socket && this._socket !== socket) return;
    this._connected = false;
    this._socket = null;
    this._buffer = '';
    this._decoder = new StringDecoder('utf8');
    this._rejectAllPending(new RpcError(-32003, 'RPC connection closed'));
    this.emit('closed');
  }

  _rejectAllPending(error) {
    for (const entry of this._pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
    this._pending.clear();
  }

  _destroySocket() {
    const socket = this._socket;
    this._socket = null;
    this._connected = false;
    this._buffer = '';
    this._decoder = new StringDecoder('utf8');
    if (socket && !socket.destroyed) {
      try {
        socket.destroy();
      } catch (_) {
        // Socket already torn down — nothing to do.
      }
    }
  }
}

module.exports = { RpcClient, RpcError };
