'use strict';

/**
 * Single source of truth for MCP tool result shaping.
 *
 * Extracted verbatim from mcp/handlers.js so every interface layer (base tools
 * and the optional RPC tools) produces identical result envelopes and applies
 * the same output limits.
 */

const { formatBytes } = require('../src/format');

function textResult(text) {
  return {
    content: [{ type: 'text', text }],
  };
}

function errorResult(message, code = -32603) {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
    _meta: code ? { code } : undefined,
  };
}

const DEFAULT_MAX_OUTPUT_BYTES = 200 * 1024; // 200 KB
const DEFAULT_MAX_FILES        = 50;

function applyOutputLimit(text, args, maxBytes = DEFAULT_MAX_OUTPUT_BYTES) {
  if (args?.full_output) return text;
  const size = Buffer.byteLength(text, 'utf8');
  if (size <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf8').subarray(0, maxBytes);
  // Walk back past any UTF-8 continuation bytes so we never split a character.
  let cutLen = buf.length;
  while (cutLen > 0 && (buf[cutLen - 1] & 0xc0) === 0x80) cutLen--;
  const cut = buf.subarray(0, cutLen).toString('utf8');
  return (
    cut +
    `\n… [truncated ${formatBytes(size)} → ${formatBytes(maxBytes)}; ` +
    `pass full_output=true for the complete output]`
  );
}

function limitFiles(files, args) {
  if (args?.full_output || files.length <= DEFAULT_MAX_FILES) return files;
  return files.slice(0, DEFAULT_MAX_FILES);
}

module.exports = {
  textResult,
  errorResult,
  applyOutputLimit,
  limitFiles,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_FILES,
};