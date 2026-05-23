const fs   = require('fs');
const path = require('path');
const glob = require('fast-glob');
const logger = require('./logger');
const { parseDepsLines } = require('./manifest');
const { fetchRepo } = require('./repo-fetcher');

/**
 * Resolves all deps for all repos, clones them, copies .inc files,
 * and returns an array of include-dir paths to pass to the compiler.
 *
 * Priority: manifest.globalDeps > repo.deps_override > DEPS_LIST file
 */
async function resolveDeps(manifest, noFetch, buildDir) {
  const token = manifest.github.token;

  // Merge all dep sources into a single map keyed by "owner/repo"
  // Lower priority entries are added first, higher priority overwrite
  const merged = new Map(); // key → { repo, ref, include_path, source }

  // Collect per-repo deps (lowest priority first)
  for (const repoConfig of manifest.repos) {
    const repoLocalDir = await fetchRepo(repoConfig.repo, repoConfig.ref, token, noFetch);

    let repoDeps;
    if (repoConfig.deps_override) {
      repoDeps = repoConfig.deps_override;
      logger.info(`Deps for ${shortName(repoConfig.repo)}: deps_override (${repoDeps.length} entries)`);
    } else {
      repoDeps = readDepsListFile(repoLocalDir, repoConfig.repo);
    }

    for (const dep of repoDeps) {
      const key = normalizeKey(dep.repo);
      if (!merged.has(key)) {
        merged.set(key, { ...dep, source: 'repo' });
      }
    }
  }

  // manifest.globalDeps win over everything
  for (const dep of manifest.globalDeps) {
    const key = normalizeKey(dep.repo);
    merged.set(key, { ...dep, source: 'manifest' });
  }

  logger.info(
    `Merged deps: ${merged.size} unique` +
    (countOverridden(manifest.globalDeps, merged) > 0
      ? ` (${countOverridden(manifest.globalDeps, merged)} overridden by manifest)`
      : '')
  );

  if (merged.size === 0) return [];

  const includesRoot = path.join(buildDir, '_includes');
  fs.mkdirSync(includesRoot, { recursive: true });

  const includeDirs = [];

  for (const [key, dep] of merged) {
    const depLocalDir = await fetchRepo(dep.repo, dep.ref, token, noFetch);
    const includeSourceDir = resolveIncludePath(depLocalDir, dep.include_path, dep.repo);

    const depIncludeDir = path.join(includesRoot, key.replace('/', '__'));
    fs.mkdirSync(depIncludeDir, { recursive: true });

    const incFiles = await glob('**/*.inc', {
      cwd: includeSourceDir,
      dot: false,
    });

    for (const f of incFiles) {
      const src  = path.join(includeSourceDir, f);
      const dest = path.join(depIncludeDir, f);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }

    logger.dim(`  ${dep.repo}@${dep.ref}: ${incFiles.length} .inc files`);
    includeDirs.push(depIncludeDir);
  }

  const totalInc = includeDirs.reduce((s, d) => {
    try { return s + countIncFiles(d); } catch { return s; }
  }, 0);
  logger.info(`Includes collected: ${totalInc} .inc files → build/_includes/`);

  return includeDirs;
}

function readDepsListFile(repoDir, repoName) {
  const depsFile = path.join(repoDir, 'DEPS_LIST');
  if (!fs.existsSync(depsFile)) {
    logger.dim(`  Deps for ${shortName(repoName)}: no DEPS_LIST file`);
    return [];
  }
  const lines  = fs.readFileSync(depsFile, 'utf8').split(/\r?\n/);
  const deps   = parseDepsLines(lines);
  logger.info(`Deps for ${shortName(repoName)}: DEPS_LIST found (${deps.length} entries)`);
  return deps;
}

function resolveIncludePath(repoDir, explicitPath, repoName) {
  if (explicitPath) {
    const full = path.join(repoDir, explicitPath);
    if (!fs.existsSync(full)) {
      throw new Error(`Include path "${explicitPath}" not found in ${repoName}`);
    }
    return full;
  }

  // Auto-detect: scripting/include/ → include/ → root
  for (const candidate of ['scripting/include', 'include', '.']) {
    const full = path.join(repoDir, candidate);
    if (fs.existsSync(full)) return full;
  }
  return repoDir;
}

function normalizeKey(repo) {
  return repo.toLowerCase();
}

function shortName(repo) {
  return repo.split('/').pop();
}

function countOverridden(globalDeps, merged) {
  return globalDeps.filter((d) => {
    const entry = merged.get(normalizeKey(d.repo));
    return entry && entry.source === 'manifest';
  }).length;
}

function countIncFiles(dir) {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countIncFiles(path.join(dir, entry.name));
    else if (entry.name.endsWith('.inc')) count++;
  }
  return count;
}

module.exports = { resolveDeps };
