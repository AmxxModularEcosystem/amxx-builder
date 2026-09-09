'use strict';

const fs = require('fs');
const path = require('path');
const { Transform, pipeline } = require('stream');

const axios = require('axios');
const { createBar } = require('./progress');
const { withRetry } = require('./retry');

// Streaming downloads bound memory (bytes accepted) and wall-clock time.
// Defaults are generous — real archives are a few MB — the point is bounds.
const DEFAULT_MAX_BYTES   = 2 * 1024 * 1024 * 1024; // 2 GiB
const DEFAULT_DEADLINE_MS = 30 * 60 * 1000;         // 30 min per attempt
const DEFAULT_TIMEOUT_MS  = 600000;                 // socket idle — unchanged

/**
 * Streams a GET download to `dest` instead of buffering the body in memory.
 *
 * - Writes to <dest>.part and renames into place, so an interrupted download
 *   never leaves a half-written file at `dest`.
 * - Enforces a byte cap (`maxBytes`) on the total body size.
 * - Enforces a total wall-clock deadline per attempt via AbortController.
 *   axios's `timeout` only trips on socket *inactivity*, so a server that
 *   trickles bytes forever would otherwise stream forever.
 * - Retries transient failures with withRetry; each attempt gets a fresh
 *   controller because an aborted signal cannot be reused.
 * - Emits progress via the same bar.update(pct) contract as before.
 *
 * @param {string} url
 * @param {string} dest
 * @param {object} [options]
 * @param {object} [options.headers]     extra request headers
 * @param {string} [options.label]       retry/error label (defaults to filename)
 * @param {number} [options.maxBytes]    byte cap (default 2 GiB)
 * @param {number} [options.deadlineMs]  per-attempt wall-clock deadline
 * @param {number} [options.timeoutMs]   axios socket-idle timeout
 * @param {number} [options.attempts]    withRetry attempts (default 3)
 * @param {string} [options.progressLabel] progress bar label (null = no bar)
 * @returns {Promise<{ headers: object }>} response headers of the final request
 */
async function downloadToFile(url, dest, options = {}) {
  const {
    headers,
    label = path.basename(url) || url,
    maxBytes = DEFAULT_MAX_BYTES,
    deadlineMs = DEFAULT_DEADLINE_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    attempts = 3,
    progressLabel = null,
  } = options;

  const part = dest + '.part';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const bar = progressLabel ? createBar(100, progressLabel) : null;

  try {
    const resHeaders = await withRetry(async () => {
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), deadlineMs);
      try {
        const response = await axios.get(url, {
          headers,
          responseType: 'stream',
          maxRedirects: 5,
          timeout: timeoutMs,
          signal: controller.signal,
        });
        const total = parseInt(response.headers['content-length'], 10) || 0;
        if (total > maxBytes) throw capError(maxBytes, total);
        await streamToFile(response.data, part, { maxBytes, total, bar });
        fs.renameSync(part, dest);
        return response.headers;
      } catch (err) {
        if (controller.signal.aborted) throw timeoutError(label, deadlineMs);
        throw err;
      } finally {
        clearTimeout(deadline);
      }
    }, { label, attempts });

    if (bar) bar.stop();
    return { headers: resHeaders };
  } catch (err) {
    try { fs.rmSync(part, { force: true }); } catch (_) {}
    throw err;
  }
}

function streamToFile(source, destPath, { maxBytes, total, bar }) {
  return new Promise((resolve, reject) => {
    pipeline(
      source,
      byteCounter(maxBytes, total, bar),
      fs.createWriteStream(destPath),
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function byteCounter(maxBytes, total, bar) {
  let received = 0;
  return new Transform({
    transform(chunk, enc, cb) {
      received += chunk.length;
      if (received > maxBytes) {
        cb(capError(maxBytes, received));
        return;
      }
      if (bar && total > 0) {
        bar.update(Math.min(100, Math.round((received / total) * 100)));
      }
      cb(null, chunk);
    },
  });
}

function capError(maxBytes, received) {
  const err = new Error(`Download exceeds the ${maxBytes} byte limit (received ${received} bytes)`);
  err.code = 'MAX_BYTES_EXCEEDED';
  err.retryable = false;
  return err;
}

function timeoutError(label, deadlineMs) {
  const err = new Error(`Download of "${label}" timed out after ${deadlineMs} ms`);
  err.code = 'DOWNLOAD_TIMEOUT';
  err.retryable = false;
  return err;
}

module.exports = { downloadToFile, DEFAULT_MAX_BYTES, DEFAULT_DEADLINE_MS, DEFAULT_TIMEOUT_MS };
