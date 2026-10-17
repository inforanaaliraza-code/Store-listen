from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.providers.ai import MockAIProvider
from app.services.matching import match_transaction
from app.database import SessionLocal
from pymongo.errors import PyMongoError
from app.config import Settings, settings
from app.models import (
    AiProcessingRun,
    AudioRecording,
    Conversation,
    ConversationParticipant,
    PosTransaction,
    PosTransactionItem,
    ProductOpportunity,
    SalesRecommendation,
    TranscriptSegment,
)
from datetime import UTC, datetime
from datetime import timedelta
from uuid import uuid4


client = TestClient(app)


def test_production_settings_require_mongodb_uri() -> None:
    with pytest.raises(ValueError, match="valid TLS-enabled MongoDB MONGODB_URI"):
        Settings(app_env="production", demo_mode=False, debug=False, mongodb_uri="")


def test_production_settings_reject_mongodb_tls_disabled() -> None:
    with pytest.raises(ValueError, match="TLS-enabled MongoDB"):
        Settings(
            app_env="production",
            demo_mode=False,
            debug=False,
            mongodb_uri="mongodb+srv://cluster.example.invalid/storelisten?tls=false",
        )


def test_production_settings_fail_closed_without_real_pos_and_cloud_storage() -> None:
    with pytest.raises(ValueError, match="implemented POS adapter"):
        Settings(
            app_env="production",
            debug=False,
            demo_mode=False,
            mongodb_uri="mongodb+srv://test.example.invalid/storelisten",
            redis_url="rediss://redis.example.com:6380/0",
            redis_event_bus_enabled=True,
            jwt_secret="a" * 48,
            session_secret="b" * 48,
            api_base_url="https://api.example.com",
            web_base_url="https://app.example.com",
            cors_origins="https://app.example.com",
            ai_provider="openai",
            ai_api_key="provider-test-key-placeholder",
            speech_provider="whisper",
            pos_provider="square",
            storage_provider="s3",
        )


def test_production_settings_reject_plaintext_or_disabled_redis() -> None:
    with pytest.raises(ValueError, match="TLS-protected REDIS_URL"):
        Settings(
            app_env="production",
            debug=False,
            demo_mode=False,
            mongodb_uri="mongodb+srv://test.example.invalid/storelisten",
            jwt_secret="a" * 48,
            session_secret="b" * 48,
            api_base_url="https://api.example.com",
            cors_origins="https://app.example.com",
        )


def test_mongodb_uri_setting_accepts_atlas_scheme() -> None:
    configured = Settings(app_env="development", mongodb_uri="mongodb+srv://test.example.invalid/storelisten")
    assert configured.mongodb_uri.startswith("mongodb+srv://")


def test_websocket_requires_token() -> None:
    with pytest.raises(Exception):
        with client.websocket_connect("/ws/dashboard") as websocket:
            websocket.receive_text()


def test_websocket_dashboard_auth() -> None:
    login = client.post("/api/v1/auth/login", json={"email": "admin@storelisten.demo", "password": "StoreListen!2026"})
    token = login.json()["token"]
    with client.websocket_connect("/ws/dashboard", subprotocols=["storelisten.v1", token]) as websocket:
        websocket.send_text("ping")


def test_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_list_routes_apply_database_pagination() -> None:
    login_response = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@storelisten.demo", "password": "StoreListen!2026"},
    )
    headers = {"Authorization": f"Bearer {login_response.json()['token']}"}
    stores = client.get("/api/v1/stores?page=1&page_size=1", headers=headers).json()["stores"]
    conversations = client.get("/api/v1/conversations?page=1&page_size=1", headers=headers).json()["conversations"]
    opportunities = client.get("/api/v1/opportunities?page=1&page_size=1", headers=headers).json()["opportunities"]

    for page in (stores, conversations, opportunities):
        assert page["page"] == 1
        assert page["page_size"] == 1
        assert len(page["items"]) == 1
        assert page["total"] >= 1


