'use strict';

const axios = require('axios');

/** Global default timeout for GitHub REST / API calls; download sites override per-call. */
const DEFAULT_API_TIMEOUT_MS = 30000;
axios.defaults.timeout = DEFAULT_API_TIMEOUT_MS;

/** GitHub REST headers: JSON `Accept` + optional Bearer token. Fresh object each call. */
function githubHeaders(token) {
  const h = { Accept: 'application/vnd.github+json' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

module.exports = { axios, DEFAULT_API_TIMEOUT_MS, githubHeaders };
