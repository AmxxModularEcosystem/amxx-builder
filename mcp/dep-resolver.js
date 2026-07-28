#!/usr/bin/env node
'use strict';

/**
 * MCP server: AMXX Dependency Interface Resolver
 *
 * Provides tools for the opencode agent to fetch and inspect .inc files
 * from AMX Mod X dependencies (git repos or GitHub release assets).
 *
 * Tools:
 *   - get_dep_interface  → fetch dep, return .inc file contents
 *   - list_dep_incs      → list available .inc files without reading them
 *
 * Register in opencode.json:
 *   "mcp": {
 *     "amxx-dep-resolver": {
 *       "type": "local",
 *       "command": ["node", "mcp/dep-resolver.js"],
 *       "enabled": true
 *     }
 *   }
 */

const fs   = require('fs');
const path = require('path');
const glob = require('fast-glob');
const { McpServer } = require('./mcp-server');

// ─── Project modules ────────────────────────────────────────────────────────

const { fetchRepo, resolveRef } = require('../src/repo-fetcher');
const { fetchReleaseDep }       = require('../src/release-fetcher');
const { getCacheDir }           = require('../src/cache-dir');
const { buildDepTree }          = require('../src/deps-tree');
const { parseManifest, parseDepsLines, resolveManifest } = require('../src/manifest');
const { validateManifestFile }  = require('../src/validate');
const { getCacheInfo }          = require('../src/cache-info');
const { listReleases, listTags } = require('../src/release-lister');

// ─── Dep parsing ─────────────────────────────────────────────────────────────

/**
 * Parse a dep entry from user input.
 * Accepts:
 *   - string: "owner/repo@ref" or "owner/repo@ref:include_path"
 *   - object: { repo, ref, source?, include_path?, asset? }
 *
 * Returns a normalised dep object consumable by repo-fetcher / release-fetcher.
 */
function parseDep(raw) {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    const match = trimmed.match(/^([^@\s]+)@([^:\s]+)(?::(.+))?$/);
    if (!match) {
      throw new Error(
        `Invalid dep string: "${trimmed}". Expected format: "owner/repo@ref" or "owner/repo@ref:include_path"`
      );
    }
    const [, repo, ref, includePath] = match;
    return {
      repo:         repo.trim(),
      ref:          ref.trim(),
      include_path: includePath ? includePath.trim() : null,
      source:       'git',
      asset:        null,
    };
  }

  if (raw && typeof raw === 'object') {
    if (!raw.repo || !raw.ref) {
      throw new Error('Dep object must include both "repo" and "ref" fields');
    }
    const source = raw.source || 'git';
    if (!['git', 'release'].includes(source)) {
      throw new Error(`Dep source must be "git" or "release", got "${source}"`);
    }
    return {
      repo:         String(raw.repo).trim(),
      ref:          String(raw.ref).trim(),
      include_path: raw.include_path ? String(raw.include_path).trim() : null,
      source,
      asset:        raw.asset != null ? raw.asset : null,
    };
  }

  throw new Error('Dep must be a string or an object');
}

/**
 * Resolve a "latest" ref to the actual release tag.
 * Delegates to repo-fetcher's resolveRef (GitHub API).
 */
async function resolveDepRef(dep, token) {
  if (dep.ref !== 'latest') return dep.ref;
  return resolveRef(dep.repo, dep.ref, token);
}

/**
 * Fetch a dependency and return the directory containing its .inc files.
 */
async function fetchDepIncludeDir(dep, token, noFetch) {
  if (dep.source === 'release') {
    return fetchReleaseDep(
      { repo: dep.repo, ref: dep.ref, include_path: dep.include_path, asset: dep.asset },
      token,
      noFetch
    );
  }

  const repoDir = await fetchRepo(dep.repo, dep.ref, token, noFetch, false);

  // Try to locate the include directory
  const candidates = dep.include_path
    ? [dep.include_path]
    : ['scripting/include', 'amxmodx/scripting/include', 'include', '.'];

  for (const candidate of candidates) {
    const full = path.join(repoDir, candidate);
    if (fs.existsSync(full)) return full;
  }

  return repoDir;
}