def test_recordings_library_filters_dates_and_respects_store_scope() -> None:
    suffix = uuid4().hex
    captured_at = datetime.now(UTC)
    conversation_id = f"conv-recording-{suffix}"
    other_conversation_id = f"conv-recording-other-{suffix}"
    recording_id = f"audio-recording-{suffix}"
    other_recording_id = f"audio-recording-other-{suffix}"
    db = SessionLocal()
    db.add_all([
        Conversation(
            id=conversation_id,
            store_id="store-001",
            status="ENDED",
            primary_language="en",
            started_at=captured_at,
            opportunity_status="UNKNOWN",
        ),
        Conversation(
            id=other_conversation_id,
            store_id="store-002",
            status="ENDED",
            primary_language="en",
            started_at=captured_at,
            opportunity_status="UNKNOWN",
        ),
        AudioRecording(
            id=recording_id,
            store_id="store-001",
            conversation_id=conversation_id,
            storage_key=f"test/{recording_id}.webm",
            content_type="audio/webm",
            byte_size=120,
            duration_seconds=4,
            sequence=1,
            speaker_role="customer",
            captured_at=captured_at,
            retain_until=captured_at + timedelta(days=7),
        ),
        AudioRecording(
            id=other_recording_id,
            store_id="store-002",
            conversation_id=other_conversation_id,
            storage_key=f"test/{other_recording_id}.webm",
            content_type="audio/webm",
            byte_size=120,
            duration_seconds=4,
            sequence=1,
            speaker_role="customer",
            captured_at=captured_at,
            retain_until=captured_at + timedelta(days=7),
        ),
        TranscriptSegment(
            id=f"segment-{suffix}",
            conversation_id=conversation_id,
            speaker_id="speaker-customer",
            language="en",
            original_text="I need a phone charger.",
            translated_text="I need a phone charger.",
            start_time=0,
            end_time=3,
            confidence=0.95,
        ),
        AiProcessingRun(
            id=f"run-{suffix}",
            conversation_id=conversation_id,
            provider="mock",
            status="completed",
            input_excerpt="I need a phone charger.",
            output_json="{}",
        ),
    ])
    db.commit()
    db.close()

    admin_login = client.post("/api/v1/auth/login", json={"email": "admin@storelisten.demo", "password": "StoreListen!2026"})
    date_filter = captured_at.date().isoformat()
    response = client.get(
        f"/api/v1/recordings?from_date={date_filter}&to_date={date_filter}&page_size=100",
        headers={"Authorization": f"Bearer {admin_login.json()['token']}"},
    )
    assert response.status_code == 200
    rows = {row["id"]: row for row in response.json()["recordings"]}
    assert recording_id in rows and other_recording_id in rows
    assert rows[recording_id]["transcript_snippet"] == "I need a phone charger."
    assert rows[recording_id]["analysis_status"] == "analyzed"
    assert rows[recording_id]["audio_available"] is True

    manager_login = client.post("/api/v1/auth/login", json={"email": "manager@storelisten.demo", "password": "StoreListen!2026"})
    manager_response = client.get(
        "/api/v1/recordings?page_size=100",
        headers={"Authorization": f"Bearer {manager_login.json()['token']}"},
    )
    manager_ids = {row["id"] for row in manager_response.json()["recordings"]}
    assert recording_id in manager_ids
    assert other_recording_id not in manager_ids

    cleanup = SessionLocal()
    try:
        cleanup.query(AudioRecording).filter(AudioRecording.id.in_([recording_id, other_recording_id])).delete()
        cleanup.query(TranscriptSegment).filter(TranscriptSegment.id == f"segment-{suffix}").delete()
        cleanup.query(AiProcessingRun).filter(AiProcessingRun.id == f"run-{suffix}").delete()
        cleanup.query(Conversation).filter(Conversation.id.in_([conversation_id, other_conversation_id])).delete()
        cleanup.commit()
    finally:
        cleanup.close()


