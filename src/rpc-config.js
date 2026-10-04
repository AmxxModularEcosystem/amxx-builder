'use strict';

/**
 * Resolve the amxx-rpc-module client configuration from environment variables.
 *
 * The RPC endpoint is the game server's side channel (default 127.0.0.1:27016,
 * NOT the game port 27015). A token is mandatory: even with
 * `AMXB_RPC_ENABLED=1` the client stays disabled until a non-empty
 * `AMXB_RPC_TOKEN` is present.
 *
 * Environment keys:
 *   AMXB_RPC_ENABLED  optional force switch (1/true/yes/on | 0/false/no/off)
 *   AMXB_RPC_HOST     default 127.0.0.1
 *   AMXB_RPC_PORT     default 27016 (integer; invalid -> default)
 *   AMXB_RPC_TOKEN    shared secret, trimmed (required)
 *   AMXB_RPC_TIMEOUT  seconds, default 15 (invalid/<=0 -> default)
 *
 * Lives in core so every interface resolves the configuration identically.
 */

const RPC_DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 27016,
  timeoutMs: 15000,
});

/**
 * Parse a boolean-ish env value (trimmed, case-insensitive):
 *
 *   unset / empty / other   -> null  (no explicit override)
 *   1 | true | yes | on     -> true
 *   0 | false | no | off    -> false
 *
 * @param {*} value
 * @returns {boolean|null}
 */
function parseRpcBool(value) {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function parseRpcPort(raw) {
  if (raw == null || String(raw).trim() === '') return RPC_DEFAULTS.port;
  const port = Number(String(raw).trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) return RPC_DEFAULTS.port;
  return port;
}

function parseRpcTimeoutMs(raw) {
  if (raw == null || String(raw).trim() === '') return RPC_DEFAULTS.timeoutMs;
  const seconds = Number(String(raw).trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return RPC_DEFAULTS.timeoutMs;
  return Math.round(seconds * 1000);
}

/**
 * Resolve the effective RPC client configuration.
 *
 * @param {object} [env=process.env] - environment source (injectable for tests)
 * @returns {{enabled: boolean, host: string, port: number, timeoutMs: number, token: string, reason: string|null}}
 */
function resolveRpcConfig(env = process.env) {
  const e = env || {};

  const rawHost = e.AMXB_RPC_HOST;
  const host =
    rawHost != null && String(rawHost).trim() !== ''
      ? String(rawHost).trim()
      : RPC_DEFAULTS.host;

  const port = parseRpcPort(e.AMXB_RPC_PORT);
  const timeoutMs = parseRpcTimeoutMs(e.AMXB_RPC_TIMEOUT);
  const token = e.AMXB_RPC_TOKEN == null ? '' : String(e.AMXB_RPC_TOKEN).trim();
  const flag = parseRpcBool(e.AMXB_RPC_ENABLED);

  let enabled = false;
  let reason = null;
  if (!token) {
    reason = 'missing token';
  } else if (flag === false) {
    reason = 'disabled by AMXB_RPC_ENABLED';
  } else {
    enabled = true;
  }

  return { enabled, host, port, timeoutMs, token, reason };
}

module.exports = { resolveRpcConfig, parseRpcBool, RPC_DEFAULTS };
