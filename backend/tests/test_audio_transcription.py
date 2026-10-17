from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.models import (
    AiProcessingRun,
    AudioRecording,
    Conversation,
    ConversationParticipant,
    CustomerIntent,
    DailyReport,
    MissedOpportunity,
    ProductOpportunity,
    SalesRecommendation,
    TranscriptSegment,
)
from app.providers.speech import (
    NoSpeechDetected,
    SpeechResult,
    UnsupportedLanguageDetected,
    WhisperSpeechProvider,
    normalize_supported_language,
)
from app.services.audio_storage import cleanup_expired_audio, delete_audio_clip, resolve_audio_clip, save_audio_clip

client = TestClient(app)


def test_whisper_tempfile_is_closed_before_transcription(monkeypatch):
    seen = {}

    class DummyHandle:
        def __init__(self):
            self.closed = False

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc_value, traceback):
            self.close()

        def write(self, payload):
            return None

        def flush(self):
            return None

        def close(self):
            self.closed = True

    handle = DummyHandle()

    def fake_transcribe_file(self, audio_path: str, language_hint: str | None = None):
        seen["audio_path"] = audio_path
        if not handle.closed:
            raise AssertionError("Temporary audio file should be closed before Whisper reads it.")
        return SpeechResult(
            original_text="hello there",
            language="en",
            translated_text="hello there",
            confidence=0.92,
            is_final=True,
            speaker_id="spk-unassigned",
        )

    monkeypatch.setattr(WhisperSpeechProvider, "transcribe_file", fake_transcribe_file)

    class FakeMkstemp:
        def __call__(self, suffix):
            handle.closed = False
            return 3, "C:/tmp/whisper-voice.webm"

    monkeypatch.setattr("tempfile.mkstemp", FakeMkstemp())
    monkeypatch.setattr("os.fdopen", lambda fd, mode: handle)
    monkeypatch.setattr("os.unlink", lambda path: None)

    result = WhisperSpeechProvider().transcribe(b"sample audio", "en")

    assert result.original_text == "hello there"
    assert seen["audio_path"] == "C:/tmp/whisper-voice.webm"


def test_whisper_rejects_languages_outside_english_and_spanish(monkeypatch, tmp_path):
    from types import SimpleNamespace

    class FrenchModel:
        def transcribe(self, audio_path, **kwargs):
            segment = SimpleNamespace(
                text="Je voudrais acheter un telephone s'il vous plait",
                avg_logprob=-0.1,
            )
            return iter([segment]), SimpleNamespace(language="fr")

    monkeypatch.setattr(WhisperSpeechProvider, "_get_model", lambda _self: FrenchModel())

    with pytest.raises(UnsupportedLanguageDetected):
        WhisperSpeechProvider().transcribe_file(tmp_path / "french.wav")


def test_supported_languages_are_english_and_spanish_only():
    assert normalize_supported_language("en-US") == "en"
    assert normalize_supported_language("es-MX") == "es"
    assert normalize_supported_language("hi-IN") is None
    assert normalize_supported_language("ur-PK") is None
    assert normalize_supported_language("fr-FR") is None


def test_audio_preview_is_disabled_by_default_for_latency(monkeypatch):
    from app import api as api_module
    from app.config import settings

    monkeypatch.setattr(settings, "whisper_preview_enabled", False)
    client.cookies.clear()
    login = client.post("/api/v1/auth/login", json={"email": "admin@storelisten.demo", "password": "StoreListen!2026"})
    headers = {"Authorization": f"Bearer {login.json()['token']}"}
    session = client.post("/api/v1/audio/sessions", headers=headers, json={"store_id": "store-001"})
    conversation_id = session.json()["conversation_id"]
    response = client.post(
        "/api/v1/audio/transcribe/preview",
        headers=headers,
        data={"store_id": "store-001", "conversation_id": conversation_id, "capture_sequence": 2, "preview_sequence": 3},
        files={"audio": ("live-preview.webm", b"partial audio", "audio/webm")},
    )
    assert response.status_code == 200, response.text
    assert response.json()["segment"] is None
    assert response.json()["preview_status"] == "disabled_for_latency"


