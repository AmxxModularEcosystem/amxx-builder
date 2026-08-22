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
      | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\(.*\)",*/\1/' || true)
  else
    tag=$(curl -sfL "$api_url" 2>/dev/null \
      | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\(.*\)",*/\1/' || true)
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
command -v curl >/dev/null 2>&1 || fail "curl not found. Install curl first"

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 18 ]; then
    fail "Node.js 18+ required (found $(node --version))"
fi
step "Node.js $(node --version) OK"

# ── 2. Resolve version ──────────────────────────────────────────────────────────
VERSION=$(resolve_version)

# ── 2.5 Resolve commit SHA ─────────────────────────────────────────────────────
# npm installs github:...#<full 40-hex SHA> as a plain tarball without git;
# tags/branches would need git. The /commits/{ref} endpoint dereferences
# annotated tags, and the first "sha" key is the commit SHA.
resolve_sha() {
  local version="$1"
  local api_url="https://api.github.com/repos/$REPO/commits/$version"
  local sha

  # First "sha": "<40 hex>" in the response is the commit SHA (the endpoint
  # dereferences annotated tags). -oE extracts each match separately, so the
  # first one (head -1) is the top-level commit — not tree/parent shas.
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    sha=$(curl -sfL -H "Authorization: Bearer $GITHUB_TOKEN" "$api_url" 2>/dev/null \
      | grep -oE '"sha": *"[0-9a-f]{40}"' | head -1 | grep -oE '[0-9a-f]{40}' || true)
  else
    sha=$(curl -sfL "$api_url" 2>/dev/null \
      | grep -oE '"sha": *"[0-9a-f]{40}"' | head -1 | grep -oE '[0-9a-f]{40}' || true)
  fi
  echo "$sha"
}

INSTALL_REF="$VERSION"
SHA=$(resolve_sha "$VERSION")
if [ -n "$SHA" ]; then
  INSTALL_REF="$SHA"
  step "Resolved $VERSION → $SHA (git-free install)"
else
  echo -e "\033[33m[amxx-builder]\033[0m WARNING: could not resolve commit SHA for $VERSION; installing github:$REPO#$VERSION (this path requires git)" >&2
fi

# ── 3. Install via npm ──────────────────────────────────────────────────────────
step "Installing amxb from github:$REPO#${INSTALL_REF} ..."

if [ -n "${GITHUB_TOKEN:-}" ]; then
    export GH_TOKEN="$GITHUB_TOKEN"
fi

npm install -g "github:$REPO#${INSTALL_REF}"

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
