from __future__ import annotations

import os
import tempfile
from datetime import UTC, datetime
from fractions import Fraction
from pathlib import Path
from uuid import uuid4

from app.config import settings
from app.models import AudioRecording

_EXTENSIONS = {
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/mp4": ".m4a",
    "audio/mpeg": ".mp3",
}


def save_audio_clip(data: bytes, content_type: str, captured_at: datetime | None = None) -> str:
    extension = _EXTENSIONS.get(content_type)
    if extension is None:
        raise ValueError("Unsupported audio content type.")
    captured_at = captured_at or datetime.now(UTC)
    key = f"{captured_at:%Y/%m/%d}/{uuid4().hex}{extension}"
    target = Path(settings.audio_storage_dir).resolve() / key
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
    return key


def resolve_audio_clip(storage_key: str) -> Path:
    root = Path(settings.audio_storage_dir).resolve()
    target = (root / storage_key).resolve()
    if root not in target.parents or not target.is_file():
        raise FileNotFoundError("Audio recording is unavailable.")
    return target


def delete_audio_clip(storage_key: str) -> None:
    try:
        resolve_audio_clip(storage_key).unlink()
    except FileNotFoundError:
        pass


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