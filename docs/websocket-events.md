# WebSocket events

Endpoints:

- `WS /ws/dashboard`
- `WS /ws/stores/{storeId}`
- `WS /ws/device/{deviceId}`

Browser and desktop clients authenticate with WebSocket subprotocols: `storelisten.v1` followed by the short-lived user token or device secret. Do not put credentials in query strings. Store/dashboard routes enforce user/store scope; device routes verify the device secret hash and reject revoked devices.

In local single-process mode events are delivered in memory. Set `REDIS_EVENT_BUS_ENABLED=true` with a reachable Redis URL for multi-worker fanout. Production requires TLS Redis (`rediss://`). Pub/Sub is transient; durable outbox/replay is not yet implemented, so clients reload active transcript records after reconnect.

Event names match `packages/event-contracts`. Example `transcript.final` includes `originalText`, `translatedText`, `language`, `confidence`, `isFinal`.
