# API

Version prefix: `/api/v1`.

Auth: `POST /api/v1/auth/login` → `{ token, user }`. Send `Authorization: Bearer`.

Notable routes: dashboard/summary, stores, conversations, transcripts, opportunities (PATCH review), sales-intelligence, reports/{daily|weekly|monthly}, employees/{id}/performance, pos/transactions, pos/demo, pos/webhook, analytics, settings, devices/register, demo/replay, devcore/tasks.

Audio capture: `POST /api/v1/audio/sessions` starts a store-scoped conversation session; post each clip to `POST /api/v1/audio/transcribe` with its session ID, sequence, duration, and operator role (`unknown` is the honest default for a shared mic); then call `POST /api/v1/audio/sessions/{conversation_id}/finish`. Uploaded clips are stored under the configured local audio directory and returned as private playback paths. `GET /api/v1/conversations/{id}/audio?page=1&page_size=20` lists paginated metadata; `GET /api/v1/audio/recordings/{id}` streams a clip after store-scope authorization. Expired audio is deleted from storage and the database during API startup according to `AUDIO_RETENTION_DAYS`.

Report routes accept optional `store_id` and `business_date` query parameters and use that store's timezone. Daily report generation is `POST /api/v1/reports/daily/generate` with `{ "store_id": "store-001", "business_date": "YYYY-MM-DD" }` (date is optional). Manager/admin roles only. Generation snapshots conversation, transcript, audio, opportunity, and POS metrics; scans all transcript clips for possible product phrases (including unattributed clips); runs the configured daily-summary provider; and saves the result for subsequent GETs. The response includes sales count, revenue by currency, audio/transcript coverage, top detected intents, and a caveat that text mentions or missing POS matches do not prove customer intent or why a sale did not happen. Mock POS data is not live store revenue.

Health: `/health`, `/ready`, `/metrics`.

OpenAPI: `/docs`.
