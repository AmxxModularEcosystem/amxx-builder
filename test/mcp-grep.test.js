'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { HANDLERS } = require('../mcp/handlers');

const PLATFORM = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
const BIN      = PLATFORM === 'windows' ? 'amxxpc.exe' : 'amxxpc';

const ORIG_CACHE_ENV = process.env.AMXX_BUILDER_CACHE;

function useTempCache(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.AMXX_BUILDER_CACHE = dir;
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (ORIG_CACHE_ENV === undefined) delete process.env.AMXX_BUILDER_CACHE;
    else process.env.AMXX_BUILDER_CACHE = ORIG_CACHE_ENV;
  });
  return dir;
}

function useTmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

function seedCompiler(cache, version) {
  write(cache, `amxxpc/${version}/${PLATFORM}/${BIN}`, 'binary');
  fs.mkdirSync(path.join(cache, 'amxxpc', version, PLATFORM, 'include'), { recursive: true });
}

function textOf(result) {
  assert.equal(result.isError, undefined);
  return result.content[0].text;
}

test('get_dep_interface: grep lists only files that match', async (t) => {
  useTempCache(t, 'amxb-mcp-grep-dep-cache-');
  const root = useTmpDir(t, 'amxb-mcp-grep-dep-');
  write(root, 'scripting/include/a.inc', 'stock Alpha() {}\n');
  write(root, 'scripting/include/b.inc', 'native NeedleFunc();\n');
  write(root, 'scripting/include/c.inc', 'stock Gamma() {}\n');

  const text = textOf(await HANDLERS.get_dep_interface(
    { dep: { source: 'local', path: root, name: 'tool' }, grep: 'NeedleFunc', no_fetch: true },
    null,
    true
  ));

  assert.match(text, /Found 1 of 3 \.inc file\(s\) in local\/tool \(local\) matching "NeedleFunc":/);
  assert.match(text, /──── b\.inc ────/);
  assert.doesNotMatch(text, /a\.inc/);
  assert.doesNotMatch(text, /c\.inc/);
  assert.doesNotMatch(text, /no matches for/);
});

test('get_dep_interface: grep with no matches reports one line, no file blocks', async (t) => {
  useTempCache(t, 'amxb-mcp-grep-dep-none-cache-');
  const root = useTmpDir(t, 'amxb-mcp-grep-dep-none-');
  write(root, 'scripting/include/a.inc', 'stock Alpha() {}\n');
  write(root, 'scripting/include/b.inc', 'stock Beta() {}\n');

  const text = textOf(await HANDLERS.get_dep_interface(
    { dep: { source: 'local', path: root, name: 'tool' }, grep: 'NeedleFunc', no_fetch: true },
    null,
    true
  ));

  assert.match(text, /No \.inc file in local\/tool \(local\) matches "NeedleFunc" \(searched 2\)\./);
  assert.doesNotMatch(text, /──── /);
  assert.doesNotMatch(text, /a\.inc|b\.inc/);
});

test('get_amxmodx_include: grep lists only matching files and finds matches past the 50-file cap', async (t) => {
  const cache   = useTempCache(t, 'amxb-mcp-grep-std-cache-');
  const version = '1.10.5428';
  seedCompiler(cache, version);
  const includeDir = path.join(cache, 'amxxpc', version, PLATFORM, 'include');

  for (let i = 0; i < 60; i++) {
    const name = `f${String(i).padStart(2, '0')}.inc`;
    write(includeDir, name, i === 55 ? 'native CreateOneForward(...);\n' : `stock F${i}() {}\n`);
  }

  const text = textOf(await HANDLERS.get_amxmodx_include(
    { version, grep: 'CreateOneForward', no_fetch: true },
    null,
    true
  ));

  assert.match(text, /AMX Mod X 1\.10\.5428 — 1 of 60 standard include file\(s\) matching "CreateOneForward":/);
  assert.match(text, /──── f55\.inc ────/);
  assert.match(text, /> {4}1 │ native CreateOneForward/);
  assert.doesNotMatch(text, /f00\.inc/);
  assert.doesNotMatch(text, /no matches for/);
  assert.doesNotMatch(text, /pass full_output=true/);
});

test('get_amxmodx_include: grep with no matches reports one line', async (t) => {
  const cache   = useTempCache(t, 'amxb-mcp-grep-std-none-cache-');
  const version = '1.10.5428';
  seedCompiler(cache, version);
  write(cache, `amxxpc/${version}/${PLATFORM}/include/core.inc`, 'stock Core() {}\n');

  const text = textOf(await HANDLERS.get_amxmodx_include(
    { version, grep: 'CreateOneForward', no_fetch: true },
    null,
    true
  ));

  assert.match(text, /No standard include file matches "CreateOneForward" in AMX Mod X 1\.10\.5428 \(searched 1\)\./);
  assert.doesNotMatch(text, /──── /);
});

test('get_agent_docs: grep lists only docs that match', async (t) => {
  const root = useTmpDir(t, 'amxb-mcp-grep-docs-');
  write(root, 'docs/alpha.md', 'Alpha has nothing relevant.\n');
  write(root, 'docs/beta.md', 'Beta exposes NeedleFunc.\n');
  const manifestPath = write(root, 'amxbuild.yml', [
    'name: GrepServer',
    'version: "1.0.0"',
    'docs:',
    '  - file: docs/alpha.md',
    '    name: alpha',
    '  - file: docs/beta.md',
    '    name: beta',
    '',
  ].join('\n'));

  const text = textOf(await HANDLERS.get_agent_docs({ manifest: manifestPath, grep: 'NeedleFunc' }));

  assert.match(text, /──── beta \(docs\/beta\.md\) ────/);
  assert.doesNotMatch(text, /alpha/);
  assert.doesNotMatch(text, /no matches for/);
});

test('get_agent_docs: grep with no matches reports one line', async (t) => {
  const root = useTmpDir(t, 'amxb-mcp-grep-docs-none-');
  write(root, 'docs/alpha.md', 'Alpha has nothing relevant.\n');
  const manifestPath = write(root, 'amxbuild.yml', [
    'name: GrepServer',
    'version: "1.0.0"',
    'docs:',
    '  - file: docs/alpha.md',
    '    name: alpha',
    '',
  ].join('\n'));

  const text = textOf(await HANDLERS.get_agent_docs({ manifest: manifestPath, grep: 'NeedleFunc' }));

  assert.match(text, /No agent doc matches "NeedleFunc" \(searched 1\)\./);
  assert.doesNotMatch(text, /──── alpha/);
});