/**
 * Collect .inc files from a directory, returning relative path → full path.
 */
async function collectIncFiles(srcDir) {
  const entries = await glob('**/*.inc', { cwd: srcDir, dot: false });
  entries.sort();
  return entries.map((rel) => ({
    rel,
    abs: path.join(srcDir, rel),
  }));
}

/**
 * Read a file, returning content as a string. Handles binary gracefully.
 */
function readFileSafe(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
    // Try UTF-8; if that fails, return base64
    try {
      const text = buf.toString('utf8');
      // Check for null bytes → likely binary
      if (text.includes('\u0000')) {
        return `[binary file, ${buf.length} bytes]`;
      }
      return text;
    } catch (_) {
      return `[binary file, ${buf.length} bytes]`;
    }
  } catch (err) {
    return `[error reading file: ${err.message}]`;
  }
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const SERVER_INFO = {
  name:    'amxx-dep-resolver',
  version: '1.0.0',
};

const server = new McpServer(SERVER_INFO, {
  tools: {},
});

// ─── Tool: list_dep_incs ────────────────────────────────────────────────────

server.setRequestHandler('ListTools', async () => {
  return {
    tools: [
      {
        name: 'get_dep_interface',
        title: 'Get dependency public interface',
        description:
          'Download (if not cached) an AMXX dependency from a deps entry and return the ' +
          'full contents of all its .inc files. Use this to understand the public API, ' +
          'functions, constants, and defines that a dependency exposes.\n\n' +
          'Supports:\n' +
          '  - git deps: "owner/repo@ref" or "owner/repo@ref:include_path"\n' +
          '  - release deps: { repo, ref, source: "release", include_path?, asset? }\n\n' +
          'Results are cached in the same cache directory as amxb build (~/.cache/amxx-builder/).',
        inputSchema: {
          type: 'object',
          properties: {
            dep: {
              type: 'string',
              description:
                'Dependency string in format "owner/repo@ref" or "owner/repo@ref:include_path". ' +
                'Examples:\n' +
                '  "AmxxModularEcosystem/ParamsController@1.4.0"\n' +
                '  "Next21Team/AmxxEasyHttp@1.4.0:amxx/scripting/include"\n' +
                '  "rehlds/ReAPI@5.29.0.358"',
            },
            source: {
              type: 'string',
              description: 'Fetch method: "git" (clone repo) or "release" (download release asset)',
              default: 'git',
              enum: ['git', 'release'],
            },
            include_path: {
              type: 'string',
              description:
                'Override the path inside the repo/asset where .inc files are located. ' +
                'Auto-detected: scripting/include → amxmodx/scripting/include → include → root',
            },
            asset: {
              description:
                'For source=release: which release asset to download. ' +
                'Can be a glob pattern like "*-include*.zip" or an index number.',
            },
            token: {
              type: 'string',
              description:
                'GitHub Personal Access Token for private repos. ' +
                'Falls back to GITHUB_TOKEN env var if not provided.',
            },
            no_fetch: {
              type: 'boolean',
              description:
                'If true, only return results from cache without fetching. ' +
                'Throws if the dep is not cached.',
              default: false,
            },
          },
          required: ['dep'],
        },
      },
      {
        name: 'list_dep_incs',
        title: 'List dependency .inc files',
        description:
          'Download (if not cached) an AMXX dependency and list available .inc files ' +
          'without reading their contents. Faster than get_dep_interface when you only ' +
          'need to know what files exist.',
        inputSchema: {
          type: 'object',
          properties: {
            dep: {
              type: 'string',
              description:
                'Dependency string in format "owner/repo@ref" or "owner/repo@ref:include_path".',
            },
            source: {
              type: 'string',
              description: 'Fetch method: "git" or "release"',
              default: 'git',
              enum: ['git', 'release'],
            },
            include_path: {
              type: 'string',
              description: 'Override include path inside the repo/asset.',
            },
            asset: {
              description:
                'For source=release: asset selector (glob pattern or index).',
            },
            token: {
              type: 'string',
              description: 'GitHub PAT. Falls back to GITHUB_TOKEN env var.',
            },
            no_fetch: {
              type: 'boolean',
              description: 'Only use cache, skip network fetch.',
              default: false,
            },
          },
          required: ['dep'],
        },
      },
      {
        name: 'get_dep_tree',
        title: 'Get recursive dependency tree',
        description:
          'Build a recursive dependency tree starting from root deps or a manifest. ' +
          'Walks each dependency, clones the repo, reads its DEPS_LIST, and recurses ' +
          'into sub-dependencies. Detects cycles and handles deps_override.\n\n' +
          'Provide either "manifest" (path to amxbuild.yml) or "deps" (array of dep entries).\n\n' +
          'Each dep entry can be a string ("owner/repo@ref") or an object ' +
          '({ repo, ref, source?, include_path?, asset? }).',
        inputSchema: {
          type: 'object',
          properties: {
            manifest: {
              type: 'string',
              description:
                'Path to amxbuild.yml. When provided, root deps are extracted from ' +
                'manifest repos and global deps. deps_override is respected.',
            },
            deps: {
              type: 'array',
              description:
                'Array of dep entries (strings or objects). Alternative to manifest. ' +
                'Example: ["owner/repo@ref"] or [{ repo: "owner/repo", ref: "v1", source: "git" }].',
              items: {
                oneOf: [
                  { type: 'string' },
                  {
                    type: 'object',
                    properties: {
                      repo:  { type: 'string' },
                      ref:   { type: 'string' },
                      source: { type: 'string', enum: ['git', 'release'] },
                      include_path: { type: 'string' },
                      asset: { oneOf: [{ type: 'string' }, { type: 'number' }] },
                    },
                    required: ['repo', 'ref'],
                  },
                ],
              },
            },
            depth: {
              type: 'number',
              description: 'Max recursion depth (0 = unlimited). Default: 0.',
              default: 0,
            },
            token: {
              type: 'string',
              description:
                'GitHub Personal Access Token for private repos. ' +
                'Falls back to GITHUB_TOKEN env var if not provided.',
            },
            no_fetch: {
              type: 'boolean',
              description: 'Only use cache, skip network fetch.',
              default: false,
            },
          },
          oneOf: [
            { required: ['manifest'] },
            { required: ['deps'] },
          ],
        },
      },
      {
        name: 'resolve_manifest',
        title: 'Resolve manifest with all overrides',
        description:
          'Parse an amxbuild.yml, merge with defaults, validate against schema, ' +
          'and apply --set/--define overrides. Returns the fully resolved manifest object.\n\n' +
          'If manifest is not provided, auto-detects amxbuild.yml in the working directory.',
        inputSchema: {
          type: 'object',
          properties: {
            manifest: {
              type: 'string',
              description:
                'Path to amxbuild.yml. If omitted, looks for amxbuild.yml / amxbuild.yaml / ' +
                'manifest.yml in the current working directory.',
            },
            set: {
              type: 'array',
              description:
                'Override manifest fields via dot notation, e.g. ["version=1.2", "output.pack=false"].',
              items: { type: 'string' },
            },
            define: {
              type: 'array',
              description:
                'Compiler defines to add, e.g. ["DEBUG", "VERSION=1.2"]. ' +
                'Appended to amxmodx.defines.',
              items: { type: 'string' },
            },
          },
        },
      },
      {
        name: 'validate_manifest',
        title: 'Validate manifest',
        description:
          'Validate an amxbuild.yml against the schema and return structured diagnostics ' +
          '(errors and warnings) as data. Never throws — inspect the result.\n\n' +
          'If manifest is not provided, auto-detects amxbuild.yml in the working directory.',
        inputSchema: {
          type: 'object',
          properties: {
            manifest: {
              type: 'string',
              description:
                'Path to amxbuild.yml. If omitted, looks for amxbuild.yml / amxbuild.yaml / ' +
                'manifest.yml in the current working directory.',
            },
          },
        },
      },
      {
        name: 'get_cache_info',
        title: 'Get cache information',
        description:
          'Show contents of the local build cache (~/.cache/amxx-builder). ' +
          'Includes cached compiler binaries, repo clones, release dependencies, ' +
          'and optional local asset cache for a given manifest.\n\n' +
          'If manifest is provided, also checks local .amxb-cache/ for asset cache info.',
        inputSchema: {
          type: 'object',
          properties: {
            manifest: {
              type: 'string',
              description:
                'Optional path to manifest to also check local .amxb-cache/ assets.',
            },
          },
        },
      },
      {
        name: 'list_releases',
        title: 'List GitHub releases or tags for a repository',
        description:
          'Get the list of releases (or git tags) for a GitHub repository. ' +
          'Useful for discovering available versions of a dependency.\n\n' +
          'By default returns releases. Use tags=true to list git tags instead ' +
          '(useful for repos that do not publish GitHub Releases).',
        inputSchema: {
          type: 'object',
          properties: {
            repo: {
              type: 'string',
              description: 'Repository in format "owner/repo", e.g. "AmxxModularEcosystem/ParamsController"',
            },
            limit: {
              type: 'number',
              description: 'Max results to return (default: 10).',
              default: 10,
            },
            includeAssets: {
              type: 'boolean',
              description: 'Include asset details (name, size, download count) per release.',
              default: false,
            },
            tags: {
              type: 'boolean',
              description: 'List git tags instead of releases.',
              default: false,
            },
            token: {
              type: 'string',
              description:
                'GitHub PAT. Falls back to GITHUB_TOKEN env var.',
            },
          },
          required: ['repo'],
        },
      },
    ],
  };
});

