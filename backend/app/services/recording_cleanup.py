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


def _delete_recording_files(recordings: list[AudioRecording]) -> int:
    for recording in recordings:
        delete_audio_clip(recording.storage_key)
    return len(recordings)


def _bulk_delete_conversation_rows(db, conversation_ids: list[str]) -> dict[str, int]:
    """Delete related rows for many conversations with one query per table."""
    if not conversation_ids:
        return {
            "conversations": 0,
            "recordings": 0,
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

    recordings = db.query(AudioRecording).filter(AudioRecording.conversation_id.in_(conversation_ids)).all()
    recording_count = _delete_recording_files(recordings)
    if recordings:
        db.query(AudioRecording).filter(AudioRecording.id.in_([row.id for row in recordings])).delete(synchronize_session=False)

    missed = db.query(MissedOpportunity).filter(MissedOpportunity.conversation_id.in_(conversation_ids)).delete(synchronize_session=False)
    opportunities = db.query(ProductOpportunity).filter(ProductOpportunity.conversation_id.in_(conversation_ids)).delete(synchronize_session=False)
    recommendations = db.query(SalesRecommendation).filter(SalesRecommendation.conversation_id.in_(conversation_ids)).delete(synchronize_session=False)
    intents = db.query(CustomerIntent).filter(CustomerIntent.conversation_id.in_(conversation_ids)).delete(synchronize_session=False)
    ai_runs = db.query(AiProcessingRun).filter(AiProcessingRun.conversation_id.in_(conversation_ids)).delete(synchronize_session=False)
    pos_matches = db.query(ConversationPosMatch).filter(ConversationPosMatch.conversation_id.in_(conversation_ids)).delete(synchronize_session=False)
    segments = db.query(TranscriptSegment).filter(TranscriptSegment.conversation_id.in_(conversation_ids)).delete(synchronize_session=False)
    participants = db.query(ConversationParticipant).filter(ConversationParticipant.conversation_id.in_(conversation_ids)).delete(synchronize_session=False)
    sessions = db.query(AudioSession).filter(AudioSession.conversation_id.in_(conversation_ids)).delete(synchronize_session=False)
    conversations = db.query(Conversation).filter(Conversation.id.in_(conversation_ids)).delete(synchronize_session=False)

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


def delete_conversation_cascade(db, conversation_id: str) -> dict[str, int]:
    """Remove one conversation and all linked audio / transcript / AI rows."""
    return _bulk_delete_conversation_rows(db, [conversation_id])


def delete_recording_entry(db, recording: AudioRecording) -> dict[str, int]:
    """Delete a library row. Conversation-linked clips remove the whole conversation."""
    if recording.conversation_id:
        return delete_conversation_cascade(db, recording.conversation_id)
    recording_count = _delete_recording_files([recording])
    db.delete(recording)
    return {
        "conversations": 0,
        "recordings": recording_count,
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

    conversation_ids = list(dict.fromkeys(
        recording.conversation_id for recording in recordings if recording.conversation_id
    ))
    orphan_recordings = [recording for recording in recordings if not recording.conversation_id]

    totals = _bulk_delete_conversation_rows(db, conversation_ids)
    if orphan_recordings:
        _merge_counts(totals, {
            "recordings": _delete_recording_files(orphan_recordings),
        })
        db.query(AudioRecording).filter(AudioRecording.id.in_([row.id for row in orphan_recordings])).delete(synchronize_session=False)

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
    # Chunk large wipes so a single Mongo/SQL statement stays bounded.
    totals: dict[str, int] = {}
    chunk_size = 200
    for index in range(0, len(conversation_ids), chunk_size):
        chunk = conversation_ids[index:index + chunk_size]
        _merge_counts(totals, _bulk_delete_conversation_rows(db, chunk))
        db.flush()

    orphans = recording_query.all()
    if orphans:
        recording_count = _delete_recording_files(orphans)
        db.query(AudioRecording).filter(AudioRecording.id.in_([row.id for row in orphans])).delete(synchronize_session=False)
        _merge_counts(totals, {"recordings": recording_count})

    return {"store_id": store_id, "deleted": totals}
