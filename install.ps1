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
$BRANCH = 'master'

function Write-Step { param([string]$msg) Write-Host "[amxx-builder] $msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$msg) Write-Host "[amxx-builder] $msg" -ForegroundColor Green }
function Write-Fail { param([string]$msg) Write-Error "[amxx-builder] $msg" }

# ── 1. Check Node.js ──────────────────────────────────────────────────────────
Write-Step 'Checking prerequisites...'

try { $nodeRaw = & node --version 2>&1 } catch { Write-Fail 'Node.js not found. Install from https://nodejs.org (LTS recommended)' }
$nodeMajor = [int]($nodeRaw -replace 'v(\d+)\..*', '$1')
if ($nodeMajor -lt 16) { Write-Fail "Node.js 16+ required (found $nodeRaw)" }
Write-Step "Node.js $nodeRaw OK"

try { & npm --version | Out-Null } catch { Write-Fail 'npm not found. Reinstall Node.js from https://nodejs.org' }

# ── 2. Install via npm ────────────────────────────────────────────────────────
Write-Step "Installing amxb from github:$REPO ..."

$npmArgs = @('install', '-g', "github:$REPO")

# Pass token if set (for private repos)
$token = $env:GITHUB_TOKEN
if ($token) {
    # npm reads GH_TOKEN / GITHUB_TOKEN for private GitHub packages
    $env:GH_TOKEN = $token
}

& npm @npmArgs
if ($LASTEXITCODE -ne 0) { Write-Fail 'npm install failed. See output above.' }

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
