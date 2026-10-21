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
$previousHost = $env:HOST
try {
    $env:HOST = "127.0.0.1"
    $errorLogPath = Join-Path $logDirectory "api.stderr.log"
    $process = Start-Process `
        -FilePath "node.exe" `
        -ArgumentList @("src/server.js") `
        -WorkingDirectory $backendDirectory `
        -NoNewWindow `
        -PassThru `
        -RedirectStandardOutput $logPath `
        -RedirectStandardError $errorLogPath
    $process.WaitForExit()
    exit $process.ExitCode
} finally {
    $env:HOST = $previousHost
    Pop-Location
}