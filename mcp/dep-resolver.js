#!/usr/bin/env node
'use strict';

/**
 * MCP server: AMXX Dependency Interface Resolver.
 * Tools and schemas live in mcp/registry.js; handlers in mcp/handlers.js.
 * Register in opencode.json:
 *   "mcp": { "amxx-dep-resolver": { "type": "local", "command": ["amxb", "mcp"], "enabled": true } }
 */

const path   = require('path');
const dotenv = require('dotenv');

const logger   = require('../src/logger');
const progress = require('../src/progress');
const { McpServer } = require('./mcp-server');
const { listTools, callTool } = require('./registry');

const SERVER_INFO = {
  name:    'amxx-dep-resolver',
  version: '1.0.0',
};

/**
 * Create and configure the MCP server with all tool handlers.
 * Does NOT connect — call startServer() to begin listening on stdin.
 */
function createServer() {
  const server = new McpServer(SERVER_INFO, { tools: {} });

  server.setRequestHandler('ListTools', async () => listTools());

  server.setRequestHandler('CallTool', async (request) => {
    const { name, arguments: args } = request.params;

    try {
      return await callTool(name, args);
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message || String(err)}` }],
        isError: true,
      };
    }
  });

  return server;
}

// Load project .env like the CLI does; keep stdout free for JSON-RPC.
// No override: real process env (client-provided GITHUB_TOKEN etc.) wins.
function prepareEnvironment() {
  dotenv.config({ path: path.join(process.cwd(), '.env'), quiet: true });
  logger.setStderr(true);
  progress.setEnabled(false);
}

/**
 * Start the MCP server — listens on stdin/stdout forever.
 */
async function startServer() {
  prepareEnvironment();
  const server = createServer();
  await server.connect();
}

module.exports = { createServer, startServer };

// ─── Direct execution guard ────────────────────────────────────────────────────

if (require.main === module) {
  startServer().catch((err) => {
    console.error('Fatal MCP server error:', err);
    process.exit(1);
  });
}
