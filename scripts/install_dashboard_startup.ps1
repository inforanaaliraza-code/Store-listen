param(
    [string]$TaskName = "StoreListenDashboard"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot "run_dashboard.ps1"
if (-not (Test-Path (Join-Path $repoRoot "frontend\dist\index.html"))) {
    throw "Dashboard build is missing. Run scripts/build_tailscale_dashboard.ps1 first."
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

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Starts the loopback-only Store Listen owner dashboard after this Windows user signs in." -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Registered $TaskName for $currentUser. The dashboard listens only on 127.0.0.1:3000."