const fs   = require('fs');
const path = require('path');
const glob = require('fast-glob');
const logger = require('./logger');
const { parseDepsLines, resolveGithubToken } = require('./manifest');
const { fetchRepo, resolveRefIfLatest } = require('./repo-fetcher');
const { fetchReleaseDep } = require('./release-fetcher');
const { fetchFungunDep } = require('./fungun-fetcher');

/**
 * Resolves all deps, clones them, copies .inc files to build/_includes/,
 * and returns an array of include-dir paths to pass to the compiler (-i flags).
 *
 * Priority: manifest.globalDeps > repo.deps_override > DEPS_LIST file in repo root
 */
async function resolveDeps(manifest, repoLocalDirs, noFetch, buildDir) {
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
      const token = resolveGithubToken(manifest, dep.repo);
      srcDir = await fetchReleaseDep(dep, token, noFetch);
    } else if (dep.source === 'fungun') {
      srcDir = await fetchFungunDep(dep, noFetch);
    } else {
      const token = resolveGithubToken(manifest, dep.repo);
      const resolvedDepRef = await resolveRefIfLatest(dep.ref, dep.repo, token);
      const depDir = await fetchRepo(dep.repo, resolvedDepRef, token, noFetch, manifest.github.ssh);
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

    logger.dim(`  ${depLabel(dep)}: ${files.length} .inc files`);
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

// git-dep include-dir candidates — release archives keep their own list in
// release-fetcher (archive layout first); do not merge them.
const DEP_INCLUDE_CANDIDATES = ['scripting/include', 'amxmodx/scripting/include', 'include', '.'];

/**
 * Locate the include directory of a fetched git dep.
 * Canonical single source shared by deps-resolver.resolveIncludePath (build
 * pipeline: throws on a missing explicit include_path) and
 * include-tree.fetchDepIncludeDir (interfaces: silently falls back to the repo
 * root). `throwOnMissing` flips between those two policies.
 *
 * @param {string} repoDir - local cache dir of the dep repo
 * @param {string|null} explicitPath - dep.include_path or null (auto-search)
 * @param {object} [opts]
 * @param {boolean} [opts.throwOnMissing=false]
 * @param {string} [opts.repoName] - repo name for the throw message
 * @returns {string} include dir (repo root when nothing matches)
 */
function findDepIncludeDir(repoDir, explicitPath, { throwOnMissing = false, repoName } = {}) {
  if (explicitPath) {
    const full = path.join(repoDir, explicitPath);
    if (fs.existsSync(full)) return full;
    if (throwOnMissing) throw new Error(`Include path "${explicitPath}" not found in ${repoName}`);
    return repoDir;
  }
  for (const candidate of DEP_INCLUDE_CANDIDATES) {
    const full = path.join(repoDir, candidate);
    if (fs.existsSync(full)) return full;
  }
  return repoDir;
}

function resolveIncludePath(repoDir, explicitPath, repoName) {
  return findDepIncludeDir(repoDir, explicitPath, { throwOnMissing: true, repoName });
}

/**
 * Fetch a dependency's root directory and return a human-readable label for it.
 * Single source of truth shared by the build pipeline, the MCP server and
 * agent-assets resolution.
 *
 * `dep` is a parsed dep OBJECT ({ repo, ref, source, include_path, asset }).
 * GitHub token resolution (per-owner fallbacks) is an interface-layer concern —
 * callers pass the already-resolved token, this function never calls fallbackToken.
 *
 * @param {object} dep - parsed dep object
 * @param {object} [opts]
 * @param {string} [opts.token]     - GitHub token or null (anonymous)
 * @param {boolean} [opts.noFetch]  - only use cache, skip network fetches
 * @param {boolean} [opts.ssh]      - clone via system git instead of tarball
 * @returns {Promise<{ rootDir: string, label: string }>}
 */
async function fetchDepRoot(dep, { token, noFetch, ssh = false } = {}) {
  if (dep.source === 'release') {
    const dir = await fetchReleaseDep(dep, token, noFetch);
    return { rootDir: dir, label: `${dep.repo}@${dep.ref} (release)` };
  }

  if (dep.source === 'fungun') {
    const dir = await fetchFungunDep(dep, noFetch);
    return { rootDir: dir, label: depLabel(dep) };
  }

  const resolvedRef = await resolveRefIfLatest(dep.ref, dep.repo, token);
  const repoDir = await fetchRepo(dep.repo, resolvedRef, token, noFetch, ssh);
  if (dep.include_path) {
    const sub = path.join(repoDir, dep.include_path);
    if (!fs.existsSync(sub)) {
      throw new Error(`include_path "${dep.include_path}" not found in ${dep.repo}`);
    }
    return { rootDir: sub, label: `${dep.repo}@${dep.ref || 'default branch'}` };
  }
  return { rootDir: repoDir, label: `${dep.repo}@${dep.ref || 'default branch'}` };
}

/**
 * Fetch a dependency's include directory (release/fungun/git), using the
 * fetch cache where possible.
 * Canonical single-source-of-truth shared by the build pipeline (include-tree),
 * the CLI, the serve interface and the MCP layer.
 *
 * Explicit-include_path semantics: silently falls back to the repo root when
 * the given path does not exist (the interface callers rely on this).
 *
 * @param {object} dep - { repo, ref, include_path, source, asset }
 * @param {string|null} token - GitHub PAT (per-owner resolved by the caller)
 * @param {boolean} [noFetch=false] - only use cache, skip network
 * @param {boolean} [ssh=false] - clone via SSH
 * @returns {Promise<string>} directory to use as the include dir
 */
async function fetchDepIncludeDir(dep, token, noFetch, ssh = false) {
  if (dep.source === 'release') {
    return fetchReleaseDep(
      { repo: dep.repo, ref: dep.ref, include_path: dep.include_path, asset: dep.asset },
      token,
      noFetch
    );
  }

  if (dep.source === 'fungun') {
    return fetchFungunDep(dep, noFetch);
  }

  const resolvedRef = await resolveRefIfLatest(dep.ref, dep.repo, token);
  const repoDir = await fetchRepo(dep.repo, resolvedRef, token, noFetch, ssh);
  return findDepIncludeDir(repoDir, dep.include_path);
}

/**
 * Sequentially fetch the include dir of every manifest.globalDeps entry.
 * Canonical helper for the "collect dep include dirs" loops that the serve and
 * MCP interfaces previously copy-pasted. A failing dep never throws — it is
 * recorded in `errors` and iteration continues.
 *
 * Both returned arrays are index-parallel with manifest.globalDeps:
 * `dirs[i]` is dep i's include dir (or null on failure) and `errors[i]` is the
 * dep's error message (or null on success). Interface layers prefix their own
 * dep label (depLabel / repo@ref) onto the raw messages, preserving each
 * interface's existing formatting.
 *
 * GitHub tokens are resolved per-owner via resolveGithubToken(manifest, repo);
 * ssh must be passed explicitly by the caller (manifest.github.ssh).
 *
 * @param {object|null} manifest - parsed manifest (null → no deps)
 * @param {object} [opts]
 * @param {boolean} [opts.noFetch=false] - only use cache, skip network
 * @param {boolean} [opts.ssh=false] - clone via SSH
 * @returns {Promise<{ dirs: (string|null)[], errors: (string|null)[] }>}
 */
async function collectDepIncludeDirs(manifest, { noFetch = false, ssh = false } = {}) {
  const deps = (manifest && manifest.globalDeps) || [];
  const dirs = new Array(deps.length).fill(null);
  const errors = new Array(deps.length).fill(null);
  for (let i = 0; i < deps.length; i++) {
    const dep = deps[i];
    try {
      dirs[i] = await fetchDepIncludeDir(dep, resolveGithubToken(manifest, dep.repo), noFetch, ssh);
    } catch (err) {
      errors[i] = err && err.message ? err.message : String(err);
    }
  }
  return { dirs, errors };
}

// Single source of truth for repo-name normalization (used for cache keys
// and dedup by core modules that previously inlined repo.toLowerCase()).
function normalize(repo) { return repo.toLowerCase(); }

// Human-readable dep label (fungun deps: no repo@ref — addressed by shop page id).
function depLabel(dep) {
  if (dep && dep.source === 'fungun') {
    return `fungun.net plugin #${dep.id}`;
  }
  return `${dep.repo}@${dep.ref || 'default branch'}`;
}

function repoKey(repoConfig) {
  return `${repoConfig.repo}@${repoConfig._resolvedRef || repoConfig.ref || 'HEAD'}`;
}

// Case-insensitive identity of a manifest repo entry — two spellings of the
// same repo (Org/Plugin vs org/plugin) are the same source.
function normalizeRepo(repoConfig) {
  return `${normalize(repoConfig.repo)}@${repoConfig._resolvedRef || repoConfig.ref || 'HEAD'}`;
}

function shortName(repo)  { return repo.split('/').pop(); }

function countIncFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countIncFiles(path.join(dir, e.name));
    else if (e.name.endsWith('.inc')) n++;
  }
  return n;
}

module.exports = {
  resolveDeps, readDepsListFile, resolveIncludePath, normalize, normalizeRepo, repoKey, fetchDepRoot, depLabel,
  DEP_INCLUDE_CANDIDATES, findDepIncludeDir, fetchDepIncludeDir, collectDepIncludeDirs,
};
