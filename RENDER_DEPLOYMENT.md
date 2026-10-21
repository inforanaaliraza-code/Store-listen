# Render Deployment

The root `render.yaml` defines the Node.js/Express API and the Vite static frontend. The API uses MongoDB Atlas for application data and GridFS for durable audio recordings. Do not use local disk for production recordings; Render's free service filesystem is ephemeral.

## Required setup

1. Create a MongoDB Atlas cluster and database user. Use a unique password, TLS, and Render's outbound IP ranges in the Atlas network access list. Do not allow `0.0.0.0/0` unless there is a deliberate, separately reviewed reason.
2. In Render, create or sync the Blueprint using this repository's root `render.yaml`. The API build installs the standalone backend lockfile with `npm ci --workspaces=false`, so it does not accidentally use the monorepo workspace lock.
3. Set `MONGODB_URI` and `DEEPGRAM_API_KEY` in the API service's private environment settings. Rotate any Deepgram key that was pasted into chat or otherwise exposed before adding a replacement.
4. Set `DEEPL_API_KEY` only if Spanish-to-English translation is required; it is optional. The app's coaching, transcript analysis, and daily summaries are deterministic phrase rules and verified aggregates, not generative AI.
5. The Blueprint generates `JWT_SECRET`, sets `STORAGE_PROVIDER=gridfs`, and keeps `DEMO_MODE=true` with mock POS data for safe testing. Do not use demo mode or mock records for customer reporting. Before live operations, set `DEMO_MODE=false` in the API service after configuring live integrations and data. The desktop labels demo mode and disables capture when the API reports that transcription is unavailable.
6. Wait for the API deployment to pass `/ready`, then check the frontend and verify login, a live Deepgram transcription, WebSocket transcript delivery, report generation, and audio upload/read/delete against the deployed services.

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
- `CORS_ORIGINS` (exact frontend HTTPS origin)

Optional:

- `DEEPL_API_KEY` and `DEEPL_API_URL` for translation
- `POS_PROVIDER` (currently only mock/demo POS is available)
- `AUDIO_RETENTION_DAYS` and `TRANSCRIPT_RETENTION_DAYS`

Production startup fails closed when the Mongo URI, production JWT secret, Deepgram key, or GridFS storage mode is missing. Render Free may sleep, has limited CPU/RAM, and cannot provide always-on real-time capture; use a paid service for dependable production operation. MongoDB Atlas and Deepgram have their own availability, capacity, and billing limits.

## Desktop

The desktop installer must be built with an explicit HTTPS API URL supplied privately to the release build. Never place service credentials in frontend `VITE_*` variables or the desktop application. The desktop device pairs through the Node API and sends capture chunks over the authenticated WebSocket connection.

If a provider key has been pasted into chat, committed, or otherwise shared, revoke it and create a replacement before adding the replacement to Render or a local ignored `.env` file.
