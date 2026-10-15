param(
    [switch]$AllowPrivateTailnetDemo
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
    throw "Tailscale CLI is not installed. Sign in to the authorized backend tailnet first."
}

$statusOutput = & tailscale status --json
if ($LASTEXITCODE -ne 0) { throw "Tailscale status failed. Sign in to the backend tailnet first." }
$status = $statusOutput | ConvertFrom-Json
$dnsName = ([string]$status.Self.DNSName).TrimEnd('.').ToLowerInvariant()
if (-not $dnsName -or $dnsName -notmatch '^[a-z0-9.-]+\.ts\.net$') {
    throw "This backend has no Tailscale MagicDNS HTTPS name. Enable MagicDNS and HTTPS certificates before building a client installer."
}
$apiBase = "https://$dnsName`:8443"
try {
    $readiness = Invoke-RestMethod -Uri "$apiBase/ready" -TimeoutSec 10
} catch {
    throw "The private API is not reachable at $apiBase. Confirm Tailscale Serve, backend readiness, and tailnet ACL access before packaging."
}
$productionReady = $readiness.status -eq "ready" -and $readiness.mode -eq "production"
$privateDemoReady = $AllowPrivateTailnetDemo -and $readiness.status -eq "ready" -and $readiness.mode -eq "demo"
if (-not $productionReady -and -not $privateDemoReady) {
    throw "The API is not production-ready (mode: $($readiness.mode)). For this tailnet-only demo only, rerun with -AllowPrivateTailnetDemo. No installer was built."
}

$env:STORE_LISTEN_API_BASE_URL = $apiBase
if ($privateDemoReady) {
    Write-Host "Building a tailnet-only demo installer for $apiBase. Demo credentials/data remain enabled."
} else {
    Write-Host "Building a client-only installer for $apiBase. No Tailscale key or device credential is embedded."
}

Push-Location $PSScriptRoot\..
try {
    & npm.cmd run dist
    if ($LASTEXITCODE -ne 0) { throw "Windows installer build failed." }
} finally {
    Remove-Item Env:STORE_LISTEN_API_BASE_URL -ErrorAction SilentlyContinue
    Pop-Location
}