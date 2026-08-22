# amxx-builder — AGENTS.md

## Overview
CLI + GitHub Action for building/packaging AMX Mod X servers from an `amxbuild.yml` manifest.
Entry: `index.js` (CLI via `commander`). Action: `action-entry.js` → synthesises `process.argv` → requires `index.js`.

## Tech
- Node.js 18+, pure **CommonJS** (`require`), no ESM. Exception: `action-entry.js` uses `import * as core from '@actions/core'` because `@actions/core@3.x` is ESM-only — esbuild transpiles it to CJS in the bundle. Do not "fix" that import back to `require`, it fails to resolve.
- **Node 18+ is a deliberate, genuinely minimal floor.** Write code that works on Node 18 — do not use newer-version-only APIs (stable `node:test` features, `fetch`, `AbortSignal.timeout`, …) unless they exist in 18. If a feature truly requires a newer Node, propose raising the minimum in the PR/discussion first; right now there is no practical benefit in raising it (no feature pressure, no dependency forcing it), and a raised floor would only cut off users stuck on 18. CI tests the matrix 18/24 (floor + newest) to keep this honest.
- Only dev dep: `esbuild` for bundling the GitHub Action.
- Tests: `node --test` (built-in node:test, zero deps; discovers `test/*.test.js` automatically — keep fixtures out of `test/`). No linter or type checker configured.

## Architecture: logic lives once in the core
- All business logic MUST live in `src/` (the core) and be interface-agnostic: no `process.argv`, no `process.stdout` writes, no `commander`, no JSON-RPC/MCP schemas, no CLI rendering.
- Interfaces are thin adapters that map params → core calls and render core events → their output format.
  - Current interfaces: CLI (`src/commands/`), MCP (`mcp/`), serve (JSON-RPC over stdio).
  - **serve** — started via `amxb serve`; uses `src/jsonrpc-transport.js` (generic JSON-RPC 2.0 over stdio, lives in core); methods are thin wrappers over core calls (`manifest.validate`, `build.start`, `include.resolve`, …); build progress is pushed as notifications (`build.stage` / `build.compiled` / `build.done` / `build.error`).
  - Repo fetching (`source: git`) downloads GitHub tarballs (codeload) instead of `git clone`; system git is only required when `github.ssh: true`.
- **Never copy a core function into an interface layer.** If two interfaces need the same behavior, it belongs in `src/` — refactor it there instead of duplicating.
- Interfaces must not do their own resolution/parsing: reuse the core single-source-of-truth helpers instead of reimplementing them. Known ones:
  - Include-path candidate lists (`['scripting/include', 'amxmodx/scripting/include', 'include', '.']`) — single source: `src/deps-resolver.js` (`resolveIncludePath`)
  - Dep string parsing (`owner/repo@ref[:include_path]`) — single source: `src/manifest.js` (`parseDepsLines`)
  - GitHub token resolution — `src/manifest.js` (`resolveGithubToken`); repo key / normalization — `src/deps-resolver.js` (`repoKey`, `normalize`)
- When touching an interface layer, check whether the logic already exists in `src/` before writing new code. New core exports are cheap; new duplication is debt.

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
| `amxb init --script` | Also create `build.bat` / `build.sh` quick-build scripts |
| `amxb clean` | Clean build/ and clone cache |
| `amxb clean --all` | Also clean compiler cache |
| `amxb cache info` | Show cache contents |
| `amxb serve` | Start JSON-RPC server for editor integration (stdio transport) |
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
npm run bundle   # esbuild action-entry.js → dist/index.js + scripts/gen-licenses.js → dist/licenses.txt
node scripts/smoke-test.js   # runs the bundled action with INPUT_* env, asserts GITHUB_OUTPUT name output
# Commit dist/, update package.json version, push tags, publish to npm (idempotent: re-runs are no-ops)
```
This is automated in `.github/workflows/release.yml` on `v*.*.*` tags.

## MCP dep-resolver server
- Source: `mcp/dep-resolver.js` (reuses `src/repo-fetcher.js`, `src/release-fetcher.js`, `src/cache-dir.js`)
- Runs directly from source — no bundling needed (installed alongside main package)
- Started via `amxb mcp` (registered as subcommand in `src/cli.js` → `src/commands/mcp.js`)
- Uses a custom lightweight `McpServer` from `mcp/mcp-server.js` (no external SDK dependency)
- Register in any project's `.opencode/opencode.json` via `"command": ["amxb", "mcp"]`
- Exposes tools: `get_dep_interface`, `list_dep_incs`, `get_dep_tree`, `resolve_manifest`, `validate_manifest`, `get_cache_info`, `list_amxmodx_incs`, `get_amxmodx_include`, `resolve_include`, `list_releases`

## Serve (JSON-RPC)
- Source: `src/commands/serve.js` — thin adapter; transport: `src/jsonrpc-transport.js` (generic JSON-RPC 2.0 over stdio, in core, no external deps)
- Started via `amxb serve` (registered as subcommand in `src/cli.js` → `src/commands/serve.js`); stdout stays pure JSON-RPC, logs go to stderr, progress bars disabled
- Method categories (all thin wrappers over core calls — no domain logic in the adapter):
  - manifest: `manifest.validate`, `manifest.resolve`
  - include: `include.resolve`, `include.list`
  - deps: `deps.tree`
  - releases: `releases.list`
  - cache: `cache.info`
  - build: `build.plan`, `build.start`, `build.cancel`
  - compile: `compile.single`
  - watch: `watch.start`, `watch.stop`
- Lifecycle events are pushed as server→client notifications: `build.stage` / `build.compiled` / `build.progress` / `build.done` / `build.error`, plus `watch.changed`
- Full API reference (methods, params, results, error codes): `docs/serve/INDEX.md`

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
