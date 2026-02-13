<#
Usage:
  PowerShell -ExecutionPolicy Bypass -NoProfile -File .\scripts\up.ps1
  PowerShell -ExecutionPolicy Bypass -NoProfile -File .\scripts\up.ps1 -Port 5173 -NewWindow:$true -KillExisting:$true

What it does:
  - Ensures data/ exists
  - Optionally kills any process listening on the configured port
  - Installs web deps (npm install in ./web) unless -SkipInstall is used
  - Runs `npm run build` inside ./web
  - Starts the backend (node server.js). By default starts in a new PowerShell window so this script returns immediately.
#>

[CmdletBinding()]
param(
  [int]$Port = 5173,
  [bool]$NewWindow = $true,
  [bool]$KillExisting = $true,
  [switch]$SkipInstall
)

try {
  $Root = Split-Path -Parent $MyInvocation.MyCommand.Definition
} catch {
  $Root = Get-Location
}

Write-Host "Working directory: $Root"

# ensure data folder exists
if (-not (Test-Path (Join-Path $Root 'data'))) {
  Write-Host 'Creating data/ directory'
  New-Item -ItemType Directory -Path (Join-Path $Root 'data') | Out-Null
}

function Get-ProcessIdOnPort($PortNumber) {
  try {
    $c = Get-NetTCPConnection -LocalPort $PortNumber -ErrorAction SilentlyContinue
    if ($c) { return $c.OwningProcess }
  } catch {}
  # fallback: parse netstat output
  try {
    $line = netstat -ano | Select-String ":$PortNumber " | Select-Object -First 1
    if ($line) {
      $parts = ($line -split '\s+') | Where-Object { $_ -ne '' }
      return $parts[-1]
    }
  } catch {}
  return $null
}

if ($KillExisting) {
  $listenerProcess = Get-ProcessIdOnPort $Port
  if ($listenerProcess) {
    Write-Host "Killing process on port $Port (PID $listenerProcess)"
    try { Stop-Process -Id $listenerProcess -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 } catch { }
  }
}

if (-not $SkipInstall) {
  Write-Host 'Installing web dependencies (this may take a while)...'
  # Use cmd /c to avoid PowerShell script wrappers (npm.ps1) execution policy issues
  & cmd /c "cd /d `"$Root\\web`" && npm install"
}

Write-Host 'Building web (npm run build)...'
& cmd /c "cd /d `"$Root\\web`" && npm run build"

if ($NewWindow) {
  $cmd = "cd /d `"$Root`"; `$env:PORT='$Port'; node server.js"
  Write-Host "Starting server in a new window on port $Port"
  Start-Process -FilePath 'powershell' -ArgumentList '-NoExit','-Command',$cmd
  Write-Host 'Server started in a new window.'
} else {
  Write-Host "Starting server in current window on port $Port (Ctrl+C to stop)"
  $env:PORT = "$Port"
  node server.js
}
