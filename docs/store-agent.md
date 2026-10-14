# Store agent

`backend/store-agent/agent.py`

- Device id + optional token (never org master keys)
- Heartbeat + exponential backoff
- Graceful SIGINT/SIGTERM
- Audio source flag: mock | file | microphone
- Local config under `~/.storelisten/device.json`

Register devices via `POST /api/v1/devices/register` to receive a one-time secret.

## Existing Windows desktop capture application

The separately packaged Electron application in `desktop-agent/` is the Windows microphone capture client. It bundles its runtime, activates a store-scoped device, encrypts its device secret with Windows secure storage, uploads short audio clips, reports health over an authenticated WebSocket, and reconnects with exponential backoff plus jitter. Cloud release builds use `STORE_LISTEN_API_BASE_URL=https://...`; private self-hosted builds use `npm --prefix desktop-agent run dist:tailscale` to derive the actual MagicDNS HTTPS origin. Packaged clients cannot edit the API host. See `docs/tailscale-self-host.md` for device authorization and ACL requirements.

The Python Store Agent remains a health/reconnect entry point and does not yet capture/upload audio. Neither agent has been validated on production store hardware or through a full store-hours soak test. Offline audio buffering, replay/idempotency, and durable retry are not implemented.
