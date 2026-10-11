'use strict';

/**
 * Unit tests for src/release-lister.js — the raw axios.get calls go through
 * withRetry: transient failures are retried, permanent 4xx are not.
 *
 * Offline + deterministic: axios.get is stubbed, and global.setTimeout is
 * replaced by an immediate-fire recorder (same pattern as test/retry.test.js)
 * so retry backoff never actually sleeps.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { listReleases, listTags } = require('../src/release-lister');

const realGet = axios.get;
after(() => { axios.get = realGet; });

function httpError(status) {
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status, data: {} };
  return err;
}

// Replaces global.setTimeout with an immediate-fire recorder (same pattern as
// test/retry.test.js): retry backoff is captured, never actually slept.
function stubTimers() {
  const captured = [];
  const orig = global.setTimeout;
  global.setTimeout = (fn, ms) => { captured.push(ms); fn(); return 0; };
  return { captured, restore() { global.setTimeout = orig; } };
}

async function withStubGet(handler, fn) {
  const orig = axios.get;
  axios.get = handler;
  try {
    return await fn();
  } finally {
    axios.get = orig;
  }
}

test('listReleases: transient 500 is retried then mapped', async () => {
  let calls = 0;
  const timers = stubTimers();
  let releases;
  try {
    releases = await withStubGet(async () => {
      calls++;
      if (calls === 1) throw httpError(500);
      return { data: [{ tag_name: 'v1.0.0', name: 'Release 1', published_at: '2026-01-01T00:00:00Z', prerelease: false, assets: [] }] };
    }, () => listReleases('org/r', { limit: 5 }));
  } finally {
    timers.restore();
  }
  assert.deepEqual(releases, [
    { tagName: 'v1.0.0', name: 'Release 1', publishedAt: '2026-01-01T00:00:00Z', prerelease: false },
  ]);
  assert.equal(calls, 2);
  assert.equal(timers.captured.length, 1);
});

test('listReleases: permanent 404 is not retried', async () => {
  let calls = 0;
  const timers = stubTimers();
  try {
    await assert.rejects(
      () => withStubGet(async () => { calls++; throw httpError(404); }, () => listReleases('org/gone', {})),
      (err) => err.response.status === 404
    );
  } finally {
    timers.restore();
  }
  assert.equal(calls, 1, '404 is permanent — axios.get must be called once');
  assert.equal(timers.captured.length, 0);
});

test('listTags: transient 500 is retried then mapped', async () => {
  let calls = 0;
  const timers = stubTimers();
  let tags;
  try {
    tags = await withStubGet(async () => {
      calls++;
      if (calls === 1) throw httpError(500);
      return { data: [{ name: 'v2.0.0', commit: { sha: 'abc123' } }] };
    }, () => listTags('org/r', { limit: 5 }));
  } finally {
    timers.restore();
  }
  assert.deepEqual(tags, [{ name: 'v2.0.0', commitSha: 'abc123' }]);
  assert.equal(calls, 2);
  assert.equal(timers.captured.length, 1);
});

test('listTags: permanent 404 is not retried', async () => {
  let calls = 0;
  const timers = stubTimers();
  try {
    await assert.rejects(
      () => withStubGet(async () => { calls++; throw httpError(404); }, () => listTags('org/gone', {})),
      (err) => err.response.status === 404
    );
  } finally {
    timers.restore();
  }
  assert.equal(calls, 1, '404 is permanent — axios.get must be called once');
  assert.equal(timers.captured.length, 0);
});
