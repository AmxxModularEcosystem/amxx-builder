'use strict';

const core = require('@actions/core');
const fs   = require('fs');
const yaml = require('js-yaml');

const manifest     = core.getInput('manifest')     || './amxbuild.yml';
const buildDir     = core.getInput('build-dir')    || './build';

// Expose manifest name as output before the build runs
try {
  const raw = yaml.load(fs.readFileSync(manifest, 'utf8'));
  if (raw && raw.name) core.setOutput('name', raw.name);
} catch (_) {}
const version      = core.getInput('version');
const archiveName  = core.getInput('archive-name');
const setRaw       = core.getInput('set');
const noFetch      = core.getInput('no-fetch')     === 'true';
const noArchive    = core.getInput('no-archive')   === 'true';
const githubToken  = core.getInput('github-token');

if (githubToken) process.env.GITHUB_TOKEN = githubToken;

// Collect all --set pairs: shorthands first, then raw multiline block
const setPairs = [];
if (version)     setPairs.push(`version=${version}`);
if (archiveName) setPairs.push(`output.archive_name=${archiveName}`);
if (setRaw)      setPairs.push(...setRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean));

// Synthesise argv so Commander in index.js parses our inputs
process.argv = [
  process.execPath,
  'amxx-builder',
  'build',
  '--manifest', manifest,
  '--build-dir', buildDir,
  ...setPairs.flatMap(p => ['--set', p]),
  ...(noFetch   ? ['--no-fetch']   : []),
  ...(noArchive ? ['--no-archive'] : []),
];

require('./index.js');
