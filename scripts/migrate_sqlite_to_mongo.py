#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import sqlite3
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from pymongo import InsertOne, MongoClient, UpdateOne
from pymongo.errors import PyMongoError


ROOT = Path(__file__).resolve().parents[1]
DOTENV = ROOT / ".env"


def load_runtime_env() -> None:
    if DOTENV.exists():
        load_dotenv(DOTENV)


def connect_sqlite(source_db: str) -> sqlite3.Connection:
    path = Path(source_db).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f"SQLite source database not found: {path}")
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def list_tables(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()
    return [row["name"] for row in rows]


def fetch_table_rows(conn: sqlite3.Connection, table: str) -> list[dict[str, Any]]:
    column_info = conn.execute(f"PRAGMA table_info('{table}')").fetchall()
    columns = [(info[1], info[2].upper()) for info in column_info]
    rows = conn.execute(f"SELECT * FROM \"{table}\"").fetchall()
    return [
        {column: _normalize_sqlite_value(row[index], declared_type) for index, (column, declared_type) in enumerate(columns)}
        for row in rows
    ]


def _normalize_sqlite_value(value: Any, declared_type: str) -> Any:
    if value is None:
        return None
    if "BOOL" in declared_type:
        return bool(value)
    if "DATETIME" in declared_type or declared_type == "TIMESTAMP":
        if isinstance(value, str):
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed
        return value
    if declared_type == "DATE":
        return date.fromisoformat(value) if isinstance(value, str) else value
    return value


def mongo_client_from_env() -> MongoClient:
    uri = os.getenv("MONGODB_URI") or os.getenv("MONGODB_CONNECTION_STRING")
    if not uri:
        raise RuntimeError("MONGODB_URI is not set. Add it to .env or environment before running live migration.")
    return MongoClient(uri)


def dry_run(source_db: str) -> None:
    conn = connect_sqlite(source_db)
    try:
        tables = list_tables(conn)
        print(f"SQLite source: {source_db}")
        print(f"Tables found: {len(tables)}")
        for table in tables:
            rows = fetch_table_rows(conn, table)
            print(f"- {table}: {len(rows)} rows")
    finally:
        conn.close()


def live_migrate(source_db: str, database_name: str, batch_size: int = 500) -> None:
    uri = os.getenv("MONGODB_URI") or os.getenv("MONGODB_CONNECTION_STRING")
    if not uri:
        raise RuntimeError("MONGODB_URI is required for a live migration.")

    client = MongoClient(uri, tz_aware=True)
    conn = None
    try:
        db = client[database_name or os.getenv("MONGO_DATABASE_NAME", "storelisten")]
        conn = connect_sqlite(source_db)
        tables = list_tables(conn)
        for table in tables:
            rows = fetch_table_rows(conn, table)
            collection = db[table]
            collection.create_index("id", unique=True)
            for index in range(0, len(rows), batch_size):
                batch = rows[index:index + batch_size]
                operations = []
                for row in batch:
                    pk_field = None
                    if "id" in row:
                        pk_field = "id"
                    elif row:
                        pk_field = next(iter(row.keys()))
                    if pk_field is not None:
                        operations.append(UpdateOne({pk_field: row[pk_field]}, {"$set": row}, upsert=True))
                    else:
                        operations.append(InsertOne(row))
                if operations:
                    collection.bulk_write(operations, ordered=False)
            imported_count = collection.count_documents({})
            if imported_count < len(rows):
                raise RuntimeError(f"Import verification failed for {table}: expected at least {len(rows)}, found {imported_count}.")
            print(f"Imported {table}: {len(rows)} source rows; {imported_count} documents in Atlas")
    except PyMongoError as exc:
        raise RuntimeError(f"MongoDB migration failed: {exc}") from exc
    finally:
        if conn is not None:
            conn.close()
        client.close()


def main() -> None:
    load_runtime_env()
    parser = argparse.ArgumentParser(description="Safely migrate SQLite data into MongoDB Atlas or dry-run the expected import.")
    parser.add_argument("--source-db", default=str(ROOT / "backend" / "storelisten.db"), help="Path to the current SQLite database.")
    parser.add_argument("--database-name", default=os.getenv("MONGO_DATABASE_NAME", "storelisten"), help="Target Mongo database name.")
    parser.add_argument("--batch-size", type=int, default=500, help="Batch size for Mongo upserts.")
    parser.add_argument("--live", action="store_true", help="Apply the migration to MongoDB Atlas; default is dry-run.")
    args = parser.parse_args()

    if args.live:
        live_migrate(args.source_db, args.database_name, batch_size=args.batch_size)
        print(f"Live migration finished for {args.database_name}")
    else:
        dry_run(args.source_db)
        print("Dry-run complete. Add --live to push data to MongoDB Atlas.")


if __name__ == "__main__":
    main()
