from __future__ import annotations

import math
import re
from uuid import uuid4

from sqlalchemy.orm import Session

from app.config import settings
from app.models import AiProcessingRun, CustomerIntent, ProductOpportunity, SalesRecommendation, StoreRule
from app.providers.ai import AnalysisResult, get_ai_provider


def confidence_label(value: float) -> str:
    if value >= 0.85:
        return "High Confidence"
    if value >= 0.65:
        return "Medium Confidence"
    return "Low Confidence"


def _matching_store_rule(db: Session, store_id: str, transcript: str) -> StoreRule | None:
    stop_words = {"a", "an", "and", "are", "about", "as", "at", "be", "buys", "customer", "for", "from", "has", "have", "if", "in", "is", "it", "of", "on", "or", "asks", "the", "their", "to", "when", "with"}
    transcript_terms = set(re.findall(r"[a-z0-9]+", transcript.casefold()))
    for rule in db.query(StoreRule).filter(StoreRule.store_id == store_id, StoreRule.active.is_(True)).order_by(StoreRule.created_at.asc()).all():
        trigger_terms = {
            term for term in re.findall(r"[a-z0-9]+", rule.trigger_condition.casefold())
            if term not in stop_words and len(term) > 2
        }
        if not trigger_terms:
            continue
        matches = len(trigger_terms & transcript_terms)
        required_matches = 1 if len(trigger_terms) <= 2 else math.ceil(len(trigger_terms) * 0.6)
        if matches >= required_matches:
            return rule
    return None


def analyze_and_persist(
    db: Session,
    *,
    conversation_id: str,
    store_id: str,
    employee_id: str | None,
    original_text: str,
    translated_text: str,
    language: str,
    speaker_role: str,
) -> AnalysisResult | None:
    if speaker_role == "unknown":
        return None
    provider = get_ai_provider(settings.ai_provider)
    try:
        result = provider.analyze(original_text, translated_text, language, speaker_role)
    except Exception as exc:
        db.add(
            AiProcessingRun(
                id=f"run-{uuid4().hex[:10]}",
                conversation_id=conversation_id,
                provider=provider.name,
                status="unavailable",
                input_excerpt=original_text[:280],
                output_json=str(exc)[:1000],
            )
        )
        return None
    matched_rule = (
        _matching_store_rule(db, store_id, f"{original_text} {translated_text}")
        if speaker_role == "customer"
        else None
    )
    if matched_rule:
        if not result.opportunity:
            result.intent = f"store_rule: {matched_rule.name}"[:120]
            result.product = "unspecified product"
        result.opportunity = True
        result.recommendation = matched_rule.expected_action
        result.confidence = min(result.confidence, 0.75)
    run = AiProcessingRun(
        id=f"run-{uuid4().hex[:10]}",
        conversation_id=conversation_id,
        provider=provider.name,
        status="completed",
        input_excerpt=original_text[:280],
        output_json=str(result),
    )
    db.add(run)
    if result.opportunity and speaker_role != "employee":
        db.add(
            CustomerIntent(
                id=f"int-{uuid4().hex[:10]}",
                conversation_id=conversation_id,
                intent=result.intent,
                product=result.product,
                confidence=result.confidence,
                source=provider.name,
            )
        )
        db.add(
            ProductOpportunity(
                id=f"opp-{uuid4().hex[:10]}",
                conversation_id=conversation_id,
                store_id=store_id,
                employee_id=employee_id,
                customer_intent=result.intent,
                product_name=result.product,
                status="OPEN",
                confidence=result.confidence,
                recommendation=result.recommendation,
            )
        )
        db.add(
            SalesRecommendation(
                id=f"tip-{uuid4().hex[:10]}",
                conversation_id=conversation_id,
                store_id=store_id,
                title=matched_rule.name if matched_rule else "Contextual sales tip",
                message=result.recommendation,
                confidence=result.confidence,
            )
        )
    return result
