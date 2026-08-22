#!/usr/bin/env node
'use strict';

/**
 * MCP (Model Context Protocol) server — thin protocol adapter over the generic
 * JSON-RPC 2.0 stdio transport in src/jsonrpc-transport.js.
 *
 * Implements the subset of MCP needed for tool discovery and invocation:
 *   - initialize / notifications/initialized
 *   - tools/list, tools/call
 *   - ping
 *   - notifications/cancelled
 *
 * All wire handling (line framing, parse errors, EPIPE guard, request/
 * notification dispatch) lives in the transport. This file only maps MCP
 * method names to the stored ListTools / CallTool handlers.
 *
 * No external dependencies.
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

const { JsonRpcServer } = require('../src/jsonrpc-transport');

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

    this._transport = new JsonRpcServer();
    this._wireProtocol();
  }

  // ─── MCP protocol semantics over the generic transport ───────────────────

  _wireProtocol() {
    const t = this._transport;

    t.onRequest('initialize', (params) => ({
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: this.capabilities,
      serverInfo: this.serverInfo,
    }));

    t.onNotification('notifications/initialized', () => {
      this._initialized = true;
    });

    t.onRequest('ping', () => ({}));

    t.onRequest('tools/list', async () => {
      const handler = this._handlers.ListTools || this._handlers.ListToolsRequestSchema;
      if (handler) return await handler();
      return { tools: [] };
    });

    t.onRequest('tools/call', async (params) => {
      const handler = this._handlers.CallTool || this._handlers.CallToolRequestSchema;
      if (!handler) {
        const err = new Error('Method not found: tools/call');
        err.code = -32601;
        throw err;
      }
      return await handler({
        params: {
          name: params?.name,
          arguments: params?.arguments,
        },
      });
    });

    t.onNotification('notifications/cancelled', () => {
      // Optional: could abort in-flight operations. For now, no-op.
    });
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
    await this._transport.connect();
  }

  close() {
    this._transport.close();
  }
}

module.exports = { McpServer };
