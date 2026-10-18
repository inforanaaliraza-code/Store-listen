from __future__ import annotations

from collections import Counter
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from app.config import settings
from app.models import (
    Alert,
    AiProcessingRun,
    AudioRecording,
    Conversation,
    ConversationPosMatch,
    CustomerIntent,
    Employee,
    PosTransaction,
    ProductOpportunity,
    SalesRecommendation,
    Store,
    StoreDevice,
    StorePerformance,
    TranscriptSegment,
    User,
)
from app.providers.ai import RULES


def scoped_store_ids(user: User) -> list[str] | None:
    if user.role == "SUPER_ADMIN":
        return None
    if user.store_id:
        return [user.store_id]
    return []


def apply_store_scope(query, model, user: User):
    if user.role == "SUPER_ADMIN":
        return query

    if model is Store:
        if user.role == "ORG_ADMIN":
            return query.filter(Store.organization_id == user.organization_id)
        return query.filter(Store.id == user.store_id) if user.store_id else query.filter(Store.id.is_(None))

    allowed = scoped_store_ids(user)
    if hasattr(model, "store_id"):
        if user.role == "ORG_ADMIN":
            organization_stores = query.session.query(Store).filter(Store.organization_id == user.organization_id).all()
            return query.filter(model.store_id.in_([store.id for store in organization_stores]))
        if model is Alert and user.store_id:
            return query.filter((model.store_id == user.store_id) | model.store_id.is_(None))
        return query.filter(model.store_id.in_(allowed))
    return query


def serialize_store(store: Store, db: Session) -> dict:
    return serialize_stores([store], db)[0]


def serialize_stores(stores: list[Store], db: Session) -> list[dict]:
    if not stores:
        return []
    store_ids = [store.id for store in stores]
    devices_by_store: dict[str, StoreDevice] = {}
    for device in db.query(StoreDevice).filter(StoreDevice.store_id.in_(store_ids)).all():
        devices_by_store.setdefault(device.store_id, device)
    live_counts = Counter(
        conversation.store_id
        for conversation in db.query(Conversation).filter(
            Conversation.store_id.in_(store_ids), Conversation.status == "LIVE"
        ).all()
    )
    employee_counts = Counter(
        employee.store_id
        for employee in db.query(Employee).filter(
            Employee.store_id.in_(store_ids), Employee.active.is_(True)
        ).all()
    )

    result = []
    for store in stores:
        device = devices_by_store.get(store.id)
        result.append({
            "id": store.id,
            "name": store.name,
            "code": store.code,
            "city": store.city,
            "region": store.region,
            "timezone": store.timezone,
            "online": store.online,
            "device_connected": bool(device and device.status == "connected"),
            "device": None
            if not device
            else {
                "id": device.id,
                "name": device.name,
                "status": device.status,
                "audio_source": device.audio_source,
                "version": device.version,
                "last_heartbeat": device.last_heartbeat.isoformat() if device.last_heartbeat else None,
                "cpu_pct": device.cpu_pct,
                "memory_pct": device.memory_pct,
                "audio_status": device.audio_status,
                "microphone_status": device.microphone_status,
                "stream_status": device.stream_status,
                "processing_latency_ms": device.processing_latency_ms,
            },
            "open_conversations": live_counts.get(store.id, 0),
            "employees": employee_counts.get(store.id, 0),
        })
    return result


def serialize_conversation(item: Conversation, db: Session) -> dict:
    return serialize_conversations([item], db)[0]


