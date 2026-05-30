'use strict';

const logger = require('./logger');

/**
 * Retries an async function up to `attempts` times with exponential backoff.
 * Only retries on network/timeout errors, not on 4xx responses.
 */
async function withRetry(fn, { attempts = 3, baseDelayMs = 1000, label = '' } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      if (status && status >= 400 && status < 500) throw err;

      if (i < attempts - 1) {
        const delay = baseDelayMs * 2 ** i;
        const tag   = label ? ` (${label})` : '';
        logger.warn(`Retrying${tag} in ${delay / 1000}s... (attempt ${i + 2}/${attempts})`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

module.exports = { withRetry };