def test_conversation_analysis_only_processes_customer_speech_once() -> None:
    suffix = uuid4().hex
    conversation_id = f"conv-analysis-{suffix}"
    unknown_conversation_id = f"conv-analysis-unknown-{suffix}"
    customer_segment_id = f"segment-customer-{suffix}"
    staff_segment_id = f"segment-staff-{suffix}"
    unknown_segment_id = f"segment-unknown-{suffix}"
    db = SessionLocal()
    db.add_all([
        Conversation(
            id=conversation_id,
            store_id="store-001",
            status="ENDED",
            primary_language="en",
            started_at=datetime.now(UTC),
            opportunity_status="UNKNOWN",
        ),
        Conversation(
            id=unknown_conversation_id,
            store_id="store-001",
            status="ENDED",
            primary_language="en",
            started_at=datetime.now(UTC),
            opportunity_status="UNKNOWN",
        ),
        ConversationParticipant(
            id=f"participant-{suffix}",
            conversation_id=conversation_id,
            speaker_label="Customer (operator selected)",
            mapped_role="customer",
        ),
        TranscriptSegment(
            id=customer_segment_id,
            conversation_id=conversation_id,
            speaker_id="speaker-customer",
            language="en",
            original_text="I need a phone charger.",
            translated_text="I need a phone charger.",
            start_time=0,
            end_time=2,
            confidence=0.95,
        ),
        TranscriptSegment(
            id=staff_segment_id,
            conversation_id=conversation_id,
            speaker_id="speaker-employee-001",
            language="en",
            original_text="Let me help you.",
            translated_text="Let me help you.",
            start_time=3,
            end_time=5,
            confidence=0.95,
        ),
        TranscriptSegment(
            id=unknown_segment_id,
            conversation_id=unknown_conversation_id,
            speaker_id="speaker-unknown",
            language="en",
            original_text="I need a phone charger.",
            translated_text="I need a phone charger.",
            start_time=0,
            end_time=2,
            confidence=0.6,
        ),
    ])
    db.commit()
    db.close()

    login = client.post("/api/v1/auth/login", json={"email": "admin@storelisten.demo", "password": "StoreListen!2026"})
    headers = {"Authorization": f"Bearer {login.json()['token']}"}
    first = client.post(f"/api/v1/conversations/{conversation_id}/analysis", headers=headers)
    assert first.status_code == 200
    assert first.json()["analysis_status"] == "analyzed"
    assert first.json()["processed_segments"] == 1
    assert len(first.json()["opportunities"]) == 1

    second = client.post(f"/api/v1/conversations/{conversation_id}/analysis", headers=headers)
    assert second.status_code == 200
    assert second.json()["processed_segments"] == 0
    assert len(second.json()["opportunities"]) == 1
    unattributed = client.post(f"/api/v1/conversations/{unknown_conversation_id}/analysis", headers=headers)
    assert unattributed.status_code == 409

    cleanup = SessionLocal()
    try:
        cleanup.query(ProductOpportunity).filter(ProductOpportunity.conversation_id.in_([conversation_id, unknown_conversation_id])).delete()
        cleanup.query(SalesRecommendation).filter(SalesRecommendation.conversation_id == conversation_id).delete()
        cleanup.query(AiProcessingRun).filter(AiProcessingRun.conversation_id.in_([conversation_id, unknown_conversation_id])).delete()
        cleanup.query(ConversationParticipant).filter(ConversationParticipant.conversation_id == conversation_id).delete()
        cleanup.query(TranscriptSegment).filter(TranscriptSegment.id.in_([customer_segment_id, staff_segment_id, unknown_segment_id])).delete()
        cleanup.query(Conversation).filter(Conversation.id.in_([conversation_id, unknown_conversation_id])).delete()
        cleanup.commit()
    finally:
        cleanup.close()


def test_gemini_conversation_report_provider_parses_structured_output(monkeypatch) -> None:
    from app.providers import ai

    monkeypatch.setattr(settings, "ai_provider", "gemini")
    monkeypatch.setattr(settings, "gemini_api_key", "provider-test-key")
    request = {}

    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {"candidates": [{"content": {"parts": [{"text": json.dumps({
                "summary": "The customer asked for a phone charger.",
                "customer_needs": ["A compatible phone charger"],
                "customer_sentiment": "neutral",
                "products_discussed": ["phone charger"],
                "opportunity_type": "potential",
                "opportunity_summary": "Confirm the phone connector before recommending a charger.",
                "recommendation": "Ask which connector the customer needs.",
                "evidence": "The customer asked for a charger but did not specify a connector.",
                "confidence": 0.82,
            })}]} }]}

    def fake_post(url, **kwargs):
        request.update(url=url, **kwargs)
        return Response()

    monkeypatch.setattr(ai.httpx, "post", fake_post)
    report = ai.generate_conversation_report([{"role": "unknown", "language": "en", "time_seconds": 0, "text": "I need a phone charger."}])

    assert report.opportunity_type == "potential"
    assert report.customer_needs == ["A compatible phone charger"]
    assert request["headers"]["x-goog-api-key"] == "provider-test-key"
    assert "provider-test-key" not in request["url"]
    assert request["json"]["generationConfig"]["responseMimeType"] == "application/json"


