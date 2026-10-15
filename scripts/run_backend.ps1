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
    $pythonPath = & py.exe -3.13 -c "import sys; print(sys.executable)"
    if ($LASTEXITCODE -ne 0 -or -not $pythonPath) { throw "Python 3.13 could not be resolved." }
    $errorLogPath = Join-Path $logDirectory "api.stderr.log"
    $process = Start-Process `
        -FilePath $pythonPath.Trim() `
        -ArgumentList @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000") `
        -NoNewWindow `
        -PassThru `
        -RedirectStandardOutput $logPath `
        -RedirectStandardError $errorLogPath
    $process.WaitForExit()
    exit $process.ExitCode
} finally {
    Pop-Location
}