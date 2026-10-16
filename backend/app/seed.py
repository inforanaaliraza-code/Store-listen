from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

from sqlalchemy.orm import Session

from app.models import (
    Alert,
    Conversation,
    ConversationParticipant,
    ConversationPosMatch,
    DailyReport,
    DevcoreProject,
    DevcoreTask,
    Employee,
    EmployeePerformance,
    IntegrationConnection,
    Organization,
    PosTransaction,
    PosTransactionItem,
    Product,
    ProductOpportunity,
    RolePermission,
    SalesRecommendation,
    Store,
    StoreDevice,
    StorePerformance,
    TranscriptSegment,
    User,
)
from app.security import hash_device_secret, hash_password

DEMO_PASSWORD = "StoreListen!2026"
DEVCORE_PASSWORD = "Devcore!2026"


def seed_if_empty(db: Session) -> None:
    if db.get(Organization, "org-northstar"):
        return
    now = datetime.now(UTC)
    org = Organization(id="org-northstar", name="Northstar Retail")
    db.add(org)
    stores = [
        Store(id="store-001", organization_id=org.id, name="Store 001", code="DAL-001", city="Dallas", region="TX", online=True),
        Store(id="store-002", organization_id=org.id, name="Store 002", code="PHX-002", city="Phoenix", region="AZ", online=True),
        Store(id="store-003", organization_id=org.id, name="Store 003", code="CHI-003", city="Chicago", region="IL", online=False),
    ]
    db.add_all(stores)
    db.add_all(
        [
            StoreDevice(
                id="device-001",
                store_id="store-001",
                name="Counter mic A",
                status="connected",
                approval_status="approved",
                audio_source="mock",
                secret_hash=hash_device_secret("device-001-demo-secret"),
                last_heartbeat=now,
                audio_status="streaming",
                stream_status="live",
                processing_latency_ms=180,
                approved_at=now,
            ),
            StoreDevice(
                id="device-002",
                store_id="store-002",
                name="Counter mic A",
                status="heartbeat_missing",
                approval_status="approved",
                audio_source="mock",
                secret_hash=hash_device_secret("device-002-demo-secret"),
                last_heartbeat=now - timedelta(minutes=18),
                audio_status="degraded",
                microphone_status="low_level",
                approved_at=now,
            ),
            StoreDevice(
                id="device-003",
                store_id="store-003",
                name="Counter mic A",
                status="disconnected",
                approval_status="approved",
                audio_source="mock",
                secret_hash=hash_device_secret("device-003-demo-secret"),
                approved_at=now,
            ),
        ]
    )
    employees = [
        Employee(id="employee-001", store_id="store-001", full_name="Maya Rivera", role_title="Sales associate"),
        Employee(id="employee-002", store_id="store-001", full_name="Jordan Chen", role_title="Sales associate"),
        Employee(id="employee-003", store_id="store-002", full_name="Avery Brooks", role_title="Store supervisor"),
        Employee(id="employee-004", store_id="store-003", full_name="Sam Okonkwo", role_title="Sales associate"),
    ]
    db.add_all(employees)
    db.add_all(
        [
            User(
                id="user-admin",
                organization_id=org.id,
                email="admin@storelisten.demo",
                full_name="Alex Rivera",
                password_hash=hash_password(DEMO_PASSWORD),
                role="SUPER_ADMIN",
            ),
            User(
                id="user-manager",
                organization_id=org.id,
                email="manager@storelisten.demo",
                full_name="Priya Shah",
                password_hash=hash_password(DEMO_PASSWORD),
                role="STORE_MANAGER",
                store_id="store-001",
            ),
            User(
                id="user-devcore",
                organization_id=org.id,
                email="hello@devcore.studio",
                full_name="Devcore Operator",
                password_hash=hash_password(DEVCORE_PASSWORD),
                role="ORG_ADMIN",
            ),
        ]
    )
    roles = ["SUPER_ADMIN", "ORG_ADMIN", "STORE_MANAGER", "SUPERVISOR", "EMPLOYEE", "VIEWER"]
    perms = ["stores.read", "conversations.read", "opportunities.review", "reports.read", "settings.read"]
    for role in roles:
        for perm in perms:
            if role == "VIEWER" and perm.endswith("review"):
                continue
            db.add(RolePermission(role=role, permission=perm))

    products = [
        Product(id="prod-charger", sku="CHG-USBC", name="USB-C Charger", category="accessories", keywords="charger iphone usb-c cargador"),
        Product(id="prod-cable", sku="CBL-LTN", name="Lightning cable", category="accessories", keywords="cable wire lightning"),
        Product(id="prod-case", sku="CSE-CLR", name="Clear case", category="accessories", keywords="case protector"),
    ]
    db.add_all(products)

    conversations = [
        Conversation(
            id="conv-1001",
            store_id="store-001",
            employee_id="employee-001",
            status="ENDED",
            primary_language="es",
            started_at=now - timedelta(hours=1, minutes=8),
            ended_at=now - timedelta(hours=1),
            customer_intent="charger purchase",
            detected_product="phone charger",
            opportunity_status="CONVERTED",
        ),
        Conversation(
            id="conv-1002",
            store_id="store-001",
            employee_id="employee-002",
            status="ENDED",
            primary_language="en",
            started_at=now - timedelta(hours=3),
            ended_at=now - timedelta(hours=2, minutes=50),
            customer_intent="cable purchase",
            detected_product="phone cable",
            opportunity_status="MISSED",
        ),
        Conversation(
            id="conv-1003",
            store_id="store-002",
            employee_id="employee-003",
            status="ENDED",
            primary_language="en",
            started_at=now - timedelta(hours=5),
            ended_at=now - timedelta(hours=4, minutes=50),
            customer_intent="price inquiry",
            detected_product="unspecified product",
            opportunity_status="UNKNOWN",
        ),
        Conversation(
            id="conv-1004",
            store_id="store-001",
            employee_id="employee-001",
            status="ENDED",
            primary_language="en",
            started_at=now - timedelta(hours=6),
            ended_at=now - timedelta(hours=5, minutes=48),
            customer_intent="availability",
            detected_product="clear case",
            opportunity_status="OPEN",
        ),
        Conversation(
            id="conv-1005",
            store_id="store-003",
            employee_id="employee-004",
            status="ENDED",
            primary_language="es",
            started_at=now - timedelta(hours=8),
            ended_at=now - timedelta(hours=7, minutes=55),
            customer_intent="accessory purchase",
            detected_product="phone cable",
            opportunity_status="REVIEW_REQUIRED",
        ),
    ]
    db.add_all(conversations)
    db.add_all(
        [
            ConversationParticipant(id="part-1", conversation_id="conv-1001", speaker_label="Speaker 01", mapped_role="customer"),
            ConversationParticipant(id="part-2", conversation_id="conv-1001", speaker_label="Speaker 02", mapped_role="employee", employee_id="employee-001"),
        ]
    )
    db.add_all(
        [
            TranscriptSegment(
                id="seg-1",
                conversation_id="conv-1001",
                speaker_id="spk-1",
                language="es",
                original_text="¿Tiene un cargador para iPhone?",
                translated_text="Do you have an iPhone charger?",
                start_time=0,
                end_time=2.8,
                confidence=0.97,
            ),
            TranscriptSegment(
                id="seg-2",
                conversation_id="conv-1001",
                speaker_id="spk-2",
                language="en",
                original_text="Which iPhone model do you have? We have USB-C.",
                translated_text="Which iPhone model do you have? We have USB-C.",
                start_time=3.2,
                end_time=6.1,
                confidence=0.94,
            ),
            TranscriptSegment(
                id="seg-3",
                conversation_id="conv-1002",
                speaker_id="spk-1",
                language="en",
                original_text="I need a cable for my phone.",
                translated_text="I need a cable for my phone.",
                start_time=0,
                end_time=2.1,
                confidence=0.95,
            ),
            TranscriptSegment(
                id="seg-4",
                conversation_id="conv-1002",
                speaker_id="spk-2",
                language="en",
                original_text="Okay.",
                translated_text="Okay.",
                start_time=2.4,
                end_time=3.0,
                confidence=0.91,
            ),
        ]
    )
    db.add_all(
        [
            ProductOpportunity(
                id="opp-2001",
                conversation_id="conv-1001",
                store_id="store-001",
                employee_id="employee-001",
                product_id="prod-charger",
                customer_intent="charger purchase",
                product_name="USB-C charger",
                status="CONVERTED",
                confidence=0.91,
                recommendation="Ask which iPhone model or connector the customer uses.",
                created_at=now - timedelta(hours=1, minutes=6),
            ),
            ProductOpportunity(
                id="opp-2002",
                conversation_id="conv-1002",
                store_id="store-001",
                employee_id="employee-002",
                product_id="prod-cable",
                customer_intent="cable purchase",
                product_name="Lightning cable",
                status="MISSED",
                confidence=0.72,
                recommendation="Ask which connector the customer needs instead of acknowledging without a question.",
                created_at=now - timedelta(hours=3),
            ),
            ProductOpportunity(
                id="opp-2003",
                conversation_id="conv-1005",
                store_id="store-003",
                employee_id="employee-004",
                product_id="prod-cable",
                customer_intent="accessory purchase",
                product_name="phone cable",
                status="REVIEW_REQUIRED",
                confidence=0.61,
                recommendation="Manager review: customer left; POS correlation is incomplete.",
                created_at=now - timedelta(hours=8),
            ),
        ]
    )
    db.add(
        SalesRecommendation(
            id="tip-1001",
            conversation_id="conv-1001",
            store_id="store-001",
            title="Confirm connector compatibility",
            message="Ask which iPhone model or connector the customer uses.",
            confidence=0.88,
        )
    )
    txn = PosTransaction(
        id="txn-4410",
        store_id="store-001",
        employee_id="employee-001",
        amount=19.99,
        occurred_at=now - timedelta(hours=1, minutes=2),
        provider="mock",
        external_id="demo-4410",
    )
    db.add(txn)
    db.add(PosTransactionItem(id="item-4410", transaction_id=txn.id, product_id="prod-charger", sku="CHG-USBC", name="USB-C Charger", unit_price=19.99))
    db.add(
        ConversationPosMatch(
            id="match-4410",
            conversation_id="conv-1001",
            transaction_id=txn.id,
            opportunity_id="opp-2001",
            confidence=0.91,
            method="store_time_product_employee",
            certain=False,
        )
    )
    db.add_all(
        [
            Alert(
                id="alert-1",
                store_id="store-003",
                severity="CRITICAL",
                title="Store offline",
                description="Store 003 has not reported a heartbeat.",
                created_at=now - timedelta(minutes=40),
            ),
            Alert(
                id="alert-2",
                store_id="store-002",
                severity="WARNING",
                title="Audio device degraded",
                description="Microphone level is low on Store 002 counter device.",
                created_at=now - timedelta(minutes=18),
            ),
            Alert(
                id="alert-3",
                store_id="store-001",
                severity="INFO",
                title="Potential missed opportunity",
                description="Cable inquiry at Store 001 was classified as likely missed. Manager review recommended.",
                created_at=now - timedelta(hours=3),
            ),
        ]
    )
    db.add_all(
        [
            EmployeePerformance(
                id="ep-1",
                employee_id="employee-001",
                conversations_handled=18,
                opportunities_detected=7,
                opportunities_converted=5,
                potential_missed=1,
                avg_response_seconds=16.7,
                conversion_rate=0.71,
            ),
            EmployeePerformance(
                id="ep-2",
                employee_id="employee-002",
                conversations_handled=14,
                opportunities_detected=6,
                opportunities_converted=3,
                potential_missed=2,
                avg_response_seconds=22.1,
                conversion_rate=0.50,
            ),
            StorePerformance(id="sp-1", store_id="store-001", conversations=28, opportunities=12, converted=8, missed=2, conversion_rate=0.67),
            StorePerformance(id="sp-2", store_id="store-002", conversations=9, opportunities=4, converted=3, missed=0, conversion_rate=0.75),
            StorePerformance(id="sp-3", store_id="store-003", conversations=5, opportunities=2, converted=1, missed=1, conversion_rate=0.50),
        ]
    )
    db.add(
        DailyReport(
            id="rpt-demo",
            period="daily",
            payload_json="{}",
            generated_at=now,
        )
    )
    db.add_all(
        [
            IntegrationConnection(id="int-ai", kind="ai", provider="mock", status="demo", notes="Gork/Grok mentioned in client notes; unconfirmed."),
            IntegrationConnection(id="int-speech", kind="speech", provider="mock", status="demo", notes="Whisper adapter exists; demo uses MockSpeechProvider."),
            IntegrationConnection(id="int-pos", kind="pos", provider="mock", status="demo", notes="POS vendor unknown. MockPOSProvider only."),
        ]
    )
    db.add(DevcoreProject(id="proj-storelisten", name="Store Listen", client="Northstar Retail", status="active"))
    db.add_all(
        [
            DevcoreTask(id="task-1", project_id="proj-storelisten", title="Confirm POS vendor and API access", status="backlog", priority="high", assignee="Discovery", labels="client,blocker"),
            DevcoreTask(id="task-2", project_id="proj-storelisten", title="Draft recording notice copy", status="todo", priority="high", assignee="Legal liaison", labels="privacy"),
            DevcoreTask(id="task-3", project_id="proj-storelisten", title="Live monitor UX polish", status="in_progress", priority="medium", assignee="Product", labels="frontend"),
            DevcoreTask(id="task-4", project_id="proj-storelisten", title="Demo scenario QA", status="review", priority="medium", assignee="QA", labels="demo"),
            DevcoreTask(id="task-5", project_id="proj-storelisten", title="Seed Dallas store conversations", status="done", priority="low", assignee="Eng", labels="data"),
        ]
    )
    db.commit()
