# Security Overview

Store Listen is designed for enterprise use but does not claim formal compliance without an external audit. The architecture follows secure defaults:

- Environment-based secrets
- Device-specific credentials
- JWT or session tokens with expiration
- RBAC and store-scoped authorization
- Audit logging for device and user events
- CORS and request validation
- WebSocket authentication expectations

The production environment must undergo legal and compliance review before storing raw audio or PII in a live retail deployment.

## Production guardrails

- Production startup requires MongoDB Atlas configuration and rejects demo mode, weak/reused secrets, HTTP API/CORS URLs, and missing/non-TLS Redis.
- Atlas connections use TLS and the database is never exposed to desktop clients; only the API connects to MongoDB.
- WebSocket tokens are sent in the negotiated `storelisten.v1` subprotocol, not query strings. Device secrets are hashed server-side and stored encrypted on Windows with `safeStorage`.
- Device registration/revocation requires a store-management role; revocation invalidates the next WebSocket handshake and writes an audit log.
- `.env` files are ignored; `.env.example` contains placeholders only.
- Desktop releases require an HTTPS API origin at build time. It may be a private Tailscale MagicDNS name; it is endpoint configuration, not a secret. Tailscale auth keys and administrator credentials are never bundled or stored by Store Listen.

Any password or database credential pasted into chat, screenshots, issue trackers, or logs must be treated as compromised and rotated immediately. The Atlas credential shared during this setup must be rotated; use a least-privilege application user, not an Atlas administrator.

## Known security/deployment gaps

Redis Pub/Sub provides live cross-worker fanout but is not a durable outbox. Device credentials can be revoked, but a full credential-rotation workflow and key/version policy remain to be implemented. Shared cloud object storage, transcript PII redaction/deletion, production monitoring, backup recovery drills, and an external legal/security assessment are not complete. No PCI, SOC 2, or other certification is claimed.
