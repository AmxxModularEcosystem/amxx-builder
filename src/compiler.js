const fs    = require('fs');
const path  = require('path');
const chalk = require('chalk');
const { spawn } = require('child_process');
const glob       = require('fast-glob');
const micromatch = require('micromatch');
const logger = require('./logger');

/**
 * Applies plugin rules to a local .sma file path (relative to scripting/).
 * Returns null if the plugin should be skipped (enabled: false),
 * or { postfix, skipIni } where postfix is the INI postfix (false = skip INI).
 */
function applyPluginRule(smaRelPath, rules, defaultPostfix) {
  const normalized = smaRelPath.split(path.sep).join('/');
  for (const rule of rules) {
    if (micromatch.isMatch(normalized, rule.match, { dot: true })) {
      if (!rule.enabled) return null;
      const postfix = rule.ini !== null ? rule.ini : defaultPostfix;
      return { postfix, skipIni: rule.ini === false };
    }
  }
  return { postfix: defaultPostfix, skipIni: false };
}

async function compilePlugins(manifest, repoLocalDirs, compilerPath, includeDirs, buildDir) {
  const pluginsDir = path.join(buildDir, 'amxmodx', 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });

  const collectedIncDir = path.join(buildDir, 'amxmodx', 'scripting', 'include');

  // ── Build unified source list ──────────────────────────────────────────────
  const sources = manifest.repos.map((repoConfig) => ({
    label:        repoConfig.repo,
    ref:          repoConfig._resolvedRef || repoConfig.ref || 'HEAD',
    scriptingDir: path.join(
      repoLocalDirs[`${repoConfig.repo}@${repoConfig._resolvedRef || repoConfig.ref || 'HEAD'}`],
      repoConfig.amxmodx_dir,
      'scripting'
    ),
    exclude: repoConfig.exclude,
    postfix: repoConfig.plugins_ini_postfix,
  }));

  const localScriptingDir = path.join(path.dirname(manifest._path), manifest.amxmodx.dir, 'scripting');
  if (fs.existsSync(localScriptingDir)) {
    sources.push({
      label: '(local)', ref: 'local', scriptingDir: localScriptingDir,
      exclude: [], postfix: manifest.globalPostfix,
    });
  }

  // ── Collect all .sma tasks ─────────────────────────────────────────────────
  const tasks = [];
  for (const src of sources) {
    const { scriptingDir, exclude, postfix, label, ref } = src;

    if (!fs.existsSync(scriptingDir)) {
      logger.dim(`  ${label}: no scripting/ dir`);
      continue;
    }

    const excludePatterns = exclude.map((e) => `!${e}`);
    const smaFiles = await glob(['**/*.sma', ...excludePatterns], { cwd: scriptingDir, dot: false });

    const excluded = await findExcluded(scriptingDir, exclude);
    for (const ex of excluded) logger.skip(`Skipped (excluded): ${ex}`);

    const localIncDir = path.join(scriptingDir, 'include');
    const includes = [];
                                        includes.push(`-i${scriptingDir}`);
    if (fs.existsSync(localIncDir))     includes.push(`-i${localIncDir}`);
    if (fs.existsSync(collectedIncDir)) includes.push(`-i${collectedIncDir}`);
    for (const d of includeDirs)        includes.push(`-i${d}`);

    const defines = (manifest.amxmodx.defines || []).map((d) => `-D${d}`);

    if (logger.isVerbose()) {
      logger.verbose(`  includes: ${includes.join(', ') || '(none)'}`);
      if (defines.length) logger.verbose(`  defines: ${defines.join(', ')}`);
    }

    const isLocal = src.ref === 'local';

    for (const smaRel of smaFiles) {
      let taskPostfix = postfix;
      let skipIni     = false;

      if (isLocal) {
        const ruleResult = applyPluginRule(smaRel, manifest.pluginRules, postfix);
        if (!ruleResult) {
          logger.skip(`Skipped (plugin rule): ${smaRel}`);
          continue;
        }
        taskPostfix = ruleResult.postfix;
        skipIni     = ruleResult.skipIni;
      }

      const baseName = path.basename(smaRel);
      const outName  = smaRel.replace(/\.sma$/, '.amxx').split(path.sep).join('/');
      tasks.push({
        label, ref, postfix: taskPostfix, skipIni, baseName,
        srcPath: path.join(scriptingDir, smaRel),
        outName,
        outPath: path.join(pluginsDir, ...outName.split('/')),
        includes,
        defines,
      });
    }
  }

  if (!tasks.length) return [];

  logger.info(`Compiling ${tasks.length} plugin(s)...`);

  // ── Run all compilations in parallel ──────────────────────────────────────
  const settled = await Promise.allSettled(
    tasks.map((task) => runCompile(compilerPath, task))
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
    for (const { task, err } of failed) {
      logger.error(`FAILED: ${task.baseName}`);
      const out = (err.compilerOutput || '').trim();
      if (out) process.stderr.write(out + '\n');
    }
    throw new Error(
      `Compilation failed (${failed.length}/${tasks.length}): ` +
      failed.map(({ task }) => task.baseName).join(', ')
    );
  }

  return compiled;
}

