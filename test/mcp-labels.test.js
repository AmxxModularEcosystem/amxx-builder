'use strict';

/**
 * Phase A — A2 (MCP dep labels use core `depLabel`) and A5 (`list_releases`
 * honours the manifest `github.tokens` policy).
 *
 * Offline + deterministic. `releaseLister.listReleases` is stubbed BEFORE
 * `../mcp/handlers` is required: handlers destructures the reference at require
 * time, so the stub must exist first. Local sources only — no network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// Patch before requiring handlers (destructuring captures the reference).
const releaseLister = require('../src/release-lister');
let capturedReleaseToken;
releaseLister.listReleases = async (_repo, opts) => {
  capturedReleaseToken = opts && opts.token;
  return [];
};

const { HANDLERS } = require('../mcp/handlers');

function useTmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Sandbox the fetch cache so stdlib resolution never reads an ambient compiler.
function useTempCache(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const prev = process.env.AMXX_BUILDER_CACHE;
  process.env.AMXX_BUILDER_CACHE = dir;
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.AMXX_BUILDER_CACHE;
    else process.env.AMXX_BUILDER_CACHE = prev;
  });
  return dir;
}

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

test('get_dep_interface: ad-hoc local dep renders "<repo> (local)", not "@local"/"@null"', async (t) => {
  useTempCache(t, 'amxb-mcp-labels-a-cache-');
  const root = useTmpDir(t, 'amxb-mcp-labels-a-');
  write(root, 'scripting/include/api.inc', 'api');

  const result = await HANDLERS.get_dep_interface(
    { dep: { source: 'local', path: root, name: 'tool' }, no_fetch: true },
    null,
    true
  );

  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  assert.match(text, /local\/tool \(local\)/);
  assert.doesNotMatch(text, /local\/tool@local/);
  assert.doesNotMatch(text, /local\/tool@null/);
});

test('resolve_include: manifest local dep renders "<name> (local)", not "@null"', async (t) => {
  useTempCache(t, 'amxb-mcp-labels-b-cache-');
  const root = useTmpDir(t, 'amxb-mcp-labels-b-');
  write(root, 'vendor/tool/scripting/include/real.inc', 'x');
  const manifestPath = write(root, 'amxbuild.yml', [
    'name: LabelsServer',
    'version: "1.0.0"',
    'deps:',
    '  - source: local',
    '    path: ./vendor/tool',
    '    name: tool',
    '    include_path: scripting/include',
    '',
  ].join('\n'));

  const result = await HANDLERS.resolve_include(
    { manifest: manifestPath, directive: '#include <missing.inc>', no_fetch: true },
    null,
    true
  );

  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  assert.match(text, /local\/tool \(local\)/);
  assert.doesNotMatch(text, /local\/tool@null/);
  assert.doesNotMatch(text, /local\/tool@local/);
});

test('list_releases: manifest github.tokens policy wins over GITHUB_TOKEN', async (t) => {
  const root = useTmpDir(t, 'amxb-mcp-labels-c-');
  write(root, 'amxbuild.yml', [
    'name: LabelsServer',
    'version: "1.0.0"',
    'github:',
    '  tokens:',
    '    acme: AMXB_TEST_TOKENS_ACME',
    '',
  ].join('\n'));

  const prevCwd      = process.cwd();
  const prevSentinel = process.env.AMXB_TEST_TOKENS_ACME;
  const prevFallback = process.env.GITHUB_TOKEN;
  process.chdir(root);
  process.env.AMXB_TEST_TOKENS_ACME = 'sentinel-acme-token';
  process.env.GITHUB_TOKEN = 'fallback-github-token';
  t.after(() => {
    process.chdir(prevCwd);
    if (prevSentinel === undefined) delete process.env.AMXB_TEST_TOKENS_ACME;
    else process.env.AMXB_TEST_TOKENS_ACME = prevSentinel;
    if (prevFallback === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prevFallback;
  });

  capturedReleaseToken = undefined;
  const result = await HANDLERS.list_releases({ repo: 'acme/r' });

  assert.equal(result.isError, undefined);
  assert.equal(capturedReleaseToken, 'sentinel-acme-token');
});