def test_conversation_report_falls_back_to_groq_when_gemini_fails(monkeypatch) -> None:
    from app.providers import ai

    monkeypatch.setattr(settings, "ai_provider", "gemini")
    monkeypatch.setattr(settings, "gemini_api_key", "provider-test-key")
    monkeypatch.setattr(settings, "groq_api_key", "groq-test-key")

    def fail_gemini(*_args, **_kwargs):
        raise RuntimeError("Gemini report generation failed with HTTP 400.")

    class Message:
        content = json.dumps({
            "summary": "The speaker asked for a charger.",
            "customer_needs": ["phone charger"],
            "customer_sentiment": "neutral",
            "products_discussed": ["charger"],
            "opportunity_type": "potential",
            "opportunity_summary": "Ask which phone it is for.",
            "recommendation": "Confirm the connector.",
            "evidence": "The speaker asked for a charger.",
            "confidence": 0.7,
        })

    class Choice:
        message = Message()

    class Completion:
        choices = [Choice()]

    captured = {}

    class Completions:
        def create(self, **kwargs):
            captured.update(kwargs)
            return Completion()

    class Chat:
        completions = Completions()

    class FakeClient:
        def __init__(self, **kwargs):
            captured["client"] = kwargs
            self.chat = Chat()

    monkeypatch.setattr(ai, "_gemini_generate_json", fail_gemini)
    monkeypatch.setattr("openai.OpenAI", FakeClient)
    report = ai.generate_conversation_report([{"role": "unknown", "language": "en", "time_seconds": 0, "text": "I need a charger."}])
    assert report.provider == "groq"
    assert report.customer_needs == ["phone charger"]
    assert captured["model"] == "llama-3.1-8b-instant"
    assert captured["client"]["api_key"] == "groq-test-key"


def test_gemini_provider_remains_compatible_with_live_clip_analysis(monkeypatch) -> None:
    from app.providers import ai

    monkeypatch.setattr(settings, "ai_provider", "gemini")
    monkeypatch.setattr(settings, "gemini_api_key", "provider-test-key")

    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {"candidates": [{"content": {"parts": [{"text": json.dumps({
                "intent": "purchase_accessory",
                "product": "phone charger",
                "opportunity": True,
                "recommendation": "Ask which connector the customer needs.",
                "confidence": 0.84,
                "opportunity_type": "potential",
                "objections": [],
                "employee_response_quality": "unknown",
            })}]} }]}

    monkeypatch.setattr(ai.httpx, "post", lambda *_args, **_kwargs: Response())
    result = ai.get_ai_provider("gemini").analyze(
        "I need a phone charger.",
        "I need a phone charger.",
        "en",
        "customer",
    )

    assert result.product == "phone charger"
    assert result.opportunity is True
    assert result.confidence == 0.84


def test_conversation_report_persists_for_unattributed_transcript(monkeypatch) -> None:
    from app import api
    from app.providers.ai import ConversationReport

    suffix = uuid4().hex
    conversation_id = f"conv-report-{suffix}"
    segment_id = f"segment-report-{suffix}"
    monkeypatch.setattr(settings, "ai_provider", "gemini")
    monkeypatch.setattr(settings, "gemini_api_key", "provider-test-key")

    def fake_report(transcript):
        assert transcript[0]["role"] == "unknown"
        assert transcript[0]["text"] == "I need a phone charger."
        return ConversationReport(
            summary="The speaker asks about a phone charger.",
            customer_needs=["A phone charger"],
            customer_sentiment="neutral",
            products_discussed=["phone charger"],
            opportunity_type="potential",
            opportunity_summary="Confirm device compatibility.",
            recommendation="Ask which phone model they use.",
            evidence="The transcript mentions a phone charger.",
            confidence=0.8,
        )

    monkeypatch.setattr(api, "generate_conversation_report", fake_report)
    db = SessionLocal()
    db.add_all([
        Conversation(
            id=conversation_id,
            store_id="store-001",
            status="ENDED",
            primary_language="en",
            started_at=datetime.now(UTC),
            opportunity_status="UNKNOWN",
        ),
        TranscriptSegment(
            id=segment_id,
            conversation_id=conversation_id,
            speaker_id="speaker-unknown",
            language="en",
            original_text="I need a phone charger.",
            translated_text="I need a phone charger.",
            start_time=0,
            end_time=2,
            confidence=0.9,
        ),
    ])
    db.commit()
    db.close()

    login = client.post("/api/v1/auth/login", json={"email": "admin@storelisten.demo", "password": "StoreListen!2026"})
    headers = {"Authorization": f"Bearer {login.json()['token']}"}
    generated = client.post(f"/api/v1/conversations/{conversation_id}/report", headers=headers)
    assert generated.status_code == 200, generated.text
    assert generated.json()["report"]["customer_needs"] == ["A phone charger"]
    assert generated.json()["provider"] == "gemini"

    detail = client.get(f"/api/v1/conversations/{conversation_id}", headers=headers)
    assert detail.status_code == 200
    assert detail.json()["analysis_status"] == "analyzed"
    assert detail.json()["conversation_report"]["summary"] == "The speaker asks about a phone charger."

    cleanup = SessionLocal()
    try:
        from app.models import AuditLog

        cleanup.query(AuditLog).filter(AuditLog.entity_id == conversation_id, AuditLog.action == "conversation.report.generate").delete()
        cleanup.query(AiProcessingRun).filter(AiProcessingRun.conversation_id == conversation_id).delete()
        cleanup.query(TranscriptSegment).filter(TranscriptSegment.id == segment_id).delete()
        cleanup.query(Conversation).filter(Conversation.id == conversation_id).delete()
        cleanup.commit()
    finally:
        cleanup.close()


