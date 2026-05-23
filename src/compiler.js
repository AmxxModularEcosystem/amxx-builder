const fs    = require('fs');
const path  = require('path');
const chalk = require('chalk');
const { spawnSync } = require('child_process');
const glob  = require('fast-glob');
const logger = require('./logger');

const PREFIX = chalk.bold.white('[amxx-builder]');

/**
 * Compiles all plugins for all repos.
 * Returns an array of { amxxPath, pluginsIniPostfix, ini_comment } objects.
 */
async function compilePlugins(manifest, repoLocalDirs, compilerPath, includeDirs, buildDir) {
  const pluginsDir = path.join(buildDir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });

  const compiled = [];

  for (const repoConfig of manifest.repos) {
    const repoDir = repoLocalDirs[repoConfig.repo + '@' + (repoConfig.ref || 'HEAD')];

    const pluginList = await resolvePluginList(repoConfig, repoDir);

    for (const plugin of pluginList) {
      const srcPath  = path.join(repoDir, repoConfig.scripting_dir, plugin.src);
      const outName  = path.basename(plugin.src, '.sma') + '.amxx';
      const outPath  = path.join(pluginsDir, outName);

      if (!fs.existsSync(srcPath)) {
        logger.warn(`Compiling ${plugin.src} ... NOT FOUND (skipped)`);
        continue;
      }

      process.stdout.write(`${PREFIX} Compiling ${plugin.src} `);

      const localIncDir = path.join(repoDir, repoConfig.local_include_dir);
      const includeArgs = [];

      if (fs.existsSync(localIncDir)) {
        includeArgs.push(`-i${localIncDir}`);
      }
      for (const dir of includeDirs) {
        includeArgs.push(`-i${dir}`);
      }

      const args = [
        srcPath,
        `-o${outPath}`,
        ...includeArgs,
      ];

      const result = spawnSync(compilerPath, args, {
        encoding: 'utf8',
        windowsHide: true,
      });

      if (result.status !== 0) {
        process.stdout.write('\n');
        logger.error(`Compiling ${plugin.src} ... FAILED`);
        if (result.stderr) process.stderr.write(result.stderr);
        if (result.stdout) process.stderr.write(result.stdout);
        throw new Error(`Compilation failed: ${plugin.src}`);
      }

      process.stdout.write(`${chalk_dots(plugin.src)} OK\n`);

      compiled.push({
        amxxPath:           outPath,
        amxxName:           outName,
        plugins_ini_postfix: plugin.plugins_ini_postfix,
        ini_comment:        plugin.ini_comment,
        repo:               repoConfig.repo,
        ref:                repoConfig.ref || 'HEAD',
      });
    }
  }

  return compiled;
}

async function resolvePluginList(repoConfig, repoDir) {
  if (repoConfig.plugins) {
    // Explicit list: use as-is with their individual postfixes
    return repoConfig.plugins.map((p) => ({
      src:                p.src,
      ini_comment:        p.ini_comment,
      plugins_ini_postfix: p.plugins_ini_postfix,
    }));
  }

  // Auto-discover from scripting_dir
  const scriptingDir = path.join(repoDir, repoConfig.scripting_dir);
  if (!fs.existsSync(scriptingDir)) {
    logger.warn(`scripting_dir "${repoConfig.scripting_dir}" not found in ${repoConfig.repo}`);
    return [];
  }

  const patterns = ['**/*.sma'];
  const exclude  = repoConfig.exclude.map((e) => `!${e}`);

  const found = await glob([...patterns, ...exclude], {
    cwd: scriptingDir,
    dot: false,
  });

  const excluded = await getExcluded(scriptingDir, repoConfig.exclude);
  for (const ex of excluded) {
    logger.skip(`Skipped (excluded): ${ex}`);
  }

  return found.map((f) => ({
    src:                f,
    ini_comment:        null,
    plugins_ini_postfix: repoConfig.plugins_ini_postfix,
  }));
}

async function getExcluded(scriptingDir, patterns) {
  if (!patterns.length) return [];
  const all = await glob('**/*.sma', { cwd: scriptingDir });
  const kept = await glob(['**/*.sma', ...patterns.map((e) => `!${e}`)], { cwd: scriptingDir });
  const keptSet = new Set(kept);
  return all.filter((f) => !keptSet.has(f)).map((f) => path.basename(f));
}

function chalk_dots(src) {
  // Right-pad with dots to align "OK" for readability
  const maxLen = 40;
  const base = ` ${path.basename(src)} `;
  return '.'.repeat(Math.max(1, maxLen - base.length));
}


module.exports = { compilePlugins };
