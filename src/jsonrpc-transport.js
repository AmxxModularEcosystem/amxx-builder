#!/usr/bin/env node
'use strict';

/**
 * Generic JSON-RPC 2.0 server over stdio.
 *
 * Line-delimited JSON-RPC 2.0: each line on stdin is one request, response or
 * notification; each response/notification is written as one JSON line on
 * stdout. This is pure transport — it knows nothing about MCP, protocols,
 * or domain methods. Method semantics live in the adapter layer (e.g.
 * mcp/mcp-server.js), which registers request/notification handlers.
 *
 * No external dependencies.
 *
 * Usage:
 *   const { JsonRpcServer } = require('./jsonrpc-transport');
 *   const rpc = new JsonRpcServer();
 *   rpc.onRequest('greet', (params) => ({ hello: params?.name || 'world' }));
 *   rpc.onRequest('fail', () => { const e = new Error('nope'); e.code = -32000; throw e; });
 *   rpc.onNotification('log', (params) => console.error('log:', params));
 *   rpc.notify('event', { kind: 'done' });   // server → client push
 *   rpc.connect();
 */

const readline = require('readline');

class JsonRpcServer {
  constructor() {
    this._requests = new Map();
    this._notifications = new Map();
    this._rl = null;
    this._closed = false;
    // EPIPE when the client dies — exit cleanly instead of crashing.
    process.stdout.on('error', () => process.exit(0));
  }

  /**
   * Register a handler for a request method (messages WITH id).
   * Handler receives the decoded params object; may be async.
   * Its return value is sent as `result`. A thrown Error is sent as
   * `error` with code -32603 (message = err.message), unless the Error
   * carries a numeric `.code` property, which is then used verbatim.
   * Returns this for chaining.
   */
  onRequest(method, handler) {
    this._requests.set(method, handler);
    return this;
  }

  /**
   * Register a handler for a notification method (messages WITHOUT id).
   * Handler receives the decoded params object; may be async. Errors are
   * swallowed and logged to stderr (never sent — there is no id to reply to).
   * Returns this for chaining.
   */
  onNotification(method, handler) {
    this._notifications.set(method, handler);
    return this;
  }

  /**
   * Start listening on stdin. Never resolves (runs until close/EOF).
   */
  async connect() {
    this._rl = readline.createInterface({
      input: process.stdin,
      terminal: false,
    });

    for await (const line of this._rl) {
      if (this._closed) break;
      if (!line.trim()) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        // JSON parse error — try to extract id from the raw line
        const id = this._extractId(line);
        if (id != null) {
          this.sendError(id, -32700, 'Parse error');
        }
        continue;
      }

      // Dispatch without awaiting so a long-running handler does not block
      // subsequent notifications/requests. stdout writes are queued by Node,
      // so per-message response order is preserved.
      Promise.resolve()
        .then(() => this._handleMessage(msg))
        .catch((err) => {
          if (msg.id != null) {
            this.sendError(msg.id, -32603, 'Internal error: ' + err.message);
          }
        });
    }

    // stdin EOF — client closed the pipe; exit so we don't hang on open stdout.
    process.exit(0);
  }

  close() {
    this._closed = true;
    if (this._rl) this._rl.close();
  }

  // ─── Server → client ─────────────────────────────────────────────────────

  /**
   * Send a server-initiated notification (no id).
   */
  notify(method, params) {
    const msg = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    process.stdout.write(JSON.stringify(msg) + '\n');
  }

  /**
   * Send a successful response for a request id.
   */
  sendResult(id, result) {
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'
    );
  }

  /**
   * Send an error response for a request id.
   */
  sendError(id, code, message, data) {
    const err = { jsonrpc: '2.0', id, error: { code, message } };
    if (data !== undefined) err.error.data = data;
    process.stdout.write(JSON.stringify(err) + '\n');
  }

  // ─── Message dispatch ────────────────────────────────────────────────────

  async _handleMessage(msg) {
    if (!msg || typeof msg !== 'object' || !msg.method) return;

    const { method, id, params } = msg;

    // Notification (no id): fire handler, swallow errors — nothing to reply to.
    if (id == null) {
      const handler = this._notifications.get(method);
      if (handler) {
        try {
          await handler(params);
        } catch (err) {
          process.stderr.write(
            `[jsonrpc] notification "${method}" failed: ${err && err.message ? err.message : String(err)}\n`
          );
        }
      }
      return;
    }

    // Request (has id): reply with result, or an error on throw.
    const handler = this._requests.get(method);
    if (!handler) {
      this.sendError(id, -32601, `Method not found: ${method}`);
      return;
    }

    let result;
    try {
      result = await handler(params);
    } catch (err) {
      if (typeof err.code === 'number') {
        // Handlers may attach structured details via err.data (e.g. GitHub status).
        this.sendError(id, err.code, err.message || 'Error', err.data);
      } else {
        this.sendError(
          id,
          -32603,
          'Internal error: ' + (err && err.message ? err.message : String(err))
        );
      }
      return;
    }
    this.sendResult(id, result);
  }

  /**
   * Best-effort extraction of JSON-RPC id from a malformed JSON line.
   */
  _extractId(raw) {
    try {
      const m = raw.match(/"id"\s*:\s*(\d+|"[^"]+")/);
      if (m) return JSON.parse(m[1]);
    } catch (_) {}
    return null;
  }
}

module.exports = { JsonRpcServer };
