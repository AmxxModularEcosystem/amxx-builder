const fs    = require('fs');
const path  = require('path');
const glob       = require('fast-glob');
const micromatch = require('micromatch');
const logger = require('./logger');
const { emit, EVENTS } = require('./events');
const { spawnCompiler, buildIncludeArgs, buildDefineArgs } = require('./compile-utils');
const { repoKey, normalizeRepo } = require('./deps-resolver');

/**
 * Applies plugin rules to a local .sma file path (relative to scripting/).
 *
 * @param {string} smaRelPath - .sma path relative to scripting/
 * @param {Array}  rules      - manifest.plugins.rules (first matching rule wins)
 * @param {{ ini: false|string, debug: boolean }} base - plugins.defaults layer:
 *   ini '' → plugins.ini, ini false → excluded from every INI
 * @returns {null|{ postfix: string, skipIni: boolean, debug: boolean }} null
 *   when the matching rule has enabled:false (skip the plugin entirely);
 *   otherwise the effective INI postfix, whether the plugin is excluded from
 *   every INI (ini:false), and the effective debug flag. `ini` unset/null and
 *   `debug` unset/null inherit `base`.
 */
function applyPluginRule(smaRelPath, rules, base) {
  const normalized = smaRelPath.split(path.sep).join('/');
  for (const rule of rules) {
    if (micromatch.isMatch(normalized, rule.match, { dot: true })) {
      if (rule.enabled === false) return null;
      const ini = rule.ini != null ? rule.ini : base.ini;
      return {
        postfix: ini === false ? '' : ini,
        skipIni: ini === false,
        debug: rule.debug != null ? rule.debug : base.debug,
      };
    }
  }
  return { postfix: base.ini === false ? '' : base.ini, skipIni: base.ini === false, debug: base.debug };
}

async function compilePlugins(manifest, repoLocalDirs, compilerPath, includeDirs, buildDir) {
  const pluginsDir = path.join(buildDir, 'amxmodx', 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });

  const collectedIncDir = path.join(buildDir, 'amxmodx', 'scripting', 'include');

  // plugins.defaults is the base layer for every plugin (local + repo).
  const pluginIni = manifest.pluginIni || { defaultIni: false, defaultDebug: false };
  const base = { ini: pluginIni.defaultIni, debug: pluginIni.defaultDebug === true };
  // AMXB_PLUGINS_DEBUG outranks rule/repo debug when set (true or false).
  const forceDebug = pluginIni.forceDebug != null ? pluginIni.forceDebug : null;

  // ── Build unified source list ──────────────────────────────────────────────
  const seenSources = new Set(); // case-insensitive repo identity (dedupe)
  const sources = [];
  for (const repoConfig of manifest.repos) {
    const identity = normalizeRepo(repoConfig);
    if (seenSources.has(identity)) continue;
    seenSources.add(identity);
    sources.push({
      label:        repoConfig.repo,
      ref:          repoConfig._resolvedRef || repoConfig.ref || 'HEAD',
      scriptingDir: path.join(
        repoLocalDirs[repoKey(repoConfig)],
        repoConfig.amxmodx_dir,
        'scripting'
      ),
      exclude: repoConfig.exclude,
      settings: repoConfig._pluginSettings || { ini: null, debug: null },
    });
  }

  const localScriptingDir = path.join(path.dirname(manifest._path), manifest.amxmodx.dir, 'scripting');
  if (fs.existsSync(localScriptingDir)) {
    sources.push({
      label: '(local)', ref: 'local', isLocal: true, scriptingDir: localScriptingDir,
      exclude: [], settings: null,
    });
  }

  // ── Collect all .sma tasks ─────────────────────────────────────────────────
  const onConflict = manifest.output.on_conflict || 'last_wins';
  const tasksByOut = new Map(); // outPath → task (dedupe cross-source collisions)
  for (const src of sources) {
    const { scriptingDir, exclude, settings, label, ref, isLocal = false } = src;

    if (!fs.existsSync(scriptingDir)) {
      logger.dim(`  ${label}: no scripting/ dir`);
      continue;
    }

    const excludePatterns = exclude.map((e) => `!${e}`);
    const smaFiles = await glob(['**/*.sma', ...excludePatterns], { cwd: scriptingDir, dot: false });

    const excluded = await findExcluded(scriptingDir, exclude);
    for (const ex of excluded) logger.skip(`Skipped (excluded): ${ex}`);

    const localIncDir = path.join(scriptingDir, 'include');
    const includes = buildIncludeArgs({ scriptingDir, localIncDir, collectedIncDir, includeDirs });

    const defines = buildDefineArgs(manifest.amxmodx.defines);

    if (logger.isVerbose()) {
      logger.verbose(`  includes: ${includes.join(', ') || '(none)'}`);
      if (defines.length) logger.verbose(`  defines: ${defines.join(', ')}`);
    }

    for (const smaRel of smaFiles) {
      let taskPostfix;
      let skipIni = false;
      let taskDebug = base.debug;

      if (isLocal) {
        const ruleResult = applyPluginRule(smaRel, manifest.plugins.rules, base);
        if (!ruleResult) {
          logger.skip(`Skipped (plugin rule): ${smaRel}`);
          continue;
        }
        taskPostfix = ruleResult.postfix;
        skipIni     = ruleResult.skipIni;
        taskDebug   = forceDebug != null ? forceDebug : ruleResult.debug;
      } else {
        const ini = settings.ini != null ? settings.ini : base.ini;
        taskPostfix = ini === false ? '' : ini;
        skipIni     = ini === false;
        taskDebug   = forceDebug != null
          ? forceDebug
          : (settings.debug != null ? settings.debug : base.debug);
      }

      const baseName = path.basename(smaRel);
      const outName  = smaRel.replace(/\.sma$/, '.amxx').split(path.sep).join('/');
      const task = {
        label, ref, postfix: taskPostfix, skipIni, debug: taskDebug, baseName,
        srcPath: path.join(scriptingDir, smaRel),
        outName,
        outPath: path.join(pluginsDir, ...outName.split('/')),
        includes,
        defines,
      };
      const prev = tasksByOut.get(task.outPath);
      if (prev) {
        if (onConflict === 'error') {
          throw new Error(`Plugin output conflict: "${outName}" — provided by both "${prev.label}" and "${label}"`);
        }
        if (onConflict === 'first_wins') {
          logger.warn(`Plugin conflict (kept "${prev.label}"): ${outName}`);
          continue;
        }
        logger.warn(`Plugin conflict (overwriting "${prev.label}"): ${outName}`);
      }
      tasksByOut.set(task.outPath, task);
    }
  }

  const tasks = [...tasksByOut.values()];

  if (!tasks.length) return [];

  logger.info(`Compiling ${tasks.length} plugin(s)...`);

  // ── Run compilations with a bounded worker pool ───────────────────────────
  const settled = await mapLimit(tasks, 8, (task) => runCompile(compilerPath, task)
    .then((value) => ({ status: 'fulfilled', value }))
    .catch((reason) => ({ status: 'rejected', reason }))
  );

  const compiled = [];
  const failed   = [];

  for (let i = 0; i < settled.length; i++) {
    if (settled[i].status === 'fulfilled') {
      compiled.push(settled[i].value);
    } else {
      failed.push({ task: tasks[i], err: settled[i].reason });
    }
  }

  if (failed.length) {
    // Per-plugin FAILED rendering is handled by the CLI renderer via EVENTS.COMPILED.
    throw new Error(
      `Compilation failed (${failed.length}/${tasks.length}): ` +
      failed.map(({ task }) => task.baseName).join(', ')
    );
  }

  return compiled;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function runCompile(compilerPath, task) {
  const { srcPath, outPath, outName, includes, defines, baseName, postfix, skipIni, debug, label, ref } = task;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const args = [srcPath, `-o${outPath}`, ...includes, ...defines];
  logger.verbose(`  cmd: ${compilerPath} ${args.join(' ')}`);

  const { status, output } = await spawnCompiler(compilerPath, args);

  if (status !== 0) {
    emit(EVENTS.COMPILED, { baseName, ok: false, output, amxxName: null, repo: label, ref, outName });
    const err = new Error(`Compilation failed: ${baseName}`);
    err.compilerOutput = output;
    throw err;
  }

  emit(EVENTS.COMPILED, { baseName, ok: true, output, amxxName: outName, repo: label, ref, outName });

  return { amxxName: outName, plugins_ini_postfix: postfix, skipIni: skipIni || false, debug: debug === true, repo: label, ref };
}

