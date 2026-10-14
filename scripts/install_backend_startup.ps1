param(
    [string]$TaskName = "StoreListenBackend"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot "run_backend.ps1"
if (-not (Get-Command py.exe -ErrorAction SilentlyContinue)) {
    throw "Python launcher py.exe was not found. Install Python 3.13 and backend requirements first."
}
if (-not (Test-Path (Join-Path $repoRoot ".env"))) {
    throw "Repository .env is missing. Configure production backend settings before registering startup."
}

Push-Location (Join-Path $repoRoot "backend")
try {
    $configurationJson = & py.exe -3.13 -c "import json; from app.config import settings; print(json.dumps({'app_env': settings.app_env, 'demo_mode': settings.demo_mode, 'mongodb_configured': bool(settings.mongodb_uri)}))"
    if ($LASTEXITCODE -ne 0) { throw "Backend settings did not validate; no startup task was registered." }
    $configuration = $configurationJson | ConvertFrom-Json
} finally {
    Pop-Location
}
if ($configuration.app_env -ne "production" -or $configuration.demo_mode -or -not $configuration.mongodb_configured) {
    throw "Startup requires APP_ENV=production, DEMO_MODE=false, and MONGODB_URI configured. No startup task was registered."
}

$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$powerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
$action = New-ScheduledTaskAction -Execute $powerShell -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runner`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Starts the Store Listen API on loopback after this Windows user signs in." -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Registered $TaskName for $currentUser. The API binds only to 127.0.0.1:8000."
Write-Host "Logs: $((Join-Path $repoRoot 'backend\storage\logs\api.log'))"