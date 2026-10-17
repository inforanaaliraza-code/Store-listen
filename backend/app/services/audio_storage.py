from __future__ import annotations

import os
import tempfile
from datetime import UTC, datetime
from fractions import Fraction
from pathlib import Path
from uuid import uuid4

from app.config import settings
from app.database import mongo_database
from app.models import AudioRecording

# MongoDB documents cap at 16 MB. Store clips stay well under this; oversized files stay on local disk only.
_MAX_DURABLE_BYTES = 14_000_000
_blob_index_ready = False

_EXTENSIONS = {
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/mp4": ".m4a",
    "audio/mpeg": ".mp3",
}


def _blob_collection():
    global _blob_index_ready
    if mongo_database is None:
        return None
    collection = mongo_database["audio_blobs"]
    if not _blob_index_ready:
        collection.create_index("storage_key", unique=True)
        _blob_index_ready = True
    return collection


def _clip_target(storage_key: str) -> Path:
    root = Path(settings.audio_storage_dir).resolve()
    target = (root / storage_key).resolve()
    if root not in target.parents:
        raise FileNotFoundError("Audio recording is unavailable.")
    return target


def _write_clip(target: Path, data: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_path = tempfile.mkstemp(dir=target.parent, suffix=".upload")
    try:
        with os.fdopen(fd, "wb") as audio_file:
            audio_file.write(data)
            audio_file.flush()
        os.replace(temporary_path, target)
    finally:
        try:
            os.unlink(temporary_path)
        except FileNotFoundError:
            pass


def _persist_blob(storage_key: str, data: bytes, content_type: str) -> None:
    if len(data) > _MAX_DURABLE_BYTES:
        return
    collection = _blob_collection()
    if collection is None:
        return
    collection.replace_one(
        {"storage_key": storage_key},
        {
            "storage_key": storage_key,
            "data": data,
            "content_type": content_type,
            "byte_size": len(data),
        },
        upsert=True,
    )


def _load_blob(storage_key: str) -> bytes | None:
    collection = _blob_collection()
    if collection is None:
        return None
    document = collection.find_one({"storage_key": storage_key}, {"data": 1})
    if not document or document.get("data") is None:
        return None
    return bytes(document["data"])


def _delete_blob(storage_key: str) -> None:
    collection = _blob_collection()
    if collection is None:
        return
    collection.delete_many({"storage_key": storage_key})


def save_audio_clip(data: bytes, content_type: str, captured_at: datetime | None = None) -> str:
    extension = _EXTENSIONS.get(content_type)
    if extension is None:
        raise ValueError("Unsupported audio content type.")
    captured_at = captured_at or datetime.now(UTC)
    key = f"{captured_at:%Y/%m/%d}/{uuid4().hex}{extension}"
    target = _clip_target(key)
    _write_clip(target, data)
    _persist_blob(key, data, content_type)
    return key


def resolve_audio_clip(storage_key: str) -> Path:
    target = _clip_target(storage_key)
    if target.is_file():
        return target
    data = _load_blob(storage_key)
    if data is None:
        raise FileNotFoundError("Audio recording is unavailable.")
    _write_clip(target, data)
    return target


def delete_audio_clip(storage_key: str) -> None:
    try:
        target = _clip_target(storage_key)
        if target.is_file():
            target.unlink()
    except FileNotFoundError:
        pass
    _delete_blob(storage_key)


def merge_audio_clips(recordings: list[AudioRecording]) -> bytes:
    if not recordings:
        raise ValueError("At least one audio clip is required to create an overall recording.")
    try:
        import av
    except ImportError as exc:
        raise RuntimeError("Install backend requirements to combine conversation audio.") from exc

    fd, output_path = tempfile.mkstemp(suffix=".webm")
    os.close(fd)
    output = None
    output_stream = None
    next_pts = 0
    try:
        output = av.open(output_path, mode="w", format="webm")
        output_stream = output.add_stream("libopus", rate=48_000)
        output_stream.layout = "mono"
        resampler = av.AudioResampler(format="fltp", layout="mono", rate=48_000)
        ordered = sorted(recordings, key=lambda item: (item.sequence, item.captured_at))
        for recording in ordered:
            with av.open(str(resolve_audio_clip(recording.storage_key))) as source:
                audio_stream = next((stream for stream in source.streams if stream.type == "audio"), None)
                if audio_stream is None:
                    continue
                for input_frame in source.decode(audio_stream):
                    for frame in resampler.resample(input_frame):
                        frame.pts = next_pts
                        frame.time_base = Fraction(1, 48_000)
                        next_pts += frame.samples
                        for packet in output_stream.encode(frame):
                            output.mux(packet)
        if next_pts == 0:
            raise ValueError("No audio samples were found in the conversation clips.")
        for packet in output_stream.encode(None):
            output.mux(packet)
        output.close()
        output = None
        return Path(output_path).read_bytes()
    finally:
        if output is not None:
            output.close()
        try:
            os.unlink(output_path)
        except FileNotFoundError:
            pass


def cleanup_expired_audio(db, now: datetime | None = None) -> int:
    now = now or datetime.now(UTC)
    expired = db.query(AudioRecording).filter(AudioRecording.retain_until <= now).all()
    for recording in expired:
        delete_audio_clip(recording.storage_key)
        db.delete(recording)
    if expired:
        db.commit()
    return len(expired)