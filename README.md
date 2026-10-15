# Store Listen

Premium retail conversation intelligence for US stores: capture (via a pluggable audio source), transcribe, translate, detect sales opportunities, and correlate with POS — without pretending mock adapters are production integrations.

The web client is a lightweight React single-page application built with Vite. Routes are lazy-loaded; the FastAPI backend and Electron desktop recorder remain separate services.

Devcore (agency site + Kanban) is a separate product surface under `/devcore`.

## What runs locally

| Surface | URL |
| --- | --- |
| Store Listen login | http://localhost:3000/login |
| Operations console | http://localhost:3000/dashboard |
| Live monitor | http://localhost:3000/live |
| Devcore marketing | http://localhost:3000/devcore |
| API | http://localhost:8000/docs |

## Demo credentials

- Operations: `admin@storelisten.demo` / `StoreListen!2026`
- Store manager (Store 001 only): `manager@storelisten.demo` / `StoreListen!2026`
- Devcore studio: `hello@devcore.studio` / `Devcore!2026`

## How to run

The API connects directly to MongoDB Atlas. Set `MONGODB_URI` and `MONGO_DATABASE_NAME` in `.env` before starting:

```powershell
Copy-Item .env.example .env
# Set MONGODB_URI in .env before starting the API.
npm install
py -3.13 -m pip install -r backend/requirements.txt
npm run dev
```

There is no local database server or container stack. MongoDB Atlas stores application data; Redis remains optional for local event fanout.

## Demo workflow

1. Sign in.
2. Open **Live monitor** — the Spanish iPhone-charger scenario starts automatically.
3. Watch original Spanish, English translation, intent, sales tip, then mock USB-C $19.99 POS match labeled **Opportunity Converted** (not certain).
4. Review Conversations, Opportunities (manager override), Reports, Employees (AI-assisted caveat), POS.

## Providers (environment)

```
AI_PROVIDER=mock          # demo only; production requires a configured provider/key
SPEECH_PROVIDER=whisper   # local faster-whisper; mock is demo only
### Render deployment

The root [`render.yaml`](render.yaml) defines two separate Render services from this repository: a free Static Site for the Vite frontend and a free Python Web Service for the FastAPI backend. Follow [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md) to connect the GitHub repository, provide the private MongoDB Atlas URI, and configure the frontend/API URLs and CORS.

The free Render setup is a public demo; the app includes seeded demo credentials. Its backend sleeps after inactivity and has ephemeral audio storage. Production remains blocked until a real POS adapter, shared object storage, TLS Redis, and production secrets are configured. Never use demo accounts or free storage for real customer, employee, or store recordings.
### Private Tailscale deployment

The backend can stay on the designated Windows computer; it is not deployed to a VPS. Follow [the Tailscale self-host setup](docs/tailscale-self-host.md) to configure interactive device authorization, restrictive ACL tags, loopback-only backend/dashboard services, owner dashboard refresh, and logon startup tasks. Client PCs must have the official Tailscale client installed and approved by a tailnet admin before the Store Listen installer is used.

This repository currently runs in development/demo mode in the local environment. Production startup also requires TLS Redis, a real POS adapter, and shared audio storage; those production gates are intentionally not bypassed by the Tailscale scripts. The self-host guide lists the remaining prerequisites. No customer installer has been built because Tailscale is not installed or authorized in this environment.

### Desktop release

The existing Electron application bundles its runtime; clients do not install Python, Node.js, a database, or a backend. For an optional cloud deployment, the release operator can still configure an HTTPS API origin (this is public endpoint configuration, not a secret):

```powershell
The installer stores the API origin, not a secret. Device secrets are issued during activation and stored using Windows secure storage. Set the HTTPS API origin to the deployed backend URL when building a customer installer.
npm --prefix desktop-agent run dist
Remove-Item Env:STORE_LISTEN_API_BASE_URL
```

Packaging fails when the API origin is missing or not HTTPS. For the self-hosted path, use `npm --prefix desktop-agent run dist:tailscale`; it obtains the authenticated backend's actual MagicDNS name and refuses to build unless the API is production-ready. Device secrets are issued during activation and stored using Windows secure storage. A signing certificate and legal recording approval have not been supplied, so a signed customer installer has not been generated.

### Import existing local data

The importer reads `backend/storelisten.db` without modifying it and upserts rows into same-named MongoDB collections. It is safe to rerun; it does not delete cloud records.

```powershell
py -3.13 scripts/migrate_sqlite_to_mongo.py
py -3.13 scripts/migrate_sqlite_to_mongo.py --live
```

The first command is a dry run. Set the Atlas URI in `.env` before running with `--live`. Startup pings Atlas and ensures indexes; there are no SQL schema migrations.

## Store agent

```
py -3.13 backend/store-agent/agent.py --api http://localhost:8000 --device-id device-001
```

Uses a device secret, not a master API key.

## Tests

```powershell
Push-Location backend
py -3.13 -m pytest -q
Pop-Location
npm run build --workspace frontend
npm test --workspace frontend
npm --prefix desktop-agent test
```

## Docs

See `docs/` for architecture, API, WebSockets, privacy, security, POS, speech/AI pipelines, and `docs/client-questions.md`.

Do not deploy against live store microphones until legal review of US recording laws is complete.
