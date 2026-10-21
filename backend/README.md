# Backend

Node.js 24, Express, Mongoose, and WebSocket API for Store Listen. Mongo documents retain the existing collection names and `id` fields during migration.

## Local development

```powershell
Copy-Item ..\.env.example .env
# Set MONGODB_URI, DEEPGRAM_API_KEY, and DEEPL_API_KEY in backend/.env.
npm install
npm run dev
```

The API listens on `http://localhost:8000`. Health: `http://localhost:8000/health`; readiness: `http://localhost:8000/ready`. Readiness reports whether Deepgram transcription is configured; it never returns the key itself.
The Node service loads `backend/.env` first and then the repository-root `.env`; shell/Render environment variables take precedence. Never commit API keys.

Live transcription requires `DEEPGRAM_API_KEY`; Spanish-to-English translation uses optional `DEEPL_API_KEY`. Conversation analysis, coaching, and daily summaries use local phrase rules and verified database aggregates; they do not call a generative LLM. Treat phrase matches and opportunity labels as review signals, not proof of customer intent or employee performance. Daily reports state when live POS data is unavailable and never estimate revenue.

Set `STORAGE_PROVIDER=gridfs`, `DEMO_MODE=false`, and a real POS provider (or `POS_PROVIDER=none` until one is connected) for deployment. Production startup refuses demo mode, mock POS, local audio storage, missing Deepgram credentials, or a missing production JWT secret. `STORAGE_PROVIDER=local`, demo replay, and mock POS are for isolated local development/tests only. With `POS_PROVIDER=none`, POS data ingestion is explicitly unavailable rather than accepting mock transactions.

Expired audio files and their metadata are removed in batches; expired transcript segments are also removed based on `TRANSCRIPT_RETENTION_DAYS`. The cleanup runs at startup and every 15 minutes. MongoDB GridFS and database quotas still need monitoring.

Run Node backend contract tests from the repository root with `npm test --workspace backend`.

The Node/Express API is the active backend. MongoDB is the system of record; Redis is not required by this service. Before switching a live deployment, configure the secrets and persistent MongoDB storage, run the Node test suite, and verify `/ready`, transcription, WebSocket updates, and daily reports against the deployed environment.
