'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DepGraph } = require('../src/dep-graph');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'depgraph-'));
}

test('DepGraph.snapshot lists parsed files, resolved includes and missing includes', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.inc'), '#define A 1\n');
  fs.writeFileSync(path.join(dir, 'local.inc'), '#include <a>\n');
  fs.writeFileSync(path.join(dir, 'plugin.sma'), '#include <a>\n#include <b>\n#include "local.inc"\n');

  const graph = new DepGraph([dir]);
  graph.parseFile(path.join(dir, 'plugin.sma'));

  const snap = graph.snapshot();

  const sma = snap.files.find((f) => f.file.endsWith('plugin.sma'));
  assert.ok(sma, 'plugin.sma must be parsed');
  assert.equal(sma.isSma, true);
  assert.ok(sma.includes.some((p) => p.endsWith('a.inc')), 'angle include <a> resolved');
  assert.ok(sma.includes.some((p) => p.endsWith('local.inc')), 'quoted include resolved');

  const aInc = snap.files.find((f) => f.file.endsWith('a.inc'));
  assert.ok(aInc, 'a.inc must be parsed transitively');
  assert.equal(aInc.isSma, false);

  const missingB = snap.missing.find((m) => m.file.endsWith('plugin.sma') && m.name === 'b');
  assert.ok(missingB, '<b> is unresolvable → listed as missing');
  assert.equal(missingB.isAngle, true);
});

test('DepGraph.getSmasDependingOn returns smas that transitively depend on an inc', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'common.inc'), '');
  fs.writeFileSync(path.join(dir, 'mid.inc'), '#include <common>\n');
  fs.writeFileSync(path.join(dir, 'p1.sma'), '#include <mid>\n');
  fs.writeFileSync(path.join(dir, 'p2.sma'), '#include <other>\n');

  const graph = new DepGraph([dir]);
  graph.parseFile(path.join(dir, 'p1.sma'));
  graph.parseFile(path.join(dir, 'p2.sma'));

  const affected = graph.getSmasDependingOn(path.join(dir, 'common.inc'));
  assert.equal(affected.size, 1, 'only p1.sma depends on common.inc transitively');
  assert.ok([...affected][0].endsWith('p1.sma'));
});

test('DepGraph.update drops stale missing entries and re-snapshots', () => {
  const dir = tmpDir();
  const sma = path.join(dir, 'plugin.sma');
  fs.writeFileSync(sma, '#include <newly_added>\n');

  const graph = new DepGraph([dir]);
  graph.parseFile(sma);
  assert.equal(graph.snapshot().missing.length, 1, 'initially missing');

  fs.writeFileSync(path.join(dir, 'newly_added.inc'), '');
  fs.writeFileSync(sma, '#include <newly_added>\n#include <still_missing>\n');

  graph.update(sma);
  const snap = graph.snapshot();
  assert.ok(snap.files.some((f) => f.file.endsWith('newly_added.inc')), 'newly added inc is now parsed');
  assert.ok(snap.missing.some((m) => m.name === 'still_missing'), 'still_missing stays missing');
  assert.ok(!snap.missing.some((m) => m.name === 'newly_added'), 'stale missing entry dropped');
});

test('DepGraph.reattachMissingIncludes: adding a missing .inc returns waiting smas', () => {
  const dir = tmpDir();
  const sma = path.join(dir, 'plugin.sma');
  fs.writeFileSync(sma, '#include <newlib>\n');

  const graph = new DepGraph([dir]);
  graph.parseFile(sma);
  assert.equal(graph.snapshot().missing.length, 1, 'newlib is missing at first');

  const inc = path.join(dir, 'newlib.inc');
  fs.writeFileSync(inc, '');

  const affected = graph.reattachMissingIncludes(inc);
  assert.ok([...affected][0].endsWith('plugin.sma'), 'plugin.sma must be returned for recompile');

  const snap = graph.snapshot();
  assert.ok(snap.files.some((f) => f.file.endsWith('plugin.sma')), 'plugin re-parsed');
  assert.ok(!snap.missing.some((m) => m.name === 'newlib'), 'missing entry cleared');
  assert.equal(graph.getSmasDependingOn(inc).size, 1, 'edge recorded for future changes');
});

test('DepGraph.reattachMissingIncludes: .inc with missing include is resolved via its sma dependents', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'p1.sma'), '#include <mid>\n');
  fs.writeFileSync(path.join(dir, 'mid.inc'), '#include <deep>\n');

  const graph = new DepGraph([dir]);
  graph.parseFile(path.join(dir, 'p1.sma'));
  assert.ok(graph.snapshot().missing.some((m) => m.name === 'deep'), 'deep is missing');

  const deep = path.join(dir, 'deep.inc');
  fs.writeFileSync(deep, '');

  const affected = graph.reattachMissingIncludes(deep);
  assert.equal(affected.size, 1, 'p1.sma affected transitively via mid.inc');
  assert.ok([...affected][0].endsWith('p1.sma'));
  assert.equal(graph.getSmasDependingOn(deep).size, 1, 'edge from mid.inc to deep.inc recorded');
});

test('DepGraph.reattachMissingIncludes: unrelated file is not affected', () => {
  const dir = tmpDir();
  const sma = path.join(dir, 'plugin.sma');
  fs.writeFileSync(sma, '#include <aaa>\n');

  const graph = new DepGraph([dir]);
  graph.parseFile(sma);

  const other = path.join(dir, 'zzz.inc');
  fs.writeFileSync(other, '');
  assert.equal(graph.reattachMissingIncludes(other).size, 0, 'no sma waits for zzz.inc');
});