// ─── Tool: get_dep_interface ─────────────────────────────────────────────────

server.setRequestHandler('CallTool', async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // Normalise token (shared by all tools)
    const token = args?.token || process.env.GITHUB_TOKEN || null;
    const noFetch = args?.no_fetch === true;

    switch (name) {
      case 'get_dep_interface': {
        let dep;
        try {
          dep = parseDep(args?.dep || args);
        } catch (parseErr) {
          return errorResult(parseErr.message);
        }
        if (args?.source)         dep.source = args.source;
        if (args?.include_path)   dep.include_path = args.include_path;
        if (args?.asset != null)  dep.asset = args.asset;

        const resolvedRef = await resolveDepRef(dep, token);
        const srcDir      = await fetchDepIncludeDir(dep, token, noFetch);
        const incFiles    = await collectIncFiles(srcDir);

        if (incFiles.length === 0) {
          return textResult(
            `Dependency ${dep.repo}@${resolvedRef} has no .inc files in its include path.`
          );
        }

        const files = incFiles.map((f) => ({
          path: f.rel,
          content: readFileSafe(f.abs),
        }));

        return textResult(
          `Found ${files.length} .inc file(s) in ${dep.repo}@${resolvedRef}:\n\n` +
          files
            .map(
              (f) =>
                `──── ${f.path} ────\n${f.content}${
                  f.content.endsWith('\n') ? '' : '\n'
                }`
            )
            .join('\n')
        );
      }

      case 'list_dep_incs': {
        let dep;
        try {
          dep = parseDep(args?.dep || args);
        } catch (parseErr) {
          return errorResult(parseErr.message);
        }
        if (args?.source)         dep.source = args.source;
        if (args?.include_path)   dep.include_path = args.include_path;
        if (args?.asset != null)  dep.asset = args.asset;

        const resolvedRef = await resolveDepRef(dep, token);
        const srcDir      = await fetchDepIncludeDir(dep, token, noFetch);
        const incFiles    = await collectIncFiles(srcDir);

        if (incFiles.length === 0) {
          return textResult(
            `Dependency ${dep.repo}@${resolvedRef} has no .inc files in its include path.`
          );
        }

        const listing = incFiles
          .map((f) => `  ${f.rel}`)
          .join('\n');

        return textResult(
          `Dependency ${dep.repo}@${resolvedRef} — ${incFiles.length} .inc file(s):\n\n${listing}`
        );
      }

      case 'get_dep_tree': {
        const depth = args?.depth || 0;
        let rootDeps;
        let getDepsOverride = null;

        if (args?.manifest) {
          // ── From manifest ────────────────────────────────────────────
          const manifest = parseManifest(path.resolve(args.manifest));
          rootDeps = [];

          for (const repoConfig of manifest.repos) {
            rootDeps.push({ repo: repoConfig.repo, ref: repoConfig.ref });
          }
          for (const d of manifest.globalDeps) {
            rootDeps.push({ ...d });
          }

          getDepsOverride = (repo) => {
            const config = manifest.repos.find(r => r.repo === repo);
            return config ? config.deps_override : null;
          };
        } else if (args?.deps) {
          // ── From inline deps ─────────────────────────────────────────
          rootDeps = args.deps.map((entry) => {
            if (typeof entry === 'string') {
              const parsed = parseDep(entry);
              return { repo: parsed.repo, ref: parsed.ref, source: parsed.source, include_path: parsed.include_path, asset: parsed.asset };
            }
            return { repo: entry.repo, ref: entry.ref, source: entry.source || 'git', include_path: entry.include_path || null, asset: entry.asset != null ? entry.asset : null };
          });
        } else {
          return errorResult('Provide either "manifest" or "deps"', -32602);
        }

        const tree = await buildDepTree(rootDeps, {
          token,
          noFetch,
          depth,
          from: args?.manifest ? 'manifest' : 'user',
          getDepsOverride,
        });

        return textResult(JSON.stringify(tree, null, 2));
      }

      case 'resolve_manifest': {
        const manifestPath = resolveManifestPath(args?.manifest);
        const fullPath = path.resolve(manifestPath);
        require('dotenv').config({ path: path.join(path.dirname(fullPath), '.env'), override: true });

        const manifest = resolveManifest(fullPath, {
          set:    args?.set,
          define: args?.define,
        });

        return textResult(JSON.stringify(manifest, null, 2));
      }

      case 'validate_manifest': {
        const manifestPath = resolveManifestPath(args?.manifest);
        const result = validateManifestFile(manifestPath);
        return textResult(JSON.stringify(result, null, 2));
      }

      case 'get_cache_info': {
        const manifestPath = args?.manifest ? path.resolve(args.manifest) : undefined;
        const info = getCacheInfo(manifestPath);
        return textResult(JSON.stringify(info, null, 2));
      }

      case 'list_releases': {
        if (!args?.repo) return errorResult('Missing required "repo" field', -32602);
        const token = args?.token || process.env.GITHUB_TOKEN || null;
        const limit = args?.limit || 10;

        let entries;
        if (args?.tags) {
          entries = await listTags(args.repo, { token, limit });
        } else {
          entries = await listReleases(args.repo, { token, limit, includeAssets: args?.includeAssets });
        }

        return textResult(JSON.stringify(entries, null, 2));
      }

      default:
        return errorResult(`Unknown tool: ${name}`, -32601);
    }
  } catch (err) {
    return errorResult(err.message || String(err));
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function textResult(text) {
  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
  };
}

function errorResult(message, code = -32603) {
  return {
    content: [
      {
        type: 'text',
        text: `Error: ${message}`,
      },
    ],
    isError: true,
    _meta: code ? { code } : undefined,
  };
}

function resolveManifestPath(explicit) {
  if (explicit) return explicit;
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'amxbuild.yml')))  return path.join(cwd, 'amxbuild.yml');
  if (fs.existsSync(path.join(cwd, 'amxbuild.yaml'))) return path.join(cwd, 'amxbuild.yaml');
  if (fs.existsSync(path.join(cwd, 'manifest.yml')))  return path.join(cwd, 'manifest.yml');
  return path.join(cwd, 'amxbuild.yml'); // will fail with a clear error in parseManifest
}

// ─── Start ───────────────────────────────────────────────────────────────────

async function main() {
  await server.connect();
}

main().catch((err) => {
  console.error('Fatal MCP server error:', err);
  process.exit(1);
});
