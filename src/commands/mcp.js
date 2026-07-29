'use strict';

const { startServer } = require('../../mcp/dep-resolver');

/**
 * Run the MCP server (stdin/stdout JSON-RPC).
 * Intended to be spawned by opencode as a subprocess.
 */
async function runMcp() {
  await startServer();
}

module.exports = { runMcp };
