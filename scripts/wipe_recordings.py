"""Flash-delete conversation audio/transcripts from MongoDB account databases."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from pymongo import MongoClient

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")

COLLECTIONS = (
    "audio_recordings",
    "audio_sessions",
    "transcript_segments",
    "conversation_participants",
    "customer_intents",
    "product_opportunities",
    "sales_recommendations",
    "missed_opportunities",
    "ai_processing_runs",
    "conversation_pos_matches",
    "conversations",
)


def wipe_database(uri: str, database_name: str, *, dry_run: bool) -> dict[str, int]:
    client = MongoClient(uri, serverSelectionTimeoutMS=15_000, tz_aware=True)
    db = client[database_name]
    counts: dict[str, int] = {}
    for name in COLLECTIONS:
        counts[name] = db[name].estimated_document_count()
    if dry_run:
        client.close()
        return counts

    # Remove audio files referenced by this database when local storage is used.
    storage_root = Path(os.getenv("AUDIO_STORAGE_DIR") or (ROOT / "backend" / "storage" / "audio")).resolve()
    for recording in db["audio_recordings"].find({}, {"storage_key": 1}):
        key = recording.get("storage_key")
        if not key:
            continue
        target = (storage_root / key).resolve()
        try:
            if storage_root in target.parents and target.is_file():
                target.unlink()
        except OSError:
            pass

    for name in COLLECTIONS:
        result = db[name].delete_many({})
        counts[name] = result.deleted_count
    client.close()
    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description="Wipe Store Listen recordings and conversations.")
    parser.add_argument("--yes", action="store_true", help="Required to perform the wipe.")
    parser.add_argument("--dry-run", action="store_true", help="Only print counts.")
    parser.add_argument(
        "--databases",
        default="storelisten,storelisten_render_demo",
        help="Comma-separated Mongo database names.",
    )
    args = parser.parse_args()
    uri = (os.getenv("MONGODB_URI") or "").strip()
    if not uri:
        print("MONGODB_URI is required in .env", file=sys.stderr)
        return 1
    if not args.yes and not args.dry_run:
        print("Refusing to wipe without --yes (or use --dry-run).", file=sys.stderr)
        return 2

    for database_name in [item.strip() for item in args.databases.split(",") if item.strip()]:
        counts = wipe_database(uri, database_name, dry_run=args.dry_run)
        mode = "dry-run" if args.dry_run else "deleted"
        print(f"[{mode}] {database_name}: {counts}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
