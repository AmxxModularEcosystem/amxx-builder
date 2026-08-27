'use strict';

/**
 * Unit tests for the GitHub API core helpers (src/github-api.js).
 *
 * Pure helpers (isValidRepo / validateRepoStructureOptions / filterTreeEntries)
 * are tested directly; the HTTP functions are tested against a stubbed
 * axios.get, so no network is involved.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const {
  getRepoInfo, listBranches, getRepoStructure,
  GithubError, isValidRepo, validateRepoStructureOptions, filterTreeEntries,
} = require('../src/github-api');

// ─── axios stub ───────────────────────────────────────────────────────────────

const realGet = axios.get;

function axiosError(status, message) {
  const err = new Error(message || `Request failed with status code ${status}`);
  err.response = { status, data: { message: message || `HTTP ${status}` } };
  return err;
}

// Routes: array of [matcher(url) -> boolean, response | fn(url)]. Handlers may
// throw axiosError(...) to simulate GitHub API errors.
let routes = null;
axios.get = async (url) => {
  if (!routes) throw new Error('github-api.test: no routes registered');
  for (const [match, handler] of routes) {
    if (match(url)) {
      const data = typeof handler === 'function' ? await handler(url) : handler;
      return { data };
    }
  }
  throw new Error(`github-api.test: unexpected URL ${url}`);
};

after(() => { axios.get = realGet; });

function withRoutes(r, fn) {
  routes = r;
  return fn().finally(() => { routes = null; });
}

const isRepo = (repo) => (u) => u.endsWith(`/repos/${repo}`);
const isTree = () => (u) => u.includes('/git/trees/');
const isBranches = (repo) => (u) => u.includes(`/repos/${repo}/branches`);

// ─── Pure helpers ─────────────────────────────────────────────────────────────

test('isValidRepo accepts "owner/repo" and rejects junk', () => {
  assert.equal(isValidRepo('AmxxModularEcosystem/amxx-builder'), true);
  assert.equal(isValidRepo('a/b'), true);
  assert.equal(isValidRepo('a'), false);
  assert.equal(isValidRepo('a/b/c'), false);
  assert.equal(isValidRepo('a /b'), false);
  assert.equal(isValidRepo(''), false);
  assert.equal(isValidRepo(null), false);
  assert.equal(isValidRepo(42), false);
});

test('validateRepoStructureOptions rejects bad depth/maxEntries/ext/dirsOnly', () => {
  assert.equal(validateRepoStructureOptions({}), null);
  assert.equal(validateRepoStructureOptions({ depth: 2, maxEntries: 500, ext: ['sma'], dirsOnly: false }), null);
  assert.match(validateRepoStructureOptions({ depth: 0 }), /depth/);
  assert.match(validateRepoStructureOptions({ depth: 1.5 }), /depth/);
  assert.match(validateRepoStructureOptions({ maxEntries: 0 }), /maxEntries/);
  assert.match(validateRepoStructureOptions({ maxEntries: 2001 }), /maxEntries/);
  assert.match(validateRepoStructureOptions({ ext: 'sma' }), /ext/);
  assert.match(validateRepoStructureOptions({ ext: ['sma', 1] }), /ext/);
  assert.match(validateRepoStructureOptions({ dirsOnly: 'yes' }), /dirsOnly/);
});

test('filterTreeEntries maps blob/tree and skips submodules', () => {
  const tree = [
    { path: 'amxmodx', type: 'tree' },
    { path: 'amxmodx/scripting', type: 'tree' },
    { path: 'amxmodx/scripting/plugin.sma', type: 'blob' },
    { path: 'amxmodx/scripting/other.inc', type: 'blob' },
    { path: 'submodule', type: 'commit', mode: '160000' },
  ];
  const { entries, truncated } = filterTreeEntries(tree, {});
  assert.equal(truncated, false);
  assert.deepEqual(entries, [
    { path: 'amxmodx', type: 'dir' },
    { path: 'amxmodx/scripting', type: 'dir' },
    { path: 'amxmodx/scripting/plugin.sma', type: 'file' },
    { path: 'amxmodx/scripting/other.inc', type: 'file' },
  ]);
});

test('filterTreeEntries applies depth, dirsOnly, ext and maxEntries', () => {
  const tree = [
    { path: 'a', type: 'tree' },
    { path: 'a/b', type: 'tree' },
    { path: 'a/b/c', type: 'tree' },
    { path: 'a/b/c/d.sma', type: 'blob' },
    { path: 'a/b/c/d.txt', type: 'blob' },
  ];

  assert.deepEqual(filterTreeEntries(tree, { depth: 2 }).entries.map((e) => e.path), ['a', 'a/b']);
  assert.deepEqual(filterTreeEntries(tree, { dirsOnly: true, depth: 3 }).entries.map((e) => e.path), ['a', 'a/b', 'a/b/c']);
  assert.deepEqual(filterTreeEntries(tree, { ext: ['sma'] }).entries.map((e) => e.path), ['a/b/c/d.sma']);
  // Case-insensitive and dot-tolerant extensions.
  assert.deepEqual(filterTreeEntries(tree, { ext: ['.SMA'] }).entries.map((e) => e.path), ['a/b/c/d.sma']);

  const capped = filterTreeEntries(tree, { maxEntries: 2 });
  assert.equal(capped.entries.length, 2);
  assert.equal(capped.truncated, true);
});

test('filterTreeEntries is not truncated when the tree fits exactly', () => {
  const tree = [{ path: 'a', type: 'tree' }, { path: 'b', type: 'tree' }];
  const { entries, truncated } = filterTreeEntries(tree, { maxEntries: 2 });
  assert.equal(entries.length, 2);
  assert.equal(truncated, false);
});

// ─── getRepoInfo ─────────────────────────────────────────────────────────────

test('getRepoInfo maps metadata fields on success', async () => {
  await withRoutes([[
    isRepo('owner/repo'),
    {
      private: true, archived: false, disabled: false,
      default_branch: 'main', description: 'desc', pushed_at: '2026-08-24T23:47:41Z',
    },
  ]], async () => {
    const info = await getRepoInfo('owner/repo', {});
    assert.deepEqual(info, {
      repo: 'owner/repo', exists: true, private: true, archived: false, disabled: false,
      defaultBranch: 'main', description: 'desc', pushedAt: '2026-08-24T23:47:41Z',
    });
  });
});

test('getRepoInfo: 404 becomes exists:false (not an error)', async () => {
  await withRoutes([[isRepo('nope/nope'), () => { throw axiosError(404); }]], async () => {
    const info = await getRepoInfo('nope/nope', {});
    assert.deepEqual(info, { repo: 'nope/nope', exists: false, reason: 'not_found_or_no_access' });
  });
});

test('getRepoInfo: non-404 errors throw GithubError with status', async () => {
  await withRoutes([[isRepo('o/r'), () => { throw axiosError(403, 'rate limit'); }]], async () => {
    await assert.rejects(
      () => getRepoInfo('o/r', {}),
      (err) => err instanceof GithubError && err.status === 403 && /rate limit/.test(err.message)
    );
  });
});

test('getRepoInfo: network errors throw GithubError with status null', async () => {
  await withRoutes([[(u) => true, () => { throw new Error('timeout'); }]], async () => {
    await assert.rejects(
      () => getRepoInfo('o/r', {}),
      (err) => err instanceof GithubError && err.status === null
    );
  });
});

// ─── listBranches ─────────────────────────────────────────────────────────────

test('listBranches maps name/commitSha and honors limit/page', async () => {
  await withRoutes([[isBranches('o/r'), (url) => {
    assert.match(url, /per_page=5&page=2/);
    return [
      { name: 'main', commit: { sha: 'abc123' } },
      { name: 'dev', commit: { sha: 'def456' } },
    ];
  }]], async () => {
    const res = await listBranches('o/r', { limit: 5, page: 2 });
    assert.deepEqual(res, {
      repo: 'o/r',
      branches: [
        { name: 'main', commitSha: 'abc123' },
        { name: 'dev', commitSha: 'def456' },
      ],
    });
  });
});

test('listBranches: 404 → exists:false, 409 (empty repo) → empty list', async () => {
  await withRoutes([
    [isBranches('empty/r'), () => { throw axiosError(409); }],
    [isBranches('gone/r'), () => { throw axiosError(404); }],
  ], async () => {
    assert.deepEqual(await listBranches('empty/r', {}), { repo: 'empty/r', branches: [] });
    assert.deepEqual(await listBranches('gone/r', {}), { repo: 'gone/r', exists: false, reason: 'not_found_or_no_access' });
  });
});

// ─── getRepoStructure ─────────────────────────────────────────────────────────

test('getRepoStructure without ref resolves the default branch first', async () => {
  await withRoutes([
    [isRepo('o/r'), { default_branch: 'main', private: false, archived: false, disabled: false, description: null, pushed_at: null }],
    [isTree(), { tree: [
      { path: 'amxmodx', type: 'tree' },
      { path: 'amxmodx/scripting', type: 'tree' },
      { path: 'amxmodx/scripting/x.sma', type: 'blob' },
      { path: 'amxmodx/scripting/x.inc', type: 'blob' },
    ], truncated: false }],
  ], async () => {
    const res = await getRepoStructure('o/r', { ext: ['sma'] });
    assert.equal(res.repo, 'o/r');
    assert.equal(res.ref, 'main');
    assert.equal(res.truncated, false);
    assert.deepEqual(res.entries, [
      { path: 'amxmodx/scripting/x.sma', type: 'file' },
    ]);
  });
});

test('getRepoStructure without ref: missing repo → exists:false (no tree call)', async () => {
  let treeCalls = 0;
  await withRoutes([
    [isRepo('gone/r'), () => { throw axiosError(404); }],
    [isTree(), () => { treeCalls++; return { tree: [], truncated: false }; }],
  ], async () => {
    const res = await getRepoStructure('gone/r', {});
    assert.deepEqual(res, { repo: 'gone/r', exists: false, reason: 'not_found_or_no_access' });
    assert.equal(treeCalls, 0);
  });
});

test('getRepoStructure with ref: trees 404 on a live repo → "Ref not found" error (repo re-checked)', async () => {
  await withRoutes([
    [isRepo('o/r'), { default_branch: 'main', private: false, archived: false, disabled: false, description: null, pushed_at: null }],
    [isTree(), (url) => {
      assert.match(url, /\/git\/trees\/typo-branch\?/);
      throw axiosError(404);
    }],
  ], async () => {
    await assert.rejects(
      () => getRepoStructure('o/r', { ref: 'typo-branch' }),
      (err) => err instanceof GithubError && err.status === 404 && /Ref not found: typo-branch/.test(err.message)
    );
  });
});

test('getRepoStructure with ref: trees 404 + repo gone → exists:false', async () => {
  await withRoutes([
    [isTree(), () => { throw axiosError(404); }],
    [isRepo('gone/r'), () => { throw axiosError(404); }],
  ], async () => {
    const res = await getRepoStructure('gone/r', { ref: 'main' });
    assert.deepEqual(res, { repo: 'gone/r', exists: false, reason: 'not_found_or_no_access' });
  });
});

test('getRepoStructure with ref: malformed 40-hex SHA (422) propagates as-is', async () => {
  await withRoutes([[
    isTree(),
    () => { throw axiosError(422, 'No commit found for SHA: not-a-sha'); },
  ]], async () => {
    await assert.rejects(
      () => getRepoStructure('o/r', { ref: 'not-a-sha' }),
      (err) => err instanceof GithubError && err.status === 422
    );
  });
});

test('getRepoStructure without ref: verified repo + trees 404 → "Ref not found" (no re-check)', async () => {
  let repoChecks = 0;
  await withRoutes([
    [isRepo('o/r'), () => { repoChecks++; return { default_branch: 'main', private: false, archived: false, disabled: false, description: null, pushed_at: null }; }],
    [isTree(), () => { throw axiosError(404); }],
  ], async () => {
    await assert.rejects(
      () => getRepoStructure('o/r', {}),
      (err) => err instanceof GithubError && err.status === 404 && /Ref not found: main/.test(err.message)
    );
    assert.equal(repoChecks, 1); // resolved the default branch, no extra re-check
  });
});

test('getRepoStructure: 409 (empty repo) → empty entries', async () => {
  await withRoutes([
    [isTree(), () => { throw axiosError(409); }],
  ], async () => {
    const res = await getRepoStructure('empty/r', { ref: 'main' });
    assert.deepEqual(res, { repo: 'empty/r', ref: 'main', truncated: false, entries: [] });
  });
});

test('getRepoStructure defaults to depth 1 when ext is not given', async () => {
  await withRoutes([
    [isRepo('o/r'), { default_branch: 'main', private: false, archived: false, disabled: false, description: null, pushed_at: null }],
    [isTree(), { tree: [
      { path: 'a', type: 'tree' },
      { path: 'a/b', type: 'tree' },
      { path: 'a/b/c.sma', type: 'blob' },
    ], truncated: false }],
  ], async () => {
    const res = await getRepoStructure('o/r', {});
    assert.deepEqual(res.entries, [{ path: 'a', type: 'dir' }]);
    assert.equal(res.truncated, false);
  });
});

test('getRepoStructure: GitHub-side tree truncation is reported', async () => {
  await withRoutes([
    [isRepo('big/r'), { default_branch: 'main', private: false, archived: false, disabled: false, description: null, pushed_at: null }],
    [isTree(), { tree: [{ path: 'a', type: 'tree' }], truncated: true }],
  ], async () => {
    const res = await getRepoStructure('big/r', {});
    assert.equal(res.truncated, true);
  });
});
