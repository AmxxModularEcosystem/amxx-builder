const fs    = require('fs');
const path  = require('path');
const chalk = require('chalk');
const { spawnSync } = require('child_process');
const glob  = require('fast-glob');
const logger = require('./logger');

const PREFIX = chalk.bold.white('[amxx-builder]');

/**
 * Compiles all .sma files:
 *   - from <amxmodx_dir>/scripting/ of each remote repo
 *   - from local <amxmodx.dir>/scripting/ next to the manifest (local-only builds)
 * Output .amxx files go to build/amxmodx/plugins/.
 * Returns array of { amxxName, plugins_ini_postfix, ini_comment, repo, ref }.
 */
async function compilePlugins(manifest, repoLocalDirs, compilerPath, includeDirs, buildDir) {
  const pluginsDir = path.join(buildDir, 'amxmodx', 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });

  const compiled = [];

  // Build a unified list of sources: remote repos + local dir
  const sources = manifest.repos.map((repoConfig) => ({
    label:       repoConfig.repo,
    ref:         repoConfig._resolvedRef || repoConfig.ref || 'HEAD',
    scriptingDir: path.join(
      repoLocalDirs[`${repoConfig.repo}@${repoConfig._resolvedRef || repoConfig.ref || 'HEAD'}`],
      repoConfig.amxmodx_dir,
      'scripting'
    ),
    exclude:     repoConfig.exclude,
    postfix:     repoConfig.plugins_ini_postfix,
  }));

  // Local amxmodx/scripting/ next to manifest (always included)
  const localScriptingDir = path.join(path.dirname(manifest._path), manifest.amxmodx.dir, 'scripting');
  if (fs.existsSync(localScriptingDir)) {
    sources.push({
      label:        '(local)',
      ref:          'local',
      scriptingDir: localScriptingDir,
      exclude:      [],
      postfix:      manifest.globalPostfix,
    });
  }

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

    const localIncDir    = path.join(scriptingDir, 'include');
    const collectedIncDir = path.join(buildDir, 'amxmodx', 'scripting', 'include');
    const allIncludes = [];
    if (fs.existsSync(localIncDir))     allIncludes.push(`-i${localIncDir}`);
    if (fs.existsSync(collectedIncDir)) allIncludes.push(`-i${collectedIncDir}`);
    for (const d of includeDirs) allIncludes.push(`-i${d}`);

    for (const smaRel of smaFiles) {
      const srcPath = path.join(scriptingDir, smaRel);
      const outName = path.basename(smaRel, '.sma') + '.amxx';
      const outPath = path.join(pluginsDir, outName);

      process.stdout.write(`${PREFIX} Compiling ${path.basename(smaRel)} `);

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

      compiled.push({ amxxName: outName, plugins_ini_postfix: postfix, ini_comment: null, repo: label, ref });
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
