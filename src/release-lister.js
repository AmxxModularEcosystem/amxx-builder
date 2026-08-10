'use strict';

const axios = require('axios');
// Default for API calls; download sites pass their own longer timeout.
axios.defaults.timeout = 30000;

/**
 * List releases for a GitHub repository.
 *
 * @param {string} repo — "owner/repo"
 * @param {Object} [options]
 * @param {string}  [options.token]          — GitHub PAT
 * @param {number}  [options.limit=10]       — max releases to return
 * @param {boolean} [options.includeAssets]  — include asset details per release
 * @returns {Promise<Object[]>}
 */
async function listReleases(repo, options = {}) {
  const { token, limit = 10, includeAssets = false } = options;
  const headers = buildHeaders(token);
  const perPage = Math.min(100, Math.max(1, limit)); // GitHub caps per_page at 100

  const { data } = await axios.get(
    `https://api.github.com/repos/${repo}/releases?per_page=${perPage}`,
    { headers }
  );

  return data.map((r) => {
    const entry = {
      tagName: r.tag_name,
      name: r.name || r.tag_name,
      publishedAt: r.published_at,
      prerelease: r.prerelease || false,
    };

    if (includeAssets && r.assets && r.assets.length > 0) {
      entry.assets = r.assets.map((a) => ({
        name: a.name,
        size: a.size,
        downloadCount: a.download_count,
      }));
    }

    return entry;
  });
}

/**
 * List git tags for a GitHub repository.
 * Useful for repos that don't publish GitHub Releases.
 *
 * @param {string} repo — "owner/repo"
 * @param {Object} [options]
 * @param {string} [options.token]     — GitHub PAT
 * @param {number} [options.limit=10]  — max tags to return
 * @returns {Promise<Object[]>}
 */
async function listTags(repo, options = {}) {
  const { token, limit = 10 } = options;
  const headers = buildHeaders(token);
  const perPage = Math.min(100, Math.max(1, limit)); // GitHub caps per_page at 100

  const { data } = await axios.get(
    `https://api.github.com/repos/${repo}/tags?per_page=${perPage}`,
    { headers }
  );

  return data.map((t) => ({
    name: t.name,
    commitSha: t.commit.sha,
  }));
}

function buildHeaders(token) {
  const h = { Accept: 'application/vnd.github+json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

module.exports = { listReleases, listTags };
