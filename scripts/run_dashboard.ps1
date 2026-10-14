$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$frontendDirectory = Join-Path $repoRoot "frontend"
$buildEntry = Join-Path $frontendDirectory "dist\index.html"
$logDirectory = Join-Path $repoRoot "backend\storage\logs"
$logPath = Join-Path $logDirectory "dashboard.log"
$previousLogPath = "$logPath.1"

if (-not (Test-Path $buildEntry)) { throw "Production dashboard build is missing. Run scripts/build_tailscale_dashboard.ps1 first." }
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
if ((Test-Path $logPath) -and (Get-Item $logPath).Length -ge 10MB) {
    Remove-Item $previousLogPath -Force -ErrorAction SilentlyContinue
    Move-Item $logPath $previousLogPath -Force
}

Push-Location $frontendDirectory
$previousHost = $env:HOST
$previousPort = $env:PORT
try {
    $env:HOST = "127.0.0.1"
    $env:PORT = "3000"
    & npm.cmd run start *>> $logPath
    exit $LASTEXITCODE
} finally {
    if ($null -eq $previousHost) { Remove-Item Env:HOST -ErrorAction SilentlyContinue } else { $env:HOST = $previousHost }
    if ($null -eq $previousPort) { Remove-Item Env:PORT -ErrorAction SilentlyContinue } else { $env:PORT = $previousPort }
    Pop-Location
}