def test_audio_preview_broadcasts_partial_without_saving_audio_or_transcript(monkeypatch):
    from app import api as api_module
    from app.config import settings

    class SpanishSpeechProvider:
        name = "test-whisper"

        def transcribe_file(self, audio_path: str, language_hint: str | None = None) -> SpeechResult:
            return SpeechResult("Hola, necesito un cargador", "es", "Hello, I need a charger", 0.91, False)

    events = []

    async def capture_event(room, event):
        events.append((room, event))

    monkeypatch.setattr(settings, "whisper_preview_enabled", True)
    monkeypatch.setattr(api_module, "get_speech_provider", lambda _name: SpanishSpeechProvider())
    monkeypatch.setattr(api_module.hub, "publish", capture_event)
    client.cookies.clear()
    login = client.post("/api/v1/auth/login", json={"email": "admin@storelisten.demo", "password": "StoreListen!2026"})
    headers = {"Authorization": f"Bearer {login.json()['token']}"}
    session = client.post("/api/v1/audio/sessions", headers=headers, json={"store_id": "store-001"})
    conversation_id = session.json()["conversation_id"]
    events.clear()

    response = client.post(
        "/api/v1/audio/transcribe/preview",
        headers=headers,
        data={"store_id": "store-001", "conversation_id": conversation_id, "capture_sequence": 2, "preview_sequence": 3},
        files={"audio": ("live-preview.webm", b"partial audio", "audio/webm")},
    )

    assert response.status_code == 200, response.text
    assert response.json()["segment"]["originalText"].startswith("Hola")
    assert response.json()["segment"]["translatedText"] == "Hello, I need a charger"
    assert response.json()["segment"]["isFinal"] is False
    assert response.json()["segment"]["captureSequence"] == 2
    assert response.json()["segment"]["previewSequence"] == 3
    assert any(room == "store:store-001" and event["event"] == "transcript.partial" for room, event in events)
    db = SessionLocal()
    try:
        assert db.query(AudioRecording).filter(AudioRecording.conversation_id == conversation_id).count() == 0
        assert db.query(TranscriptSegment).filter(TranscriptSegment.conversation_id == conversation_id).count() == 0
    finally:
        db.query(Conversation).filter(Conversation.id == conversation_id).delete(synchronize_session=False)
        db.commit()
        db.close()


def test_whisper_uses_configured_low_latency_beam_size(monkeypatch, tmp_path):
    from types import SimpleNamespace

    from app.config import settings

    calls = []

    class FastModel:
        def transcribe(self, audio_path, **kwargs):
            calls.append(kwargs)
            return iter([SimpleNamespace(text="hello", avg_logprob=-0.1)]), SimpleNamespace(language="en")

    monkeypatch.setattr(settings, "whisper_beam_size", 1)
    monkeypatch.setattr(WhisperSpeechProvider, "_get_model", lambda _self: FastModel())
    audio_path = tmp_path / "sample.webm"
    audio_path.write_bytes(b"sample audio")

    result = WhisperSpeechProvider().transcribe_file(audio_path, "en")

    assert result.original_text == "hello"
    assert calls[0]["beam_size"] == 1
    assert calls[0]["best_of"] == 1
    assert calls[0]["temperature"] == 0.0
    assert calls[0]["vad_filter"] is True
    assert calls[0]["without_timestamps"] is True
    assert calls[0]["word_timestamps"] is False
    assert calls[0]["no_speech_threshold"] == 0.65


def test_whisper_skips_second_spanish_translation_pass_by_default(monkeypatch, tmp_path):
    from types import SimpleNamespace

    from app.config import settings

    calls = []

    class FastSpanishModel:
        def transcribe(self, audio_path, **kwargs):
            calls.append(kwargs)
            return iter([SimpleNamespace(text="Hola, necesito ayuda", avg_logprob=-0.1)]), SimpleNamespace(language="es")

    monkeypatch.setattr(settings, "whisper_translate_spanish", False)
    monkeypatch.setattr(WhisperSpeechProvider, "_get_model", lambda _self: FastSpanishModel())
    audio_path = tmp_path / "spanish.webm"
    audio_path.write_bytes(b"sample audio")

    result = WhisperSpeechProvider().transcribe_file(audio_path)

    assert result.language == "es"
    assert result.original_text == "Hola, necesito ayuda"
    assert result.translated_text == result.original_text
    assert len(calls) == 1


