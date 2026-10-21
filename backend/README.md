# Backend

Node.js 24, Express, Mongoose, and WebSocket API for Store Listen. Mongo documents retain the existing collection names and `id` fields during migration.

## Local development

```powershell
Copy-Item ..\.env.example .env
# Set MONGODB_URI, DEEPGRAM_API_KEY, GROQ_API_KEY, and optional DEEPL_API_KEY in backend/.env.
npm install
npm run dev
```

The API listens on `http://localhost:8000`. Health: `http://localhost:8000/health`; readiness: `http://localhost:8000/ready`. Readiness reports whether transcription, English translation, coaching, and daily reports are configured; it never returns secret values.
The Node service loads `backend/.env` first and then the repository-root `.env`; shell/Render environment variables take precedence. Never commit API keys.

Live transcription requires `DEEPGRAM_API_KEY`. Spanish-to-English uses `DEEPL_API_KEY` when available and automatically falls back to `GROQ_API_KEY`; a valid Groq key is therefore required if DeepL is not configured or unavailable. Groq also powers desktop live coaching and generated daily-report summaries (optional `GROQ_MODEL`, default `openai/gpt-oss-120b`). The retired `llama-3.3-70b-versatile` setting is automatically migrated to this replacement. Coaching and reports fail clearly when Groq is unavailable; they do not silently fall back to rule-based guidance. Conversation analysis remains local and rule-based. Treat AI suggestions as review prompts, not verified facts or employee-performance judgments. Daily reports use verified database/POS aggregates and never estimate revenue.

Set `STORAGE_PROVIDER=gridfs`, `DEMO_MODE=false`, and a real POS provider (or `POS_PROVIDER=none` until one is connected) for deployment. Production enforces live-only mode and refuses mock POS, local audio storage, missing Deepgram credentials, or a missing production JWT secret. `STORAGE_PROVIDER=local`, demo replay, and mock POS are for isolated local development/tests only. With `POS_PROVIDER=none`, POS data ingestion is explicitly unavailable rather than accepting mock transactions.

Production always enforces live-only behavior: if a Render dashboard override sets `DEMO_MODE=true`, the backend logs a warning and ignores it rather than serving demo data or failing startup. Keep the Render value set to `false` as well, so the dashboard configuration matches the enforced runtime mode.

The desktop agent stores both speech clips and one continuous, low-bitrate full-session recording when capture stops. Full-session uploads are limited to 20 MB/60 minutes; if that limit or upload fails, the agent reports it and keeps the speech clips. Expired audio files and their metadata are removed in batches; expired transcript segments are also removed based on `TRANSCRIPT_RETENTION_DAYS`. The cleanup runs at startup and every 15 minutes. MongoDB GridFS and database quotas still need monitoring.

Run Node backend contract tests from the repository root with `npm test --workspace backend`.

The Node/Express API is the active backend. MongoDB is the system of record; Redis is not required by this service. Before switching a live deployment, configure the secrets and persistent MongoDB storage, run the Node test suite, and verify `/ready`, transcription, WebSocket updates, and daily reports against the deployed environment.
