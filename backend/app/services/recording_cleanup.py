"""Cascade delete for recordings, conversations, transcripts, and related AI/POS rows."""

from __future__ import annotations

from typing import Any

from app.models import (
    AiProcessingRun,
    AudioRecording,
    AudioSession,
    Conversation,
    ConversationParticipant,
    ConversationPosMatch,
    CustomerIntent,
    MissedOpportunity,
    ProductOpportunity,
    SalesRecommendation,
    TranscriptSegment,
)
from app.services.audio_storage import delete_audio_clip


def _delete_recordings(db, recordings: list[AudioRecording]) -> int:
    for recording in recordings:
        delete_audio_clip(recording.storage_key)
        db.delete(recording)
    return len(recordings)


def delete_conversation_cascade(db, conversation_id: str) -> dict[str, int]:
    """Remove one conversation and all linked audio / transcript / AI rows."""
    recordings = db.query(AudioRecording).filter(AudioRecording.conversation_id == conversation_id).all()
    recording_count = _delete_recordings(db, recordings)

    missed = db.query(MissedOpportunity).filter(MissedOpportunity.conversation_id == conversation_id).delete(synchronize_session=False)
    opportunities = db.query(ProductOpportunity).filter(ProductOpportunity.conversation_id == conversation_id).delete(synchronize_session=False)
    recommendations = db.query(SalesRecommendation).filter(SalesRecommendation.conversation_id == conversation_id).delete(synchronize_session=False)
    intents = db.query(CustomerIntent).filter(CustomerIntent.conversation_id == conversation_id).delete(synchronize_session=False)
    ai_runs = db.query(AiProcessingRun).filter(AiProcessingRun.conversation_id == conversation_id).delete(synchronize_session=False)
    pos_matches = db.query(ConversationPosMatch).filter(ConversationPosMatch.conversation_id == conversation_id).delete(synchronize_session=False)
    segments = db.query(TranscriptSegment).filter(TranscriptSegment.conversation_id == conversation_id).delete(synchronize_session=False)
    participants = db.query(ConversationParticipant).filter(ConversationParticipant.conversation_id == conversation_id).delete(synchronize_session=False)
    sessions = db.query(AudioSession).filter(AudioSession.conversation_id == conversation_id).delete(synchronize_session=False)
    conversations = db.query(Conversation).filter(Conversation.id == conversation_id).delete(synchronize_session=False)

    return {
        "conversations": int(conversations or 0),
        "recordings": recording_count,
        "transcript_segments": int(segments or 0),
        "participants": int(participants or 0),
        "ai_runs": int(ai_runs or 0),
        "intents": int(intents or 0),
        "opportunities": int(opportunities or 0),
        "recommendations": int(recommendations or 0),
        "missed_opportunities": int(missed or 0),
        "pos_matches": int(pos_matches or 0),
        "audio_sessions": int(sessions or 0),
    }


def delete_recording_entry(db, recording: AudioRecording) -> dict[str, int]:
    """Delete a library row. Conversation-linked clips remove the whole conversation."""
    if recording.conversation_id:
        return delete_conversation_cascade(db, recording.conversation_id)
    return {
        "conversations": 0,
        "recordings": _delete_recordings(db, [recording]),
        "transcript_segments": 0,
        "participants": 0,
        "ai_runs": 0,
        "intents": 0,
        "opportunities": 0,
        "recommendations": 0,
        "missed_opportunities": 0,
        "pos_matches": 0,
        "audio_sessions": 0,
    }


def _merge_counts(total: dict[str, int], part: dict[str, int]) -> None:
    for key, value in part.items():
        total[key] = total.get(key, 0) + int(value)


def delete_recordings_by_ids(db, recording_ids: list[str]) -> dict[str, Any]:
    """Bulk-delete selected library rows (unique conversations only once)."""
    unique_ids = list(dict.fromkeys(recording_ids))
    recordings = db.query(AudioRecording).filter(AudioRecording.id.in_(unique_ids)).all() if unique_ids else []
    found_ids = {recording.id for recording in recordings}
    totals: dict[str, int] = {}
    seen_conversations: set[str] = set()

    for recording in recordings:
        conversation_id = recording.conversation_id
        if conversation_id:
            if conversation_id in seen_conversations:
                continue
            seen_conversations.add(conversation_id)
            _merge_counts(totals, delete_conversation_cascade(db, conversation_id))
        else:
            _merge_counts(totals, delete_recording_entry(db, recording))

    return {
        "requested": len(unique_ids),
        "matched": len(found_ids),
        "missing_ids": [recording_id for recording_id in unique_ids if recording_id not in found_ids],
        "deleted": totals,
    }


def wipe_all_conversation_audio(db, *, store_id: str | None = None) -> dict[str, Any]:
    """Flash-delete every conversation/recording (optionally scoped to one store)."""
    conversation_query = db.query(Conversation)
    recording_query = db.query(AudioRecording)
    if store_id:
        conversation_query = conversation_query.filter(Conversation.store_id == store_id)
        recording_query = recording_query.filter(AudioRecording.store_id == store_id)

    conversation_ids = [row.id for row in conversation_query.all()]
    totals: dict[str, int] = {}
    for conversation_id in conversation_ids:
        _merge_counts(totals, delete_conversation_cascade(db, conversation_id))

    # Orphan clips with no conversation (or leftover after cascade race).
    orphans = recording_query.all()
    if orphans:
        _merge_counts(totals, {"recordings": _delete_recordings(db, orphans)})

    return {"store_id": store_id, "deleted": totals}
