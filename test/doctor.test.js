'use strict';

/**
 * Regression tests for src/commands/doctor.js (Phase A, workstream A4):
 *
 *  - The Node.js floor is 18, matching package.json engines (was 16).
 *  - Manifest discovery goes through the CLI helper src/commands/shared.js,
 *    so manifest.yml is detected and its deprecation warning is emitted (the
 *    previous hand-rolled discovery only knew amxbuild.yml / amxbuild.yaml).
 *
 * Offline + deterministic:
 *  - child_process.execSync is replaced BEFORE doctor.js is required (doctor
 *    destructures it at module load, so the stub must exist by then).
 *  - axios.get is replaced on the shared module object (required at call time).
 *  - doctor runs with process.cwd() pointed at a fresh temp dir per test.
 *  - AMXX_BUILDER_CACHE points at a temp dir so getCacheDir/dirSize are local.
 *  - logger output is captured; process.exitCode is restored after each run so
 *    the runner's own exit status is never polluted.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const childProcess = require('child_process');
const axios = require('axios');

const logger = require('../src/logger');

// ─── stubs (must be in place before doctor.js is required) ──────────────────

const execCalls = [];
childProcess.execSync = (cmd) => {
  execCalls.push(cmd);
  if (cmd === 'git --version') return 'git version 2.43.0\n';
  if (cmd === 'npm --version') return '10.0.0\n';
  throw new Error(`unexpected execSync in test: ${cmd}`);
};

let axiosCalls = 0;
axios.get = async () => {
  axiosCalls++;
  return { status: 200 };
};

// doctor.js destructures execSync at module load — require it after the stub.
const { runDoctor } = require('../src/commands/doctor');

const ORIG_CACHE_ENV = process.env.AMXX_BUILDER_CACHE;

// ─── helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Fresh project dir (with `files` written flat inside) + fresh cache dir per
// test; both are removed and the original cache env value restored afterwards.
function makeEnv(t, prefix, files = {}) {
  const dir = makeTmpDir(prefix);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  const cache = makeTmpDir('amxb-doctor-cache-');
  process.env.AMXX_BUILDER_CACHE = cache;
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cache, { recursive: true, force: true });
    if (ORIG_CACHE_ENV === undefined) delete process.env.AMXX_BUILDER_CACHE;
    else process.env.AMXX_BUILDER_CACHE = ORIG_CACHE_ENV;
  });
  return dir;
}

// Runs doctor with cwd=dir, capturing logger output and the exit code it sets.
async function runDoctorIn(dir, options = {}) {
  const origCwd = process.cwd();
  const origExitCode = process.exitCode;
  const origLog = { info: logger.info, success: logger.success, warn: logger.warn };
  const logs = { info: [], success: [], warn: [] };

  logger.info = (m) => logs.info.push(m);
  logger.success = (m) => logs.success.push(m);
  logger.warn = (m) => logs.warn.push(m);
  process.exitCode = 0;

  process.chdir(dir);
  try {
    await runDoctor(options);
    return { logs, exitCode: process.exitCode };
  } finally {
    process.chdir(origCwd);
    logger.info = origLog.info;
    logger.success = origLog.success;
    logger.warn = origLog.warn;
    process.exitCode = origExitCode;
  }
}

function allLogs(logs) {
  return [...logs.info, ...logs.success, ...logs.warn];
}

// ─── manifest discovery via ./shared ────────────────────────────────────────

test('doctor: only manifest.yml present → found via ./shared + deprecation warning', async (t) => {
  const dir = makeEnv(t, 'amxb-doctor-myml-', { 'manifest.yml': 'name: DoctorTest\n' });

  const { logs, exitCode } = await runDoctorIn(dir);

  assert.ok(
    logs.success.some((m) => m.includes('Manifest: valid (manifest.yml)')),
    `expected manifest.yml to be reported valid; success=${JSON.stringify(logs.success)}`
  );
  assert.ok(
    logs.warn.some((m) => m.includes('manifest.yml is deprecated — rename it to amxbuild.yml')),
    `expected the ./shared deprecation warning; warn=${JSON.stringify(logs.warn)}`
  );
  // The deprecation warning is rendered by ./shared via logger — it is not part
  // of doctor's own `warn` list, so the exit code stays 0 (contract unchanged).
  assert.equal(exitCode, 0);
});

test('doctor: only amxbuild.yaml present → found, no deprecation warning', async (t) => {
  const dir = makeEnv(t, 'amxb-doctor-yaml-', { 'amxbuild.yaml': 'name: DoctorTest\n' });

  const { logs, exitCode } = await runDoctorIn(dir);

  assert.ok(
    logs.success.some((m) => m.includes('Manifest: valid (amxbuild.yaml)')),
    `expected amxbuild.yaml to be reported valid; success=${JSON.stringify(logs.success)}`
  );
  assert.ok(
    !logs.warn.some((m) => m.includes('deprecated')),
    `did not expect a deprecation warning; warn=${JSON.stringify(logs.warn)}`
  );
  assert.equal(exitCode, 0);
});

test('doctor: nothing present → "Manifest: not found"', async (t) => {
  const dir = makeEnv(t, 'amxb-doctor-none-');

  const { logs, exitCode } = await runDoctorIn(dir);

  assert.ok(
    logs.success.some((m) => m.includes('Manifest: not found (run amxb init)')),
    `expected "Manifest: not found"; success=${JSON.stringify(logs.success)}`
  );
  assert.equal(exitCode, 0);
});

// ─── Node floor ─────────────────────────────────────────────────────────────

test('doctor: Node 16 → warning says "minimum 18 required"', async (t) => {
  const dir = makeEnv(t, 'amxb-doctor-node16-');
  const origVersion = Object.getOwnPropertyDescriptor(process, 'version');
  Object.defineProperty(process, 'version', { value: 'v16.20.0', configurable: true, writable: false });
  t.after(() => Object.defineProperty(process, 'version', origVersion));

  const { logs, exitCode } = await runDoctorIn(dir);

  assert.ok(
    logs.warn.some((m) => m.includes('Node.js: 16.20.0 (minimum 18 required)')),
    `expected the Node 18 floor warning; warn=${JSON.stringify(logs.warn)}`
  );
  assert.ok(!allLogs(logs).some((m) => m.includes('minimum 16')), 'must not mention minimum 16');
  // Exit-code contract (unchanged): doctor's own warning present → exit code 1.
  assert.equal(exitCode, 1);
});

test('doctor: current Node (>=18) → Node line has no "(minimum ...)"', async (t) => {
  const dir = makeEnv(t, 'amxb-doctor-nodecur-');
  const nodeMajor = parseInt(process.version.slice(1).split('.')[0], 10);

  const { logs } = await runDoctorIn(dir);

  assert.ok(
    logs.success.some((m) => m.includes(`Node.js: ${process.version.slice(1)}`)),
    `expected the Node version line; success=${JSON.stringify(logs.success)}`
  );
  if (nodeMajor >= 18) {
    assert.ok(!allLogs(logs).some((m) => m.includes('(minimum')), 'no floor warning on a supported Node');
  }
  assert.ok(!allLogs(logs).some((m) => m.includes('minimum 16')), 'must not mention minimum 16');
});

// ─── offline guard ──────────────────────────────────────────────────────────

test('doctor: shell and network calls go through the stubs (no real child processes)', async (t) => {
  const dir = makeEnv(t, 'amxb-doctor-stubs-');
  const execBefore = execCalls.length;
  const axiosBefore = axiosCalls;

  await runDoctorIn(dir);

  const runCalls = execCalls.slice(execBefore);
  assert.ok(runCalls.includes('git --version'), `expected stubbed git call; got ${JSON.stringify(runCalls)}`);
  assert.ok(runCalls.includes('npm --version'), `expected stubbed npm call; got ${JSON.stringify(runCalls)}`);
  assert.ok(axiosCalls > axiosBefore, 'expected the stubbed axios.get to be called');
});
