# Backend

FastAPI service for Store Listen.

## From the repository root

```powershell
Copy-Item .env.example .env
# Set MONGODB_URI and MONGO_DATABASE_NAME in .env.
py -3.13 -m pip install -r backend/requirements.txt
npm run dev --workspace backend
```

## From this directory

```powershell
Copy-Item ..\.env.example ..\.env
py -3.13 -m pip install -r requirements.txt
npm run dev
```

The API requires MongoDB Atlas and is available at `http://localhost:8000`; health check: `http://localhost:8000/health`.

Run backend tests with `npm run test` from this directory or `npm test` from the repository root.
