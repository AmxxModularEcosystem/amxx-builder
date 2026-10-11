'use strict';

/**
 * Unit tests for src/http.js — githubHeaders, DEFAULT_API_TIMEOUT_MS, axios default.
 *
 * Offline + deterministic: no network, no filesystem.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { axios, DEFAULT_API_TIMEOUT_MS, githubHeaders } = require('../src/http');

test('githubHeaders(no token) returns the exact Accept-only object', () => {
  assert.deepStrictEqual(githubHeaders(), { Accept: 'application/vnd.github+json' });
});

test('githubHeaders(token) returns the exact Accept + Bearer object', () => {
  assert.deepStrictEqual(githubHeaders('ghp_abc123'), {
    Accept: 'application/vnd.github+json',
    Authorization: 'Bearer ghp_abc123',
  });
});

test('axios.defaults.timeout is the shared 30s default', () => {
  assert.strictEqual(axios.defaults.timeout, 30000);
});

test('DEFAULT_API_TIMEOUT_MS is 30000', () => {
  assert.strictEqual(DEFAULT_API_TIMEOUT_MS, 30000);
});