async function findExcluded(dir, patterns) {
  if (!patterns.length) return [];
  const all  = await glob('**/*.sma', { cwd: dir });
  const kept = new Set(await glob(['**/*.sma', ...patterns.map((e) => `!${e}`)], { cwd: dir }));
  return all.filter((f) => !kept.has(f)).map((f) => path.basename(f));
}

/**
 * Compiles a single .sma file. Used by watch mode.
 * Returns the .amxx filename on success, null on failure.
 *
 * eventTag (optional) is echoed in the emitted EVENTS.COMPILED payload so a
 * subscriber can attribute the event to a specific call — needed when several
 * compiles of same-named files run concurrently (serve compile.single).
 */
async function compileSingle(manifest, smaPath, compilerPath, includeDirs, buildDir, scriptingRootDir, eventTag = null) {
  const pluginsDir      = path.join(buildDir, 'amxmodx', 'plugins');
  const collectedIncDir = path.join(buildDir, 'amxmodx', 'scripting', 'include');

  const baseName = path.basename(smaPath);
  const rel      = scriptingRootDir
    ? path.relative(scriptingRootDir, smaPath)
    : baseName;
  const outName  = rel.replace(/\.sma$/, '.amxx').split(path.sep).join('/');
  const outPath  = path.join(pluginsDir, ...outName.split('/'));

  const scriptingDir = scriptingRootDir || path.dirname(smaPath);
  const localIncDir  = path.join(scriptingDir, 'include');
  const includes = buildIncludeArgs({ scriptingDir, localIncDir, collectedIncDir, includeDirs });

  const defines = buildDefineArgs(manifest.amxmodx.defines);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const { status, output } = await spawnCompiler(compilerPath, [smaPath, `-o${outPath}`, ...includes, ...defines]);

  if (status !== 0) {
    emit(EVENTS.COMPILED, { baseName, ok: false, output, amxxName: null, repo: null, ref: null, outName, tag: eventTag });
    return null;
  }

  emit(EVENTS.COMPILED, { baseName, ok: true, output, amxxName: outName, repo: null, ref: null, outName, tag: eventTag });
  return outName;
}

module.exports = { compilePlugins, compileSingle, applyPluginRule };