def serialize_conversations(items: list[Conversation], db: Session) -> list[dict]:
    if not items:
        return []
    store_ids = {item.store_id for item in items}
    employee_ids = {item.employee_id for item in items if item.employee_id}
    stores_by_id = {store.id: store for store in db.query(Store).filter(Store.id.in_(store_ids)).all()}
    employees_by_id = (
        {employee.id: employee for employee in db.query(Employee).filter(Employee.id.in_(employee_ids)).all()}
        if employee_ids
        else {}
    )
    return [
        {
            "id": item.id,
            "store_id": item.store_id,
            "store_name": stores_by_id[item.store_id].name if item.store_id in stores_by_id else item.store_id,
            "started_at": item.started_at.isoformat() if item.started_at else None,
            "ended_at": item.ended_at.isoformat() if item.ended_at else None,
            "status": item.status,
            "language": item.primary_language,
            "product": item.detected_product,
            "customer_intent": item.customer_intent,
            "salesperson": employees_by_id[item.employee_id].full_name if item.employee_id in employees_by_id else "Unassigned",
            "opportunity_status": item.opportunity_status,
        }
        for item in items
    ]


def serialize_opportunity(item: ProductOpportunity) -> dict:
    return {
        "id": item.id,
        "store_id": item.store_id,
        "conversation_id": item.conversation_id,
        "customer_intent": item.customer_intent,
        "product": item.product_name,
        "status": item.status,
        "confidence": item.confidence,
        "recommendation": item.recommendation,
        "created_at": item.created_at.isoformat() if item.created_at else None,
        "manager_note": item.manager_note,
        "insight_caveat": "AI-generated insight with confidence — not an unquestionable fact.",
    }


