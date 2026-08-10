#!/usr/bin/env node
'use strict';

/**
 * Minimal MCP (Model Context Protocol) server — pure JSON-RPC 2.0 over stdio.
 *
 * No external dependencies. Implements the subset of MCP needed for tool
 * discovery and invocation:
 *   - initialize / notifications/initialized
 *   - tools/list, tools/call
 *   - ping
 *   - notifications/cancelled
 *
 * Usage:
 *   const { McpServer } = require('./mcp-server');
 *   const server = new McpServer(
 *     { name: 'my-server', version: '1.0.0' },
 *     { tools: {} }
 *   );
 *   server.setRequestHandler('ListTools', async () => ({ tools: [...] }));
 *   server.setRequestHandler('CallTool', async (req) => { ... });
 *   server.connect();
 */

const readline = require('readline');

class McpServer {
  /**
   * @param {object} serverInfo  - { name, version } for the MCP initialize response
   * @param {object} capabilities - { tools: {}, ... } advertised to the client
   */
  constructor(serverInfo, capabilities) {
    this.serverInfo = serverInfo;
    this.capabilities = capabilities || {};
    this._handlers = {};
    this._initialized = false;
    this._rl = null;
    this._closed = false;
    // EPIPE when the client dies — exit cleanly instead of crashing.
    process.stdout.on('error', () => process.exit(0));
  }

  /**
   * Register a request handler by MCP schema name.
   * @param {'ListTools'|'CallTool'} schema
   * @param {Function} handler — async function
   */
  setRequestHandler(schema, handler) {
    this._handlers[schema] = handler;
  }

  /**
   * Start listening on stdin. Never resolves (runs until close).
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
          this._sendError(id, -32700, 'Parse error');
        }
        continue;
      }

      try {
        await this._handleMessage(msg);
      } catch (err) {
        // Handler threw unexpectedly — respond with internal error if it has an id
        if (msg.id != null) {
          this._sendError(msg.id, -32603, 'Internal error: ' + err.message);
        }
      }
    }

    // stdin EOF — client closed the pipe; exit so we don't hang on open stdout.
    process.exit(0);
  }

  close() {
    this._closed = true;
    if (this._rl) this._rl.close();
  }

  // ─── Message dispatch ────────────────────────────────────────────────────

  async _handleMessage(msg) {
    if (!msg || typeof msg !== 'object' || !msg.method) return;

    const { method, id, params } = msg;
    const isNotification = id == null;

    switch (method) {
      case 'initialize':
        this._sendResult(id, {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: this.capabilities,
          serverInfo: this.serverInfo,
        });
        break;

      case 'notifications/initialized':
        this._initialized = true;
        break;

      case 'ping':
        this._sendResult(id, {});
        break;

      case 'tools/list': {
        const handler = this._handlers.ListTools || this._handlers.ListToolsRequestSchema;
        if (handler) {
          const result = await handler();
          this._sendResult(id, result);
        } else {
          this._sendResult(id, { tools: [] });
        }
        break;
      }

      case 'tools/call': {
        const handler = this._handlers.CallTool || this._handlers.CallToolRequestSchema;
        if (handler) {
          const result = await handler({
            params: {
              name: params?.name,
              arguments: params?.arguments,
            },
          });
          this._sendResult(id, result);
        } else {
          this._sendError(id, -32601, 'Method not found: tools/call');
        }
        break;
      }

      case 'notifications/cancelled':
        // Optional: could abort in-flight operations. For now, no-op.
        break;

      default:
        if (!isNotification) {
          this._sendError(id, -32601, `Method not found: ${method}`);
        }
        break;
    }
  }

  // ─── JSON-RPC helpers ────────────────────────────────────────────────────

  _sendResult(id, result) {
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'
    );
  }

  _sendError(id, code, message, data) {
    const err = { jsonrpc: '2.0', id, error: { code, message } };
    if (data !== undefined) err.error.data = data;
    process.stdout.write(JSON.stringify(err) + '\n');
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

module.exports = { McpServer };
