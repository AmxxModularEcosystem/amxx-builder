'use strict';

/**
 * Unit tests for src/retry.js.
 *
 * retry.js exports a single function (`withRetry`); `isTransient` and
 * `retryDelayMs` are internal and are covered indirectly through its behavior.
 *
 * Offline + deterministic: tiny baseDelayMs, few attempts, and a stubbed
 * setTimeout for exact delay assertions (no real 1s waits).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { withRetry } = require('../src/retry');

// Builds an error shaped like a failed HTTP request. When `status` is
// null/undefined the error has no `response` at all (network-level failure).
function httpError(status, headers = {}) {
  const err = new Error(status === undefined || status === null ? 'network error' : `HTTP ${status}`);
  if (status !== undefined && status !== null) {
    err.response = { status, headers };
  }
  return err;
}

// Replaces global.setTimeout with a recorder that captures delays and fires
// callbacks immediately (no real waiting). Returns captured delays + restore.
function stubTimers() {
  const captured = [];
  const orig = global.setTimeout;
  global.setTimeout = (fn, ms) => {
    captured.push(ms);
    fn(); // resolve the retry sleep synchronously — no real wait
    return 0;
  };
  return {
    captured,
    restore() {
      global.setTimeout = orig;
    },
  };
}

// ─── basic success / retry-on-transient ─────────────────────────────────────

test('withRetry: resolves on first try (fn called exactly once)', async () => {
  let calls = 0;
  const result = await withRetry(async () => { calls++; return 'ok'; }, { attempts: 3, baseDelayMs: 5 });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withRetry: works with no options (defaults apply)', async () => {
  let calls = 0;
  const result = await withRetry(async () => { calls++; return 'ok'; });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withRetry: retries 500 then succeeds (fn called twice)', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls === 1) throw httpError(500);
    return 'ok';
  }, { attempts: 2, baseDelayMs: 5 });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('withRetry: retries 408 then succeeds', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls === 1) throw httpError(408);
    return 'ok';
  }, { attempts: 2, baseDelayMs: 5 });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('withRetry: retries 429 then succeeds', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls === 1) throw httpError(429);
    return 'ok';
  }, { attempts: 2, baseDelayMs: 5 });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('withRetry: retries 403 with X-RateLimit-Remaining: 0 then succeeds', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls === 1) throw httpError(403, { 'x-ratelimit-remaining': '0' });
    return 'ok';
  }, { attempts: 2, baseDelayMs: 5 });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('withRetry: retries network errors (no response) then succeeds', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls === 1) throw new Error('ECONNRESET'); // no `response` property
    return 'ok';
  }, { attempts: 2, baseDelayMs: 5 });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

// ─── non-transient errors are NOT retried ───────────────────────────────────

test('withRetry: does not retry 400/401/404 — rejects immediately, fn called once', async () => {
  for (const status of [400, 401, 404]) {
    let calls = 0;
    const err = httpError(status);
    await assert.rejects(
      withRetry(async () => { calls++; throw err; }, { attempts: 3, baseDelayMs: 5 }),
      (e) => e === err
    );
    assert.equal(calls, 1, `status ${status} must not be retried`);
  }
});

test('withRetry: does not retry 403 without X-RateLimit-Remaining: 0', async () => {
  // missing header, non-zero header, and entirely missing headers
  for (const headers of [{}, { 'x-ratelimit-remaining': '5' }, undefined]) {
    let calls = 0;
    const err = httpError(403, headers);
    await assert.rejects(
      withRetry(async () => { calls++; throw err; }, { attempts: 3, baseDelayMs: 5 }),
      (e) => e === err
    );
    assert.equal(calls, 1, `403 with headers ${JSON.stringify(headers)} must not be retried`);
  }
});

// ─── exhausting attempts ────────────────────────────────────────────────────

test('withRetry: all attempts fail → rejects with the last error', async () => {
  let calls = 0;
  const err = httpError(503);
  await assert.rejects(
    withRetry(async () => { calls++; throw err; }, { attempts: 3, baseDelayMs: 5 }),
    (e) => e === err
  );
  assert.equal(calls, 3);
});

test('withRetry: attempts: 1 never retries', async () => {
  let calls = 0;
  const err = httpError(500);
  await assert.rejects(
    withRetry(async () => { calls++; throw err; }, { attempts: 1, baseDelayMs: 5 }),
    (e) => e === err
  );
  assert.equal(calls, 1);
});

test('withRetry: label is accepted and does not affect the result', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls === 1) throw httpError(429);
    return 'ok';
  }, { attempts: 2, baseDelayMs: 5, label: 'github-api' });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

// ─── retryDelayMs behavior (captured via stubbed timers) ───────────────────

test('retryDelayMs: Retry-After header honored (integer seconds)', async () => {
  const timers = stubTimers();
  try {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls === 1) throw httpError(429, { 'retry-after': '30' });
      return 'ok';
    }, { attempts: 2, baseDelayMs: 5 });
    assert.equal(result, 'ok');
    assert.equal(calls, 2);
    assert.deepEqual(timers.captured, [30000]);
  } finally {
    timers.restore();
  }
});

test('retryDelayMs: Retry-After capped at 60s', async () => {
  const timers = stubTimers();
  try {
    let calls = 0;
    await withRetry(async () => {
      calls++;
      if (calls === 1) throw httpError(429, { 'retry-after': '120' });
      return 'ok';
    }, { attempts: 2, baseDelayMs: 5 });
    assert.equal(calls, 2);
    assert.deepEqual(timers.captured, [60000]);
  } finally {
    timers.restore();
  }
});

test('retryDelayMs: Retry-After of 0 → no wait', async () => {
  const timers = stubTimers();
  try {
    let calls = 0;
    await withRetry(async () => {
      calls++;
      if (calls === 1) throw httpError(429, { 'retry-after': '0' });
      return 'ok';
    }, { attempts: 2, baseDelayMs: 5 });
    assert.equal(calls, 2);
    assert.deepEqual(timers.captured, [0]);
  } finally {
    timers.restore();
  }
});

test('retryDelayMs: non-numeric Retry-After (HTTP-date) falls back to jitter', async () => {
  const timers = stubTimers();
  try {
    let calls = 0;
    await withRetry(async () => {
      calls++;
      if (calls === 1) throw httpError(429, { 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' });
      return 'ok';
    }, { attempts: 2, baseDelayMs: 5 });
    assert.equal(calls, 2);
    assert.equal(timers.captured.length, 1);
    assert.ok(timers.captured[0] >= 0 && timers.captured[0] < 5,
      `fallback delay ${timers.captured[0]} must be in [0, baseDelayMs)`);
  } finally {
    timers.restore();
  }
});

test('retryDelayMs: exponential backoff with full jitter (0 <= d < baseDelayMs * 2^attempt)', async () => {
  const timers = stubTimers();
  try {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls++; throw httpError(500); }, { attempts: 3, baseDelayMs: 5 }),
      (e) => e.response.status === 500
    );
    assert.equal(calls, 3);
    assert.equal(timers.captured.length, 2);
    const [d0, d1] = timers.captured;
    assert.ok(d0 >= 0 && d0 < 5, `attempt 0 delay ${d0} must be in [0, 5)`);
    assert.ok(d1 >= 0 && d1 < 10, `attempt 1 delay ${d1} must be in [0, 10)`);
  } finally {
    timers.restore();
  }
});
