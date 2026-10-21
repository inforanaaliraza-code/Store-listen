# Render Deployment

The root `render.yaml` defines the Node.js/Express API and the Vite static frontend. The API uses MongoDB Atlas for application data and GridFS for durable audio recordings. Do not use local disk for production recordings; Render's free service filesystem is ephemeral.

## Required setup

1. Create a MongoDB Atlas cluster and database user. Use a unique password, TLS, and Render's outbound IP ranges in the Atlas network access list. Do not allow `0.0.0.0/0` unless there is a deliberate, separately reviewed reason.
2. In Render, create or sync the Blueprint using this repository's root `render.yaml`. The API build installs the standalone backend lockfile with `npm ci --workspaces=false`, so it does not accidentally use the monorepo workspace lock.
3. Set `MONGODB_URI`, `DEEPGRAM_API_KEY`, and `GROQ_API_KEY` in the API service's private environment settings. Rotate any key that was pasted into chat or otherwise exposed before adding a replacement.
4. Set `GROQ_MODEL` only to override the default `openai/gpt-oss-120b`. Groq powers live desktop coaching and daily-report narratives, and is the automatic Spanish-to-English translation fallback when DeepL is not configured or unavailable. Conversation analysis remains local and rule-based. `DEEPL_API_KEY` is optional. The retired `llama-3.3-70b-versatile` setting is automatically migrated to the supported replacement.
5. The Blueprint generates `JWT_SECRET`, sets `STORAGE_PROVIDER=gridfs`, and deploys with `DEMO_MODE=false`. Production startup refuses demo mode and mock POS. Until a supported POS integration is configured, `POS_PROVIDER=none` keeps sales ingestion disabled rather than fabricating transactions.
6. Set real `DEEPGRAM_API_KEY`, `GROQ_API_KEY`, and `MONGODB_URI` privately in Render, then wait for the API deployment to pass `/ready` with `mode=live`, a connected database, and `capabilities.transcription`, `capabilities.english_translation`, `capabilities.live_coaching`, and `capabilities.daily_reports` all `available`. Verify login, device approval, live Deepgram transcription, Spanish-to-English WebSocket delivery, Groq coaching/report generation, and audio upload/read/delete against the deployed services.

The current frontend build is configured for `https://store-listen-api-z8yb.onrender.com` and `wss://store-listen-api-z8yb.onrender.com`. If Render assigns different hostnames, update the API CORS origin and both `VITE_API_URL`/`VITE_WS_URL`, then redeploy the frontend because Vite values are embedded at build time.

## API environment

Required for production:

- `APP_ENV=production`
- `HOST=0.0.0.0` (Render's external listener)
- `MONGODB_URI`
- `MONGO_DATABASE_NAME`
- `JWT_SECRET` (unique; at least 32 characters)
- `DEEPGRAM_API_KEY`
- `STORAGE_PROVIDER=gridfs`
- `DEMO_MODE=false`
- `CORS_ORIGINS` (exact frontend HTTPS origin)

Optional:

- `GROQ_API_KEY` (required for live desktop coaching, daily-report generation, and English translation when DeepL is not configured; AI endpoints return 503 if unavailable)
- `GROQ_MODEL` to override the Groq model default
- `DEEPL_API_KEY` and `DEEPL_API_URL` for translation
- `POS_PROVIDER=none` until an actual POS integration is implemented and configured
- `AUDIO_RETENTION_DAYS` and `TRANSCRIPT_RETENTION_DAYS`

Production startup fails closed when the Mongo URI, production JWT secret, Deepgram key, or GridFS storage mode is missing, or if demo mode/mock POS is enabled. The Groq key is optional for API startup but required for AI coaching and daily report generation; `/ready` reports both feature capabilities. No POS vendor connector is currently configured; do not treat empty sales data as connected POS data. Render Free may sleep, has limited CPU/RAM, and cannot provide always-on real-time capture; use a paid service for dependable production operation. MongoDB Atlas, Groq, and Deepgram have their own availability, capacity, and billing limits.

## Desktop

The desktop installer must be built with an explicit HTTPS API URL supplied privately to the release build. Never place service credentials in frontend `VITE_*` variables or the desktop application. The desktop device pairs through the Node API and sends capture chunks over the authenticated WebSocket connection.

If a provider key has been pasted into chat, committed, or otherwise shared, revoke it and create a replacement before adding the replacement to Render or a local ignored `.env` file.