def test_conversation_report_transcribes_retained_audio_when_transcript_is_missing(monkeypatch) -> None:
    from app import api
    from app.models import AuditLog
    from app.providers.ai import ConversationReport
    from app.providers.speech import SpeechResult

    suffix = uuid4().hex
    conversation_id = f"conv-report-audio-{suffix}"
    recording_id = f"recording-report-audio-{suffix}"
    captured_at = datetime.now(UTC)
    monkeypatch.setattr(settings, "ai_provider", "gemini")
    monkeypatch.setattr(settings, "gemini_api_key", "provider-test-key")
    monkeypatch.setattr(api, "resolve_audio_clip", lambda _key: "test-audio.webm")

    class FakeSpeechProvider:
        def transcribe_file(self, _path):
            return SpeechResult("I need a phone charger.", "en", "I need a phone charger.", 0.9, True)

    def fake_report(transcript):
        assert transcript == [{"role": "unknown", "language": "en", "time_seconds": 0.0, "text": "I need a phone charger."}]
        return ConversationReport(
            summary="The speaker asks about a phone charger.",
            customer_needs=["A phone charger"],
            customer_sentiment="neutral",
            products_discussed=["phone charger"],
            opportunity_type="potential",
            opportunity_summary="Confirm device compatibility.",
            recommendation="Ask which phone model they use.",
            evidence="The transcript mentions a phone charger.",
            confidence=0.8,
        )

    monkeypatch.setattr(api, "get_speech_provider", lambda _name: FakeSpeechProvider())
    monkeypatch.setattr(api, "generate_conversation_report", fake_report)
    db = SessionLocal()
    db.add_all([
        Conversation(
            id=conversation_id,
            store_id="store-001",
            status="ENDED",
            primary_language="en",
            started_at=captured_at,
            opportunity_status="UNKNOWN",
        ),
        AudioRecording(
            id=recording_id,
            store_id="store-001",
            conversation_id=conversation_id,
            storage_key=f"test/{recording_id}.webm",
            content_type="audio/webm",
            byte_size=100,
            duration_seconds=2,
            sequence=1,
            speaker_role="unknown",
            captured_at=captured_at,
            retain_until=captured_at + timedelta(days=7),
        ),
    ])
    db.commit()
    db.close()

    login = client.post("/api/v1/auth/login", json={"email": "admin@storelisten.demo", "password": "StoreListen!2026"})
    headers = {"Authorization": f"Bearer {login.json()['token']}"}
    generated = client.post(f"/api/v1/conversations/{conversation_id}/report", headers=headers)
    assert generated.status_code == 200, generated.text
    assert generated.json()["transcript_generated"] is True
    assert generated.json()["transcript_segments"] == 1

    detail = client.get(f"/api/v1/conversations/{conversation_id}", headers=headers)
    assert detail.status_code == 200
    assert detail.json()["conversation_report"]["summary"] == "The speaker asks about a phone charger."

    cleanup = SessionLocal()
    try:
        cleanup.query(AuditLog).filter(AuditLog.entity_id == conversation_id, AuditLog.action == "conversation.report.generate").delete()
        cleanup.query(AiProcessingRun).filter(AiProcessingRun.conversation_id == conversation_id).delete()
        cleanup.query(TranscriptSegment).filter(TranscriptSegment.conversation_id == conversation_id).delete()
        cleanup.query(AudioRecording).filter(AudioRecording.id == recording_id).delete()
        cleanup.query(Conversation).filter(Conversation.id == conversation_id).delete()
        cleanup.commit()
    finally:
        cleanup.close()


