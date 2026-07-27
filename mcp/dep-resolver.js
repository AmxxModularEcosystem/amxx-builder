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
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

// ─── Project modules ────────────────────────────────────────────────────────

const { fetchRepo, resolveRef } = require('../src/repo-fetcher');
const { fetchReleaseDep }       = require('../src/release-fetcher');
const { getCacheDir }           = require('../src/cache-dir');

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

const server = new Server(SERVER_INFO, {
  capabilities: {
    tools: {},
  },
});

// ─── Tool: list_dep_incs ────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
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
    ],
  };
});

// ─── Tool: get_dep_interface ─────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // Normalise token
    const token = args?.token || process.env.GITHUB_TOKEN || null;
    const noFetch = args?.no_fetch === true;

    // Build dep object
    let dep;
    try {
      dep = parseDep(args?.dep || args);
    } catch (parseErr) {
      return errorResult(parseErr.message);
    }

    // Merge explicit overrides from call arguments
    if (args?.source)         dep.source = args.source;
    if (args?.include_path)   dep.include_path = args.include_path;
    if (args?.asset != null)  dep.asset = args.asset;

    switch (name) {
      case 'get_dep_interface': {
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

// ─── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal MCP server error:', err);
  process.exit(1);
});
