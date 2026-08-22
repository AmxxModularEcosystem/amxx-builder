'use strict';

/**
 * Format a byte count as a human-readable string.
 *
 * Tiers:
 *   B  — bytes < 1024                  (exact)
 *   KB — bytes < 1024^2                (default precision 1)
 *   MB — bytes < 1024^3                (default precision 1)
 *   GB — bytes >= 1024^3               (default precision 2)
 *
 * @param {number} bytes
 * @param {{ precision?: number }} [opts] - Override the per-tier default precision.
 * @returns {string}
 */
function formatBytes(bytes, { precision } = {}) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(precision == null ? 1 : precision)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(precision == null ? 1 : precision)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(precision == null ? 2 : precision)} GB`;
}

module.exports = { formatBytes };
