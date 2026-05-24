const fs   = require('fs');
const path = require('path');
const glob = require('fast-glob');
const logger = require('./logger');
const { parseDepsLines } = require('./manifest');
const { fetchRepo } = require('./repo-fetcher');
const { fetchReleaseDep } = require('./release-fetcher');

/**
 * Resolves all deps, clones them, copies .inc files to build/_includes/,
 * and returns an array of include-dir paths to pass to the compiler (-i flags).
 *
 * Priority: manifest.globalDeps > repo.deps_override > DEPS_LIST file in repo root
 */
async function resolveDeps(manifest, repoLocalDirs, noFetch, buildDir) {
  const token  = manifest.github.token;
  const merged = new Map(); // normalised "owner/repo" → dep entry

  // Add repo-level deps first (lowest priority)
  for (const repoConfig of manifest.repos) {
    const localDir = repoLocalDirs[repoKey(repoConfig)];
    let repoDeps;

    if (repoConfig.deps_override) {
      repoDeps = repoConfig.deps_override;
      logger.info(`Deps for ${shortName(repoConfig.repo)}: deps_override (${repoDeps.length} entries)`);
    } else {
      repoDeps = readDepsListFile(localDir, repoConfig.repo);
    }

    for (const dep of repoDeps) {
      const k = normalize(dep.repo);
      if (!merged.has(k)) merged.set(k, { ...dep, _from: 'repo' });
    }
  }

  // manifest.globalDeps win over everything
  for (const dep of manifest.globalDeps) {
    merged.set(normalize(dep.repo), { ...dep, _from: 'manifest' });
  }

  if (merged.size === 0) return [];

  const overridden = [...merged.values()].filter((d) => d._from === 'manifest').length;
  logger.info(
    `Merged deps: ${merged.size} unique` +
    (overridden ? ` (${overridden} overridden by manifest)` : '')
  );

  const includesRoot = path.join(buildDir, '_includes');
  fs.mkdirSync(includesRoot, { recursive: true });

  const includeDirs = [];

  for (const [k, dep] of merged) {
    let srcDir;
    if (dep.source === 'release') {
      srcDir = await fetchReleaseDep(dep, token, noFetch);
    } else {
      const depDir = await fetchRepo(dep.repo, dep.ref, token, noFetch, manifest.github.ssh);
      srcDir = resolveIncludePath(depDir, dep.include_path, dep.repo);
    }

    const destDir = path.join(includesRoot, k.replace('/', '__'));
    fs.mkdirSync(destDir, { recursive: true });

    const files = await glob('**/*.inc', { cwd: srcDir, dot: false });
    for (const f of files) {
      const dest = path.join(destDir, f);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(srcDir, f), dest);
    }

    logger.dim(`  ${dep.repo}@${dep.ref}: ${files.length} .inc files`);
    includeDirs.push(destDir);
  }

  const total = includeDirs.reduce((s, d) => s + countIncFiles(d), 0);
  logger.info(`Includes collected: ${total} .inc files → build/_includes/`);

  return includeDirs;
}

function readDepsListFile(repoDir, repoName) {
  const p = path.join(repoDir, 'DEPS_LIST');
  if (!fs.existsSync(p)) {
    logger.dim(`  Deps for ${shortName(repoName)}: no DEPS_LIST file`);
    return [];
  }
  const deps = parseDepsLines(fs.readFileSync(p, 'utf8').split(/\r?\n/));
  logger.info(`Deps for ${shortName(repoName)}: DEPS_LIST found (${deps.length} entries)`);
  return deps;
}

function resolveIncludePath(repoDir, explicitPath, repoName) {
  if (explicitPath) {
    const full = path.join(repoDir, explicitPath);
    if (!fs.existsSync(full)) throw new Error(`Include path "${explicitPath}" not found in ${repoName}`);
    return full;
  }
  for (const candidate of ['scripting/include', 'amxmodx/scripting/include', 'include', '.']) {
    const full = path.join(repoDir, candidate);
    if (fs.existsSync(full)) return full;
  }
  return repoDir;
}

function repoKey(repoConfig) {
  return `${repoConfig.repo}@${repoConfig._resolvedRef || repoConfig.ref || 'HEAD'}`;
}

function normalize(repo) { return repo.toLowerCase(); }
function shortName(repo)  { return repo.split('/').pop(); }

function countIncFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countIncFiles(path.join(dir, e.name));
    else if (e.name.endsWith('.inc')) n++;
  }
  return n;
}

module.exports = { resolveDeps };
