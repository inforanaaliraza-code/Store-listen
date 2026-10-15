# Render Free Deployment

This repository deploys as two separate Render services from one GitHub repository:

- `store-listen-api`: Python FastAPI Web Service on Render's Free plan.
- `store-listen-web`: static Vite frontend (Render Static Sites are free).

The root `render.yaml` is the single Blueprint for both services. It does not create any paid Render resource.

## Before You Deploy

1. Push `render.yaml`, `backend/.python-version`, and `frontend/package-lock.json` to the GitHub `main` branch. The Vercel-only scaffold is not used.
2. Create a MongoDB Atlas M0 free cluster, database user, and database. Atlas is external to Render; it is not created by this Blueprint.
3. Copy the Atlas connection URI somewhere private. Do not commit it or send it in chat. Render will request it as `MONGODB_URI` when syncing the Blueprint.
4. Render Free services do not have fixed outbound IPs. For an Atlas M0 connection, configure Atlas Network Access to allow Render's dynamic egress (commonly `0.0.0.0/0`), and protect the cluster with a unique, strong database-user password and TLS. This is less restrictive than an IP allowlist.

## Create Both Services

1. Open the Render Dashboard and choose **New → Blueprint**.
2. Connect `inforanaaliraza-code/Store-listen`, choose branch `main`, and select the repository-root `render.yaml`.
3. Keep the generated plan as Free. When Render prompts for `MONGODB_URI`, paste the Atlas URI in the Render form only. Render generates separate `JWT_SECRET` and `SESSION_SECRET` values.
4. Apply the Blueprint. It creates both services and deploys them. Wait for `store-listen-api` to become Live before testing the site.
5. Confirm the API health endpoint responds: `https://store-listen-api.onrender.com/health`. Confirm `/ready` reports `demo` and a connected database.
6. Open `https://store-listen-web.onrender.com/login`. The Blueprint sets `VITE_API_URL` and `VITE_WS_URL` to the API service, and configures API CORS for this exact frontend origin.

If Render assigns different `onrender.com` hostnames because those names are already in use, update `API_BASE_URL`, `WEB_BASE_URL`, and `CORS_ORIGINS` on `store-listen-api`, plus `VITE_API_URL` and `VITE_WS_URL` on `store-listen-web`, then redeploy both. CORS origin values must be HTTPS origins only, with no trailing slash. The frontend values are embedded at build time, so changing them requires a frontend redeploy.

## Service Settings (If Creating Manually)

### Backend Web Service

- Repository: `inforanaaliraza-code/Store-listen`
- Branch: `main`
- Runtime: Python 3
- Root Directory: `backend`
- Plan: **Free**
- Build Command: `pip install -r requirements.txt`
- Start Command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- Health Check Path: `/health`
- Python: `3.13.4` (also pinned by `backend/.python-version`)

Required environment values are declared in `render.yaml`. The only value you must provide manually is `MONGODB_URI`; the JWT/session secrets are generated. Keep `APP_ENV=development` and `DEMO_MODE=true` for this free demo deployment.

### Frontend Static Site

- Repository: `inforanaaliraza-code/Store-listen`
- Branch: `main`
- Root Directory: `frontend`
- Build Command: `npm ci && npm run build`
- Publish Directory: `dist`
- Rewrite: `/*` to `/index.html` for React Router routes such as `/login` and `/dashboard`
- Environment: `VITE_API_URL=https://store-listen-api.onrender.com`, `VITE_WS_URL=wss://store-listen-api.onrender.com`

`frontend/package-lock.json` lets the independent Static Site install the Vite workspace reproducibly. `VITE_*` values are public build-time settings, not secrets.

## Free-Plan Limits

- Free web services have 512 MB RAM and 0.1 CPU. Whisper's local model can be slow, run out of memory, or fail to initialize on this plan; `tiny`/`int8` is configured but is not guaranteed to fit reliably.
- A free web service spins down after 15 minutes without inbound HTTP or WebSocket traffic. The next request can wait about a minute while it wakes up.
- Free web-service filesystems are ephemeral. Audio stored under `/tmp/storelisten-audio` is lost when the service sleeps, restarts, or redeploys. There is no persistent disk on the Free plan.
- Render provides 750 free web-service instance hours per workspace per calendar month. If the workspace exhausts its included usage, free services can be suspended for the rest of the month; monitor usage and keep any spend limit at $0 if available.
- Static Sites are free, but use monthly bandwidth/build-pipeline allowances.
- This configuration uses no Render Postgres or Key Value instance. Atlas M0 is a separate free database tier with its own quotas and availability limits.
- The app is deliberately in demo mode with mock AI/POS providers. Demo credentials and demo data must not be used for real store data. Production startup currently fails closed because the repository does not yet implement real POS and shared object-storage adapters.

Free Render is suitable for a protected demo, not dependable customer recording. For durable recordings and always-on transcription, move to paid compute plus shared object storage, or use a container host with adequate memory and storage.
