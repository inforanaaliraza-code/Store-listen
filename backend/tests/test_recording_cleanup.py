from datetime import UTC, datetime

from app.database import SessionLocal
from app.models import AudioRecording, Conversation, ConversationParticipant, TranscriptSegment
from app.services.recording_cleanup import delete_recording_entry, delete_recordings_by_ids


def test_delete_recordings_by_ids_cascades_conversation(tmp_path, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "audio_storage_dir", str(tmp_path))
    storage_key = "2026/10/16/clip-cleanup.webm"
    clip = tmp_path / storage_key
    clip.parent.mkdir(parents=True, exist_ok=True)
    clip.write_bytes(b"fake-audio")

    db = SessionLocal()
    conversation_id = "conv-cleanup-test-1"
    recording_id = "rec-cleanup-test-1"
    try:
        db.add(Conversation(id=conversation_id, store_id="store-001", status="ENDED"))
        db.add(ConversationParticipant(
            id="part-cleanup-test-1",
            conversation_id=conversation_id,
            speaker_label="Speaker",
            mapped_role="unknown",
        ))
        db.add(TranscriptSegment(
            id="seg-cleanup-test-1",
            conversation_id=conversation_id,
            speaker_id="speaker-unknown",
            language="en",
            original_text="Hello",
            translated_text="Hello",
            start_time=0,
            end_time=1,
            confidence=0.9,
            is_final=True,
        ))
        db.add(AudioRecording(
            id=recording_id,
            store_id="store-001",
            conversation_id=conversation_id,
            storage_key=storage_key,
            content_type="audio/webm",
            byte_size=10,
            duration_seconds=1.0,
            sequence=1,
            speaker_role="unknown",
            is_aggregate=True,
            captured_at=datetime.now(UTC),
            retain_until=datetime.now(UTC),
        ))
        db.commit()

        result = delete_recordings_by_ids(db, [recording_id])
        db.commit()

        assert result["matched"] == 1
        assert result["deleted"]["conversations"] == 1
        assert result["deleted"]["recordings"] >= 1
        assert db.get(Conversation, conversation_id) is None
        assert db.get(AudioRecording, recording_id) is None
        assert not clip.exists()
    finally:
        leftover = db.get(AudioRecording, recording_id)
        if leftover:
            delete_recording_entry(db, leftover)
        db.query(TranscriptSegment).filter(TranscriptSegment.conversation_id == conversation_id).delete(synchronize_session=False)
        db.query(ConversationParticipant).filter(ConversationParticipant.conversation_id == conversation_id).delete(synchronize_session=False)
        db.query(Conversation).filter(Conversation.id == conversation_id).delete(synchronize_session=False)
        db.commit()
        db.close()
