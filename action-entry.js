'use strict';

const core = require('@actions/core');

const manifest    = core.getInput('manifest')   || './manifest.yml';
const buildDir    = core.getInput('build-dir')  || './build';
const noFetch     = core.getInput('no-fetch')   === 'true';
const noArchive   = core.getInput('no-archive') === 'true';
const githubToken = core.getInput('github-token');

if (githubToken) process.env.GITHUB_TOKEN = githubToken;

// Synthesise argv so Commander in index.js parses our inputs
process.argv = [
  process.execPath,
  'amxx-builder',
  'build',
  '--manifest', manifest,
  '--build-dir', buildDir,
  ...(noFetch   ? ['--no-fetch']   : []),
  ...(noArchive ? ['--no-archive'] : []),
];

require('./index.js');
