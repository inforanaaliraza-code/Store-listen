# Setup

1. Install Python 3.13 and Node 20+.
2. Copy `.env.example` to `.env` and set `MONGODB_URI` plus `MONGO_DATABASE_NAME` for your Atlas cluster.
3. Install backend dependencies with `py -3.13 -m pip install -r backend/requirements.txt`.
4. Install frontend dependencies with `npm install` from the repository root.
5. Start both apps with `npm run dev`, or start the API with `py -3.13 -m uvicorn app.main:app --app-dir backend --reload` and the Vite React app with `npm run dev --workspace frontend`.

The frontend uses Vite for development and builds a static SPA into `frontend/dist`. Production can serve those files with `npm run start --workspace frontend`; the API remains the existing FastAPI service.

The platform defaults to demo mode and mock providers. MongoDB Atlas is required; there is no local database fallback or container setup.