def test_whisper_can_keep_optional_spanish_translation(monkeypatch, tmp_path):
    from types import SimpleNamespace

    from app.config import settings

    calls = []

    class SpanishModel:
        def transcribe(self, audio_path, **kwargs):
            calls.append(kwargs)
            language = kwargs.get("language") or "es"
            text = "Hello, I need help" if kwargs.get("task") == "translate" else "Hola, necesito ayuda"
            return iter([SimpleNamespace(text=text, avg_logprob=-0.1)]), SimpleNamespace(language=language)

    monkeypatch.setattr(settings, "whisper_translate_spanish", True)
    monkeypatch.setattr(WhisperSpeechProvider, "_get_model", lambda _self: SpanishModel())
    audio_path = tmp_path / "spanish.webm"
    audio_path.write_bytes(b"sample audio")

    result = WhisperSpeechProvider().transcribe_file(audio_path)

    assert result.original_text == "Hola, necesito ayuda"
    assert result.translated_text == "Hello, I need help"
    assert calls[1]["task"] == "translate"


def test_api_does_not_save_transcripts_for_unsupported_languages(monkeypatch):
    from app import api as api_module

    class FrenchSpeechProvider:
        name = "test-french"

        def transcribe_file(self, audio_path: str, language_hint: str | None = None) -> SpeechResult:
            return SpeechResult("Bonjour", "fr", "Hello", 0.95, True)

    monkeypatch.setattr(api_module, "get_speech_provider", lambda _name: FrenchSpeechProvider())
    client.cookies.clear()
    login = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@storelisten.demo", "password": "StoreListen!2026"},
    )
    headers = {"Authorization": f"Bearer {login.json()['token']}"}
    conversation_id = f"conv-unsupported-language-{uuid4().hex}"
    db = SessionLocal()
    db.add(
        Conversation(
            id=conversation_id,
            store_id="store-001",
            status="LIVE",
            primary_language="und",
            opportunity_status="UNKNOWN",
        )
    )
    db.commit()
    db.close()

    try:
        response = client.post(
            "/api/v1/audio/transcribe",
            headers=headers,
            data={"store_id": "store-001", "conversation_id": conversation_id},
            files={"audio": ("french.webm", b"french audio", "audio/webm")},
        )
        assert response.status_code == 200, response.text
        assert response.json()["segment"] is None
        assert response.json()["analysis_status"] == "unsupported_language"
        assert response.json()["detected_language"] == "fr"
        transcript = client.get(f"/api/v1/conversations/{conversation_id}/transcript", headers=headers)
        assert transcript.json()["segments"] == []
    finally:
        db = SessionLocal()
        try:
            recordings = db.query(AudioRecording).filter(AudioRecording.conversation_id == conversation_id).all()
            for recording in recordings:
                delete_audio_clip(recording.storage_key)
                db.delete(recording)
            db.query(Conversation).filter(Conversation.id == conversation_id).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()


def test_audio_clip_is_restored_after_local_disk_is_cleared(tmp_path, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "audio_storage_dir", str(tmp_path))
    storage_key = save_audio_clip(b"durable-audio", "audio/webm")
    local_path = resolve_audio_clip(storage_key)
    local_path.unlink()
    assert not local_path.exists()

    restored = resolve_audio_clip(storage_key)
    assert restored.read_bytes() == b"durable-audio"

    delete_audio_clip(storage_key)
    restored.unlink(missing_ok=True)
    with pytest.raises(FileNotFoundError):
        resolve_audio_clip(storage_key)


def test_expired_audio_cleanup_removes_file_and_metadata(tmp_path, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "audio_storage_dir", str(tmp_path))
    now = datetime.now(UTC)
    storage_key = save_audio_clip(b"expired audio", "audio/webm", now - timedelta(days=8))
    recording = AudioRecording(
        id=f"audio-expired-{uuid4().hex}",
        store_id="store-001",
        storage_key=storage_key,
        content_type="audio/webm",
        byte_size=13,
        duration_seconds=1,
        sequence=1,
        speaker_role="unknown",
        captured_at=now - timedelta(days=8),
        retain_until=now - timedelta(days=1),
    )
    db = SessionLocal()
    try:
        db.add(recording)
        db.commit()
        audio_path = resolve_audio_clip(storage_key)
        assert audio_path.exists()
        assert cleanup_expired_audio(db, now) == 1
        assert not audio_path.exists()
        assert db.get(AudioRecording, recording.id) is None
    finally:
        db.close()


