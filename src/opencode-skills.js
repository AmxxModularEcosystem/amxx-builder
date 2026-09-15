'use strict';

/**
 * Materialize opencode-compatible skills (one `<slug>/SKILL.md` directory per
 * skill) from three sources into a cache container:
 *
 *   1. builder  — amxb's own bundled `skills/` (handled by `amxb skills-dir`).
 *   2. project  — the current project's own `amxbuild.yml` `skills:`.
 *   3. deps     — `manifest.globalDeps` + `manifest.repos`, each read from its
 *                 own manifest `skills:`.
 *
 * Interface-agnostic core: no stdout, no argv, no CLI rendering. The CLI
 * adapter (`src/commands/opencode-skills.js`) renders what this returns.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { collectLocalAssets, collectDepAssets } = require('./agent-assets');
const { getCacheDir } = require('./cache-dir');

/**
 * Lowercase, turn runs of non `[a-z0-9]` into `-`, collapse and trim dashes.
 *
 * @param {*} str
 * @returns {string}
 */
function slugify(str) {
  return String(str == null ? '' : str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Namespaced slug for a skill, unique across sources.
 *
 * - builder → `<name>`
 * - project → `project-<name>`
 * - dep/repo → `<owner>-<repo>-<name>`
 *
 * @param {{ source: string, owner?: string, repo?: string, name: string }} opts
 * @returns {string}
 */
function skillSlug({ source, owner, repo, name }) {
  if (source === 'builder') return slugify(name);
  if (source === 'project') return ['project', slugify(name)].filter(Boolean).join('-');
  return [slugify(owner), slugify(repo), slugify(name)].filter(Boolean).join('-');
}

/**
 * Build a `SKILL.md` body with YAML frontmatter `name` + `description`.
 *
 * A missing/blank description falls back to `<name> skill`; any newline in the
 * description is collapsed to a single space so the frontmatter stays valid.
 *
 * @param {{ name: string, description?: string|null, content?: string|null }} opts
 * @returns {string}
 */
function synthesizeSkillMd({ name, description, content }) {
  const rawDesc = description == null ? '' : String(description).trim();
  const safeName = String(name);
  const desc = (rawDesc === '' ? `${safeName} skill` : rawDesc)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const body = content == null ? '' : String(content);
  return `---\nname: ${safeName}\ndescription: ${desc}\n---\n\n${body}`;
}

function defaultSkillName(skill) {
  if (skill && skill.name) return skill.name;
  if (skill && skill.kind === 'file' && skill.file) return path.basename(skill.file, path.extname(skill.file));
  if (skill && skill.dir) return path.basename(skill.dir);
  return 'skill';
}

/**
 * Write one materialized skill directory per skill under `containerDir`.
 *
 * - `kind:'file'` → `mkdir -p <containerDir>/<slug>/SKILL.md` synthesized from
 *   the skill's manifest `name`/`description` and its `content`.
 * - `kind:'dir'`  → `fs.cpSync(skill.abs, <containerDir>/<slug>, {recursive})`;
 *   a `SKILL.md` is synthesized only when the copied directory lacks one (an
 *   authored one is preserved verbatim).
 *
 * Skills whose target directory already exists are skipped, so the same slug
 * is never materialized twice in a call.
 *
 * @param {Array<object>} skills - resolved skills (see src/agent-assets.js)
 * @param {string} containerDir - absolute container directory
 * @param {{ source: string, owner?: string, repo?: string }} origin
 * @returns {Array<{ slug: string, origin: string }>}
 */
function materializeSkills(skills, containerDir, { source, owner, repo } = {}) {
  const written = [];
  for (const skill of skills || []) {
    const name = defaultSkillName(skill);
    const slug = skillSlug({ source, owner, repo, name });
    const target = path.join(containerDir, slug);

    if (fs.existsSync(target)) continue;

    fs.mkdirSync(target, { recursive: true });

    if (skill.kind === 'dir' && skill.abs) {
      fs.cpSync(skill.abs, target, { recursive: true });

      if (!fs.existsSync(path.join(target, 'SKILL.md'))) {
        const listing = (skill.files || [])
          .map((f) => f && f.rel)
          .filter((rel) => rel && rel !== 'SKILL.md')
          .map((rel) => `references: ${rel}`)
          .join('\n');
        const md = synthesizeSkillMd({ name: slug, description: skill.description, content: listing });
        fs.writeFileSync(path.join(target, 'SKILL.md'), md, 'utf8');
      }
    } else {
      const md = synthesizeSkillMd({ name: slug, description: skill.description, content: skill.content });
      fs.writeFileSync(path.join(target, 'SKILL.md'), md, 'utf8');
    }

    written.push({ slug, origin: source });
  }
  return written;
}

/**
 * The current project's declared skills, with content.
 *
 * @param {object} manifest - parsed manifest
 * @returns {Array<object>}
 */
function collectProjectSkills(manifest) {
  return collectLocalAssets(manifest).skills;
}

/**
 * Collect skills from every direct dep and repo.
 *
 * Returns an array of `{ source, owner, repo, skills }`. The array also
 * carries an `errors` property: a per-source failure never throws — it
 * contributes nothing and its message is appended to `errors`.
 *
 * @param {object} manifest - parsed manifest
 * @param {object} [opts]
 * @param {boolean} [opts.noFetch]
 * @param {boolean} [opts.ssh]
 * @param {Function} [opts.tokenFor] - (repoPath) → token|null
 * @param {Function} [opts.fetchRoot] - test seam for fetchDepRoot
 * @returns {Array<{ source: string, owner: string, repo: string, skills: Array<object> }>}
 */
async function collectDepRepoSkills(manifest, { noFetch, ssh, tokenFor, fetchRoot } = {}) {
  const sources = [];
  const errors = [];

  const entries = [
    ...((manifest && manifest.globalDeps) || []).map((dep) => ({ dep, source: 'dep' })),
    ...((manifest && manifest.repos) || []).map((r) => ({
      dep: { repo: r.repo, ref: r.ref, source: r.source || 'git', include_path: null, asset: null, _localDir: r._localDir || null },
      source: 'repo',
    })),
  ];

  for (const { dep, source } of entries) {
    const [owner, repoName] = String(dep.repo || '').split('/');
    try {
      const res = await collectDepAssets(dep, {
        token: tokenFor ? tokenFor(dep.repo) : null,
        noFetch,
        ssh,
        fetchRoot,
      });
      if (res.skills.length > 0) {
        sources.push({
          source,
          owner: owner || '',
          repo: repoName || '',
          skills: res.skills,
        });
      }
    } catch (err) {
      errors.push(`${dep.repo}: ${err && err.message ? err.message : String(err)}`);
    }
  }

  sources.errors = errors;
  return sources;
}

/**
 * Materialize all three skill sources into a per-manifest container.
 *
 * The container is wiped and recreated on every call so no stale skills leak
 * between builds. Individual source failures are collected in `errors`.
 *
 * @param {object} manifest - parsed manifest (uses `manifest._path`)
 * @param {object} [opts]
 * @param {boolean} [opts.noFetch]
 * @param {boolean} [opts.ssh]
 * @param {Function} [opts.tokenFor]
 * @param {Function} [opts.fetchRoot]
 * @param {string} [opts.containerRoot] - override the container root dir
 * @returns {Promise<{ containerDir: string, count: number, errors: string[] }>}
 */
async function buildOpencodeSkills(manifest, opts = {}) {
  const { noFetch, ssh, tokenFor, fetchRoot } = opts;
  const root = opts.containerRoot || containerRoot();

  const key = crypto.createHash('sha1').update(String(manifest._path)).digest('hex').slice(0, 12);
  const containerDir = path.join(root, key);
  fs.rmSync(containerDir, { recursive: true, force: true });
  fs.mkdirSync(containerDir, { recursive: true });

  const errors = [];
  let count = 0;

  try {
    count += materializeSkills(collectProjectSkills(manifest), containerDir, { source: 'project' }).length;
  } catch (err) {
    errors.push(`project: ${err && err.message ? err.message : String(err)}`);
  }

  const depRepo = await collectDepRepoSkills(manifest, { noFetch, ssh, tokenFor, fetchRoot });
  errors.push(...depRepo.errors);

  for (const entry of depRepo) {
    try {
      count += materializeSkills(entry.skills, containerDir, {
        source: entry.source,
        owner: entry.owner,
        repo: entry.repo,
      }).length;
    } catch (err) {
      errors.push(`${entry.owner}/${entry.repo}: ${err && err.message ? err.message : String(err)}`);
    }
  }

  return { containerDir, count, errors };
}

/**
 * Absolute root directory that holds all per-manifest skill containers.
 *
 * @returns {string}
 */
function containerRoot() {
  return path.join(getCacheDir(), 'opencode-skills');
}

module.exports = {
  slugify,
  skillSlug,
  synthesizeSkillMd,
  materializeSkills,
  collectProjectSkills,
  collectDepRepoSkills,
  buildOpencodeSkills,
  containerRoot,
};