def test_operator_can_attribute_transcript_before_generating_analysis() -> None:
    suffix = uuid4().hex
    conversation_id = f"conv-operator-analysis-{suffix}"
    segment_id = f"segment-operator-analysis-{suffix}"
    db = SessionLocal()
    db.add(Conversation(
        id=conversation_id,
        store_id="store-001",
        status="ENDED",
        primary_language="en",
        started_at=datetime.now(UTC),
        opportunity_status="UNKNOWN",
    ))
    db.add(TranscriptSegment(
        id=segment_id,
        conversation_id=conversation_id,
        speaker_id="speaker-unknown",
        language="en",
        original_text="I need a phone charger.",
        translated_text="I need a phone charger.",
        start_time=0,
        end_time=2,
        confidence=0.95,
    ))
    db.commit()
    db.close()

    login = client.post("/api/v1/auth/login", json={"email": "admin@storelisten.demo", "password": "StoreListen!2026"})
    headers = {"Authorization": f"Bearer {login.json()['token']}"}
    assignment = client.patch(
        f"/api/v1/conversations/{conversation_id}/transcript/{segment_id}/speaker",
        headers=headers,
        json={"speaker_role": "customer"},
    )
    assert assignment.status_code == 200
    assert assignment.json()["speaker_id"] == "speaker-customer"
    assert assignment.json()["speaker_role"] == "customer"

    transcript = client.get(f"/api/v1/conversations/{conversation_id}/transcript", headers=headers)
    assert transcript.status_code == 200
    assert transcript.json()["segments"][0]["speaker_label"] == "Customer (operator selected)"

    analysis = client.post(f"/api/v1/conversations/{conversation_id}/analysis", headers=headers)
    assert analysis.status_code == 200
    assert analysis.json()["processed_segments"] == 1
    locked_assignment = client.patch(
        f"/api/v1/conversations/{conversation_id}/transcript/{segment_id}/speaker",
        headers=headers,
        json={"speaker_role": "unknown"},
    )
    assert locked_assignment.status_code == 409

    cleanup = SessionLocal()
    try:
        cleanup.query(ProductOpportunity).filter(ProductOpportunity.conversation_id == conversation_id).delete()
        cleanup.query(SalesRecommendation).filter(SalesRecommendation.conversation_id == conversation_id).delete()
        cleanup.query(AiProcessingRun).filter(AiProcessingRun.conversation_id == conversation_id).delete()
        cleanup.query(ConversationParticipant).filter(ConversationParticipant.conversation_id == conversation_id).delete()
        cleanup.query(TranscriptSegment).filter(TranscriptSegment.id == segment_id).delete()
        cleanup.query(Conversation).filter(Conversation.id == conversation_id).delete()
        cleanup.commit()
    finally:
        cleanup.close()


def test_imported_opportunity_prevents_duplicate_analysis_without_run_history() -> None:
    suffix = uuid4().hex
    conversation_id = f"conv-imported-analysis-{suffix}"
    segment_id = f"segment-imported-analysis-{suffix}"
    opportunity_id = f"opp-imported-analysis-{suffix}"
    db = SessionLocal()
    db.add_all([
        Conversation(
            id=conversation_id,
            store_id="store-001",
            status="ENDED",
            primary_language="en",
            started_at=datetime.now(UTC),
            opportunity_status="OPEN",
        ),
        TranscriptSegment(
            id=segment_id,
            conversation_id=conversation_id,
            speaker_id="speaker-customer",
            language="en",
            original_text="I need a phone charger.",
            translated_text="I need a phone charger.",
            start_time=0,
            end_time=2,
            confidence=0.9,
        ),
        ProductOpportunity(
            id=opportunity_id,
            conversation_id=conversation_id,
            store_id="store-001",
            customer_intent="purchase_accessory",
            product_name="phone charger",
            status="OPEN",
            confidence=0.89,
            recommendation="Ask which connector the customer needs.",
        ),
    ])
    db.commit()
    db.close()

    login = client.post("/api/v1/auth/login", json={"email": "admin@storelisten.demo", "password": "StoreListen!2026"})
    headers = {"Authorization": f"Bearer {login.json()['token']}"}
    detail = client.get(f"/api/v1/conversations/{conversation_id}", headers=headers)
    assert detail.json()["analysis_status"] == "analyzed"
    result = client.post(f"/api/v1/conversations/{conversation_id}/analysis", headers=headers)
    assert result.status_code == 200
    assert result.json()["processed_segments"] == 0
    assert [row["id"] for row in result.json()["opportunities"]] == [opportunity_id]

    cleanup = SessionLocal()
    try:
        cleanup.query(ProductOpportunity).filter(ProductOpportunity.id == opportunity_id).delete()
        cleanup.query(TranscriptSegment).filter(TranscriptSegment.id == segment_id).delete()
        cleanup.query(Conversation).filter(Conversation.id == conversation_id).delete()
        cleanup.commit()
    finally:
        cleanup.close()


