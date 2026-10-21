# Store Listen

Store Listen is a retail conversation platform with a Vite/React web client, Node.js/Express API, MongoDB data layer, and Electron desktop recorder. The API uses Deepgram for live transcription, optional DeepL translation, WebSockets for live events, and deterministic local rules for coaching and reports. There is no Python backend or generative LLM dependency.

## Run locally

1. Install Node.js 24 or later and MongoDB Atlas (or a compatible MongoDB instance).
2. Copy `.env.example` to `.env` and set `MONGODB_URI`, `DEEPGRAM_API_KEY`, and a unique `JWT_SECRET`. Set `DEEPL_API_KEY` only when English translation is needed.
3. Run:

```powershell
npm install
npm run dev
```

The web app is available at `http://localhost:3000`; the API is at `http://localhost:8000`. For persistent recording storage in a local environment, use `STORAGE_PROVIDER=gridfs`. Local filesystem storage is for development and tests only.

## Behavior and limitations

- Deepgram produces transcripts; optional DeepL translates supported speech to English.
- Coaching, conversation analysis, and daily reports use fixed phrase rules and database aggregates. Treat them as review signals, not proof of intent, sentiment, sale outcome, or employee performance.
- POS is currently mock/demo-only. Do not use mock sales data for real financial decisions.
- Production requires MongoDB, a unique JWT secret, Deepgram credentials, GridFS audio storage, HTTPS, and exact frontend CORS configuration. Production startup rejects missing core settings.
- Do not capture customer audio until applicable legal, privacy, consent, and retention requirements have been reviewed.

## Verification

```powershell
npm test --workspace backend
npm --prefix desktop-agent test
npm run build --workspace frontend
```

See [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md) for deployment requirements and [backend/README.md](backend/README.md) for API details.
