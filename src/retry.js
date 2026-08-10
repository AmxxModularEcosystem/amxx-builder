'use strict';

const logger = require('./logger');

/**
 * Retries an async function up to `attempts` times with exponential backoff.
 * Retries on network/timeout errors, 5xx, 408/429 and GitHub rate-limit 403s;
 * other 4xx responses are NOT retried.
 */
async function withRetry(fn, { attempts = 3, baseDelayMs = 1000, label = '' } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err)) throw err;

      if (i < attempts - 1) {
        const delay = retryDelayMs(err, baseDelayMs, i);
        const tag   = label ? ` (${label})` : '';
        logger.warn(`Retrying${tag} in ${Math.round(delay / 1000)}s... (attempt ${i + 2}/${attempts})`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// 408/429 and GitHub rate-limit 403s (X-RateLimit-Remaining: 0) are transient;
// any other 4xx is a permanent failure.
function isTransient(err) {
  const status = err.response?.status;
  if (!status || status >= 500) return true;
  if (status === 408 || status === 429) return true;
  if (status === 403 && String(err.response?.headers?.['x-ratelimit-remaining']) === '0') return true;
  return false;
}

function retryDelayMs(err, baseDelayMs, attempt) {
  const retryAfter = err.response?.headers?.['retry-after'];
  const secs = retryAfter !== undefined ? parseInt(retryAfter, 10) : NaN;
  if (Number.isFinite(secs) && secs >= 0) {
    return Math.min(secs, 60) * 1000; // HTTP-date Retry-After falls back below
  }
  const exp = baseDelayMs * 2 ** attempt;
  return Math.random() * exp; // full jitter — parallel calls don't retry in lockstep
}

module.exports = { withRetry };
