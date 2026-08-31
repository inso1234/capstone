# One-command install: builds this translator and registers it as an MCP
# server in a target project. Usage:
#   .\install.ps1 -TargetProjectDir C:\path\to\target-project `
#       [-BaseUrl URL] [-ClientId ID] [-ClientSecret SECRET] [-ContentTypes "Type1,Type2"]
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetProjectDir,
    [string]$BaseUrl,
    [string]$ClientId,
    [string]$ClientSecret,
    [string]$ContentTypes
)

$ErrorActionPreference = "Stop"
$ScriptDir = $PSScriptRoot
Set-Location $ScriptDir

function Fail($msg) {
    Write-Error "install.ps1: $msg"
    exit 1
}

if (-not (Test-Path $TargetProjectDir)) {
    Fail "Target project directory does not exist: $TargetProjectDir"
}
$TargetProjectDir = (Resolve-Path $TargetProjectDir).Path

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail "node is required (>=18) but was not found on PATH."
}
$nodeMajor = [int]((node -e "console.log(process.versions.node.split('.')[0])").Trim())
if ($nodeMajor -lt 18) {
    Fail "node >=18 is required, found $(node -v)."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Fail "npm is required but was not found on PATH."
}
# The claude CLI is optional, not required — register-mcp-server.mjs falls
# back to writing .mcp.json directly when it's absent (e.g. VS Code
# extension-only setups, which don't expose a standalone claude binary).

Write-Host "==> Installing dependencies and building the translator..."
npm install
if ($LASTEXITCODE -ne 0) { Fail "npm install failed." }
npm run build
if ($LASTEXITCODE -ne 0) { Fail "npm run build failed." }

$EnvFile = Join-Path $ScriptDir ".env"
if (-not (Test-Path $EnvFile)) {
    Copy-Item (Join-Path $ScriptDir ".env.example") $EnvFile
    $content = Get-Content $EnvFile
    if ($BaseUrl) { $content = $content -replace '^ORCHARDCORE_BASE_URL=.*', "ORCHARDCORE_BASE_URL=$BaseUrl" }
    if ($ClientId) { $content = $content -replace '^ORCHARDCORE_CLIENT_ID=.*', "ORCHARDCORE_CLIENT_ID=$ClientId" }
    if ($ClientSecret) { $content = $content -replace '^ORCHARDCORE_CLIENT_SECRET=.*', "ORCHARDCORE_CLIENT_SECRET=$ClientSecret" }
    if ($ContentTypes) { $content = $content -replace '^ORCHARDCORE_ALLOWED_CONTENT_TYPES=.*', "ORCHARDCORE_ALLOWED_CONTENT_TYPES=$ContentTypes" }
    Set-Content -Path $EnvFile -Value $content -Encoding utf8
}

$envContent = Get-Content $EnvFile -Raw
if ($envContent -notmatch 'ORCHARDCORE_CLIENT_SECRET=\S+') {
    Write-Host ""
    Write-Host "A fresh .env was created at: $EnvFile"
    Write-Host "Fill in these required values, then re-run this script:"
    Write-Host "  ORCHARDCORE_BASE_URL"
    Write-Host "  ORCHARDCORE_CLIENT_ID"
    Write-Host "  ORCHARDCORE_CLIENT_SECRET"
    Write-Host "  ORCHARDCORE_ALLOWED_CONTENT_TYPES"
    Write-Host "See SETUP-ORCHARDCORE.md for how to obtain these."
    exit 1
}

Write-Host "==> Registering the orchardcore-cms MCP server in: $TargetProjectDir"
$registerScript = Join-Path $ScriptDir "scripts\register-mcp-server.mjs"
node "$registerScript" "$TargetProjectDir"
if ($LASTEXITCODE -ne 0) { Fail "MCP server registration failed." }

if (Get-Command claude -ErrorAction SilentlyContinue) {
    Write-Host "==> Verifying registration..."
    Push-Location $TargetProjectDir
    try {
        $list = claude mcp list
        if ($list -match "orchardcore-cms") {
            Write-Host "orchardcore-cms is registered."
        } else {
            Fail "orchardcore-cms did not appear in 'claude mcp list' after registration."
        }
    } finally {
        Pop-Location
    }
}

Write-Host ""
Write-Host "Install complete. Try this in a Claude Code session inside $TargetProjectDir:"
Write-Host ""
Write-Host '  "Use the orchardcore-cms MCP server to list the first 5 content items."'
Write-Host ""