class DeterministicSpeechProvider:
    name = "test-local-whisper"

    def transcribe_file(self, audio_path: str, language_hint: str | None = None) -> SpeechResult:
        if language_hint == "en":
            return SpeechResult(
                original_text="Yes, I work here. Which charger do you need?",
                language="en",
                translated_text="Yes, I work here. Which charger do you need?",
                confidence=0.94,
                is_final=True,
                speaker_id="spk-unassigned",
            )
        return SpeechResult(
            original_text="Necesito un cargador para mi teléfono.",
            language="es",
            translated_text="I need a charger for my phone.",
            confidence=0.91,
            is_final=True,
            speaker_id="spk-unassigned",
        )


def test_silent_audio_is_stored_without_creating_a_transcript_or_failing(monkeypatch):
    from app import api as api_module

    class SilentSpeechProvider:
        name = "test-silent"

        def transcribe_file(self, audio_path: str, language_hint: str | None = None) -> SpeechResult:
            raise NoSpeechDetected("No speech was detected in this audio clip.")

    monkeypatch.setattr(api_module, "get_speech_provider", lambda _name: SilentSpeechProvider())
    client.cookies.clear()
    login = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@storelisten.demo", "password": "StoreListen!2026"},
    )
    headers = {"Authorization": f"Bearer {login.json()['token']}"}
    conversation_id = f"conv-silence-test-{uuid4().hex}"
    db = SessionLocal()
    db.add(
        Conversation(
            id=conversation_id,
            store_id="store-001",
            status="LIVE",
            primary_language="und",
            opportunity_status="UNKNOWN",
        )
    )
    db.commit()
    db.close()

    try:
        response = client.post(
            "/api/v1/audio/transcribe",
            headers=headers,
            data={"store_id": "store-001", "conversation_id": conversation_id, "speaker_role": "unknown"},
            files={"audio": ("silent.webm", b"silent audio", "audio/webm")},
        )
        assert response.status_code == 200, response.text
        assert response.json()["segment"] is None
        assert response.json()["analysis_status"] == "no_speech"
        assert response.json()["raw_audio_stored"] is True
        transcript = client.get(f"/api/v1/conversations/{conversation_id}/transcript", headers=headers)
        assert transcript.status_code == 200
        assert transcript.json()["segments"] == []
    finally:
        db = SessionLocal()
        try:
            recordings = db.query(AudioRecording).filter(AudioRecording.conversation_id == conversation_id).all()
            for recording in recordings:
                delete_audio_clip(recording.storage_key)
                db.delete(recording)
            db.query(TranscriptSegment).filter(TranscriptSegment.conversation_id == conversation_id).delete(synchronize_session=False)
            db.query(ConversationParticipant).filter(ConversationParticipant.conversation_id == conversation_id).delete(synchronize_session=False)
            db.query(Conversation).filter(Conversation.id == conversation_id).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()


