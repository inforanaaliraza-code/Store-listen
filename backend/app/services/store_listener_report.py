"""Build the exact STORE LISTENER daily report payload required by client specs."""

from __future__ import annotations

from collections import Counter
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def _money(amount: float, currency: str = "USD") -> str:
    symbol = {"USD": "$", "CAD": "CA$", "EUR": "€", "GBP": "£"}.get(currency, f"{currency} ")
    return f"{symbol}{amount:,.0f}" if abs(amount - round(amount)) < 0.01 else f"{symbol}{amount:,.2f}"


def build_store_listener_daily_report(
    *,
    store_name: str,
    store_location: str,
    report: dict[str, Any],
    provider_summary: dict[str, Any] | None = None,
    low_stock_count: int = 0,
    redacted_count: int | None = None,
    interactions: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    metrics = report.get("metrics") or {}
    analysis = report.get("daily_analysis") or {}
    provider = provider_summary or analysis.get("provider_summary") or {}

    revenue_map = metrics.get("revenue_by_currency") or {}
    revenue = float(sum(revenue_map.values())) if revenue_map else 0.0
    sales_data_available = bool(metrics.get("sales_data_available", True))
    currency = next(iter(revenue_map), "USD") if len(revenue_map) <= 1 else None
    revenue_value = "N/A" if not sales_data_available else _money(revenue, currency) if currency else "Multiple currencies"
    sales_count = int(metrics.get("sales_count") or 0)
    conversations = int(metrics.get("conversations") or 0)
    missed_ops = int(metrics.get("potential_missed_opportunities") or 0)
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
        f"{conversations} recorded interactions had {revenue_value} in POS sales. "
        f"{missed_ops} potential opportunities remain open for manager review."
    )
    headline = (
        f"Active day, {revenue_value} in sales, {conversations} conversations"
        if conversations or revenue
        else "Quiet day — limited conversation and sales activity recorded"
    )

    sentiment_counts = Counter(
        str(item.get("sentiment", "")).casefold()
        for item in interactions or []
        if str(item.get("sentiment", "")).casefold() in {"positive", "neutral", "negative", "mixed"}
    )
    sentiment_sample_size = sum(sentiment_counts.values())
    sentiment = {key: 0 for key in ("positive", "neutral", "negative", "mixed")}
    if sentiment_sample_size:
        remainders = {}
        for key in sentiment:
            sentiment[key], remainders[key] = divmod(sentiment_counts[key] * 100, sentiment_sample_size)
        undistributed = 100 - sum(sentiment.values())
        for key in sorted(remainders, key=remainders.get, reverse=True)[:undistributed]:
            sentiment[key] += 1
    sentiment["sample_size"] = sentiment_sample_size

    actions = []
    if missed_ops:
        actions.append(f"Review {missed_ops} potential opportunity signal(s) with a manager before assigning follow-up.")
    if low_stock_count:
        actions.append(f"Check {low_stock_count} below-par inventory item(s) and confirm replenishment needs.")
    if not int(metrics.get("transcript_segments") or 0) and conversations:
        actions.append("Check microphone placement and capture health; no transcript segments were recorded.")
    if not sales_data_available:
        actions.append("Connect a live POS feed before drawing conclusions about sales or revenue.")
    if not actions:
        actions.append("Review the conversation summaries and assign any customer follow-up that is still needed.")

    interaction_cards = interactions if interactions is not None else []

    generated_at = report.get("generatedAt") or datetime.now(UTC).isoformat()
    return {
        "brand": "STORE LISTENER",
        "report_date": report.get("business_date"),
        "headline": headline,
        "store_name": store_name,
        "store_location": store_location,
        "generated_at": generated_at,
        "kpis": {
            "revenue": {
                "label": "REVENUE",
                "value": revenue_value,
                "detail": f"{sales_count} POS transaction(s)" if sales_data_available else "live POS data unavailable",
            },
            "missed": {"label": "MISSED", "value": str(missed_ops), "detail": "potential opportunities; value not estimated"},
            "conversations": {"label": "CONVERSATIONS", "value": str(conversations), "detail": "recorded interactions"},
            "avg_ticket": {
                "label": "AVG TICKET",
                "value": _money(avg_ticket, currency) if sales_count and sales_data_available and currency else "N/A" if not sales_data_available or not sales_count else "Multiple currencies",
                "detail": "per POS transaction" if sales_count and sales_data_available else "live POS data unavailable" if not sales_data_available else "no POS transactions",
            },
            "low_stock": {"label": "LOW STOCK", "value": str(low_stock_count), "detail": "items below par"},
            "redacted": {
                "label": "REDACTED",
                "value": str(redacted_count) if redacted_count is not None else "N/A",
                "detail": "sensitive details removed" if redacted_count is not None else "not tracked in this report",
            },
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
    timezone_name: str = "UTC",
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
        transcript_summary = " ".join(english_bits)[:280] or "No clear speech was captured for this interaction."
        opportunity_statuses = {
            str(getattr(item, "status", "")).upper()
            for item in opportunities_by_conversation.get(conversation.id, [])
        }
        ai = reports_by_conversation.get(conversation.id) or {}
        sentiment = str(ai.get("customer_sentiment") or "Not analyzed").title()
        opportunity_type = ai.get("opportunity_type")
        if not opportunity_type:
            if "MISSED" in opportunity_statuses:
                opportunity_type = "missed"
            elif "CONVERTED" in opportunity_statuses:
                opportunity_type = "converted"
            elif opportunity_statuses & {"OPEN", "REVIEW_REQUIRED"}:
                opportunity_type = "potential"
        confidence = ai.get("confidence")
        try:
            confidence = max(0.0, min(1.0, float(confidence))) if confidence is not None else None
        except (TypeError, ValueError):
            confidence = None
        started = getattr(conversation, "started_at", None)
        duration = 0.0
        if segments:
            duration = max((getattr(segment, "end_time", 0) or 0) for segment in segments)
        if started and started.tzinfo is None:
            started = started.replace(tzinfo=UTC)
        try:
            store_timezone = ZoneInfo(timezone_name)
        except ZoneInfoNotFoundError:
            store_timezone = ZoneInfo("UTC")
        local_started = started.astimezone(store_timezone) if started else None
        cards.append({
            "number": index,
            "time": local_started.strftime("%I:%M %p") if local_started else "",
            "location": store_location or store_name,
            "duration_seconds": round(float(duration), 1),
            "sentiment": sentiment,
            "confidence": confidence,
            "transcript_summary": str(ai.get("summary") or transcript_summary)[:500],
            "coaching_tip": str(ai.get("recommendation") or "No conversation coaching analysis is available."),
            "customer_needs": ai.get("customer_needs") if isinstance(ai.get("customer_needs"), list) else [],
            "products_discussed": ai.get("products_discussed") if isinstance(ai.get("products_discussed"), list) else [],
            "opportunity_type": opportunity_type,
            "conversation_id": conversation.id,
        })
    return cards
