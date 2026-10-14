# Database

MongoDB Atlas is the application's sole persistence store. Collection names match the entity tables declared in `backend/app/models.py` and include organizations, stores, devices, users, employees, conversations, transcripts, opportunities, POS, reports, audit logs, integrations, and Devcore tasks.

Configure `MONGODB_URI` and `MONGO_DATABASE_NAME` in `.env`. The URI is a secret; keep it out of source control, logs, and screenshots. Atlas SRV URIs use TLS by default. Application startup pings the cluster and creates indexes declared by the entity metadata. There is no local database fallback and no SQL migration step.

To import the existing SQLite database, first run `py -3.13 scripts/migrate_sqlite_to_mongo.py` for a read-only inventory, then add `--live` to perform idempotent collection upserts. Date/time and boolean fields are converted to native BSON-compatible types. The source SQLite file is not deleted.

Back up the Atlas database using Atlas backup/PITR before production data is ingested, restrict network access, and use a least-privilege database user.
