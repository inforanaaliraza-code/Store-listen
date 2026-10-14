$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$backendDirectory = Join-Path $repoRoot "backend"
$logDirectory = Join-Path $backendDirectory "storage\logs"
$logPath = Join-Path $logDirectory "api.log"
$previousLogPath = "$logPath.1"

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
if ((Test-Path $logPath) -and (Get-Item $logPath).Length -ge 10MB) {
    Remove-Item $previousLogPath -Force -ErrorAction SilentlyContinue
    Move-Item $logPath $previousLogPath -Force
}

Push-Location $backendDirectory
try {
    & py.exe -3.13 -m uvicorn app.main:app --host 127.0.0.1 --port 8000 *>> $logPath
    exit $LASTEXITCODE
} finally {
    Pop-Location
}