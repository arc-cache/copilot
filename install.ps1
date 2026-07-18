# ARC for GitHub Copilot CLI installer and upgrade migrator (Windows).
#
#   irm https://raw.githubusercontent.com/arc-cache/copilot/main/install.ps1 | iex
#
# Env overrides:
#   $env:ARC_VERSION        install a specific published version (default: latest)
#   $env:ARC_PACKAGE_SPEC   install an explicit npm spec (release verification only)
#   $env:ARC_INSTALL_DIR    legacy native install location to reconcile
$ErrorActionPreference = 'Stop'

function Fail($message) { throw "arc install: $message" }

function Remove-LegacyNpmShims($prefix) {
  foreach ($command in @('arc', 'agent-run-cache')) {
    foreach ($suffix in @('', '.cmd', '.ps1')) {
      $path = Join-Path $prefix "$command$suffix"
      if (-not [IO.File]::Exists($path)) { continue }
      $content = Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue
      if ($content -match 'node_modules[\\/]+agent-run-cache[\\/]') {
        Remove-Item -LiteralPath $path -Force
      }
    }
  }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js 22 or newer is required' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'npm is required' }
$nodeMajor = [int]((& node -p 'Number(process.versions.node.split(".")[0])').Trim())
if ($nodeMajor -lt 22) { Fail "Node.js 22 or newer is required (found $(& node --version))" }

$spec = if ($env:ARC_PACKAGE_SPEC) {
  $env:ARC_PACKAGE_SPEC
} elseif ($env:ARC_VERSION) {
  "arc-copilot@$($env:ARC_VERSION.TrimStart('v'))"
} else {
  'arc-copilot@latest'
}

$npmRoot = (& npm root -g).Trim()
$prefix = (& npm config get prefix).Trim()
if (-not $prefix) { Fail 'npm did not report a global prefix' }

$legacyPackage = Join-Path $npmRoot 'agent-run-cache'
if (Test-Path $legacyPackage) {
  Write-Host 'Migrating legacy global agent-run-cache installation...'
  & npm uninstall -g agent-run-cache | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'could not remove the legacy global agent-run-cache package' }
}
Remove-LegacyNpmShims $prefix

Write-Host "Installing $spec..."
& npm install -g $spec --include=optional
if ($LASTEXITCODE -ne 0) { Fail "npm could not install $spec" }

$canonical = Join-Path $prefix 'arc.cmd'
if (-not (Test-Path $canonical)) { Fail "npm completed but did not install $canonical" }

# The old native installer added ~/.arc-copilot/bin to the user PATH. Remove
# only that known entry, keep the files as a rollback copy, and put npm first.
$legacyInstallDir = if ($env:ARC_INSTALL_DIR) { $env:ARC_INSTALL_DIR } else { Join-Path $HOME '.arc-copilot' }
$legacyBin = Join-Path $legacyInstallDir 'bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$entries = @($userPath -split ';' | Where-Object { $_ -and $_ -ne $legacyBin -and $_ -ne $prefix })
[Environment]::SetEnvironmentVariable('Path', ((@($prefix) + $entries) -join ';'), 'User')
$env:Path = "$prefix;$env:Path"

& $canonical metrics --json | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'the installed ARC binary failed its metrics smoke check' }

Write-Host "`nARC is ready. Desktop and Copilot share local cache data without sharing executables."
Write-Host "Next:`n  arc plugin install`n  arc split"
