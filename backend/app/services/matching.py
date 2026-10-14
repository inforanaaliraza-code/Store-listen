from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from sqlalchemy.orm import Session

from app.models import Conversation, ConversationPosMatch, PosTransaction, PosTransactionItem, ProductOpportunity

MATCH_WINDOW = timedelta(minutes=20)
MATCH_THRESHOLD = 0.55
_IGNORED_TERMS = {
    "a", "an", "and", "for", "in", "my", "of", "the", "to", "with",
    "buy", "bought", "purchase", "purchased", "sale", "sales", "product",
}


def _terms(value: str | None) -> set[str]:
    words = re.findall(r"[a-z0-9]+", (value or "").casefold())
    normalized = {word[:-1] if word.endswith("s") and len(word) > 4 else word for word in words}
    return normalized - _IGNORED_TERMS


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def match_transaction(db: Session, transaction: PosTransaction) -> ConversationPosMatch | None:
    existing = (
        db.query(ConversationPosMatch)
        .filter(ConversationPosMatch.transaction_id == transaction.id)
        .first()
    )
    if existing:
        return existing

    transaction_time = _as_utc(transaction.occurred_at)
    window_start = transaction_time - MATCH_WINDOW
    candidates = (
        db.query(Conversation)
        .filter(Conversation.store_id == transaction.store_id)
        .order_by(Conversation.started_at.desc())
        .limit(200)
        .all()
    )
    conversations = [
        conversation
        for conversation in candidates
        if window_start <= _as_utc(conversation.started_at) <= transaction_time
    ]
    items = db.query(PosTransactionItem).filter(PosTransactionItem.transaction_id == transaction.id).all()
    item_terms = set().union(*(_terms(f"{item.name} {item.sku}") for item in items)) if items else set()
    if not item_terms:
        return None

    best: tuple[float, Conversation] | None = None
    for conversation in conversations:
        product_terms = _terms(conversation.detected_product)
        intent_terms = _terms(conversation.customer_intent)
        product_overlap = product_terms & item_terms
        intent_overlap = intent_terms & item_terms
        if not product_overlap and not intent_overlap:
            continue

        elapsed = (transaction_time - _as_utc(conversation.started_at)).total_seconds()
        proximity = max(0.0, 1.0 - elapsed / MATCH_WINDOW.total_seconds())
        score = 0.20 * proximity
        if conversation.employee_id and conversation.employee_id == transaction.employee_id:
            score += 0.15
        if product_overlap:
            score += 0.35
        if intent_overlap:
            score += 0.30
        if best is None or score > best[0]:
            best = (min(score, 0.95), conversation)
    if not best or best[0] < MATCH_THRESHOLD:
        return None
    opportunity = (
        db.query(ProductOpportunity)
        .filter(ProductOpportunity.conversation_id == best[1].id)
        .order_by(ProductOpportunity.created_at.desc())
        .first()
    )
    match = ConversationPosMatch(
        id=f"match-{uuid4().hex}",
        conversation_id=best[1].id,
        transaction_id=transaction.id,
        opportunity_id=opportunity.id if opportunity else None,
        confidence=best[0],
        method="store_time_product_employee",
        certain=False,
    )
    db.add(match)
    db.flush()
    if opportunity and best[0] >= 0.75:
        opportunity.status = "CONVERTED"
        best[1].opportunity_status = "CONVERTED"
    return match