def test_rate_limit_response_has_trace_and_security_headers(monkeypatch) -> None:
    monkeypatch.setattr(settings, "rate_limit_per_minute", 0)
    response = client.get("/health", headers={"X-Request-ID": "rate-limit-test"})

    assert response.status_code == 429
    assert response.json()["request_id"] == "rate-limit-test"
    assert response.headers["X-Request-ID"] == "rate-limit-test"
    retry_after = int(response.headers["Retry-After"])
    assert 1 <= retry_after <= 60
    assert str(retry_after) in response.json()["detail"]
    assert response.headers["X-Content-Type-Options"] == "nosniff"


def test_validation_response_redacts_input_and_includes_request_id() -> None:
    response = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@storelisten.demo"},
        headers={"X-Request-ID": "validation-test", "Origin": "http://localhost:3000"},
    )

    assert response.status_code == 422
    assert response.json()["request_id"] == "validation-test"
    assert response.json()["errors"][0]["field"] == "password"
    assert "input" not in response.json()["errors"][0]
    assert "x-request-id" in response.headers["Access-Control-Expose-Headers"].lower()


def test_readiness_returns_unavailable_when_database_probe_fails(monkeypatch) -> None:
    class UnavailableSession:
        def ping(self):
            raise PyMongoError("database unavailable")

        def close(self):
            return None

    monkeypatch.setattr("app.database.SessionLocal", UnavailableSession)
    response = client.get("/ready")

    assert response.status_code == 503
    assert response.json()["detail"] == "Database unavailable"


def test_login_and_dashboard() -> None:
    client.cookies.clear()
    denied = client.get("/api/v1/dashboard/summary")
    assert denied.status_code == 401
    login = client.post("/api/v1/auth/login", json={"email": "admin@storelisten.demo", "password": "StoreListen!2026"})
    assert login.status_code == 200
    token = login.json()["token"]
    summary = client.get("/api/v1/dashboard/summary", headers={"Authorization": f"Bearer {token}"})
    assert summary.status_code == 200
    body = summary.json()
    assert body["stores"]
    assert "conversations_today" in body["metrics"]


def test_dashboard_summary_uses_real_store_scoped_counts() -> None:
    login = client.post("/api/v1/auth/login", json={"email": "admin@storelisten.demo", "password": "StoreListen!2026"})
    headers = {"Authorization": f"Bearer {login.json()['token']}"}
    baseline = client.get("/api/v1/dashboard/summary", headers=headers).json()
    suffix = uuid4().hex
    conversation_id = f"conv-dashboard-metric-{suffix}"
    db = SessionLocal()
    try:
        db.add(Conversation(
            id=conversation_id,
            store_id="store-001",
            status="ENDED",
            primary_language="en",
            started_at=datetime.now(UTC),
            opportunity_status="UNKNOWN",
        ))
        db.commit()

        updated = client.get("/api/v1/dashboard/summary", headers=headers)
        assert updated.status_code == 200
        metrics = updated.json()["metrics"]
        baseline_metrics = baseline["metrics"]
        assert metrics["conversations_today"] == baseline_metrics["conversations_today"] + 1
        assert metrics["conversation_trend"][-1] == baseline_metrics["conversation_trend"][-1] + 1
        assert metrics["active_stores"] == len(updated.json()["stores"])
        assert metrics["online_stores"] + metrics["offline_stores"] == metrics["active_stores"]
        assert metrics["average_response_time_seconds"] is None
    finally:
        db.query(Conversation).filter(Conversation.id == conversation_id).delete(synchronize_session=False)
        db.commit()
        db.close()