def test_audio_upload_keeps_operator_selected_customer_and_staff_roles(monkeypatch):
    from app import api as api_module
    from app.config import settings

    monkeypatch.setattr(api_module, "get_speech_provider", lambda _name: DeterministicSpeechProvider())
    monkeypatch.setattr(api_module, "merge_audio_clips", lambda _recordings: b"overall-test-recording")
    monkeypatch.setattr(settings, "ai_provider", "mock")
    client.cookies.clear()
    login = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@storelisten.demo", "password": "StoreListen!2026"},
    )
    assert login.status_code == 200
    headers = {"Authorization": f"Bearer {login.json()['token']}"}
    conversation_id = f"conv-audio-test-{uuid4().hex}"
    db = SessionLocal()
    db.add(
        Conversation(
            id=conversation_id,
            store_id="store-001",
            employee_id="employee-001",
            status="LIVE",
            primary_language="und",
            opportunity_status="UNKNOWN",
        )
    )
    db.commit()
    db.close()
    customer = client.post(
        "/api/v1/audio/transcribe",
        headers=headers,
        data={"store_id": "store-001", "speaker_role": "customer", "conversation_id": conversation_id},
        files={"audio": ("customer.webm", b"test customer audio", "audio/webm")},
    )
    assert customer.status_code == 200, customer.text
    assert customer.json()["conversation_id"] == conversation_id
    assert customer.json()["segment"]["speakerLabel"] == "Customer (operator selected)"
    assert customer.json()["segment"]["language"] == "es"
    assert customer.json()["segment"]["translatedText"] == "I need a charger for my phone."
    assert customer.json()["raw_audio_stored"] is True
    customer_audio_path = f"/api/v1/audio/recordings/{customer.json()['audio_recording_id']}"
    assert client.get(customer_audio_path, headers=headers).content == b"test customer audio"
    recording_list = client.get(f"/api/v1/conversations/{conversation_id}/audio", headers=headers).json()["recordings"]
    assert len(recording_list) == 1
    assert recording_list[0]["playback_path"] == customer_audio_path

    staff = client.post(
        "/api/v1/audio/transcribe",
        headers=headers,
        data={
            "store_id": "store-001",
            "speaker_role": "employee",
            "employee_id": "employee-001",
            "conversation_id": conversation_id,
            "language_hint": "en",
            "capture_sequence": "2",
            "duration_seconds": "7.5",
            "session_offset_seconds": "8",
        },
        files={"audio": ("staff.webm", b"test staff audio", "audio/webm")},
    )
    assert staff.status_code == 200, staff.text
    assert staff.json()["segment"]["speakerLabel"] == "Staff: Maya Rivera (operator selected)"
    assert staff.json()["analysis"]["intent"] == "employee_response"
    assert staff.json()["analysis"]["opportunity"] is False

    db = SessionLocal()
    try:
        participants = db.query(ConversationParticipant).filter(ConversationParticipant.conversation_id == conversation_id).all()
        assert {(participant.mapped_role, participant.employee_id) for participant in participants} == {
            ("customer", None),
            ("employee", "employee-001"),
        }
        segments = db.query(TranscriptSegment).filter(TranscriptSegment.conversation_id == conversation_id).all()
        assert len(segments) == 2
        assert {segment.speaker_id for segment in segments} == {"speaker-customer", "speaker-employee-001"}
        assert {segment.language for segment in segments} == {"es", "en"}
        segment_by_speaker = {segment.speaker_id: segment for segment in segments}
        assert (segment_by_speaker["speaker-customer"].start_time, segment_by_speaker["speaker-customer"].end_time) == (0, 8)
        assert (segment_by_speaker["speaker-employee-001"].start_time, segment_by_speaker["speaker-employee-001"].end_time) == (8, 15.5)
        ordered = client.get(f"/api/v1/conversations/{conversation_id}/transcript", headers=headers).json()["segments"]
        assert [segment["speaker_id"] for segment in ordered] == ["speaker-customer", "speaker-employee-001"]
        transcript = client.get(f"/api/v1/conversations/{conversation_id}/transcript", headers=headers)
        assert transcript.status_code == 200
        role_by_speaker = {
            row["speaker_id"]: (row["speaker_role"], row["speaker_label"], row["employee_id"])
            for row in transcript.json()["segments"]
        }
        assert role_by_speaker["speaker-customer"] == ("customer", "Customer (operator selected)", None)
        assert role_by_speaker["speaker-employee-001"] == (
            "employee",
            "Staff: Maya Rivera (operator selected)",
            "employee-001",
        )
    finally:
        recordings = db.query(AudioRecording).filter(AudioRecording.conversation_id == conversation_id).all()
        for recording in recordings:
            delete_audio_clip(recording.storage_key)
        db.query(AudioRecording).filter(AudioRecording.conversation_id == conversation_id).delete(synchronize_session=False)
        db.query(MissedOpportunity).filter(MissedOpportunity.conversation_id == conversation_id).delete(synchronize_session=False)
        db.query(ProductOpportunity).filter(ProductOpportunity.conversation_id == conversation_id).delete(synchronize_session=False)
        db.query(SalesRecommendation).filter(SalesRecommendation.conversation_id == conversation_id).delete(synchronize_session=False)
        db.query(CustomerIntent).filter(CustomerIntent.conversation_id == conversation_id).delete(synchronize_session=False)
        db.query(AiProcessingRun).filter(AiProcessingRun.conversation_id == conversation_id).delete(synchronize_session=False)
        db.query(TranscriptSegment).filter(TranscriptSegment.conversation_id == conversation_id).delete(synchronize_session=False)
        db.query(ConversationParticipant).filter(ConversationParticipant.conversation_id == conversation_id).delete(synchronize_session=False)
        db.query(Conversation).filter(Conversation.id == conversation_id).delete(synchronize_session=False)
        db.commit()
        db.close()


