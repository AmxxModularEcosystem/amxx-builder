'use strict';

/**
 * Tests for src/rpc-config.js — environment-driven RPC client configuration.
 *
 * Every test passes an explicit fake env object so the real process.env is
 * never mutated.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveRpcConfig, parseRpcBool, RPC_DEFAULTS } = require('../src/rpc-config');

test('RPC_DEFAULTS exposes the documented defaults', () => {
  assert.equal(RPC_DEFAULTS.host, '127.0.0.1');
  assert.equal(RPC_DEFAULTS.port, 27016);
  assert.equal(RPC_DEFAULTS.timeoutMs, 15000);
});

test('resolveRpcConfig: empty env is disabled with defaults populated', () => {
  const cfg = resolveRpcConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.port, 27016);
  assert.equal(cfg.timeoutMs, 15000);
  assert.equal(cfg.token, '');
  assert.ok(cfg.reason, 'disabled config carries a human-readable reason');
  assert.match(cfg.reason, /token/i);
});

test('resolveRpcConfig: token alone enables the client', () => {
  const cfg = resolveRpcConfig({ AMXB_RPC_TOKEN: 's3cret-token-16ch' });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.token, 's3cret-token-16ch');
  assert.equal(cfg.reason, null);
});

test('resolveRpcConfig: full override wins over defaults', () => {
  const cfg = resolveRpcConfig({
    AMXB_RPC_ENABLED: '1',
    AMXB_RPC_HOST: '10.0.0.5',
    AMXB_RPC_PORT: '12345',
    AMXB_RPC_TOKEN: '  tok  ',
    AMXB_RPC_TIMEOUT: '30',
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.host, '10.0.0.5');
  assert.equal(cfg.port, 12345);
  assert.equal(cfg.timeoutMs, 30000);
  assert.equal(cfg.token, 'tok', 'token is trimmed');
});

test('resolveRpcConfig: AMXB_RPC_ENABLED=true without a token stays disabled', () => {
  const cfg = resolveRpcConfig({ AMXB_RPC_ENABLED: 'true' });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.reason, 'missing token');
  assert.equal(cfg.host, '127.0.0.1', 'host still populated when disabled');
  assert.equal(cfg.port, 27016, 'port still populated when disabled');
  assert.equal(cfg.timeoutMs, 15000, 'timeout still populated when disabled');
});

test('resolveRpcConfig: AMXB_RPC_ENABLED=0 forces off even with a token', () => {
  const cfg = resolveRpcConfig({
    AMXB_RPC_ENABLED: '0',
    AMXB_RPC_TOKEN: 's3cret-token-16ch',
  });
  assert.equal(cfg.enabled, false);
  assert.ok(cfg.reason);
  assert.match(cfg.reason, /AMXB_RPC_ENABLED/);
});

test('resolveRpcConfig: AMXB_RPC_ENABLED=1 with a token enables', () => {
  const cfg = resolveRpcConfig({
    AMXB_RPC_ENABLED: '1',
    AMXB_RPC_TOKEN: 's3cret-token-16ch',
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.reason, null);
});

test('resolveRpcConfig: whitespace-only token is treated as missing', () => {
  const cfg = resolveRpcConfig({ AMXB_RPC_TOKEN: '   ' });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.token, '');
  assert.equal(cfg.reason, 'missing token');
});

test('resolveRpcConfig: invalid port falls back to the default', () => {
  assert.equal(resolveRpcConfig({ AMXB_RPC_PORT: 'abc' }).port, 27016);
  assert.equal(resolveRpcConfig({ AMXB_RPC_PORT: '0' }).port, 27016);
  assert.equal(resolveRpcConfig({ AMXB_RPC_PORT: '70000' }).port, 27016);
  assert.equal(resolveRpcConfig({ AMXB_RPC_PORT: '1.5' }).port, 27016);
  assert.equal(resolveRpcConfig({ AMXB_RPC_PORT: '' }).port, 27016);
});

test('resolveRpcConfig: invalid timeout falls back to the default', () => {
  assert.equal(resolveRpcConfig({ AMXB_RPC_TIMEOUT: '0' }).timeoutMs, 15000);
  assert.equal(resolveRpcConfig({ AMXB_RPC_TIMEOUT: '-5' }).timeoutMs, 15000);
  assert.equal(resolveRpcConfig({ AMXB_RPC_TIMEOUT: 'abc' }).timeoutMs, 15000);
  assert.equal(resolveRpcConfig({ AMXB_RPC_TIMEOUT: '' }).timeoutMs, 15000);
  assert.equal(resolveRpcConfig({ AMXB_RPC_TIMEOUT: '0.5' }).timeoutMs, 500);
});

test('resolveRpcConfig: empty host falls back to the default', () => {
  assert.equal(resolveRpcConfig({ AMXB_RPC_HOST: '   ' }).host, '127.0.0.1');
});

test('parseRpcBool: truthy spellings (case-insensitive)', () => {
  for (const value of ['1', 'true', 'TRUE', 'Yes', 'on', ' ON ']) {
    assert.equal(parseRpcBool(value), true, `${value} -> true`);
  }
});

test('parseRpcBool: falsy spellings (case-insensitive)', () => {
  for (const value of ['0', 'false', 'FALSE', 'No', 'off', ' Off ']) {
    assert.equal(parseRpcBool(value), false, `${value} -> false`);
  }
});

test('parseRpcBool: anything else is null', () => {
  for (const value of [null, undefined, '', '  ', 'maybe', '2', 'enabled']) {
    assert.equal(parseRpcBool(value), null, `${String(value)} -> null`);
  }
});
