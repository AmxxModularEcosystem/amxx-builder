#!/usr/bin/env node
'use strict';

const { HANDLERS } = require('./handlers');

// Single source of truth for MCP tools: schemas, descriptions, handler wiring.
// Adding a tool = one entry here (+ its handler in handlers.js).

const TOOLS = [

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
              grep: {
                type: 'string',
                description:
                  'Optional substring (case-insensitive) to search for within include files. ' +
                  'When set, only matching lines with surrounding context are returned. ' +
                  'Use with `before` and `after` to control how many context lines to show.',
              },
              before: {
                type: 'number',
                description:
                  'Lines of context to show before each grep match. Default: 0.',
                default: 0,
              },
              after: {
                type: 'number',
                description:
                  'Lines of context to show after each grep match. Default: 0.',
                default: 0,
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
          name: 'list_amxmodx_incs',
          title: 'List standard AMX Mod X include files',
          description:
            'List available .inc files from the standard AMXX bundle (amxmodx.inc, ' +
            'core.inc, float.inc, etc.).\n\n' +
            'By default uses the version from amxbuild.yml (amxmodx.version), ' +
            'or the latest available compiler version if no manifest is found.\n\n' +
            'Supports optional glob pattern filtering.',
          inputSchema: {
            type: 'object',
            properties: {
              manifest: {
                type: 'string',
                description:
                  'Path to amxbuild.yml. If omitted, auto-detects in the working directory.',
              },
              version: {
                type: 'string',
                description:
                  'AMX Mod X version override (e.g. "1.10.5428"). ' +
                  'Default: from manifest amxmodx.version, or latest.',
              },
              pattern: {
                type: 'string',
                description:
                  'Glob pattern to filter include files. Example: "core.*" or "*.inc".',
                default: '*.inc',
              },
            },
          },
        },
        {
          name: 'get_amxmodx_include',
          title: 'Get standard AMX Mod X include file contents',
          description:
            'Download (if not cached) the AMXX compiler bundle and return the contents ' +
            'of standard .inc files — functions, constants, defines from the AMXX stdlib.\n\n' +
            'By default uses the version from amxbuild.yml (amxmodx.version), ' +
            'or the latest available compiler version if no manifest is found.\n\n' +
            'The `file` parameter supports glob patterns (e.g. "core.inc" or "cs*.inc"). ' +
            'Omit to return all standard includes.',
          inputSchema: {
            type: 'object',
            properties: {
              manifest: {
                type: 'string',
                description:
                  'Path to amxbuild.yml. If omitted, auto-detects in the working directory.',
              },
              version: {
                type: 'string',
                description:
                  'AMX Mod X version override (e.g. "1.10.5428"). ' +
                  'Default: from manifest amxmodx.version, or latest.',
              },
              file: {
                type: 'string',
                description:
                  'Include file name or glob pattern. Examples: "amxmodx.inc", "core.*", "*.inc". ' +
                  'Default: "*.inc" (all).',
                default: '*.inc',
              },
              grep: {
                type: 'string',
                description:
                  'Optional substring (case-insensitive) to search for within include files. ' +
                  'When set, only matching lines with surrounding context are returned. ' +
                  'Use with `before` and `after` to control how many context lines to show.',
              },
              before: {
                type: 'number',
                description:
                  'Lines of context to show before each grep match. Default: 0.',
                default: 0,
              },
              after: {
                type: 'number',
                description:
                  'Lines of context to show after each grep match. Default: 0.',
                default: 0,
              },
            },
          },
        },
        {
          name: 'resolve_include',
          title: 'Resolve an `#include` directive against stdlib and deps',
          description:
            'Resolve an AMXX preprocessor `#include` directive — find which file it ' +
            'refers to and return its contents.\n\n' +
            'Accepts:\n' +
            '  - `#include <file>` — global search (stdlib + deps)\n' +
            '  - `#include "file"` — local (sma dir) first, then global\n' +
            '  - `#include file`   — bare, equivalent to <>\n' +
            '  - The `#include` prefix is optional; just `<file>`, `"file"`, or `file` works.\n\n' +
            'Extension defaults to `.inc` if omitted. Case-sensitive first, ' +
            'then case-insensitive fallback.\n\n' +
             'Search order: sma dir (for `""`, via sma_file or cwd) → stdlib → manifest deps.',
          inputSchema: {
            type: 'object',
            properties: {
              directive: {
                type: 'string',
                description:
                  'The include directive to resolve. Examples:\n' +
                  '  "#include <amxmodx>"\n' +
                  '  "#include \\"ColorChat\\""\n' +
                  '  "#include file"\n' +
                  '  "<amxmodx>" or "amxmodx"',
              },
              sma_file: {
                type: 'string',
                description:
                  'Path to the .sma file containing the directive. ' +
                  'Optional — if omitted, uses the current working directory. ' +
                  'Useful when the include is declared in another include and ' +
                  'the originating .sma is unknown.',
              },
              manifest: {
                type: 'string',
                description:
                  'Path to amxbuild.yml. Optional — auto-detects amxbuild.yml / ' +
                  'amxbuild.yaml / manifest.yml in the working directory. ' +
                  'When found, searches manifest globalDeps for the include file.',
              },
              version: {
                type: 'string',
                description:
                  'AMX Mod X version override for stdlib lookup ' +
                  '(default: from manifest or latest).',
              },
              grep: {
                type: 'string',
                description:
                  'Optional substring (case-insensitive) to search for within the resolved include file. ' +
                  'When set, only matching lines with surrounding context are returned. ' +
                  'Use with `before` and `after` to control how many context lines to show.',
              },
              before: {
                type: 'number',
                description:
                  'Lines of context to show before each grep match. Default: 0.',
                default: 0,
              },
              after: {
                type: 'number',
                description:
                  'Lines of context to show after each grep match. Default: 0.',
                default: 0,
              },
            },
            required: ['directive'],
          },
        },
        {
          name: 'build_include_tree',
          title: 'Build #include dependency tree',
          description:
            'Build a bidirectional #include tree for an AMXX project. ' +
            'Parses all .sma files (local + repos), resolves #include directives, ' +
            'detects include guards, and returns a tree in the requested direction.\n\n' +
            'Direction:\n' +
            '  - "down" (default for .sma): show everything the target file #includes (transitively)\n' +
            '  - "up"   (default for .inc): show everything that #includes the target (transitively)\n' +
            '  - "both" or "auto": auto-select based on file extension\n\n' +
            'Include guards (#if defined … #endinput … #define) are detected and ' +
            'used to avoid re-expanding guarded files within the same compilation unit. ' +
            'The tree also tracks <angle> vs "quoted" include style and annotates ' +
            'each node with its origin (stdlib, dep, local, repo).',
          inputSchema: {
            type: 'object',
            properties: {
              file: {
                type: 'string',
                description:
                  'Path to the .sma or .inc file to build the tree from. ' +
                  'Required. Relative paths are resolved from the working directory.',
              },
              manifest: {
                type: 'string',
                description:
                  'Path to amxbuild.yml. Auto-detected if omitted ' +
                  '(searches for amxbuild.yml / amxbuild.yaml / manifest.yml in cwd).',
              },
              direction: {
                type: 'string',
                description:
                  '"down" — show includes (default for .sma)\n' +
                  '"up"   — show includers (default for .inc)\n' +
                  '"auto" — auto-detect from file extension',
                default: 'auto',
                enum: ['auto', 'down', 'up'],
              },
              depth: {
                type: 'number',
                description:
                  'Max tree depth (0 = unlimited). Useful for limiting large trees.',
                default: 0,
              },
              format: {
                type: 'string',
                description: 'Output format: "text" (tree with box-drawing) or "json".',
                default: 'text',
                enum: ['text', 'json'],
              },
              no_fetch: {
                type: 'boolean',
                description:
                  'If true, skip network fetches (compiler, repos, deps). ' +
                  'Only use what is already cached.',
                default: false,
              },
              token: {
                type: 'string',
                description: 'GitHub PAT. Falls back to GITHUB_TOKEN env var.',
              },
            },
            required: ['file'],
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
];

TOOLS.forEach((t) => {
  t.handler = HANDLERS[t.name];
  if (!t.inputSchema.properties) t.inputSchema.properties = {};
  t.inputSchema.properties.full_output = {
    type: 'boolean',
    description: 'Return the complete output, bypassing the default 200 KB / 50-file limits.',
    default: false,
  };
  const tok = t.inputSchema.properties.token;
  if (tok) {
    tok.description =
      'GitHub PAT override. Defaults to the GITHUB_TOKEN env var ' +
      '(the project .env is auto-loaded); env/manifest data is preferred.';
  }
});

function listTools() {
  return { tools: TOOLS.map(({ handler, ...def }) => def) };
}

async function callTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return {
      content: [{ type: 'text', text: 'Error: Unknown tool: ' + name }],
      isError: true,
      _meta: { code: -32601 },
    };
  }
  const token   = args?.token || process.env.GITHUB_TOKEN || null;
  const noFetch = args?.no_fetch === true;
  return tool.handler(args, token, noFetch);
}

module.exports = { TOOLS, listTools, callTool };