def test_unknown_audio_role_is_not_assigned_to_customer(monkeypatch):
    from app import api as api_module
    from app.config import settings

    monkeypatch.setattr(api_module, "get_speech_provider", lambda _name: DeterministicSpeechProvider())
    monkeypatch.setattr(api_module, "merge_audio_clips", lambda _recordings: b"overall-test-recording")
    monkeypatch.setattr(settings, "ai_provider", "mock")
    client.cookies.clear()
    login = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@storelisten.demo", "password": "StoreListen!2026"},
    )
    headers = {"Authorization": f"Bearer {login.json()['token']}"}
    session = client.post("/api/v1/audio/sessions", headers=headers, json={"store_id": "store-001"})
    assert session.status_code == 200
    conversation_id = session.json()["conversation_id"]

    response = client.post(
        "/api/v1/audio/transcribe",
        headers=headers,
        data={"store_id": "store-001", "speaker_role": "unknown", "conversation_id": conversation_id},
        files={"audio": ("mixed.webm", b"mixed conversation", "audio/webm")},
    )

    assert response.status_code == 200, response.text
    assert response.json()["segment"]["speakerLabel"] == "Speaker"
    assert response.json()["transcription_ms"] >= 0
    assert response.json()["analysis"] is None
    assert response.json()["analysis_status"] == "speaker_unattributed"
    finished = client.post(f"/api/v1/audio/sessions/{conversation_id}/finish", headers=headers)
    assert finished.status_code == 200
    assert finished.json()["status"] == "ENDED"
    daily_report = client.post("/api/v1/reports/daily/generate", headers=headers, json={"store_id": "store-001"})
    assert daily_report.status_code == 200, daily_report.text
    report_payload = daily_report.json()
    charger_signal = next(
        mention for mention in report_payload["daily_analysis"]["potential_product_mentions"]
        if mention["product"] == "phone charger"
    )
    assert charger_signal["count"] >= 1
    assert charger_signal["unattributed_clips"] >= 1
    assert report_payload["daily_analysis"]["staff_interaction_signals"]["coverage"] == "insufficient_staff_attribution"

    db = SessionLocal()
    try:
        recording = db.query(AudioRecording).filter(AudioRecording.conversation_id == conversation_id).one()
        delete_audio_clip(recording.storage_key)
        db.query(AudioRecording).filter(AudioRecording.conversation_id == conversation_id).delete(synchronize_session=False)
        db.query(DailyReport).filter(DailyReport.id == f"daily-store-001-{report_payload['business_date']}").delete(synchronize_session=False)
        db.query(TranscriptSegment).filter(TranscriptSegment.conversation_id == conversation_id).delete(synchronize_session=False)
        db.query(ConversationParticipant).filter(ConversationParticipant.conversation_id == conversation_id).delete(synchronize_session=False)
        db.query(AiProcessingRun).filter(AiProcessingRun.conversation_id == conversation_id).delete(synchronize_session=False)
        db.query(Conversation).filter(Conversation.id == conversation_id).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


