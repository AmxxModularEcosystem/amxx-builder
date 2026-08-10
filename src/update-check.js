'use strict';

/**
 * Checks npm-style (GitHub) version once per 24h and returns newer version if found.
 * Fires a single GET to GitHub API — respects rate limits by caching check timestamps.
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');
const { getCacheDir } = require('./cache-dir');

const PKG = require('../package.json');
const CHECK_FILE = 'update-check.json';
const CHECK_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const GITHUB_API = 'https://api.github.com/repos/AmxxModularEcosystem/amxx-builder/releases/latest';

/**
 * Simple semver compare (major.minor.patch).
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
function cmpVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

function readCheckCache() {
  const cacheDir = getCacheDir();
  const file = path.join(cacheDir, CHECK_FILE);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeCheckCache(data) {
  const cacheDir = getCacheDir();
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, CHECK_FILE);
  fs.writeFileSync(file, JSON.stringify(data));
}

/**
 * Fetch latest release tag from GitHub API.
 * Returns tag string (e.g. "v1.4.0") or null on failure.
 */
function fetchLatestTag() {
  return new Promise((resolve) => {
    const req = https.get(GITHUB_API, {
      headers: {
        'User-Agent': 'amxx-builder',
        Accept: 'application/vnd.github.v3+json',
      },
      timeout: 5000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          const data = JSON.parse(body);
          if (data.tag_name) return resolve(data.tag_name);
        } catch { /* ignore parse errors */ }
        resolve(null);
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * Check for a newer version. Returns the newer version string or null.
 * Respects 24h cache — does not call GitHub API if checked recently.
 */
async function checkForUpdate() {
  // Respect opt-out env
  if (process.env.AMXB_NO_UPDATE_CHECK) return null;

  const cached = readCheckCache();
  const now = Date.now();

  if (cached && (now - cached.ts) < CHECK_TTL_MS) {
    // Still within cooldown
    return null;
  }

  // Mark checked even if API call fails — prevents retry on every command
  writeCheckCache({ ts: now });

  const latestTag = await fetchLatestTag();
  if (!latestTag) return null;

  const latestVer = latestTag.replace(/^v/i, '');
  const currentVer = PKG.version;

  if (cmpVersions(latestVer, currentVer) > 0) {
    return latestVer;
  }

  return null;
}

module.exports = { checkForUpdate };
