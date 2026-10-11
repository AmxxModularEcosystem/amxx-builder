'use strict';

/**
 * B5 — `compile_sma` delegates the assembly + spawn to core `compileFile`.
 * `resolveStdlibState` (compiler availability) and `compileFile` are stubbed
 * BEFORE `../mcp/handlers` is required: handlers destructures both references at
 * require time, so the stubs must exist first. Offline and deterministic.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const compilerFetcher = require('../src/compiler-fetcher');
compilerFetcher.resolveStdlibState = async () => ({
  version: '1.10.5428',
  degraded: false,
  platform: 'linux',
  compilerPath: '/fake/amxxpc',
  includeDir: '/fake/include',
  cached: true,
});

const compiler = require('../src/compiler');
let captured = null;
compiler.compileFile = async (...callArgs) => {
  captured = callArgs;
  return { status: 0, output: 'compiler says ok' };
};

const { HANDLERS } = require('../mcp/handlers');

function useTmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('compile_sma delegates to core compileFile with the flat temp outPath and tool defines', async (t) => {
  const root = useTmpDir(t, 'amxb-mcp-compile-');
  const smaPath = path.join(root, 'demo.sma');
  fs.writeFileSync(smaPath, 'public plugin_init() {}', 'utf8');
  // Explicit non-existent manifest → no ambient manifest/deps are read.
  const manifestArg = path.join(root, 'absent.yml');

  captured = null;
  const result = await HANDLERS.compile_sma(
    { sma_file: smaPath, manifest: manifestArg, define: ['DEBUG', 'VERSION=2'], keep_output: true },
    null,
    true
  );

  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  assert.match(text, /Compiled OK \(amxxpc 1\.10\.5428\): demo\.sma/);
  assert.match(text, /compiler says ok/);

  assert.ok(captured, 'compileFile was not called');
  const [manifest, sma, compilerPath, includeDirs, outPath] = captured;
  assert.deepEqual(manifest, { amxmodx: { defines: ['DEBUG', 'VERSION=2'] } });
  assert.equal(sma, smaPath);
  assert.equal(compilerPath, '/fake/amxxpc');
  assert.deepEqual(includeDirs, ['/fake/include']);
  assert.equal(path.dirname(outPath), path.join(os.tmpdir(), 'amxb-mcp-compile'));
  assert.match(path.basename(outPath), /^demo_\d+_[a-z0-9]+\.amxx$/);
  assert.ok(text.includes(`Output: ${outPath}`), `expected Output line for ${outPath}`);
});
