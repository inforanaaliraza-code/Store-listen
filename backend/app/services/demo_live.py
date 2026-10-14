from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models import (
    AiProcessingRun,
    Conversation,
    ConversationParticipant,
    ConversationPosMatch,
    CustomerIntent,
    MissedOpportunity,
    PosTransaction,
    PosTransactionItem,
    ProductOpportunity,
    SalesRecommendation,
    Store,
    TranscriptSegment,
)
from app.providers.pos import get_pos_provider
from app.services.events import hub
from app.services.matching import match_transaction

LIVE_CONVERSATION_ID = "conv-live-demo"


def _event(name: str, **payload):
    return {"event": name, "timestamp": datetime.now(UTC).isoformat(), **payload}


async def run_live_demo(store_id: str = "store-001") -> str:
    db = SessionLocal()
    try:
        store = db.get(Store, store_id)
        if store:
            store.online = True
        existing = db.get(Conversation, LIVE_CONVERSATION_ID)
        if existing:
            db.query(TranscriptSegment).filter(TranscriptSegment.conversation_id == LIVE_CONVERSATION_ID).delete()
            db.query(ConversationParticipant).filter(ConversationParticipant.conversation_id == LIVE_CONVERSATION_ID).delete()
            db.query(SalesRecommendation).filter(SalesRecommendation.conversation_id == LIVE_CONVERSATION_ID).delete()
            db.query(CustomerIntent).filter(CustomerIntent.conversation_id == LIVE_CONVERSATION_ID).delete()
            db.query(AiProcessingRun).filter(AiProcessingRun.conversation_id == LIVE_CONVERSATION_ID).delete()
            db.query(MissedOpportunity).filter(MissedOpportunity.conversation_id == LIVE_CONVERSATION_ID).delete()
            db.query(ConversationPosMatch).filter(ConversationPosMatch.conversation_id == LIVE_CONVERSATION_ID).delete()
            db.query(ProductOpportunity).filter(ProductOpportunity.conversation_id == LIVE_CONVERSATION_ID).delete()
            db.delete(existing)
            db.commit()
        conversation = Conversation(
            id=LIVE_CONVERSATION_ID,
            store_id=store_id,
            employee_id="employee-001",
            status="LIVE",
            primary_language="es",
            customer_intent=None,
            detected_product=None,
            opportunity_status="UNKNOWN",
        )
        db.add(conversation)
        db.add(ConversationParticipant(id=f"p-{uuid4().hex[:8]}", conversation_id=LIVE_CONVERSATION_ID, speaker_label="Speaker 01", mapped_role="customer"))
        db.add(ConversationParticipant(id=f"p-{uuid4().hex[:8]}", conversation_id=LIVE_CONVERSATION_ID, speaker_label="Speaker 02", mapped_role="employee", employee_id="employee-001"))
        db.commit()

        room = f"store:{store_id}"
        await hub.publish(room, _event("store.connected", storeId=store_id, conversationId=LIVE_CONVERSATION_ID))
        await asyncio.sleep(0.8)
        await hub.publish(room, _event("device.health.updated", storeId=store_id, deviceId="device-001", status="connected", audioStatus="streaming"))
        await asyncio.sleep(0.7)
        await hub.publish(room, _event("conversation.started", storeId=store_id, conversationId=LIVE_CONVERSATION_ID))
        await asyncio.sleep(0.6)
        await hub.publish(room, _event("speaker.detected", storeId=store_id, conversationId=LIVE_CONVERSATION_ID, speakerId="spk-1", speakerLabel="Speaker 01", mappedRole="customer"))

        partials = ["¿Tiene", "¿Tiene un", "¿Tiene un cargador", "¿Tiene un cargador para iPhone?"]
        for index, text in enumerate(partials):
            await hub.publish(
                room,
                _event(
                    "transcript.partial",
                    conversationId=LIVE_CONVERSATION_ID,
                    segmentId="seg-live-1",
                    storeId=store_id,
                    speakerId="spk-1",
                    language="es",
                    originalText=text,
                    translatedText="",
                    confidence=0.62 + index * 0.08,
                    isFinal=False,
                ),
            )
            await asyncio.sleep(0.85)

        original = "¿Tiene un cargador para iPhone?"
        translated = "Do you have an iPhone charger?"
        db.add(
            TranscriptSegment(
                id="seg-live-1",
                conversation_id=LIVE_CONVERSATION_ID,
                speaker_id="spk-1",
                language="es",
                original_text=original,
                translated_text=translated,
                start_time=0,
                end_time=2.9,
                confidence=0.96,
                is_final=True,
            )
        )
        conversation.customer_intent = "charger purchase"
        conversation.detected_product = "phone charger"
        conversation.opportunity_status = "OPEN"
        db.add(
            ProductOpportunity(
                id="opp-live",
                conversation_id=LIVE_CONVERSATION_ID,
                store_id=store_id,
                employee_id="employee-001",
                customer_intent="charger purchase",
                product_name="phone charger",
                status="OPEN",
                confidence=0.89,
                recommendation="Ask which iPhone model/connector the customer uses.",
            )
        )
        db.add(
            SalesRecommendation(
                id="tip-live",
                conversation_id=LIVE_CONVERSATION_ID,
                store_id=store_id,
                title="Connector clarification",
                message="Ask which iPhone model/connector the customer uses.",
                confidence=0.89,
            )
        )
        db.commit()

        await hub.publish(
            room,
            _event(
                "transcript.final",
                conversationId=LIVE_CONVERSATION_ID,
                segmentId="seg-live-1",
                storeId=store_id,
                speakerId="spk-1",
                speakerLabel="Customer",
                language="es",
                originalText=original,
                translatedText=translated,
                confidence=0.96,
                isFinal=True,
            ),
        )
        await hub.publish(room, _event("language.detected", conversationId=LIVE_CONVERSATION_ID, storeId=store_id, language="es"))
        await hub.publish(room, _event("translation.updated", conversationId=LIVE_CONVERSATION_ID, storeId=store_id, originalText=original, translatedText=translated))
        await hub.publish(room, _event("intent.detected", conversationId=LIVE_CONVERSATION_ID, storeId=store_id, intent="charger purchase", product="phone charger", confidence=0.89, label="High Confidence"))
        await hub.publish(room, _event("opportunity.detected", conversationId=LIVE_CONVERSATION_ID, storeId=store_id, opportunityId="opp-live", status="OPEN", product="phone charger", confidence=0.89, label="Potential Opportunity"))
        await hub.publish(room, _event("sales_tip.generated", conversationId=LIVE_CONVERSATION_ID, storeId=store_id, message="Ask which iPhone model/connector the customer uses.", confidence=0.89))
        await asyncio.sleep(1.2)

        employee_text = "Yes — USB-C or Lightning? What iPhone do you have?"
        db.add(
            TranscriptSegment(
                id="seg-live-2",
                conversation_id=LIVE_CONVERSATION_ID,
                speaker_id="spk-2",
                language="en",
                original_text=employee_text,
                translated_text=employee_text,
                start_time=3.4,
                end_time=6.0,
                confidence=0.94,
                is_final=True,
            )
        )
        db.commit()
        await hub.publish(room, _event("speaker.detected", storeId=store_id, conversationId=LIVE_CONVERSATION_ID, speakerId="spk-2", speakerLabel="Speaker 02", mappedRole="employee"))
        await hub.publish(
            room,
            _event(
                "transcript.final",
                conversationId=LIVE_CONVERSATION_ID,
                segmentId="seg-live-2",
                storeId=store_id,
                speakerId="spk-2",
                speakerLabel="Employee",
                language="en",
                originalText=employee_text,
                translatedText=employee_text,
                confidence=0.94,
                isFinal=True,
            ),
        )
        await asyncio.sleep(1.3)

        sale = get_pos_provider("mock").simulate_sale(store_id, "employee-001", "CHG-USBC", "USB-C Charger", 19.99)
        txn = PosTransaction(
            id=sale.id,
            store_id=sale.store_id,
            employee_id=sale.employee_id,
            amount=sale.amount,
            occurred_at=sale.occurred_at,
            provider="mock",
        )
        db.add(txn)
        db.add(PosTransactionItem(id=f"item-{sale.id}", transaction_id=sale.id, sku="CHG-USBC", name="USB-C Charger", unit_price=19.99))
        db.commit()
        await hub.publish(room, _event("pos.transaction.received", storeId=store_id, transactionId=sale.id, product="USB-C Charger", amount=19.99, provider="mock"))
        match = match_transaction(db, txn)
        db.commit()
        if match:
            await hub.publish(
                room,
                _event(
                    "pos.transaction.matched",
                    storeId=store_id,
                    conversationId=LIVE_CONVERSATION_ID,
                    transactionId=sale.id,
                    confidence=match.confidence,
                    status="CONVERTED",
                    certain=False,
                    label="Opportunity Converted",
                ),
            )
        conversation.status = "ENDED"
        conversation.ended_at = datetime.now(UTC)
        conversation.opportunity_status = "CONVERTED"
        db.commit()
        await hub.publish(room, _event("conversation.ended", storeId=store_id, conversationId=LIVE_CONVERSATION_ID, opportunityStatus="CONVERTED"))
        return LIVE_CONVERSATION_ID
    finally:
        db.close()


async def emit_missed_example(store_id: str = "store-001") -> None:
    await hub.publish(
        f"store:{store_id}",
        _event(
            "missed_opportunity.detected",
            storeId=store_id,
            conversationId="conv-1002",
            status="MISSED",
            confidence=0.72,
            label="Likely Missed Opportunity",
            note="AI-assisted. Requires manager review.",
        ),
    )
    await hub.publish(
        "dashboard",
        _event("alert.created", storeId=store_id, severity="WARNING", title="Likely missed accessory sale"),
    )