async function runCompile(compilerPath, task) {
  const { srcPath, outPath, outName, includes, defines, baseName, postfix, skipIni, label, ref } = task;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const args = [srcPath, `-o${outPath}`, ...includes, ...defines];
  logger.verbose(`  cmd: ${compilerPath} ${args.join(' ')}`);

  const { status, output } = await spawnAsync(compilerPath, args);

  if (status !== 0) {
    const err = new Error(`Compilation failed: ${baseName}`);
    err.compilerOutput = output;
    throw err;
  }

  process.stdout.write(
    `${chalk.bold.white('[amxx-builder]')}   ${baseName} ${dots(baseName)} ${chalk.green('OK')}\n`
  );

  return { amxxName: outName, plugins_ini_postfix: postfix, skipIni: skipIni || false, ini_comment: null, repo: label, ref };
}

function spawnAsync(cmd, args) {
  const env = { ...process.env };
  if (process.platform === 'linux') {
    const compilerDir = path.dirname(cmd);
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH
      ? `${compilerDir}:${env.LD_LIBRARY_PATH}`
      : compilerDir;
  }
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { windowsHide: true, env });
    let output = '';
    if (proc.stdout) proc.stdout.on('data', (d) => output += d);
    if (proc.stderr) proc.stderr.on('data', (d) => output += d);
    proc.on('close', (code) => resolve({ status: code, output }));
    proc.on('error', reject);
  });
}

async function findExcluded(dir, patterns) {
  if (!patterns.length) return [];
  const all  = await glob('**/*.sma', { cwd: dir });
  const kept = new Set(await glob(['**/*.sma', ...patterns.map((e) => `!${e}`)], { cwd: dir }));
  return all.filter((f) => !kept.has(f)).map((f) => path.basename(f));
}

function dots(filename) {
  return chalk.dim(' ' + '.'.repeat(Math.max(1, 42 - filename.length)) + ' ');
}

/**
 * Compiles a single .sma file. Used by watch mode.
 * Returns the .amxx filename on success, null on failure.
 */
async function compileSingle(manifest, smaPath, compilerPath, includeDirs, buildDir, scriptingRootDir) {
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
  const includes     = [];
                                        includes.push(`-i${scriptingDir}`);
  if (fs.existsSync(localIncDir))     includes.push(`-i${localIncDir}`);
  if (fs.existsSync(collectedIncDir)) includes.push(`-i${collectedIncDir}`);
  for (const d of includeDirs)        includes.push(`-i${d}`);

  const defines = (manifest.amxmodx.defines || []).map((d) => `-D${d}`);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const { status, output } = await spawnAsync(compilerPath, [smaPath, `-o${outPath}`, ...includes, ...defines]);

  if (status !== 0) {
    logger.error(`FAILED: ${baseName}`);
    const out = (output || '').trim();
    if (out) process.stderr.write(out + '\n');
    return null;
  }

  process.stdout.write(
    `${chalk.bold.white('[amxx-builder]')}   ${baseName} ${dots(baseName)} ${chalk.green('OK')}\n`
  );
  return outName;
}

module.exports = { compilePlugins, compileSingle, applyPluginRule };
