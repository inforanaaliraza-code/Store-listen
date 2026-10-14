param(
    [Parameter(Mandatory = $true)]
    [switch]$ConfirmRestrictedTailnet,

    [string]$Hostname = "storelisten-backend"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
    throw "Tailscale CLI is not installed. Install the official Tailscale Windows client, sign in, and rerun this script. No auth key is needed or accepted."
}
if (-not $ConfirmRestrictedTailnet) {
    throw "Configure the restricted tag-based ACL in docs/tailscale-self-host.md, then rerun with -ConfirmRestrictedTailnet. No API was exposed."
}

function Get-TailscaleStatus {
    $output = & tailscale status --json 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $output) { return $null }
    try { return ($output | ConvertFrom-Json) } catch { return $null }
}

$status = Get-TailscaleStatus
if (-not $status -or $status.BackendState -ne "Running" -or -not $status.Self) {
    Write-Host "Tailscale needs an interactive sign-in. Complete the browser authorization for the backend account."
    & tailscale up "--hostname=$Hostname" --unattended
    if ($LASTEXITCODE -ne 0) { throw "Tailscale sign-in was not completed. No API was exposed." }
    $status = Get-TailscaleStatus
}

if (-not $status -or $status.BackendState -ne "Running" -or -not $status.Self) {
    throw "Tailscale is not connected. Finish device authorization and rerun this script."
}

$selfName = [string]$status.Self.HostName
if ($selfName -ne $Hostname) {
    & tailscale set "--hostname=$Hostname"
    if ($LASTEXITCODE -ne 0) { throw "Could not set the backend's Tailscale hostname. No API was exposed." }
    $status = Get-TailscaleStatus
}

$dnsName = ([string]$status.Self.DNSName).TrimEnd('.').ToLowerInvariant()
if (-not $dnsName -or $dnsName -notmatch '^[a-z0-9.-]+\.ts\.net$') {
    throw "MagicDNS with HTTPS certificates is not ready for this tailnet. Enable MagicDNS and HTTPS certificates in the Tailscale admin console, then rerun."
}

try {
    $ready = Invoke-RestMethod -Uri "http://127.0.0.1:8000/ready" -TimeoutSec 5
} catch {
    throw "The loopback backend is not ready at 127.0.0.1:8000. Start the backend first. Details: $($_.Exception.Message)"
}
if ($ready.status -ne "ready") { throw "The backend readiness check did not return ready. No API was exposed." }
if ($ready.mode -ne "production") {
    throw "This backend reports mode '$($ready.mode)'. Set APP_ENV=production and DEMO_MODE=false, then satisfy all production config gates before exposing it to client devices."
}

$listeners = Get-NetTCPConnection -State Listen -LocalPort 8000 -ErrorAction SilentlyContinue
$nonLoopbackListeners = $listeners | Where-Object { $_.LocalAddress -notin @("127.0.0.1", "::1") }
if ($nonLoopbackListeners) {
    throw "API port 8000 is listening beyond loopback. Stop that process and restart with 'npm run start:tailscale --workspace backend' before exposing it."
}

try {
    Invoke-WebRequest -Uri "http://127.0.0.1:3000/login" -TimeoutSec 5 -UseBasicParsing | Out-Null
} catch {
    throw "The private dashboard is not ready at 127.0.0.1:3000. Build it with scripts/build_tailscale_dashboard.ps1 and start it before exposing it."
}

& tailscale serve --bg --https=443 --yes http://127.0.0.1:3000
if ($LASTEXITCODE -ne 0) { throw "Tailscale Serve could not configure the frontend on port 443. Check tailnet HTTPS certificate settings." }
& tailscale serve --bg --https=8443 --yes http://127.0.0.1:8000
if ($LASTEXITCODE -ne 0) { throw "Tailscale Serve could not configure the backend on port 8443." }

Write-Host "Public web app: https://$dnsName"
Write-Host "Private API: https://$dnsName`:8443"
Write-Host "Serve forwards HTTPS to loopback only; restrict TCP 443 to client/backend tags and TCP 8443 to owner/backend tags in the tailnet ACL."
Write-Host "Do not enable Tailscale Funnel or open backend port 8000 in the Windows firewall/router."