def dashboard_summary(db: Session, user: User) -> dict:
    stores_q = apply_store_scope(db.query(Store), Store, user)
    stores = serialize_stores(stores_q.all(), db)
    conv_q = apply_store_scope(db.query(Conversation), Conversation, user)
    opp_q = apply_store_scope(db.query(ProductOpportunity), ProductOpportunity, user)
    now = datetime.now(UTC)
    conversations = conv_q.order_by(Conversation.started_at.desc()).limit(8).all()
    opportunities = opp_q.order_by(ProductOpportunity.created_at.desc()).limit(8).all()
    alerts = apply_store_scope(db.query(Alert), Alert, user).order_by(Alert.created_at.desc()).limit(8).all()
    total_opp = opp_q.count()
    converted = opp_q.filter(ProductOpportunity.status == "CONVERTED").count()
    missed = opp_q.filter(ProductOpportunity.status == "MISSED").count()
    window_start = datetime.now(UTC) - timedelta(days=7)
    recent_sales = apply_store_scope(db.query(PosTransaction), PosTransaction, user).filter(PosTransaction.occurred_at >= window_start).all()
    recent_recordings = apply_store_scope(db.query(AudioRecording), AudioRecording, user).filter(AudioRecording.captured_at >= window_start).all()
    revenue_by_currency: dict[str, float] = {}
    for sale in recent_sales:
        revenue_by_currency[sale.currency] = revenue_by_currency.get(sale.currency, 0) + sale.amount
    conversations_today = 0
    for store in stores:
        try:
            timezone = ZoneInfo(store["timezone"])
        except (KeyError, ValueError):
            timezone = ZoneInfo("UTC")
        local_date = now.astimezone(timezone).date()
        local_start = datetime.combine(local_date, time.min, tzinfo=timezone).astimezone(UTC)
        local_end = datetime.combine(local_date + timedelta(days=1), time.min, tzinfo=timezone).astimezone(UTC)
        conversations_today += conv_q.filter(
            Conversation.store_id == store["id"],
            Conversation.started_at >= local_start,
            Conversation.started_at < local_end,
        ).count()
    trend_start = datetime.combine(now.date() - timedelta(days=6), time.min, tzinfo=UTC)
    trend_dates = [(now.date() - timedelta(days=offset)).isoformat() for offset in range(6, -1, -1)]
    trend_counts: Counter[str] = Counter()
    languages: Counter[str] = Counter()
    for conversation in conv_q.all():
        languages[conversation.primary_language] += 1
        if conversation.started_at and trend_start <= conversation.started_at <= now:
            trend_counts[conversation.started_at.date().isoformat()] += 1
    all_conversations = conv_q.all()
    conversation_ids = [row.id for row in all_conversations]
    analyzed_ids = set()
    if conversation_ids:
        for run in db.query(AiProcessingRun).filter(
            AiProcessingRun.conversation_id.in_(conversation_ids),
            AiProcessingRun.status == "completed",
        ).all():
            analyzed_ids.add(run.conversation_id)
        for opportunity in opp_q.all():
            analyzed_ids.add(opportunity.conversation_id)
    missed_rows = opp_q.filter(ProductOpportunity.status == "MISSED").all()
    missed_by_category: Counter[str] = Counter()
    for opportunity in missed_rows:
        product = (getattr(opportunity, "product_name", None) or getattr(opportunity, "product", None) or "Other").strip()
        category = product.split()[0].title() if product else "Other"
        if "charg" in product.lower():
            category = "Charger"
        elif "iphone" in product.lower() or "phone" in product.lower():
            category = "Phone models"
        missed_by_category[category or "Other"] += 1
    metrics = {
        "active_stores": len(stores),
        "online_stores": sum(1 for store in stores if store["online"]),
        "offline_stores": sum(1 for store in stores if not store["online"]),
        "live_conversations": conv_q.filter(Conversation.status == "LIVE").count(),
        "conversations_today": conversations_today,
        "total_conversations": len(all_conversations),
        "analyzed_conversations": len(analyzed_ids),
        "potential_missed_opportunities": missed,
        "sales_opportunities": total_opp,
        "converted_opportunities": converted,
        "conversion_rate": round(converted / total_opp, 2) if total_opp else 0,
        "average_response_time_seconds": None,
        "language_distribution": languages,
        "conversation_trend": [trend_counts.get(day, 0) for day in trend_dates],
        "conversation_trend_dates": trend_dates,
        "missed_by_category": dict(missed_by_category),
        "manager_review_required": opp_q.filter(ProductOpportunity.status == "REVIEW_REQUIRED").count(),
        "pos_correlated": db.query(ConversationPosMatch).filter(
            ConversationPosMatch.conversation_id.in_(conversation_ids)
        ).count() if conversation_ids else 0,
        "sales_count_7d": len(recent_sales),
        "revenue_by_currency_7d": {currency: round(amount, 2) for currency, amount in revenue_by_currency.items()},
        "listening_seconds_7d": round(sum(recording.duration_seconds for recording in recent_recordings), 2),
        "recorders_online": sum(1 for store in stores if store["device_connected"]),
        "recorders_total": db.query(StoreDevice).filter(
            StoreDevice.store_id.in_([store["id"] for store in stores]),
            StoreDevice.revoked.is_(False),
        ).count() if stores else 0,
    }
    visible_conv_map = {row.id: row.store_id for row in conv_q.all()}
    stores_by_id = {s["id"]: s["name"] for s in stores}
    recent_segments = (
        db.query(TranscriptSegment)
        .filter(TranscriptSegment.conversation_id.in_(list(visible_conv_map.keys())))
        .order_by(TranscriptSegment.created_at.desc())
        .limit(20)
        .all()
    ) if visible_conv_map else []
    live_transcripts = [
        {
            "id": seg.id,
            "conversation_id": seg.conversation_id,
            "store_id": visible_conv_map.get(seg.conversation_id, ""),
            "store_name": stores_by_id.get(visible_conv_map.get(seg.conversation_id, ""), visible_conv_map.get(seg.conversation_id, "")),
            "speaker": "Customer (operator selected)" if seg.speaker_id == "speaker-customer" else "Speaker",
            "original_text": seg.original_text,
            "translated_text": seg.translated_text if seg.translated_text and seg.translated_text != seg.original_text else None,
            "language": seg.language or "und",
            "confidence": seg.confidence,
            "timestamp": seg.created_at.isoformat() if seg.created_at else None,
        }
        for seg in recent_segments
    ]
    return {
        "generated_at": datetime.now(UTC).isoformat(),
        "dataMode": "demo",
        "metrics": metrics,
        "stores": stores,
        "live_transcripts": live_transcripts,
        "recent_conversations": serialize_conversations(conversations, db),
        "opportunities": [serialize_opportunity(item) for item in opportunities],
        "recommendations": [
            {
                "id": rec.id,
                "conversation_id": rec.conversation_id,
                "store_id": rec.store_id,
                "title": rec.title,
                "message": rec.message,
                "confidence": rec.confidence,
                "label": "AI-assisted recommendation",
            }
            for rec in apply_store_scope(db.query(SalesRecommendation), SalesRecommendation, user).limit(6).all()
        ],
        "alerts": [
            {
                "id": alert.id,
                "severity": alert.severity,
                "title": alert.title,
                "description": alert.description,
                "store_id": alert.store_id,
                "created_at": alert.created_at.isoformat() if alert.created_at else None,
            }
            for alert in alerts
        ],
        "store_performance": [
            {
                "store_id": row.store_id,
                "conversations": row.conversations,
                "opportunities": row.opportunities,
                "converted": row.converted,
                "missed": row.missed,
                "conversion_rate": row.conversion_rate,
            }
            for row in apply_store_scope(db.query(StorePerformance), StorePerformance, user).all()
        ],
    }


