# Private Tailscale Deployment

This keeps the API and owner dashboard on the designated Windows computer. It does not create a VPS, Tailscale Funnel, or public API endpoint. The backend is proxied from loopback by Tailscale Serve; desktop clients never run a backend.

## Network and authorization

Install the official Tailscale client on the backend computer, the owner computer, and each client PC. Sign in each device with an authorized tailnet identity and approve it in the Tailscale admin console. Do not use an admin auth key in scripts, the installer, or the application.

Merge a restrictive policy like the following into the existing tailnet policy. Preserve other existing policy rules and replace the example owner identity with the actual owner account/group. The backend, owner, and client tags must be assigned by an authorized tailnet admin. Do not tag client devices as owners.

```json
{
  "groups": {
    "group:storelisten-owners": ["owner@example.com"]
  },
  "tagOwners": {
    "tag:storelisten-backend": ["autogroup:admin"],
    "tag:storelisten-owner": ["autogroup:admin"],
    "tag:storelisten-client": ["autogroup:admin"]
  },
  "grants": [
    {
      "src": ["tag:storelisten-client"],
      "dst": ["tag:storelisten-backend"],
      "ip": ["tcp:443"]
    },
    {
      "src": ["tag:storelisten-owner", "group:storelisten-owners"],
      "dst": ["tag:storelisten-backend"],
      "ip": ["tcp:443", "tcp:8443"]
    }
  ]
}
```

This policy limits client PCs to the API. Only owner-tagged devices or the named owner identity can reach the dashboard port. Store Listen still enforces login, device credentials, roles, and store scope. Revoking a client requires removing/expiring its Tailscale device and revoking its Store Listen device registration.

## Backend Computer

1. Install Python 3.13, Node.js, backend requirements, MongoDB Atlas access, and the official Tailscale Windows client. The backend must be allowed to make its outbound database connections.
2. Configure the root `.env` with unique production secrets, `APP_ENV=production`, `DEMO_MODE=false`, `API_BASE_URL=https://<actual-magicdns-name>:8443`, `WEB_BASE_URL=https://<actual-magicdns-name>`, and `CORS_ORIGINS=https://<actual-magicdns-name>`.
3. Production startup is fail-closed. It also requires TLS Redis, a real AI provider/key, a real POS adapter, and shared audio storage. The current repository does not implement production POS or shared object storage, so it will reject a production launch until those gates are resolved; do not weaken them to expose demo data.
4. Sign in to Tailscale on the backend computer and have an admin assign `tag:storelisten-backend`. Enable MagicDNS and HTTPS certificates in the tailnet admin console.
5. Stop the existing development API if it is bound to `0.0.0.0:8000`. Start the private version with `npm run start:tailscale --workspace backend`; it binds to `127.0.0.1:8000` only.
6. Build the owner dashboard for the real MagicDNS endpoint with `scripts/build_tailscale_dashboard.ps1`, then start it with `scripts/run_dashboard.ps1`.
7. Register logon startup tasks with `scripts/install_backend_startup.ps1` and `scripts/install_dashboard_startup.ps1`. These run as the current Windows user after sign-in, keep logs under `backend/storage/logs/`, and restart a failed process. The computer must be powered on and a Windows user must sign in for these interactive tasks to start.
8. After merging and validating the ACL, configure private HTTPS with `scripts/tailscale_backend_setup.ps1 -ConfirmRestrictedTailnet`. The script checks `/ready`, requires production mode, checks port 8000 is loopback-only, and serves the public web app on `:443` and the private API on `:8443`. It never configures Funnel.

The public storefront/operations app is available at `https://<actual-magicdns-name>` and the private backend remains at `https://<actual-magicdns-name>:8443`. Tailscale Serve supplies HTTPS and forwards to loopback. Port 8000 must not be opened in the router or Windows Firewall.

## Client Installer

Install and authorize Tailscale on the client PC first, then have an admin assign `tag:storelisten-client`. This is an explicit device-approval step; the Store Listen installer does not install Tailscale, join the tailnet, or embed a tailnet key.

From an authorized backend/owner device, create the client-only Windows installer with `npm --prefix desktop-agent run dist:tailscale`. The script reads the backend's current MagicDNS name from `tailscale status`, checks the API reports production-ready mode, and builds the EXE with that HTTPS origin. The package contains no Tailscale credentials or backend code. Device login/activation then uses the existing Store Listen authentication flow, storing its device secret with Windows secure storage.

The desktop agent checks `/ready` before login, updates connection status while offline, and retries its authenticated device-health WebSocket with backoff. The owner dashboard silently refreshes summary data every 15 seconds while visible. Transcript pages resynchronize active transcript data after WebSocket reconnection. This is near-real-time behavior, not durable replay for every historical event.

## Recovery and Availability

`tailscale serve --bg` persists across reboots and Tailscale restarts. Verify it with `tailscale serve status`; the current backend/owner device names with `tailscale status`; and the local API with `http://127.0.0.1:8000/ready`. Logs are `backend/storage/logs/api.log` and `backend/storage/logs/dashboard.log`. Scheduled tasks can be inspected in Windows Task Scheduler under the names `StoreListenBackend` and `StoreListenDashboard`.

If the designated computer is powered off, logged out, disconnected, or its Internet fails, the API and dashboard are unavailable to clients. No VPS/failover host is configured. Tailscale reconnects networking, and clients retry health/WebSocket connections, but this setup does not guarantee that audio being uploaded at the instant of a disconnect is durably replayed. Validate recording recovery and backups before live use.

The current development machine has no Tailscale client installed and is using `APP_ENV=development`, `DEMO_MODE=true`, and optional Redis. Tailnet authorization, MagicDNS, ACL approval, and customer installer creation therefore remain operator steps; the helper scripts intentionally refuse to expose this current demo configuration.