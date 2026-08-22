#Requires -Version 5.1
<#
.SYNOPSIS
    Installs amxb (amxx-builder) globally.

.DESCRIPTION
    One-liner install for Windows:
        irm https://raw.githubusercontent.com/AmxxModularEcosystem/amxx-builder/master/install.ps1 | iex

    Or with a PAT for private repos:
        $env:GITHUB_TOKEN="ghp_xxx"; irm https://raw.githubusercontent.com/AmxxModularEcosystem/amxx-builder/master/install.ps1 | iex
#>

$ErrorActionPreference = 'Stop'

$REPO   = 'AmxxModularEcosystem/amxx-builder'   # <-- replace with actual GitHub owner/repo

# Shared GitHub API headers (token-aware), reused by both resolution calls below.
$headers = @{ Accept = 'application/vnd.github+json' }
$token = $env:GITHUB_TOKEN
if ($token) { $headers.Authorization = "Bearer $token" }

function Write-Step { param([string]$msg) Write-Host "[amxx-builder] $msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$msg) Write-Host "[amxx-builder] $msg" -ForegroundColor Green }
function Write-Fail { param([string]$msg) Write-Error "[amxx-builder] $msg" }

# ── Version resolution ──────────────────────────────────────────────────────────
#   $env:AMXB_VERSION  — explicit tag, branch, or commit hash
#   (unset)            — resolve latest GitHub release, fallback to master
function Resolve-Version {
    $version = $env:AMXB_VERSION
    if ($version) {
        return $version
    }

    Write-Step "Resolving latest release for $REPO ..."
    $apiUrl = "https://api.github.com/repos/$REPO/releases/latest"

    try {
        $response = Invoke-RestMethod -Uri $apiUrl -Headers $headers -ErrorAction Stop
        $tag = $response.tag_name
        Write-Step "Latest release: $tag"
        return $tag
    } catch {
        Write-Step "Could not resolve latest release ($($_.Exception.Message)), falling back to master"
        return 'master'
    }
}

# ── Commit SHA resolution ─────────────────────────────────────────────────────
# npm installs github:...#<full 40-hex SHA> as a plain tarball without git;
# tags/branches would need git. /commits/{ref} dereferences annotated tags.
function Resolve-Sha {
    param([string]$Version)
    $apiUrl = "https://api.github.com/repos/$REPO/commits/$Version"
    try {
        $response = Invoke-RestMethod -Uri $apiUrl -Headers $headers -ErrorAction Stop
        return $response.sha
    } catch {
        return $null
    }
}

# ── 1. Check Node.js ──────────────────────────────────────────────────────────
Write-Step 'Checking prerequisites...'

try { $nodeRaw = & node --version 2>&1 } catch { Write-Fail 'Node.js not found. Install from https://nodejs.org (LTS recommended)' }
$nodeMajor = [int]($nodeRaw -replace 'v(\d+)\..*', '$1')
if ($nodeMajor -lt 18) { Write-Fail "Node.js 18+ required (found $nodeRaw)" }
Write-Step "Node.js $nodeRaw OK"

try { & npm --version | Out-Null } catch { Write-Fail 'npm not found. Reinstall Node.js from https://nodejs.org' }

# ── 2. Resolve version ──────────────────────────────────────────────────────────
$VERSION = Resolve-Version

# ── 2.5 Resolve commit SHA (allows installing without git) ─────────────────────
$SHA = Resolve-Sha -Version $VERSION
$INSTALL_REF = $VERSION
if ($SHA) {
    $INSTALL_REF = $SHA
    Write-Step "Resolved $VERSION → $SHA (git-free install)"
} else {
    Write-Host "[amxx-builder] WARNING: could not resolve commit SHA for $VERSION; installing github:${REPO}#${VERSION} (this path requires git)" -ForegroundColor Yellow
}

# ── 3. Install via npm ──────────────────────────────────────────────────────────
Write-Step "Installing amxb from github:${REPO}#${INSTALL_REF} ..."

$npmArgs = @('install', '-g', "github:${REPO}#${INSTALL_REF}")

# Pass token if set (for private repos)
if ($token) {
    # npm reads GH_TOKEN / GITHUB_TOKEN for private GitHub packages
    $env:GH_TOKEN = $token
}

# npm writes warnings to stderr; PS 5.1 treats native stderr as ErrorRecord with Stop preference
$ErrorActionPreference = 'Continue'
& npm @npmArgs
$npmExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($npmExit -ne 0) { Write-Fail 'npm install failed. See output above.' }

# ── 3. Verify ────────────────────────────────────────────────────────────────
Write-Step 'Verifying installation...'
try {
    $ver = & amxb --version 2>&1
    Write-Ok "amxb $ver installed successfully!"
} catch {
    Write-Host '[amxx-builder] amxb installed but not yet on PATH in this session.' -ForegroundColor Yellow
    Write-Host '               Restart your terminal and run: amxb --help' -ForegroundColor Yellow
}

Write-Ok 'Done. Usage:'
Write-Host '  cd your-server-project'
Write-Host '  amxb build                      # uses ./amxbuild.yml'
Write-Host '  amxb build --manifest other.yml'
Write-Host '  amxb build --dry-run'
Write-Host ''
Write-Host 'MCP server for opencode:'
Write-Host '  amxb mcp                         # start the MCP server'
