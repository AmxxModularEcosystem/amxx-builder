const fs    = require('fs');
const path  = require('path');
const chalk = require('chalk');
const { spawn } = require('child_process');
const glob  = require('fast-glob');
const logger = require('./logger');

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
    if (fs.existsSync(localIncDir))     includes.push(`-i${localIncDir}`);
    if (fs.existsSync(collectedIncDir)) includes.push(`-i${collectedIncDir}`);
    for (const d of includeDirs) includes.push(`-i${d}`);

    for (const smaRel of smaFiles) {
      const baseName = path.basename(smaRel);
      tasks.push({
        label, ref, postfix, baseName,
        srcPath:  path.join(scriptingDir, smaRel),
        outName:  baseName.replace(/\.sma$/, '.amxx'),
        outPath:  path.join(pluginsDir, baseName.replace(/\.sma$/, '.amxx')),
        includes,
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
  const { srcPath, outPath, outName, includes, baseName, postfix, label, ref } = task;

  const { status, output } = await spawnAsync(compilerPath, [srcPath, `-o${outPath}`, ...includes]);

  if (status !== 0) {
    const err = new Error(`Compilation failed: ${baseName}`);
    err.compilerOutput = output;
    throw err;
  }

  process.stdout.write(
    `${chalk.bold.white('[amxx-builder]')}   ${baseName} ${dots(baseName)} ${chalk.green('OK')}\n`
  );

  return { amxxName: outName, plugins_ini_postfix: postfix, ini_comment: null, repo: label, ref };
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

module.exports = { compilePlugins };
