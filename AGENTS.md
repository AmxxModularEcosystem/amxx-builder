# amxx-builder — AGENTS.md

## Overview
CLI + GitHub Action for building/packaging AMX Mod X servers from an `amxbuild.yml` manifest.
Entry: `index.js` (CLI via `commander`). Action: `action-entry.js` → synthesises `process.argv` → requires `index.js`.

## Tech
- Node.js 18+, pure **CommonJS** (`require`), no ESM.
- Only dev dep: `@vercel/ncc` for bundling the GitHub Action.
- No test framework, linter, or type checker configured.

## Commands
| Command | Description |
|---------|-------------|
| `amxb build` | Full build from `amxbuild.yml` |
| `amxb build --dry-run` | Show plan without executing |
| `amxb build --set key=value` | Override manifest fields (dot notation for nested, e.g. `output.archive_name=...`) |
| `amxb build --define DEBUG` | Add compiler define (appends to `amxmodx.defines`) |
| `amxb build --verbose` | Detailed per-file output |
| `amxb deploy` | Deploy `build/` to server path |
| `amxb deploy --build` | Build then deploy |
| `amxb watch` | Watch local files, incremental build+deploy |
| `amxb init` | Scaffold manifest and optional files |
| `amxb clean` | Clean build/ and clone cache |
| `amxb clean --all` | Also clean compiler cache |
| `amxb cache info` | Show cache contents |
| `npm start` | Alias for `node index.js` |

## Build order (matters)
1. Parse manifest (deep-merge with `defaults/amxbuild.defaults.yml`)
2. Fetch compiler (`amxxpc`, auto-resolves latest version)
3. Resolve refs + clone repos (deduped by `repo@resolved_ref`)
4. Resolve deps (git or release), collect `.inc` files
5. **Collect** — copy files from repos + local `amxmodx/` + local `assets/` into `build/`
6. Fetch remote assets (URLs, GitHub releases)
7. **Compile** — all `.sma` → `.amxx` in parallel (overwrites pre-built plugins in `build/`)
8. Generate `plugins-*.ini` into `build/amxmodx/configs/`
9. Archive → `.zip` or copy to output dir

## Manifest quirks
- **Arrays are replaced entirely** (repos, deps, assets.sources) — not merged with defaults.
- `version` **must be a quoted string** in YAML or parsing fails.
- `ref: latest` resolves to the latest GitHub release tag automatically.
- Plugin rules (`plugins:`) apply **only to local** `.sma` files, not repo plugins.
- Local `amxmodx/` always wins over repo files (intentional override layer, no conflict warning).
- `.sma` files ARE copied during collect (like any other file) and are also compiled; exclude them per-repo via `exclude_files` if sources should not ship.

## GitHub Action release flow
```bash
npm ci
npx ncc build action-entry.js -o dist --minify --license licenses.txt
# Commit dist/, update package.json version, push tags
```
This is automated in `.github/workflows/release.yml` on `v*.*.*` tags.

## MCP dep-resolver server
- Source: `mcp/dep-resolver.js` (reuses `src/repo-fetcher.js`, `src/release-fetcher.js`, `src/cache-dir.js`)
- Runs directly from source — no bundling needed (installed alongside main package)
- Started via `amxb mcp` (registered as subcommand in `src/cli.js` → `src/commands/mcp.js`)
- Uses a custom lightweight `McpServer` from `mcp/mcp-server.js` (no external SDK dependency)
- Register in any project's `.opencode/opencode.json` via `"command": ["amxb", "mcp"]`
- Exposes tools: `get_dep_interface`, `list_dep_incs`, `get_dep_tree`, `resolve_manifest`, `validate_manifest`, `get_cache_info`, `list_amxmodx_incs`, `get_amxmodx_include`, `resolve_include`, `list_releases`

## Cache
- Win: `%LOCALAPPDATA%\amxx-builder`, Unix: `~/.cache/amxx-builder`
- Override: `AMXX_BUILDER_CACHE`
- Local per-manifest asset cache: `.amxb-cache/` next to `amxbuild.yml`
- Separate dirs: `repos/`, `release-deps/`, `amxxpc/` (compiler binaries)

## Watch mode
- Uses `chokidar` + dep-graph (`src/dep-graph.js`).
- `.inc` change → recompile only plugins that `#include` it.
- `.sma` change → recompile that plugin, deploy + RCON.
- Manifest change → full rebuild.
- Non-sma/non-inc files → deploy directly if deploy path set.

## DEPS_LIST files
Repos can contain a `DEPS_LIST` file (one dep per line, `owner/repo@ref[:include_path]`).
Overridden by `deps_override` on that repo. Global `deps` in manifest win over everything.
