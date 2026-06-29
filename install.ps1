# ARC for GitHub Copilot CLI installer (Windows).
#
#   irm https://raw.githubusercontent.com/arc-cache/copilot/main/install.ps1 | iex
#
# Env overrides:
#   $env:ARC_VERSION       install a specific version (default: latest release)
#   $env:ARC_INSTALL_DIR   install location (default: $HOME\.arc-copilot)
$ErrorActionPreference = 'Stop'

$repo = 'arc-cache/copilot'
$installDir = if ($env:ARC_INSTALL_DIR) { $env:ARC_INSTALL_DIR } else { Join-Path $HOME '.arc-copilot' }
$binDir = Join-Path $installDir 'bin'

function Fail($msg) { Write-Error "arc install: $msg"; exit 1 }

$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -ne 'AMD64') {
  Fail "unsupported architecture: $arch (try npm: npm i -g arc-copilot)"
}
$target = 'windows-x64'

$version = if ($env:ARC_VERSION) {
  $env:ARC_VERSION.TrimStart('v')
} else {
  $rel = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest"
  $rel.tag_name.TrimStart('v')
}
if (-not $version) { Fail 'could not determine the latest release (set $env:ARC_VERSION)' }

$asset = "arc-$version-$target.zip"
$url = "https://github.com/$repo/releases/download/v$version/$asset"

$tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ([guid]::NewGuid()))
try {
  Write-Host "Downloading arc $version ($target)..."
  $zip = Join-Path $tmp $asset
  Invoke-WebRequest -Uri $url -OutFile $zip

  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  Expand-Archive -Path $zip -DestinationPath $binDir -Force
  Write-Host "Installed arc to $(Join-Path $binDir 'arc.exe')"

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -notlike "*$binDir*") {
    [Environment]::SetEnvironmentVariable('Path', "$binDir;$userPath", 'User')
    Write-Host "Added $binDir to your user PATH. Restart your terminal to pick it up."
  }
  Write-Host "`nNext:`n  arc setup`n  arc split"
}
finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
