# Deployment Status

## Self-hosted private tailnet

The API and owner dashboard can run on the designated Windows computer without deploying the backend to a VPS. Use [the Tailscale self-host guide](tailscale-self-host.md) for HTTPS Serve, MagicDNS-based desktop/dashboard builds, restricted device tags, startup tasks, and revocation. This path requires an administrator to authorize every Tailscale device and apply the ACL policy; the application installer does not join a tailnet. The API is loopback-bound and Tailscale Serve is the only intended remote ingress.

The current local environment is `APP_ENV=development`, `DEMO_MODE=true`, and has no Tailscale client installed. Production startup also remains blocked until a real POS adapter and shared audio storage are implemented/configured, in addition to Atlas, TLS Redis, real AI, and secrets. These checks are not disabled for self-hosting.

## Local development

Install the Python and Node dependencies, configure `MONGODB_URI` and `MONGO_DATABASE_NAME` in `.env`, then run `npm run dev`. The API and dashboard run directly as local processes; the application does not require Docker or a local database service. Redis is optional in local development.

## Production prerequisites

The API rejects missing MongoDB configuration, demo data, weak/reused secrets, HTTP origins, plaintext/missing Redis, mock AI, unsupported speech configuration, mock/unimplemented POS, and local/unimplemented shared audio storage.

Before deployment, provision:

1. MongoDB Atlas with TLS, restricted network access, backups/PITR, and a least-privilege application user.
2. TLS Redis for cross-worker event fanout.
3. Shared encrypted object storage for retained audio. No S3-compatible adapter is implemented yet.
4. Either a public HTTPS API origin and WSS endpoint behind a managed reverse proxy, or the private Tailscale Serve endpoint documented above.
5. Approved dashboard origins for `CORS_ORIGINS`.
6. Unique `JWT_SECRET` and `SESSION_SECRET` from a secret manager.
7. Confirmed AI provider/key and POS vendor/API adapter. No production POS adapter is currently implemented.
8. Recording notice/consent, retention, and deletion decisions approved for each operating jurisdiction.

Set `MONGODB_URI` and `MONGO_DATABASE_NAME` through the deployment secret manager. Startup verifies Atlas connectivity and ensures collection indexes; there is no SQL migration job. For cloud hosting, build the static dashboard with `VITE_API_URL=https://...` and matching `VITE_WS_URL=wss://...`. For self-hosting, the Tailscale dashboard build script injects the authorized MagicDNS API URL on port `8443` and the dashboard is only served to owner-tagged devices.

The dashboard is a Vite-built React SPA. Production serves `frontend/dist` as static files with history fallback; no Next.js server process is required.

## Windows desktop release

For cloud hosting, set `STORE_LISTEN_API_BASE_URL` to the HTTPS API origin before `npm --prefix desktop-agent run dist`. For self-hosting, run `npm --prefix desktop-agent run dist:tailscale`; that helper reads the actual backend MagicDNS name and requires a production-ready API. Both paths package only an HTTPS origin, never credentials. The app stores its Store Listen device secret with Windows `safeStorage` and reconnects its health WebSocket with jittered backoff.

## Recovery and remaining release gates

Configure Atlas backups/PITR and periodically test restores before real data is ingested. Redis Pub/Sub is transient; a durable transactional outbox and background worker are still needed for guaranteed event delivery and long-running report/transcription jobs. Browser/desktop clients resynchronize active transcripts after reconnect, but historical event replay is not implemented. Do not claim zero data loss or production availability until these are tested.

Do not deploy for live store recording until the POS vendor, hardware, cloud/object storage, legal approval, retention policy, operational monitoring, and rollback/restore procedures are confirmed.
