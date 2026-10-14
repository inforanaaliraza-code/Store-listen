# Roadmap and Completion

## Completed locally

- Local faster-whisper provider behind `SPEECH_PROVIDER`, with English/Spanish-only transcript acceptance.
- Mock AI and POS paths that demonstrate intent, coaching, opportunities, transaction matching, and reporting without vendor credentials.
- Store-scoped authentication and CRUD for stores, employees, stock, and store rules; active store rules can inform reviewable coaching.
- Database-derived dashboard counts, local-day conversation totals, seven-day trend, POS revenue, listening time, and recorder status.
- Daily, weekly, and monthly reports; saved daily report history; authenticated WebSockets; live browser and desktop microphone capture paths.
- MongoDB Atlas persistence and indexes, production TLS/Redis/secret guardrails, Redis multi-worker event fanout, and an idempotent SQLite-to-Mongo importer.
- Electron packaged releases bind to a build-time HTTPS API origin, encrypt device secrets in Windows storage, use authenticated WebSocket subprotocols, and reconnect with jitter. Device registration/revocation is store-authorized and audited.
- Backend regression coverage, desktop tests, and frontend production build. These are local verification, not production certification.

## Remaining engineering work

1. Add a transactional outbox/durable event replay and background jobs for slow transcription/report workloads; Pub/Sub alone is transient.
2. Implement shared encrypted audio object storage and retention/deletion workflows; audio storage is currently local to the API host.
3. Add durable offline capture buffering, idempotency keys, replay, and conflict handling in the desktop client.
4. Add browser end-to-end coverage for sign-in, live capture/demo, reconnect/resynchronization, opportunity review, POS correlation, and reports.
5. Complete the independent Store Agent capture/streaming/buffering lifecycle and verify it on target store hardware; the separate Electron recorder currently provides local capture.
6. Add transcript PII redaction and auditable audio/transcript deletion workflows.
7. Calculate employee performance only from complete, validated event-level signals; response time and objective service scores are not currently measured.
8. Complete production monitoring, backups/restore drills, device-secret rotation procedures, Windows code signing, and target-hardware soak tests.

## Blocked on client/legal input

- Confirm POS vendor/version/API access and credentials before building a real POS adapter.
- Provision the cloud API hostname, MongoDB Atlas, TLS Redis, and shared object storage. Do not deploy from or depend on a developer workstation.
- Rotate any Atlas credential previously shared in chat/screenshots; use a least-privilege application user and a secret manager.
- Confirm store audio hardware, operating systems, network conditions, and whether browser or edge-device capture is approved.
- Obtain jurisdiction-specific recording notice/consent and employee notice decisions, retention/deletion policy, and privacy/legal approval.
- Confirm whether `Gork/Grok` refers to Grok or another analysis provider, and provide approved credentials if required.
- Confirm cloud/deployment environment and identity provider.

Do not treat mock data, local tests, or a successful demo as evidence that these production blockers are resolved.
