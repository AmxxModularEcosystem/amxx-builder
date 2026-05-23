const fs    = require('fs');
const path  = require('path');
const chalk = require('chalk');
const { spawnSync } = require('child_process');
const glob  = require('fast-glob');
const logger = require('./logger');

const PREFIX = chalk.bold.white('[amxx-builder]');

/**
 * Compiles all .sma files found in <amxmodx_dir>/scripting/ of each repo.
 * Output .amxx files go to build/amxmodx/plugins/.
 * Returns array of { amxxName, plugins_ini_postfix, ini_comment, repo, ref } for ini generation.
 */
async function compilePlugins(manifest, repoLocalDirs, compilerPath, includeDirs, buildDir) {
  const pluginsDir = path.join(buildDir, 'amxmodx', 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });

  const compiled = [];

  for (const repoConfig of manifest.repos) {
    const repoDir     = repoLocalDirs[`${repoConfig.repo}@${repoConfig._resolvedRef || repoConfig.ref || 'HEAD'}`];
    const scriptingDir = path.join(repoDir, repoConfig.amxmodx_dir, 'scripting');

    if (!fs.existsSync(scriptingDir)) {
      logger.dim(`  ${repoConfig.repo}: no scripting/ dir in ${repoConfig.amxmodx_dir}/`);
      continue;
    }

    const excludePatterns = repoConfig.exclude.map((e) => `!${e}`);
    const smaFiles = await glob(['**/*.sma', ...excludePatterns], {
      cwd: scriptingDir,
      dot: false,
    });

    const excluded = await findExcluded(scriptingDir, repoConfig.exclude);
    for (const ex of excluded) logger.skip(`Skipped (excluded): ${ex}`);

    for (const smaRel of smaFiles) {
      const srcPath = path.join(scriptingDir, smaRel);
      const outName = path.basename(smaRel, '.sma') + '.amxx';
      const outPath = path.join(pluginsDir, outName);

      process.stdout.write(`${PREFIX} Compiling ${path.basename(smaRel)} `);

      // Include dirs: repo's own scripting/include + all dep includes
      const localIncDir = path.join(scriptingDir, 'include');
      const allIncludes = [];
      if (fs.existsSync(localIncDir)) allIncludes.push(`-i${localIncDir}`);
      for (const d of includeDirs) allIncludes.push(`-i${d}`);

      const result = spawnSync(compilerPath, [srcPath, `-o${outPath}`, ...allIncludes], {
        encoding: 'utf8',
        windowsHide: true,
      });

      if (result.status !== 0) {
        process.stdout.write('\n');
        logger.error(`Compiling ${path.basename(smaRel)} ... FAILED`);
        if (result.stderr) process.stderr.write(result.stderr);
        if (result.stdout) process.stderr.write(result.stdout);
        throw new Error(`Compilation failed: ${smaRel}`);
      }

      process.stdout.write(dots(path.basename(smaRel)) + chalk.green('OK') + '\n');

      compiled.push({
        amxxName:           outName,
        plugins_ini_postfix: repoConfig.plugins_ini_postfix,
        ini_comment:        null,
        repo:               repoConfig.repo,
        ref:                repoConfig._resolvedRef || repoConfig.ref || 'HEAD',
      });
    }
  }

  return compiled;
}

async function findExcluded(dir, patterns) {
  if (!patterns.length) return [];
  const all  = await glob('**/*.sma', { cwd: dir });
  const kept = new Set(await glob(['**/*.sma', ...patterns.map((e) => `!${e}`)], { cwd: dir }));
  return all.filter((f) => !kept.has(f)).map((f) => path.basename(f));
}

function dots(filename) {
  return ' ' + '.'.repeat(Math.max(1, 42 - filename.length)) + ' ';
}

module.exports = { compilePlugins };
