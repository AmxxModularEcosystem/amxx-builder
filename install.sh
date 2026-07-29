#!/usr/bin/env bash
# One-liner install for Linux / macOS:
#   curl -fsSL https://raw.githubusercontent.com/AmxxModularEcosystem/amxx-builder/master/install.sh | bash
#
# With PAT for private repos:
#   GITHUB_TOKEN=ghp_xxx curl -fsSL .../install.sh | bash

set -euo pipefail

REPO="AmxxModularEcosystem/amxx-builder"   # <-- replace with actual GitHub owner/repo

step()  { echo -e "\033[36m[amxx-builder]\033[0m $*"; }
ok()    { echo -e "\033[32m[amxx-builder]\033[0m $*"; }
fail()  { echo -e "\033[31m[amxx-builder]\033[0m ERROR: $*" >&2; exit 1; }

# ── Version resolution ──────────────────────────────────────────────────────────
#   AMXB_VERSION  — explicit tag, branch, or commit hash
#   (unset)       — resolve latest GitHub release, fallback to master
resolve_version() {
  if [ -n "${AMXB_VERSION:-}" ]; then
    echo "$AMXB_VERSION"
    return
  fi

  step "Resolving latest release for $REPO ..."
  local api_url="https://api.github.com/repos/$REPO/releases/latest"
  local tag

  if [ -n "${GITHUB_TOKEN:-}" ]; then
    tag=$(curl -sfL -H "Authorization: Bearer $GITHUB_TOKEN" "$api_url" 2>/dev/null \
      | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\(.*\)",*/\1/')
  else
    tag=$(curl -sfL "$api_url" 2>/dev/null \
      | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\(.*\)",*/\1/')
  fi

  if [ -n "$tag" ]; then
    step "Latest release: $tag"
    echo "$tag"
  else
    step "Could not resolve latest release, falling back to master"
    echo "master"
  fi
}

# ── 1. Check Node.js ──────────────────────────────────────────────────────────
step "Checking prerequisites..."

command -v node >/dev/null 2>&1 || fail "Node.js not found. Install from https://nodejs.org"
command -v npm  >/dev/null 2>&1 || fail "npm not found. Reinstall Node.js from https://nodejs.org"

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 16 ]; then
    fail "Node.js 16+ required (found $(node --version))"
fi
step "Node.js $(node --version) OK"

# ── 2. Resolve version ──────────────────────────────────────────────────────────
VERSION=$(resolve_version)

# ── 3. Install via npm ──────────────────────────────────────────────────────────
step "Installing amxb from github:$REPO#${VERSION} ..."

if [ -n "${GITHUB_TOKEN:-}" ]; then
    export GH_TOKEN="$GITHUB_TOKEN"
fi

npm install -g "github:$REPO#${VERSION}"

# ── 3. Verify ────────────────────────────────────────────────────────────────
step "Verifying installation..."
if command -v amxb >/dev/null 2>&1; then
    ok "amxb $(amxb --version) installed successfully!"
else
    echo -e "\033[33m[amxx-builder]\033[0m amxb installed but not yet on PATH in this session."
    echo "               Restart your terminal or run: source ~/.bashrc"
fi

ok "Done. Usage:"
echo "  cd your-server-project"
echo "  amxb build                      # uses ./amxbuild.yml"
echo "  amxb build --manifest other.yml"
echo "  amxb build --dry-run"
echo ""
echo ""
echo "MCP server for opencode:"
echo "  amxb mcp                         # start the MCP server"