def test_finish_audio_session_replaces_source_clips_with_one_master(monkeypatch, tmp_path):
    from app import api as api_module
    from app.config import settings

    monkeypatch.setattr(settings, "audio_storage_dir", str(tmp_path))
    monkeypatch.setattr(api_module, "merge_audio_clips", lambda _recordings: b"overall-webm-recording")
    client.cookies.clear()
    login = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@storelisten.demo", "password": "StoreListen!2026"},
    )
    headers = {"Authorization": f"Bearer {login.json()['token']}"}
    started = client.post("/api/v1/audio/sessions", headers=headers, json={"store_id": "store-001"})
    assert started.status_code == 200
    conversation_id = started.json()["conversation_id"]
    captured_at = datetime.now(UTC)
    source_ids = [f"audio-source-{uuid4().hex[:12]}" for _ in range(2)]
    source_keys = [save_audio_clip(f"source-{index}".encode(), "audio/webm", captured_at) for index in range(2)]
    db = SessionLocal()
    try:
        db.add_all([
            AudioRecording(
                id=source_ids[index],
                store_id="store-001",
                conversation_id=conversation_id,
                storage_key=source_keys[index],
                content_type="audio/webm",
                byte_size=9,
                duration_seconds=2,
                sequence=index + 1,
                speaker_role="unknown",
                captured_at=captured_at + timedelta(seconds=index * 3),
                retain_until=captured_at + timedelta(days=7),
            )
            for index in range(2)
        ])
        db.commit()
    finally:
        db.close()

    finished = client.post(f"/api/v1/audio/sessions/{conversation_id}/finish", headers=headers)
    assert finished.status_code == 200, finished.text
    assert finished.json()["recordings"] == 1
    assert finished.json()["recording_id"]

    detail_audio = client.get(f"/api/v1/conversations/{conversation_id}/audio", headers=headers)
    assert detail_audio.status_code == 200
    assert detail_audio.json()["total"] == 1
    assert len(detail_audio.json()["recordings"]) == 1

    library = client.get(f"/api/v1/recordings?store_id=store-001&page_size=100", headers=headers)
    visible_rows = [row for row in library.json()["recordings"] if row["conversation_id"] == conversation_id]
    assert len(visible_rows) == 1
    assert visible_rows[0]["id"] == finished.json()["recording_id"]

    cleanup = SessionLocal()
    try:
        for recording in cleanup.query(AudioRecording).filter(AudioRecording.conversation_id == conversation_id).all():
            delete_audio_clip(recording.storage_key)
            cleanup.delete(recording)
        cleanup.query(Conversation).filter(Conversation.id == conversation_id).delete(synchronize_session=False)
        cleanup.commit()
    finally:
        cleanup.close()


def test_merge_audio_clips_returns_decodable_webm(tmp_path, monkeypatch):
    from fractions import Fraction
    from io import BytesIO
    from types import SimpleNamespace

    import av
    import numpy as np

    from app.config import settings
    from app.services.audio_storage import merge_audio_clips

    monkeypatch.setattr(settings, "audio_storage_dir", str(tmp_path))
    captured_at = datetime.now(UTC)
    recordings = []
    for index in range(2):
        storage_key = f"synthetic-{index}.webm"
        with av.open(str(tmp_path / storage_key), mode="w", format="webm") as container:
            stream = container.add_stream("libopus", rate=48_000)
            stream.layout = "mono"
            frame = av.AudioFrame.from_ndarray(
                np.zeros((1, 4_800), dtype=np.float32), format="fltp", layout="mono"
            )
            frame.sample_rate = 48_000
            frame.pts = 0
            frame.time_base = Fraction(1, 48_000)
            for packet in stream.encode(frame):
                container.mux(packet)
            for packet in stream.encode(None):
                container.mux(packet)
        recordings.append(SimpleNamespace(
            sequence=index + 1,
            captured_at=captured_at + timedelta(seconds=index),
            storage_key=storage_key,
        ))

    merged = merge_audio_clips(recordings)
    with av.open(BytesIO(merged), mode="r", format="webm") as container:
        decoded_samples = sum(frame.samples for frame in container.decode(audio=0))

    assert len(merged) > 0
    assert decoded_samples >= 9_600



def test_audio_upload_rejects_unselected_or_wrong_store_staff():
    client.cookies.clear()
    login = client.post(
        "/api/v1/auth/login",
        json={"email": "manager@storelisten.demo", "password": "StoreListen!2026"},
    )
    headers = {"Authorization": f"Bearer {login.json()['token']}"}
    audio = {"audio": ("staff.webm", b"not used", "audio/webm")}

    missing_staff = client.post(
        "/api/v1/audio/transcribe",
        headers=headers,
        data={"store_id": "store-001", "speaker_id": "speaker-02", "speaker_role": "employee"},
        files=audio,
    )
    assert missing_staff.status_code == 422

    wrong_store_staff = client.post(
        "/api/v1/audio/transcribe",
        headers=headers,
        data={
            "store_id": "store-001",
            "speaker_id": "speaker-avery",
            "speaker_role": "employee",
            "employee_id": "employee-003",
        },
        files=audio,
    )
    assert wrong_store_staff.status_code == 404