def report_summary(
    db: Session,
    user: User,
    period: str,
    store_id: str | None = None,
    business_date: date | None = None,
) -> dict:
    store = db.get(Store, store_id) if store_id else None
    timezone = ZoneInfo(store.timezone) if store else ZoneInfo("UTC")
    local_now = datetime.now(timezone)
    selected_day = business_date or local_now.date()
    if period == "daily":
        start_day = selected_day
        end_day = start_day + timedelta(days=1)
    elif period == "weekly":
        start_day = selected_day - timedelta(days=selected_day.weekday())
        end_day = start_day + timedelta(days=7)
    else:
        start_day = selected_day.replace(day=1)
        end_day = (start_day.replace(day=28) + timedelta(days=4)).replace(day=1)
    start_local = datetime.combine(start_day, time.min, tzinfo=timezone)
    end_local = min(local_now, datetime.combine(end_day, time.min, tzinfo=timezone))
    start = start_local.astimezone(UTC)
    end = end_local.astimezone(UTC)

    conversations = apply_store_scope(db.query(Conversation), Conversation, user).filter(
        Conversation.started_at >= start, Conversation.started_at < end
    )
    opportunities = apply_store_scope(db.query(ProductOpportunity), ProductOpportunity, user).filter(
        ProductOpportunity.created_at >= start, ProductOpportunity.created_at < end
    )
    sales = apply_store_scope(db.query(PosTransaction), PosTransaction, user).filter(
        PosTransaction.occurred_at >= start, PosTransaction.occurred_at < end
    )
    recordings = apply_store_scope(db.query(AudioRecording), AudioRecording, user).filter(
        AudioRecording.captured_at >= start,
        AudioRecording.captured_at < end,
        AudioRecording.retain_until > datetime.now(UTC),
    )
    if store_id:
        conversations = conversations.filter(Conversation.store_id == store_id)
        opportunities = opportunities.filter(ProductOpportunity.store_id == store_id)
        sales = sales.filter(PosTransaction.store_id == store_id)
        recordings = recordings.filter(AudioRecording.store_id == store_id)
    if period == "daily":
        conversations = conversations.filter(Conversation.data_source == "live")
    conversation_rows = conversations.all()
    conversation_ids = [conversation.id for conversation in conversation_rows]
    if period == "daily":
        opportunities = opportunities.filter(ProductOpportunity.conversation_id.in_(conversation_ids))
        recordings = recordings.filter(AudioRecording.conversation_id.in_(conversation_ids))
    analysis_run_rows = db.query(AiProcessingRun).filter(AiProcessingRun.conversation_id.in_(conversation_ids)).all()
    if period == "daily":
        analysis_run_rows = [
            run for run in analysis_run_rows
            if str(getattr(run, "provider", "")).casefold() not in {"", "mock", "demo"}
        ]
        analyzed_conversation_ids = {run.conversation_id for run in analysis_run_rows}
        opportunities = opportunities.filter(ProductOpportunity.conversation_id.in_(analyzed_conversation_ids))
    analysis_runs = analysis_run_rows
    transcript = db.query(TranscriptSegment).filter(TranscriptSegment.conversation_id.in_(conversation_ids))

    total_opportunities = opportunities.count()
    converted = opportunities.filter(ProductOpportunity.status == "CONVERTED").count()
    missed = opportunities.filter(ProductOpportunity.status == "MISSED").count()
    languages = dict(Counter(conversation.primary_language for conversation in conversation_rows))
    stores_query = apply_store_scope(db.query(Store), Store, user)
    if store_id:
        stores_query = stores_query.filter(Store.id == store_id)
    report_stores = stores_query.all()
    store_performance = []
    for report_store in report_stores:
        store_conversations = conversations.filter(Conversation.store_id == report_store.id).count()
        store_opportunities = opportunities.filter(ProductOpportunity.store_id == report_store.id)
        store_total = store_opportunities.count()
        store_converted = store_opportunities.filter(ProductOpportunity.status == "CONVERTED").count()
        store_missed = store_opportunities.filter(ProductOpportunity.status == "MISSED").count()
        store_performance.append({
            "store_id": report_store.id,
            "conversations": store_conversations,
            "opportunities": store_total,
            "converted": store_converted,
            "missed": store_missed,
            "conversion_rate": round(store_converted / store_total, 2) if store_total else 0,
        })

    transactions = [
        transaction for transaction in sales.all()
        if str(getattr(transaction, "provider", "")).casefold() not in {"", "mock", "demo"}
    ]
    sales_data_available = bool(transactions)
    pos_correlated = db.query(ConversationPosMatch).filter(
        ConversationPosMatch.conversation_id.in_(conversation_ids),
        ConversationPosMatch.transaction_id.in_([transaction.id for transaction in transactions]),
    ).count()
    revenue_by_currency: dict[str, float] = {}
    for transaction in transactions:
        revenue_by_currency[transaction.currency] = revenue_by_currency.get(transaction.currency, 0) + transaction.amount
    transcript_rows = transcript.all()
    speaker_counts = Counter(segment.speaker_id for segment in transcript_rows)
    staff_segments = [segment for segment in transcript_rows if segment.speaker_id.startswith("speaker-employee-")]
    staff_question_clips = 0
    brief_acknowledgement_clips = 0
    acknowledgements = {"ok", "okay", "yes", "yeah", "sure", "right", "got it", "no problem"}
    for segment in staff_segments:
        text = (segment.original_text or "").strip().casefold()
        normalized = " ".join(text.strip(" .,!?").split())
        if "?" in text:
            staff_question_clips += 1
        if normalized in acknowledgements:
            brief_acknowledgement_clips += 1
    product_mentions: dict[str, dict[str, int]] = {}
    for segment in transcript_rows:
        spoken_text = f"{segment.original_text} {segment.translated_text or ''}".casefold()
        for keys, _, product, _ in RULES:
            if any(key in spoken_text for key in keys):
                mention = product_mentions.setdefault(product, {"count": 0, "unattributed_clips": 0})
                mention["count"] += 1
                if segment.speaker_id == "speaker-unknown":
                    mention["unattributed_clips"] += 1
                break
    attributed_customers = sum(count for speaker, count in speaker_counts.items() if speaker == "speaker-customer")
    attributed_staff = sum(count for speaker, count in speaker_counts.items() if speaker.startswith("speaker-employee-"))
    unattributed = speaker_counts.get("speaker-unknown", 0)
    open_opportunities = opportunities.filter(ProductOpportunity.status.in_(["OPEN", "REVIEW_REQUIRED"])).count()
    intent_rows = db.query(CustomerIntent).filter(CustomerIntent.conversation_id.in_(conversation_ids)).all()
    if period == "daily":
        intent_rows = [
            intent for intent in intent_rows
            if intent.conversation_id in analyzed_conversation_ids
            and str(getattr(intent, "source", "")).casefold() not in {"", "mock", "demo"}
        ]
    intent_counts = Counter(intent.intent for intent in intent_rows)
    top_intents = [
        {"intent": intent, "count": count}
        for intent, count in intent_counts.most_common(5)
    ]
    if sales_data_available:
        sales_summary = f"{len(transactions)} POS transactions totaling {sum(revenue_by_currency.values()):.2f} were recorded."
    else:
        sales_summary = "Live POS sales data is unavailable; no revenue or zero-sales claim can be reported."
    return {
        "range_start": start.isoformat(),
        "range_end": end.isoformat(),
        "business_date": selected_day.isoformat(),
        "timezone": str(timezone),
        "metrics": {
            "conversations": len(conversation_rows),
            "sales_opportunities": total_opportunities,
            "converted_opportunities": converted,
            "potential_missed_opportunities": missed,
            "conversion_rate": round(converted / total_opportunities, 2) if total_opportunities else 0,
            "language_distribution": languages,
            "pos_correlated": pos_correlated,
            "sales_count": len(transactions),
            "sales_data_available": sales_data_available,
            "revenue_by_currency": {currency: round(amount, 2) for currency, amount in revenue_by_currency.items()},
            "audio_recordings": recordings.count(),
            "recorded_seconds": round(sum(recording.duration_seconds for recording in recordings.all()), 2),
            "transcript_segments": len(transcript_rows),
        },
        "store_performance": store_performance,
        "daily_analysis": {
            "top_intents": top_intents,
            "potential_product_mentions": [
                {"product": product, **counts}
                for product, counts in sorted(product_mentions.items(), key=lambda item: item[1]["count"], reverse=True)
            ],
            "ai_analysis_runs": len(analysis_runs),
            "interaction_summary": (
                f"{attributed_customers} customer-labeled, {attributed_staff} staff-labeled, and "
                f"{unattributed} unattributed transcript clips. This is not an objective staff-quality score."
            ),
            "staff_interaction_signals": {
                "labeled_staff_clips": len(staff_segments),
                "clips_with_question_marks": staff_question_clips,
                "brief_acknowledgement_clips": brief_acknowledgement_clips,
                "coverage": "available_from_operator_labeled_clips" if staff_segments else "insufficient_staff_attribution",
                "caveat": "These are transcription-text counts, not an assessment of service quality. Unattributed shared-mic clips are excluded.",
            },
            "sales_summary": sales_summary,
            "potential_unconverted_opportunities": open_opportunities,
            "caveat": "Potential signals are not proof of why a sale was or was not made. Speaker labels are operator-selected; unknown clips are not attributed.",
        },
        "caveat": "AI-assisted metrics. Not a determination of employee performance.",
        "dataMode": "demo" if settings.demo_mode else "live",
    }


def paginate(items: list, page: int, page_size: int) -> dict:
    start = (page - 1) * page_size
    return {
        "items": items[start : start + page_size],
        "page": page,
        "page_size": page_size,
        "total": len(items),
        "pages": (len(items) + page_size - 1) // page_size if page_size else 0,
    }


def paginate_query(query, page: int, page_size: int) -> dict:
    total = query.count()
    items = query.offset((page - 1) * page_size).limit(page_size).all()
    return {
        "items": items,
        "page": page,
        "page_size": page_size,
        "total": total,
        "pages": (total + page_size - 1) // page_size if page_size else 0,
    }
