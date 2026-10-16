"""Build the exact STORE LISTENER daily report payload required by client specs."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any


def _money(amount: float) -> str:
    return f"${amount:,.0f}" if abs(amount - round(amount)) < 0.01 else f"${amount:,.2f}"


def build_store_listener_daily_report(
    *,
    store_name: str,
    store_location: str,
    report: dict[str, Any],
    provider_summary: dict[str, Any] | None = None,
    low_stock_count: int = 0,
    redacted_count: int = 0,
    interactions: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    metrics = report.get("metrics") or {}
    analysis = report.get("daily_analysis") or {}
    provider = provider_summary or analysis.get("provider_summary") or {}

    revenue_map = metrics.get("revenue_by_currency") or {}
    revenue = float(sum(revenue_map.values())) if revenue_map else 0.0
    sales_count = int(metrics.get("sales_count") or 0)
    conversations = int(metrics.get("conversations") or 0)
    missed_ops = int(metrics.get("potential_missed_opportunities") or 0)
    # Spec MISSED card is potential revenue; estimate $25 per missed opportunity when unknown.
    missed_revenue = float(missed_ops * 25)
    avg_ticket = round(revenue / sales_count, 2) if sales_count else 0.0

    findings = list(provider.get("findings") or [])
    if not findings:
        findings = [
            analysis.get("sales_summary") or "No sales summary available for this business day.",
            analysis.get("interaction_summary") or "Conversation attribution coverage varies by operator labeling.",
        ]
        mentions = analysis.get("potential_product_mentions") or []
        if mentions:
            top = mentions[0]
            findings.append(f"Most discussed product signal: {top.get('product')} ({top.get('count')} mentions).")

    summary_text = provider.get("summary") or (
        f"{conversations} customers were attended today with {_money(revenue)} in recorded sales. "
        f"{missed_ops} potential opportunities remain open for manager review."
    )
    headline = (
        f"Active day, {_money(revenue)} in sales, {conversations} conversations"
        if conversations or revenue
        else "Quiet day — limited conversation and sales activity recorded"
    )

    # Sentiment distribution — derive lightly from opportunity outcomes when AI sentiment is absent.
    converted = int(metrics.get("converted_opportunities") or 0)
    open_ops = int(analysis.get("potential_unconverted_opportunities") or 0)
    total_sent = max(converted + missed_ops + open_ops, 1)
    sentiment = {
        "positive": round(100 * converted / total_sent),
        "neutral": round(100 * open_ops / total_sent),
        "negative": round(100 * missed_ops / total_sent),
    }
    # Normalize to 100
    drift = 100 - sum(sentiment.values())
    sentiment["neutral"] = max(0, sentiment["neutral"] + drift)

    actions = findings[:5] if findings else [
        "Review open opportunities with floor staff at open.",
        "Confirm microphone placement before peak hours.",
        "Follow up on any conversations without clear product resolution.",
    ]

    interaction_cards = interactions or []
    if not interaction_cards:
        # Fallback skeleton from product mentions / intents when per-conversation AI tips are unavailable.
        for index, intent in enumerate((analysis.get("top_intents") or [])[:8], start=1):
            interaction_cards.append({
                "number": index,
                "time": report.get("business_date"),
                "location": store_location or store_name,
                "duration_seconds": 0,
                "sentiment": "Neutral",
                "score": 70,
                "transcript_summary": f"Intent signal: {intent.get('intent')} ({intent.get('count')} mentions).",
                "coaching_tip": "Confirm customer need early and offer one clear next-step product option.",
            })

    generated_at = report.get("generatedAt") or datetime.now(UTC).isoformat()
    return {
        "brand": "STORE LISTENER",
        "report_date": report.get("business_date"),
        "headline": headline,
        "store_name": store_name,
        "store_location": store_location,
        "generated_at": generated_at,
        "kpis": {
            "revenue": {"label": "REVENUE", "value": _money(revenue), "detail": f"{sales_count} item(s) sold"},
            "missed": {"label": "MISSED", "value": _money(missed_revenue), "detail": "potential revenue"},
            "conversations": {"label": "CONVERSATIONS", "value": str(conversations), "detail": "customers attended"},
            "avg_ticket": {"label": "AVG TICKET", "value": _money(avg_ticket), "detail": "per sale"},
            "low_stock": {"label": "LOW STOCK", "value": str(low_stock_count), "detail": "items below par"},
            "redacted": {"label": "REDACTED", "value": str(redacted_count), "detail": "sensitive details removed"},
        },
        "executive_summary": summary_text,
        "key_points": findings[:8],
        "sentiment": sentiment,
        "actions_for_tomorrow": actions,
        "interactions": interaction_cards,
    }


def build_interaction_cards_from_conversations(
    conversation_rows: list[Any],
    *,
    store_name: str,
    store_location: str,
    segments_by_conversation: dict[str, list[Any]],
    opportunities_by_conversation: dict[str, list[Any]],
    reports_by_conversation: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    cards: list[dict[str, Any]] = []
    for index, conversation in enumerate(conversation_rows, start=1):
        segments = segments_by_conversation.get(conversation.id, [])
        english_bits = []
        for segment in segments[:12]:
            text = (segment.translated_text or segment.original_text or "").strip()
            if text:
                english_bits.append(text)
        summary = " ".join(english_bits)[:280] or "No clear speech was captured for this interaction."
        opp = opportunities_by_conversation.get(conversation.id) or []
        missed = any(getattr(item, "status", "") == "MISSED" for item in opp)
        converted = any(getattr(item, "status", "") == "CONVERTED" for item in opp)
        sentiment = "Negative" if missed else "Positive" if converted else "Neutral"
        score = 55 if missed else 88 if converted else 72
        ai = reports_by_conversation.get(conversation.id) or {}
        coaching = (
            ai.get("coaching_tip")
            or ai.get("recommendation")
            or (
                "Revisit the missed product ask before closing the conversation."
                if missed
                else "Keep confirming the customer's need and offer one clear next step."
            )
        )
        started = getattr(conversation, "started_at", None)
        duration = 0.0
        if segments:
            duration = max((getattr(segment, "end_time", 0) or 0) for segment in segments)
        cards.append({
            "number": index,
            "time": started.astimezone(UTC).strftime("%I:%M %p") if started else "",
            "location": store_location or store_name,
            "duration_seconds": round(float(duration), 1),
            "sentiment": sentiment,
            "score": score,
            "transcript_summary": summary,
            "coaching_tip": coaching,
            "conversation_id": conversation.id,
        })
    return cards
