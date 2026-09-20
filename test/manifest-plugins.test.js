'use strict';

/**
 * Tests for the unified plugin INI configuration in src/manifest.js:
 * normalizeIni, both `plugins` forms, repos[].plugins/_pluginSettings and
 * finalizePluginConfig (design §4.2 generation truth table §4.5, precedence
 * §4.3, debug inheritance, legacy adaptation + _deprecations, post---set
 * finalize, idempotency).
 *
 * Offline + deterministic: temp YAML files only, no network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  normalizeIni,
  finalizePluginConfig,
  parseManifest,
  resolveManifest,
} = require('../src/manifest');

function writeTmpYaml(content) {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'amxb-plugins-'));
  const file = path.join(dir, 'amxbuild.yml');
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function bareManifest({ defaults = {}, rules = [], repos = [], output = {}, pluginsIniPostfix = null } = {}) {
  return {
    plugins: {
      defaults: { ini: null, debug: null, ...defaults },
      rules: rules.map((r, i) => ({
        match: `rule-${i}.sma`, enabled: true, ini: null, debug: null, ...r,
      })),
    },
    repos: repos.map((r) => ({
      repo: r.repo || 'Org/R',
      plugins: r.plugins || null,
      plugins_ini_postfix: r.plugins_ini_postfix || null,
    })),
    output,
    plugins_ini_postfix: pluginsIniPostfix,
  };
}

// Fallback composition from design §4.3 — asserts the resolved data supports
// the documented precedence (rule > repo > defaults).
function effectiveLocal(m, smaRel) {
  const rule = m.plugins.rules.find((r) => r.match === smaRel);
  if (!rule) return { ini: m.pluginIni.defaultIni, debug: m.pluginIni.defaultDebug };
  if (rule.enabled === false) return { skipped: true };
  return {
    ini:   rule.ini   !== null ? rule.ini   : m.pluginIni.defaultIni,
    debug: rule.debug !== null ? rule.debug : m.pluginIni.defaultDebug,
  };
}

function effectiveRepo(m, repoName) {
  const repo = m.repos.find((r) => r.repo === repoName);
  const s = repo._pluginSettings;
  return {
    ini:   s.ini   !== null ? s.ini   : m.pluginIni.defaultIni,
    debug: s.debug !== null ? s.debug : m.pluginIni.defaultDebug,
  };
}

// ─── normalizeIni ────────────────────────────────────────────────────────────

test('normalizeIni: null/undefined → null (inherit)', () => {
  assert.equal(normalizeIni(null), null);
  assert.equal(normalizeIni(undefined), null);
});

test('normalizeIni: false → false, true → empty-string postfix', () => {
  assert.equal(normalizeIni(false), false);
  assert.equal(normalizeIni(true), '');
});

test('normalizeIni: strings pass through, numbers coerce to strings', () => {
  assert.equal(normalizeIni(''), '');
  assert.equal(normalizeIni('vip'), 'vip');
  assert.equal(normalizeIni(0), '0');
  assert.equal(normalizeIni(123), '123');
});

// ─── plugins: object form ───────────────────────────────────────────────────

test('parseManifest: canonical object form parses defaults + rules', () => {
  const file = writeTmpYaml([
    'name: TestServer',
    'version: "1.0.0"',
    'plugins:',
    '  defaults:',
    '    ini: myserver',
    '    debug: true',
    '  rules:',
    '    - match: "VipM/*.sma"',
    '      ini: vipm',
    '      debug: false',
    '    - match: "wip/*.sma"',
    '      enabled: false',
  ].join('\n'));

  const m = parseManifest(file);

  assert.deepEqual(m.plugins.defaults, { ini: 'myserver', debug: true });
  assert.deepEqual(m.plugins.rules, [
    { match: 'VipM/*.sma', enabled: true, ini: 'vipm', debug: false },
    { match: 'wip/*.sma', enabled: false, ini: null, debug: null },
  ]);
  assert.deepEqual(m.pluginIni, { enabled: true, defaultIni: 'myserver', defaultDebug: true });
  assert.deepEqual(m._deprecations, []);
});

test('parseManifest: empty object form → explicit null sentinels, disabled', () => {
  const file = writeTmpYaml('name: TestServer\nversion: "1.0.0"\nplugins: {}\n');
  const m = parseManifest(file);

  assert.deepEqual(m.plugins.defaults, { ini: null, debug: null });
  assert.deepEqual(m.plugins.rules, []);
  assert.deepEqual(m.pluginIni, { enabled: false, defaultIni: false, defaultDebug: false });
});

test('parseManifest: legacy array form → rules only, null defaults', () => {
  const file = writeTmpYaml([
    'name: TestServer',
    'version: "1.0.0"',
    'plugins:',
    '  - match: "VipM/*.sma"',
    '    ini: vipm',
    '  - match: "legacy.sma"',
    '    enabled: false',
  ].join('\n'));

  const m = parseManifest(file);

  assert.deepEqual(m.plugins.defaults, { ini: null, debug: null });
  assert.deepEqual(m.plugins.rules, [
    { match: 'VipM/*.sma', enabled: true, ini: 'vipm', debug: null },
    { match: 'legacy.sma', enabled: false, ini: null, debug: null },
  ]);
  assert.deepEqual(m.pluginIni, { enabled: true, defaultIni: '', defaultDebug: false });
});

test('parseManifest: ini true/false normalise per rule', () => {
  const file = writeTmpYaml([
    'name: TestServer',
    'version: "1.0.0"',
    'plugins:',
    '  rules:',
    '    - match: "a.sma"',
    '      ini: true',
    '    - match: "b.sma"',
    '      ini: false',
  ].join('\n'));

  const m = parseManifest(file);
  assert.equal(m.plugins.rules[0].ini, '');
  assert.equal(m.plugins.rules[1].ini, false);
  assert.equal(m.pluginIni.enabled, true);
});

// ─── repos ──────────────────────────────────────────────────────────────────

test('parseManifest: repos[].plugins parsed, legacy repo postfix kept raw', () => {
  const file = writeTmpYaml([
    'name: TestServer',
    'version: "1.0.0"',
    'repos:',
    '  - repo: Org/New',
    '    plugins:',
    '      ini: vip',
    '      debug: false',
    '  - repo: Org/Legacy',
    '    plugins_ini_postfix: legacy-post',
    '  - Org/Plain',
  ].join('\n'));

  const m = parseManifest(file);

  assert.deepEqual(m.repos[0].plugins, { ini: 'vip', debug: false });
  assert.equal(m.repos[0].plugins_ini_postfix, null);
  assert.deepEqual(m.repos[1].plugins, null);
  assert.equal(m.repos[1].plugins_ini_postfix, 'legacy-post');
  assert.deepEqual(m.repos[2]._pluginSettings, { ini: null, debug: null });
  assert.deepEqual(m._deprecations, [
    '[DEPRECATED] repos[].plugins_ini_postfix (Org/Legacy) — use repos[].plugins.ini instead',
  ]);
});

test('parseManifest: global plugins_ini_postfix is not injected into repos', () => {
  const file = writeTmpYaml([
    'name: TestServer',
    'version: "1.0.0"',
    'plugins_ini_postfix: globalpost',
    'repos:',
    '  - repo: Org/A',
  ].join('\n'));

  const m = parseManifest(file);

  assert.equal(m.plugins_ini_postfix, 'globalpost');
  assert.equal(m.repos[0].plugins_ini_postfix, null);
  assert.deepEqual(m.repos[0]._pluginSettings, { ini: null, debug: null });
  assert.equal(m.pluginIni.enabled, false);
});

test('finalizePluginConfig: repo _pluginSettings computed without mutating repo.plugins', () => {
  const m = bareManifest({ repos: [{ repo: 'Org/R', plugins: { debug: true } }] });
  finalizePluginConfig(m);

  assert.deepEqual(m.repos[0].plugins, { ini: null, debug: true });
  assert.deepEqual(m.repos[0]._pluginSettings, { ini: null, debug: true });
  assert.deepEqual(Object.keys(m.repos[0].plugins).sort(), ['debug', 'ini']);
  assert.equal('enabled' in m.repos[0].plugins, false);
});

// ─── generation truth table (design §4.5) ───────────────────────────────────

const TRUTH_TABLE = [
  { name: 'null / no rule / no repo → disabled',
    defaults: { ini: null },  rules: [],                 repos: [],               expect: { enabled: false, defaultIni: false } },
  { name: 'null / rule ini / no repo → plugins.ini',
    defaults: { ini: null },  rules: [{ ini: 'x' }],     repos: [],               expect: { enabled: true,  defaultIni: '' } },
  { name: 'x / no rule / no repo → plugins-x.ini',
    defaults: { ini: 'x' },   rules: [],                 repos: [],               expect: { enabled: true,  defaultIni: 'x' } },
  { name: 'x / rule false → enabled, base x',
    defaults: { ini: 'x' },   rules: [{ ini: false }],   repos: [],               expect: { enabled: true,  defaultIni: 'x' } },
  { name: 'false / no rule / no repo → disabled',
    defaults: { ini: false }, rules: [],                 repos: [],               expect: { enabled: false, defaultIni: false } },
  { name: 'false / rule ini → enabled, base excluded',
    defaults: { ini: false }, rules: [{ ini: 'r' }],     repos: [],               expect: { enabled: true,  defaultIni: false } },
  { name: 'false / repo ini → enabled, base excluded',
    defaults: { ini: false }, rules: [],                 repos: [{ ini: 'vip' }], expect: { enabled: true,  defaultIni: false } },
  { name: 'true / no rule / no repo → plugins.ini',
    defaults: { ini: true },  rules: [],                 repos: [],               expect: { enabled: true,  defaultIni: '' } },
  { name: 'null / repo ini → plugins.ini',
    defaults: { ini: null },  rules: [],                 repos: [{ ini: 'vip' }], expect: { enabled: true,  defaultIni: '' } },
];

for (const row of TRUTH_TABLE) {
  test(`finalizePluginConfig truth table: ${row.name}`, () => {
    const m = bareManifest({
      defaults: row.defaults,
      rules:    row.rules,
      repos:    row.repos.map((r) => ({ plugins: { ini: r.ini, debug: null } })),
    });

    finalizePluginConfig(m);

    assert.equal(m.pluginIni.enabled, row.expect.enabled);
    assert.equal(m.pluginIni.defaultIni, row.expect.defaultIni);
  });
}

// ─── precedence & debug ─────────────────────────────────────────────────────

test('precedence: rule > repo > defaults, unset inherits', () => {
  const file = writeTmpYaml([
    'name: TestServer',
    'version: "1.0.0"',
    'plugins:',
    '  defaults:',
    '    ini: base',
    '    debug: true',
    '  rules:',
    '    - match: "rule.sma"',
    '      ini: rule',
    '      debug: false',
    '    - match: "inherit.sma"',
    '    - match: "excluded.sma"',
    '      ini: false',
    'repos:',
    '  - repo: Org/Repo',
    '    plugins:',
    '      ini: vip',
    '      debug: false',
    '  - repo: Org/Inherit',
  ].join('\n'));

  const m = parseManifest(file);

  assert.deepEqual(effectiveLocal(m, 'rule.sma'),     { ini: 'rule',    debug: false });
  assert.deepEqual(effectiveLocal(m, 'inherit.sma'),  { ini: 'base',    debug: true });
  assert.deepEqual(effectiveLocal(m, 'excluded.sma'), { ini: false,     debug: true });
  assert.deepEqual(effectiveLocal(m, 'wip/*.sma'),    { ini: 'base',    debug: true });
  assert.deepEqual(effectiveRepo(m, 'Org/Repo'),      { ini: 'vip',     debug: false });
  assert.deepEqual(effectiveRepo(m, 'Org/Inherit'),   { ini: 'base',    debug: true });

  assert.equal(m.pluginIni.defaultIni, 'base');
  assert.equal(m.pluginIni.defaultDebug, true);
});

test('precedence: enabled:false rule is skipped, others unaffected', () => {
  const file = writeTmpYaml([
    'name: TestServer',
    'version: "1.0.0"',
    'plugins:',
    '  defaults:',
    '    ini: base',
    '  rules:',
    '    - match: "skip.sma"',
    '      enabled: false',
    '      ini: never',
  ].join('\n'));

  const m = parseManifest(file);

  assert.deepEqual(effectiveLocal(m, 'skip.sma'), { skipped: true });
  assert.deepEqual(effectiveLocal(m, 'other.sma'), { ini: 'base', debug: false });
  assert.equal(m.pluginIni.defaultIni, 'base');
});

test('debug: defaults.debug flows into defaultDebug; unset defaults → false', () => {
  const on  = parseManifest(writeTmpYaml([
    'name: T', 'version: "1.0.0"',
    'plugins:', '  defaults:', '    debug: true',
  ].join('\n')));
  const off = parseManifest(writeTmpYaml('name: T\nversion: "1.0.0"\n'));

  assert.equal(on.pluginIni.defaultDebug, true);
  assert.equal(off.pluginIni.defaultDebug, false);
});

test('debug: rule override and inheritance', () => {
  const m = bareManifest({
    defaults: { ini: 'base', debug: true },
    rules: [{ match: 'off.sma', debug: false }, { match: 'on.sma' }],
  });
  finalizePluginConfig(m);

  assert.equal(effectiveLocal(m, 'off.sma').debug, false);
  assert.equal(effectiveLocal(m, 'on.sma').debug, true);
});

test('debug: repo override and inheritance without losing the ini base', () => {
  const m = bareManifest({
    defaults: { ini: 'base', debug: true },
    repos: [
      { repo: 'Org/Off', plugins: { debug: false } },
      { repo: 'Org/Inherit' },
    ],
  });
  finalizePluginConfig(m);

  const off = effectiveRepo(m, 'Org/Off');
  assert.deepEqual(off, { ini: 'base', debug: false });
  assert.deepEqual(m.repos[0].plugins, { ini: null, debug: false });
  assert.deepEqual(effectiveRepo(m, 'Org/Inherit'), { ini: 'base', debug: true });
});

// ─── legacy adaptation & _deprecations ──────────────────────────────────────

test('legacy: output.generate_ini:true → plugins.ini + deprecation', () => {
  const file = writeTmpYaml([
    'name: TestServer',
    'version: "1.0.0"',
    'output:',
    '  generate_ini: true',
  ].join('\n'));

  const m = parseManifest(file);

  assert.deepEqual(m.pluginIni, { enabled: true, defaultIni: '', defaultDebug: false });
  assert.equal(m._deprecations.length, 1);
  assert.match(m._deprecations[0], /output\.generate_ini/);
});

test('legacy: generate_ini:true + plugins_ini_postfix → adapted postfix, both warnings', () => {
  const file = writeTmpYaml([
    'name: TestServer',
    'version: "1.0.0"',
    'output:',
    '  generate_ini: true',
    'plugins_ini_postfix: mypost',
  ].join('\n'));

  const m = parseManifest(file);

  assert.deepEqual(m.pluginIni, { enabled: true, defaultIni: 'mypost', defaultDebug: false });
  assert.equal(m._deprecations.length, 2);
  assert.ok(m._deprecations.some((d) => /output\.generate_ini/.test(d)));
  assert.ok(m._deprecations.some((d) => /plugins_ini_postfix/.test(d)));
});

test('legacy: plugins_ini_postfix without generate_ini is inert but warns', () => {
  const file = writeTmpYaml([
    'name: TestServer',
    'version: "1.0.0"',
    'plugins_ini_postfix: inertpost',
  ].join('\n'));

  const m = parseManifest(file);

  assert.equal(m.plugins_ini_postfix, 'inertpost');
  assert.deepEqual(m.pluginIni, { enabled: false, defaultIni: false, defaultDebug: false });
  assert.equal(m._deprecations.length, 1);
  assert.match(m._deprecations[0], /plugins_ini_postfix/);
});

test('legacy: repos[].plugins_ini_postfix → _pluginSettings + warning', () => {
  const file = writeTmpYaml([
    'name: TestServer',
    'version: "1.0.0"',
    'repos:',
    '  - repo: Org/Legacy',
    '    plugins_ini_postfix: repo-post',
  ].join('\n'));

  const m = parseManifest(file);

  assert.deepEqual(m.repos[0]._pluginSettings, { ini: 'repo-post', debug: null });
  assert.deepEqual(m.pluginIni, { enabled: true, defaultIni: '', defaultDebug: false });
  assert.equal(m._deprecations.length, 1);
  assert.match(m._deprecations[0], /repos\[\]\.plugins_ini_postfix/);
});

test('legacy: explicit plugins.defaults.ini wins over legacy adaptation', () => {
  const file = writeTmpYaml([
    'name: TestServer',
    'version: "1.0.0"',
    'output:',
    '  generate_ini: true',
    'plugins_ini_postfix: oldpost',
    'plugins:',
    '  defaults:',
    '    ini: newpost',
  ].join('\n'));

  const m = parseManifest(file);

  assert.equal(m.pluginIni.defaultIni, 'newpost');
  assert.equal(m._deprecations.length, 2);
});

test('legacy: no legacy fields → empty _deprecations', () => {
  const m = parseManifest(writeTmpYaml([
    'name: TestServer',
    'version: "1.0.0"',
    'plugins:',
    '  defaults:',
    '    ini: x',
  ].join('\n')));

  assert.deepEqual(m._deprecations, []);
});

// ─── --set (post-override finalize) ─────────────────────────────────────────

test('resolveManifest --set: plugins.defaults.ini/debug take effect after override', () => {
  const file = writeTmpYaml('name: TestServer\nversion: "1.0.0"\n');
  const m = resolveManifest(file, {
    set: ['plugins.defaults.ini=vip', 'plugins.defaults.debug=true'],
  });

  assert.deepEqual(m.plugins.defaults, { ini: 'vip', debug: true });
  assert.deepEqual(m.pluginIni, { enabled: true, defaultIni: 'vip', defaultDebug: true });
});

test('resolveManifest --set: output.generate_ini=true adapts defaults.ini', () => {
  const file = writeTmpYaml('name: TestServer\nversion: "1.0.0"\n');
  const m = resolveManifest(file, { set: ['output.generate_ini=true'] });

  assert.deepEqual(m.pluginIni, { enabled: true, defaultIni: '', defaultDebug: false });
  assert.equal(m._deprecations.length, 1);
  assert.match(m._deprecations[0], /output\.generate_ini/);
});

test('resolveManifest --set: plugins_ini_postfix + generate_ini adapt and warn', () => {
  const file = writeTmpYaml('name: TestServer\nversion: "1.0.0"\n');
  const m = resolveManifest(file, {
    set: ['output.generate_ini=true', 'plugins_ini_postfix=mypost'],
  });

  assert.equal(m.pluginIni.enabled, true);
  assert.equal(m.pluginIni.defaultIni, 'mypost');
  assert.equal(m._deprecations.length, 2);
});

test('resolveManifest --set: numeric ini coerces to string, false disables', () => {
  const file = writeTmpYaml('name: TestServer\nversion: "1.0.0"\n');

  const numeric = resolveManifest(file, { set: ['plugins.defaults.ini=0'] });
  assert.equal(numeric.pluginIni.defaultIni, '0');

  const disabled = resolveManifest(file, { set: ['plugins.defaults.ini=false'] });
  assert.deepEqual(disabled.pluginIni, { enabled: false, defaultIni: false, defaultDebug: false });
});

test('resolveManifest --set: repos.0.plugins.ini overrides the repo layer', () => {
  const file = writeTmpYaml([
    'name: TestServer',
    'version: "1.0.0"',
    'repos:',
    '  - repo: Org/A',
  ].join('\n'));

  const m = resolveManifest(file, { set: ['repos.0.plugins.ini=vip'] });

  assert.deepEqual(m.repos[0]._pluginSettings, { ini: 'vip', debug: null });
  assert.equal(m.pluginIni.enabled, true);
  assert.equal(m.pluginIni.defaultIni, '');
});

// ─── idempotency ────────────────────────────────────────────────────────────

function snapshot(m) {
  return {
    plugins:      m.plugins,
    pluginIni:    m.pluginIni,
    deprecations: m._deprecations,
    repos: m.repos.map((r) => ({
      repo:                r.repo,
      plugins:             r.plugins,
      plugins_ini_postfix: r.plugins_ini_postfix,
      pluginSettings:      r._pluginSettings,
    })),
  };
}

test('finalizePluginConfig: idempotent across repeated runs', () => {
  const file = writeTmpYaml([
    'name: TestServer',
    'version: "1.0.0"',
    'output:',
    '  generate_ini: true',
    'plugins_ini_postfix: mypost',
    'plugins:',
    '  defaults:',
    '    debug: true',
    '  rules:',
    '    - match: "a.sma"',
    '      ini: "5"',
    'repos:',
    '  - repo: Org/Legacy',
    '    plugins_ini_postfix: repo-post',
    '  - repo: Org/New',
    '    plugins:',
    '      ini: true',
  ].join('\n'));

  const m = parseManifest(file);
  const once = JSON.parse(JSON.stringify(snapshot(m)));

  finalizePluginConfig(m);
  finalizePluginConfig(m);

  assert.deepEqual(snapshot(m), once);
  assert.equal(m.plugins.rules[0].ini, '5');
  assert.deepEqual(m.pluginIni, { enabled: true, defaultIni: 'mypost', defaultDebug: true });
});
