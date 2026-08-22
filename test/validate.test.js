'use strict';

/**
 * Unit tests for src/validate.js (validateManifestFile).
 *
 * Never throws — always returns { valid, errors, warnings }.
 * Offline + deterministic: real temp dirs, no network.
 * loadDefaultsRaw() is intentionally NOT stubbed — it reads
 * defaults/amxbuild.defaults.yml from the repo root.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { validateManifestFile } = require('../src/validate');

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeManifest(dir, content) {
  const p = path.join(dir, 'amxbuild.yml');
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

test('validateManifestFile: nonexistent path → not found error at (root)', () => {
  const result = validateManifestFile('/nonexistent/definitely/missing/amxbuild.yml');

  assert.equal(result.valid, false);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].path, '(root)');
  assert.match(result.errors[0].message, /Manifest not found/);
});

test('validateManifestFile: invalid YAML → parse error at (root)', (t) => {
  const dir = makeTmpDir('amxb-val-yaml-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifestPath = writeManifest(dir, 'name: [unclosed');

  const result = validateManifestFile(manifestPath);

  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].path, '(root)');
  assert.match(result.errors[0].message, /YAML parse error/);
});

test('validateManifestFile: empty file → not a valid YAML object', (t) => {
  const dir = makeTmpDir('amxb-val-empty-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifestPath = writeManifest(dir, '');

  const result = validateManifestFile(manifestPath);

  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].path, '(root)');
  assert.match(result.errors[0].message, /not a valid YAML object/);
});

test('validateManifestFile: YAML scalar (non-object) → not a valid YAML object', (t) => {
  const dir = makeTmpDir('amxb-val-scalar-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifestPath = writeManifest(dir, 'just a string');

  const result = validateManifestFile(manifestPath);

  assert.equal(result.valid, false);
  assert.match(result.errors[0].message, /not a valid YAML object/);
});

test('validateManifestFile: YAML array → not a valid YAML object', (t) => {
  const dir = makeTmpDir('amxb-val-array-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifestPath = writeManifest(dir, '- one\n- two');

  const result = validateManifestFile(manifestPath);

  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].path, '(root)');
  assert.match(result.errors[0].message, /not a valid YAML object/);
});

test('validateManifestFile: missing name → error at /name', (t) => {
  const dir = makeTmpDir('amxb-val-noname-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifestPath = writeManifest(dir, 'version: "1.0"');

  const result = validateManifestFile(manifestPath);

  assert.equal(result.valid, false);
  const nameErr = result.errors.find((e) => e.path === '/name');
  assert.ok(nameErr, 'expected an error at /name');
  assert.match(nameErr.message, /Missing required field/);
});

test('validateManifestFile: non-string name → error at /name', (t) => {
  const dir = makeTmpDir('amxb-val-nametype-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifestPath = writeManifest(dir, 'name: 123');

  const result = validateManifestFile(manifestPath);

  assert.equal(result.valid, false);
  const nameErr = result.errors.find((e) => e.path === '/name');
  assert.ok(nameErr, 'expected an error at /name');
  assert.match(nameErr.message, /Missing required field/);
});

test('validateManifestFile: unquoted numeric version → error at /version (quoted string)', (t) => {
  const dir = makeTmpDir('amxb-val-version-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifestPath = writeManifest(dir, 'name: Test\nversion: 5.0');

  const result = validateManifestFile(manifestPath);

  assert.equal(result.valid, false);
  const versionErrors = result.errors.filter((e) => e.path === '/version');
  assert.ok(versionErrors.length > 0, 'expected an error at /version');
  assert.ok(
    versionErrors.some((e) => /quoted string/.test(e.message)),
    `expected a /version error mentioning quoted string, got: ${JSON.stringify(result.errors)}`
  );
});

test('validateManifestFile: fully valid manifest → valid with no errors', (t) => {
  const dir = makeTmpDir('amxb-val-ok-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifestPath = writeManifest(dir, 'name: Test\nversion: "1.0"');

  const result = validateManifestFile(manifestPath);

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('validateManifestFile: repos wrong type → schema error at /repos', (t) => {
  const dir = makeTmpDir('amxb-val-repos-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifestPath = writeManifest(dir, 'name: Test\nrepos: notanarray');

  const result = validateManifestFile(manifestPath);

  assert.equal(result.valid, false);
  const reposErr = result.errors.find((e) => e.path === '/repos');
  assert.ok(reposErr, `expected a schema error at /repos, got: ${JSON.stringify(result.errors)}`);
  assert.match(reposErr.message, /must be array/);
});

test('validateManifestFile: plugins wrong type → schema error at /plugins', (t) => {
  const dir = makeTmpDir('amxb-val-plugins-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifestPath = writeManifest(dir, 'name: Test\nplugins:\n  a: 1');

  const result = validateManifestFile(manifestPath);

  assert.equal(result.valid, false);
  const pluginsErr = result.errors.find((e) => e.path === '/plugins');
  assert.ok(pluginsErr, `expected a schema error at /plugins, got: ${JSON.stringify(result.errors)}`);
  assert.match(pluginsErr.message, /must be array/);
});

test('validateManifestFile: invalid manifest accumulates multiple errors', (t) => {
  const dir = makeTmpDir('amxb-val-multi-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifestPath = writeManifest(dir, 'version: 5.0\nrepos: nope');

  const result = validateManifestFile(manifestPath);

  assert.equal(result.valid, false);
  const paths = result.errors.map((e) => e.path);
  assert.ok(paths.includes('/name'), 'missing /name error');
  assert.ok(paths.includes('/version'), 'missing /version error');
  assert.ok(paths.includes('/repos'), 'missing /repos error');
});
