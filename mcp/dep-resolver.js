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
 *       "command": ["amxx-dep-resolver"],
 *       "enabled": true
 *     }
 *   }
 */

const { McpServer } = require('./mcp-server');
const { callTool }   = require('./handlers');

const SERVER_INFO = {
  name:    'amxx-dep-resolver',
  version: '1.0.0',
};

const server = new McpServer(SERVER_INFO, { tools: {} });

// ─── Tool schemas ──────────────────────────────────────────────────────────────

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
              description: 'GitHub PAT. Falls back to GITHUB_TOKEN env var.',
            },
          },
          required: ['repo'],
        },
      },
    ],
  };
});

// ─── Tool call dispatcher ──────────────────────────────────────────────────────

server.setRequestHandler('CallTool', async (request) => {
  const { name, arguments: args } = request.params;

  try {
    return await callTool(name, args);
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message || String(err)}` }],
      isError: true,
    };
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────────

async function main() {
  await server.connect();
}

main().catch((err) => {
  console.error('Fatal MCP server error:', err);
  process.exit(1);
});