def test_store_manager_scope() -> None:
    login = client.post("/api/v1/auth/login", json={"email": "manager@storelisten.demo", "password": "StoreListen!2026"})
    token = login.json()["token"]
    stores = client.get("/api/v1/stores", headers={"Authorization": f"Bearer {token}"}).json()
    ids = [row["id"] for row in stores["stores"]["items"]]
    assert ids == ["store-001"]


def test_opportunity_review() -> None:
    login = client.post("/api/v1/auth/login", json={"email": "admin@storelisten.demo", "password": "StoreListen!2026"})
    token = login.json()["token"]
    patched = client.patch(
        "/api/v1/opportunities/opp-2003",
        headers={"Authorization": f"Bearer {token}"},
        json={"status": "REVIEW_REQUIRED", "manager_note": "Needs human review"},
    )
    assert patched.status_code == 200
    assert patched.json()["manager_note"] == "Needs human review"


def test_mock_ai_charger_intent() -> None:
    result = MockAIProvider().analyze("¿Tiene un cargador para iPhone?", "Do you have an iPhone charger?", "es", "customer")
    assert result.opportunity is True
    assert "charger" in result.product or "charger" in result.intent or "Ask" in result.recommendation


def test_websocket_dashboard_requires_token() -> None:
    try:
        with client.websocket_connect("/ws/dashboard"):
            raise AssertionError("unauthenticated websocket should not connect")
    except Exception:
        pass


def test_websocket_dashboard_with_token() -> None:
    login = client.post("/api/v1/auth/login", json={"email": "admin@storelisten.demo", "password": "StoreListen!2026"})
    token = login.json()["token"]
    with client.websocket_connect("/ws/dashboard", subprotocols=["storelisten.v1", token]):
        pass


def test_pos_match_window() -> None:
    db = SessionLocal()
    try:
        suffix = uuid4().hex
        test_store_id = f"test-store-{suffix}"
        transaction_time = datetime.now(UTC)
        conversation = Conversation(
            id=f"conv-match-{suffix}",
            store_id=test_store_id,
            employee_id="employee-001",
            status="LIVE",
            primary_language="es",
            started_at=transaction_time - timedelta(minutes=2),
            customer_intent="charger purchase",
            detected_product="phone charger",
            opportunity_status="OPEN",
        )
        db.add(conversation)
        txn = PosTransaction(id=f"txn-match-{suffix}", store_id=test_store_id, employee_id="employee-001", amount=19.99, occurred_at=transaction_time, provider="mock")
        db.add(txn)
        db.add(PosTransactionItem(id=f"item-match-{suffix}", transaction_id=txn.id, sku="CHG-USBC", name="USB-C Charger", unit_price=19.99))
        db.flush()
        match = match_transaction(db, txn)
        assert match is not None
        assert match.conversation_id == conversation.id
        assert match.certain is False
        assert match.confidence >= 0.55
        assert match_transaction(db, txn).id == match.id
    finally:
        db.rollback()
        db.close()


def test_pos_match_rejects_future_and_out_of_window_conversations() -> None:
    db = SessionLocal()
    try:
        suffix = uuid4().hex
        test_store_id = f"test-store-{suffix}"
        transaction_time = datetime.now(UTC)
        txn = PosTransaction(id=f"txn-window-{suffix}", store_id=test_store_id, employee_id="employee-001", amount=19.99, occurred_at=transaction_time, provider="mock")
        db.add(txn)
        db.add(PosTransactionItem(id=f"item-window-{suffix}", transaction_id=txn.id, sku="CHG-USBC", name="USB-C Charger", unit_price=19.99))
        db.add_all([
            Conversation(id=f"conv-future-{suffix}", store_id=test_store_id, employee_id="employee-001", status="LIVE", primary_language="en", started_at=transaction_time + timedelta(minutes=1), customer_intent="charger purchase", detected_product="phone charger", opportunity_status="OPEN"),
            Conversation(id=f"conv-old-{suffix}", store_id=test_store_id, employee_id="employee-001", status="ENDED", primary_language="en", started_at=transaction_time - timedelta(minutes=21), customer_intent="charger purchase", detected_product="phone charger", opportunity_status="OPEN"),
        ])
        db.flush()
        assert match_transaction(db, txn) is None
    finally:
        db.rollback()
        db.close()
