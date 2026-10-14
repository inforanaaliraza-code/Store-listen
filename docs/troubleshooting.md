# Troubleshooting

- Dashboard 401: sign in again; token is in localStorage `sl_token`.
- Empty live monitor: click Run charger demo; confirm API on :8000 and WS URL.
- MongoDB unavailable: verify `MONGODB_URI`, Atlas IP access list/private endpoint, database-user permissions, and DNS/network access.
- Python import errors: run pytest from `backend/` with `pytest.ini` pythonpath.
- CORS: add the web origin to `CORS_ORIGINS`.
