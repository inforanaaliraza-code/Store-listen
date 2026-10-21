param(
    [string]$TaskName = "StoreListenBackend",
    [switch]$AllowPrivateTailnetDemo
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot "run_backend.ps1"
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    throw "Node.js was not found. Install Node.js 24 or later before registering API startup."
}
if (-not (Test-Path (Join-Path $repoRoot ".env"))) {
    throw "Repository .env is missing. Configure production backend settings before registering startup."
}

Push-Location (Join-Path $repoRoot "backend")
try {
    $configurationJson = & node.exe --input-type=module -e "import { config } from './src/config.js'; console.log(JSON.stringify({ app_env: config.appEnv, demo_mode: config.demoMode, mongodb_configured: Boolean(config.mongoUri), deepgram_configured: Boolean(config.deepgramApiKey), jwt_configured: Boolean(process.env.JWT_SECRET), gridfs_configured: config.storageProvider === 'gridfs' }))"
    if ($LASTEXITCODE -ne 0) { throw "Node backend settings did not validate; no startup task was registered." }
    $configuration = $configurationJson | ConvertFrom-Json
} finally {
    Pop-Location
}
$productionReady = $configuration.app_env -eq "production" -and -not $configuration.demo_mode -and $configuration.mongodb_configured -and $configuration.deepgram_configured -and $configuration.jwt_configured -and $configuration.gridfs_configured
if (-not $productionReady) {
    $privateDemoReady = $AllowPrivateTailnetDemo -and `
        $configuration.app_env -eq "development" -and `
        $configuration.demo_mode -and `
        $configuration.mongodb_configured
    if (-not $privateDemoReady) {
        throw "Startup requires production settings. For this local demo only, use -AllowPrivateTailnetDemo; it still requires a running Tailscale connection and tailnet-only Serve routes."
    }
    if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
        throw "Tailscale CLI was not found. No private demo startup task was registered."
    }
    $tailnetJson = & tailscale status --json 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $tailnetJson) {
        throw "Tailscale is not connected. No private demo startup task was registered."
    }
    $tailnetStatus = $tailnetJson | ConvertFrom-Json
    if ($tailnetStatus.BackendState -ne "Running") {
        throw "Tailscale is not running. No private demo startup task was registered."
    }
    $serveStatus = (& tailscale serve status 2>&1 | Out-String)
    $privateRouteCount = [regex]::Matches($serveStatus, "\(tailnet only\)").Count
    if ($privateRouteCount -lt 2 -or $serveStatus -notmatch "proxy http://127\.0\.0\.1:8000" -or $serveStatus -match "Funnel") {
        throw "Both app routes must be tailnet-only Tailscale Serve proxies, including 127.0.0.1:8000. No private demo startup task was registered."
    }
}

$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$powerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
$action = New-ScheduledTaskAction -Execute $powerShell -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runner`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Starts the Store Listen API on loopback after this Windows user signs in." -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
if ($productionReady) {
    Write-Host "Registered production task $TaskName for $currentUser. The API binds only to 127.0.0.1:8000."
} else {
    Write-Host "Registered tailnet-only demo task $TaskName for $currentUser. No public Funnel is configured; the API binds only to 127.0.0.1:8000."
}
Write-Host "Logs: $((Join-Path $repoRoot 'backend\storage\logs\api.log'))"