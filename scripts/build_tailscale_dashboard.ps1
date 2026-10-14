$ErrorActionPreference = "Stop"

if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
    throw "Tailscale CLI is not installed. Sign in to the authorized backend tailnet first."
}

$statusOutput = & tailscale status --json
if ($LASTEXITCODE -ne 0) { throw "Tailscale status failed. Sign in to the backend tailnet first." }
$status = $statusOutput | ConvertFrom-Json
$dnsName = ([string]$status.Self.DNSName).TrimEnd('.').ToLowerInvariant()
if (-not $dnsName -or $dnsName -notmatch '^[a-z0-9.-]+\.ts\.net$') {
    throw "This backend has no Tailscale MagicDNS HTTPS name. Enable MagicDNS and HTTPS certificates first."
}

$previousApiUrl = $env:VITE_API_URL
$previousWsUrl = $env:VITE_WS_URL
$env:VITE_API_URL = "https://$dnsName`:8443"
$env:VITE_WS_URL = "wss://$dnsName`:8443"
try {
    Push-Location (Split-Path -Parent $PSScriptRoot)
    try {
        & npm.cmd run build --workspace frontend
        if ($LASTEXITCODE -ne 0) { throw "Dashboard production build failed." }
    } finally {
        Pop-Location
    }
} finally {
    if ($null -eq $previousApiUrl) { Remove-Item Env:VITE_API_URL -ErrorAction SilentlyContinue } else { $env:VITE_API_URL = $previousApiUrl }
    if ($null -eq $previousWsUrl) { Remove-Item Env:VITE_WS_URL -ErrorAction SilentlyContinue } else { $env:VITE_WS_URL = $previousWsUrl }
}

Write-Host "Built owner dashboard for Tailscale API https://$dnsName`:8443"