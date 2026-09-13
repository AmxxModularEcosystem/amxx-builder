'use strict';

// Pure/deterministic: the WSL DrvFs/9p guard is exercised with injected
// wsl/mountpoints so results do not depend on the host filesystem.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { spawnCompiler, checkCompilerInputs, parse9pMountpoints } = require('../src/compile-utils');

const MOUNTS = ['/mnt/c', '/mnt/j'];

test('checkCompilerInputs: native source and includes pass', () => {
  const r = checkCompilerInputs(
    ['/home/u/plugin.sma', '-o/tmp/out.amxx', '-i/home/u/include', 'DEBUG=1'],
    { wsl: true, mountpoints: MOUNTS }
  );
  assert.deepEqual(r, { ok: true, inputs: [], error: null });
});

test('checkCompilerInputs: source on a 9p mount is rejected', () => {
  const r = checkCompilerInputs(
    ['/mnt/j/proj/VipModular.sma', '-o/tmp/out.amxx', '-i/tmp/inc'],
    { wsl: true, mountpoints: MOUNTS }
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.inputs, ['/mnt/j/proj/VipModular.sma']);
  assert.match(r.error, /VipModular\.sma/);
  assert.match(r.error, /DrvFs\/9p/);
  assert.match(r.error, /fatal error 100/);
});

test('checkCompilerInputs: include dir on a 9p mount is rejected (attached -i)', () => {
  const r = checkCompilerInputs(
    ['/home/u/plugin.sma', '-o/tmp/out.amxx', '-i/mnt/j/proj/include'],
    { wsl: true, mountpoints: MOUNTS }
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.inputs, ['/mnt/j/proj/include']);
});

test('checkCompilerInputs: include dir on a 9p mount is rejected (separate -i)', () => {
  const r = checkCompilerInputs(
    ['/home/u/plugin.sma', '-o/tmp/out.amxx', '-i', '/mnt/j/proj/include'],
    { wsl: true, mountpoints: MOUNTS }
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.inputs, ['/mnt/j/proj/include']);
});

test('checkCompilerInputs: writing output to a 9p mount is allowed', () => {
  const r = checkCompilerInputs(
    ['/home/u/plugin.sma', '-o/mnt/j/proj/out.amxx', '-i/home/u/include'],
    { wsl: true, mountpoints: MOUNTS }
  );
  assert.equal(r.ok, true);
});

test('checkCompilerInputs: sibling /mnt paths are not mistaken for a mount point', () => {
  const r = checkCompilerInputs(
    ['/mnt/cc/plugin.sma', '-i/mnt/jj/include'],
    { wsl: true, mountpoints: ['/mnt/c', '/mnt/j'] }
  );
  assert.equal(r.ok, true);
});

test('checkCompilerInputs: no WSL → no guard', () => {
  const r = checkCompilerInputs(['/mnt/j/a.sma'], { wsl: false, mountpoints: MOUNTS });
  assert.equal(r.ok, true);
});

test('checkCompilerInputs: no 9p mounts → no guard', () => {
  const r = checkCompilerInputs(['/mnt/j/a.sma'], { wsl: true, mountpoints: [] });
  assert.equal(r.ok, true);
});

test('parse9pMountpoints: keeps only 9p entries and decodes octal escapes', () => {
  const text = [
    'none /proc proc rw 0 0',
    'C:\\134 /mnt/c 9p rw,aname=drvfs 0 0',
    'tmpfs /mnt/wsl tmpfs rw 0 0',
    'C:\\134Program\\040Files /Docker/host 9p rw 0 0',
  ].join('\n');
  assert.deepEqual(parse9pMountpoints(text), ['/mnt/c', '/Docker/host']);
});

test('spawnCompiler: 9p input short-circuits instead of spawning amxxpc', async () => {
  const r = await spawnCompiler(
    '/definitely/missing/amxxpc',
    ['/mnt/j/proj/a.sma', '-o/tmp/a.amxx', '-i/tmp/inc'],
    { wsl: true, mountpoints: ['/mnt/j'] }
  );
  assert.equal(r.status, 1);
  assert.match(r.output, /DrvFs\/9p/);
  assert.doesNotMatch(r.output, /ENOENT/);
});
