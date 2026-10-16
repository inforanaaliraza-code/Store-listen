from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.database import SessionLocal
from app.main import app
from app.models import AudioRecording, Conversation, ConversationParticipant, DailyReport, Employee, PosTransaction, SalesRecommendation, StockItem, Store, StoreDevice, StoreRule, TranscriptSegment
from app.providers.speech import MockSpeechProvider
from app.security import hash_device_secret
from app.services.audio_storage import delete_audio_clip

client = TestClient(app)


def login(email: str = "admin@storelisten.demo", password: str = "StoreListen!2026") -> dict[str, str]:
    client.cookies.clear()
    response = client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": password},
    )
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['token']}"}


def test_remaining_authenticated_read_routes():
    headers = login()
    assert client.get("/api/v1/auth/me", headers=headers).status_code == 200
    assert client.get("/ready").json()["status"] == "ready"
    assert "requests_total" in client.get("/metrics").json()

    assert client.get("/api/v1/stores", headers=headers).json()["stores"]["total"] >= 3
    assert client.get("/api/v1/stores/store-001", headers=headers).status_code == 200
    assert client.get("/api/v1/conversations", headers=headers).status_code == 200
    assert client.get("/api/v1/conversations/conv-1001", headers=headers).status_code == 200
    transcript = client.get("/api/v1/conversations/conv-1001/transcript", headers=headers)
    assert transcript.status_code == 200
    assert transcript.json()["segments"][0]["original_text"]
    assert client.get("/api/v1/opportunities", headers=headers).status_code == 200
    assert client.get("/api/v1/sales-intelligence", headers=headers).status_code == 200
    assert client.get("/api/v1/alerts", headers=headers).status_code == 200
    assert client.get("/api/v1/employees", headers=headers).status_code == 200
    assert client.get("/api/v1/employees/employee-001", headers=headers).status_code == 200
    assert client.get("/api/v1/employees/employee-001/performance", headers=headers).status_code == 200
    assert client.get("/api/v1/pos/transactions", headers=headers).status_code == 200
    assert client.get("/api/v1/analytics", headers=headers).status_code == 200
    assert client.get("/api/v1/settings", headers=headers).status_code == 200
    for period in ("daily", "weekly", "monthly"):
        report = client.get(f"/api/v1/reports/{period}", headers=headers)
        assert report.status_code == 200
        assert report.json()["pos_provider"] == "mock"


def test_reports_filter_conversations_to_the_selected_period():
    headers = login()
    baseline_daily = client.get("/api/v1/reports/daily", headers=headers).json()["metrics"]["conversations"]
    baseline_monthly = client.get("/api/v1/reports/monthly", headers=headers).json()["metrics"]["conversations"]
    suffix = uuid4().hex
    now = datetime.now(UTC)
    db = SessionLocal()
    try:
        db.add_all([
            Conversation(
                id=f"conv-report-current-{suffix}",
                store_id="store-001",
                status="ENDED",
                primary_language="en",
                started_at=now,
                opportunity_status="UNKNOWN",
            ),
            Conversation(
                id=f"conv-report-old-{suffix}",
                store_id="store-001",
                status="ENDED",
                primary_language="en",
                started_at=now - timedelta(days=60),
                opportunity_status="UNKNOWN",
            ),
        ])
        db.commit()

        daily = client.get("/api/v1/reports/daily", headers=headers).json()
        monthly = client.get("/api/v1/reports/monthly", headers=headers).json()
        assert daily["metrics"]["conversations"] == baseline_daily + 1
        assert monthly["metrics"]["conversations"] == baseline_monthly + 1
        assert daily["range_start"] != monthly["range_start"]
    finally:
        db.query(Conversation).filter(Conversation.id.in_([
            f"conv-report-current-{suffix}",
            f"conv-report-old-{suffix}",
        ])).delete(synchronize_session=False)
        db.commit()
        db.close()


def test_daily_report_generation_snapshots_store_pos_revenue():
    headers = login()
    suffix = uuid4().hex
    transaction_id = f"txn-report-{suffix}"
    now = datetime.now(UTC)
    db = SessionLocal()
    db.add(PosTransaction(
        id=transaction_id,
        store_id="store-001",
        employee_id="employee-001",
        amount=23.45,
        currency="USD",
        occurred_at=now,
        provider="mock",
    ))
    db.commit()
    db.close()

    generated = client.post(
        "/api/v1/reports/daily/generate",
        headers=headers,
        json={"store_id": "store-001"},
    )
    assert generated.status_code == 200, generated.text
    body = generated.json()
    assert body["reportStatus"] == "generated"
    assert body["pos_provider"] == "mock"
    assert body["daily_analysis"]["provider_summary"]["provider"] == "mock"
    assert body["daily_analysis"]["provider_summary"]["status"] == "completed"
    assert body["metrics"]["sales_count"] >= 1
    assert body["metrics"]["revenue_by_currency"]["USD"] >= 23.45
    assert body["timezone"] == "America/Chicago"

    reloaded = client.get("/api/v1/reports/daily?store_id=store-001", headers=headers)
    assert reloaded.status_code == 200
    assert reloaded.json() == body
    history = client.get("/api/v1/reports/history?store_id=store-001", headers=headers)
    assert history.status_code == 200
    assert any(row["business_date"] == body["business_date"] for row in history.json()["reports"])

    db = SessionLocal()
    try:
        db.query(PosTransaction).filter(PosTransaction.id == transaction_id).delete(synchronize_session=False)
        db.query(DailyReport).filter(DailyReport.id == f"daily-store-001-{body['business_date']}").delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


def test_pos_demo_and_webhook_validate_input_and_scope():
    admin_headers = login()
    created = client.post("/api/v1/pos/demo", headers=admin_headers)
    assert created.status_code == 200
    assert created.json()["transaction"]["amount"] == 19.99

    webhook_payload = {
        "store_id": "store-001",
        "employee_id": "employee-001",
        "sku": "CHG-USBC",
        "name": "USB-C Charger",
        "amount": 19.99,
    }
    accepted = client.post("/api/v1/pos/webhook", headers=admin_headers, json=webhook_payload)
    assert accepted.status_code == 200
    assert accepted.json()["accepted"] is True
    assert client.post("/api/v1/pos/webhook", headers=admin_headers, json={**webhook_payload, "amount": -1}).status_code == 422

    manager_headers = login("manager@storelisten.demo")
    denied = client.post("/api/v1/pos/webhook", headers=manager_headers, json={**webhook_payload, "store_id": "store-003"})
    assert denied.status_code == 404


def test_store_manager_cannot_access_other_store_records_or_actions():
    headers = login("manager@storelisten.demo")
    assert client.get("/api/v1/stores/store-003", headers=headers).status_code == 404
    assert client.get("/api/v1/conversations/conv-1005", headers=headers).status_code == 404
    assert client.get("/api/v1/conversations/conv-1005/transcript", headers=headers).status_code == 404
    assert client.get("/api/v1/employees/employee-004", headers=headers).status_code == 404
    assert client.get("/api/v1/employees/employee-004/performance", headers=headers).status_code == 404
    assert client.patch(
        "/api/v1/opportunities/opp-2003",
        headers=headers,
        json={"status": "MISSED", "manager_note": "out of scope"},
    ).status_code == 404
    assert client.post("/api/v1/devices/register", headers=headers, json={"store_id": "store-003"}).status_code == 404
    assert client.post("/api/v1/demo/replay?store_id=store-003", headers=headers).status_code == 404

    settings = client.get("/api/v1/settings", headers=headers).json()
    assert [store["id"] for store in settings["stores"]] == ["store-001"]
    assert [user["id"] for user in settings["users"]] == ["user-manager"]

    token = headers["Authorization"].split()[-1]
    with client.websocket_connect("/ws/stores/store-001", subprotocols=["storelisten.v1", token]):
        pass
    with client.websocket_connect(f"/ws/stores/store-001?token={token}", subprotocols=["storelisten.v1"]) as store_socket:
        store_socket.send_text("ping")
        assert store_socket.receive_text() == "pong"
    with __import__("pytest").raises(WebSocketDisconnect) as error:
        with client.websocket_connect("/ws/stores/store-003", subprotocols=["storelisten.v1", headers["Authorization"].split()[-1]]):
            pass
    assert error.value.code == 4403
    with __import__("pytest").raises(WebSocketDisconnect) as error:
        with client.websocket_connect("/ws/dashboard", subprotocols=["storelisten.v1", headers["Authorization"].split()[-1]]):
            pass
    assert error.value.code == 4403


def test_device_registration_and_authenticated_health_websocket():
    headers = login()
    registered = client.post(
        "/api/v1/devices/register",
        headers=headers,
        json={"store_id": "store-001", "name": "QA device", "audio_source": "mock"},
    )
    assert registered.status_code == 200
    device_id = registered.json()["device_id"]
    device_secret = registered.json()["device_secret"]
    assert device_secret

    payload = {
        "cpu_pct": 19.5,
        "memory_pct": 41.2,
        "audio_status": "streaming",
        "microphone_status": "ok",
        "stream_status": "live",
        "processing_latency_ms": 172,
    }
    with client.websocket_connect(f"/ws/device/{device_id}", subprotocols=["storelisten.v1", device_secret]) as websocket:
        websocket.send_json(payload)

    with __import__("pytest").raises(WebSocketDisconnect) as error:
        with client.websocket_connect(f"/ws/device/{device_id}", subprotocols=["storelisten.v1", "wrong-secret"]):
            pass
    assert error.value.code == 4401
    with __import__("pytest").raises(WebSocketDisconnect) as error:
        with client.websocket_connect(f"/ws/device/{device_id}"):
            pass
    assert error.value.code == 4401

    db = SessionLocal()
    try:
        device = db.get(StoreDevice, device_id)
        assert device is not None and device.status == "heartbeat_missing"
        assert device.cpu_pct == 19.5
        assert device.last_heartbeat is not None
        assert device.secret_hash == hash_device_secret(device_secret)
        revoked = client.post(f"/api/v1/devices/{device_id}/revoke", headers=headers)
        assert revoked.status_code == 200
        assert revoked.json()["status"] == "revoked"
        with __import__("pytest").raises(WebSocketDisconnect) as error:
            with client.websocket_connect(
                f"/ws/device/{device_id}",
                subprotocols=["storelisten.v1", device_secret],
            ):
                pass
        assert error.value.code == 4401
        db.refresh(device)
        assert device.revoked is True
    finally:
        if device is not None:
            db.delete(device)
        db.commit()
        db.close()


def test_device_audio_is_store_scoped_and_visible_in_admin_transcripts(monkeypatch):
    monkeypatch.setattr("app.api.get_speech_provider", lambda _name: MockSpeechProvider())
    monkeypatch.setattr("app.api.merge_audio_clips", lambda _recordings: b"overall-test-recording")
    admin_headers = login()
    registered = client.post(
        "/api/v1/devices/register",
        headers=admin_headers,
        json={"store_id": "store-001", "name": "Desktop capture test", "audio_source": "microphone"},
    )
    assert registered.status_code == 200, registered.text
    device_id = registered.json()["device_id"]
    assert registered.json()["approval_status"] == "pending"
    blocked = client.post(
        "/api/v1/audio/sessions",
        headers={
            "Authorization": f"Bearer {registered.json()['device_secret']}",
            "X-Device-ID": device_id,
        },
        json={"store_id": "store-001"},
    )
    assert blocked.status_code == 403, blocked.text
    approved = client.post(f"/api/v1/devices/{device_id}/approve", headers=admin_headers)
    assert approved.status_code == 200, approved.text
    assert approved.json()["approval_status"] == "approved"
    device_headers = {
        "Authorization": f"Bearer {registered.json()['device_secret']}",
        "X-Device-ID": device_id,
    }
    conversation_id = None
    db = None
    try:
        started = client.post("/api/v1/audio/sessions", headers=device_headers, json={"store_id": "store-001"})
        assert started.status_code == 200, started.text
        conversation_id = started.json()["conversation_id"]
        assert client.post("/api/v1/audio/sessions", headers=device_headers, json={"store_id": "store-003"}).status_code == 404

        uploaded = client.post(
            "/api/v1/audio/transcribe",
            headers=device_headers,
            data={
                "store_id": "store-001",
                "conversation_id": conversation_id,
                "speaker_role": "unknown",
                "capture_sequence": "0",
                "duration_seconds": "4",
            },
            files={"audio": ("store-clip.webm", b"Customer asks if this charger is available.", "audio/webm")},
        )
        assert uploaded.status_code == 200, uploaded.text
        assert uploaded.json()["segment"]["originalText"]
        assert client.post(
            f"/api/v1/audio/sessions/{conversation_id}/finish", headers=device_headers
        ).json()["status"] == "ENDED"

        transcript = client.get(f"/api/v1/conversations/{conversation_id}/transcript", headers=admin_headers)
        assert transcript.status_code == 200
        assert transcript.json()["segments"][0]["original_text"] == uploaded.json()["segment"]["originalText"]
    finally:
        db = SessionLocal()
        try:
            if conversation_id:
                recordings = db.query(AudioRecording).filter(AudioRecording.conversation_id == conversation_id).all()
                for recording in recordings:
                    delete_audio_clip(recording.storage_key)
                    db.delete(recording)
                db.query(TranscriptSegment).filter(TranscriptSegment.conversation_id == conversation_id).delete(synchronize_session=False)
                db.query(ConversationParticipant).filter(ConversationParticipant.conversation_id == conversation_id).delete(synchronize_session=False)
                db.query(Conversation).filter(Conversation.id == conversation_id).delete(synchronize_session=False)
            device = db.get(StoreDevice, device_id)
            if device:
                db.delete(device)
            db.commit()
        finally:
            db.close()


def test_store_and_employee_crud_preserves_scope_and_history():
    headers = login()
    suffix = uuid4().hex[:8]
    store_ids: list[str] = []
    employee_ids: list[str] = []

    try:
        created_store = client.post(
            "/api/v1/stores",
            headers=headers,
            json={"name": "CRUD Store", "code": f"T-{suffix}", "city": "Dallas", "region": "TX"},
        )
        assert created_store.status_code == 201, created_store.text
        store_id = created_store.json()["id"]
        store_ids.append(store_id)

        updated_store = client.patch(f"/api/v1/stores/{store_id}", headers=headers, json={"name": "CRUD Store Updated"})
        assert updated_store.status_code == 200
        assert updated_store.json()["name"] == "CRUD Store Updated"

        created_employee = client.post(
            "/api/v1/employees",
            headers=headers,
            json={"name": "CRUD Employee", "store_id": store_id, "role": "Sales associate"},
        )
        assert created_employee.status_code == 201, created_employee.text
        employee_id = created_employee.json()["id"]
        employee_ids.append(employee_id)

        updated_employee = client.patch(
            f"/api/v1/employees/{employee_id}",
            headers=headers,
            json={"name": "CRUD Employee Updated", "role": "Store lead"},
        )
        assert updated_employee.status_code == 200
        assert updated_employee.json()["name"] == "CRUD Employee Updated"
        assert updated_employee.json()["role"] == "Store lead"

        archived = client.delete(f"/api/v1/employees/{employee_id}", headers=headers)
        assert archived.status_code == 200
        assert archived.json()["active"] is False
        listed = client.get(f"/api/v1/employees?store_id={store_id}", headers=headers).json()["employees"]
        assert employee_id not in {employee["id"] for employee in listed}
        assert client.get(f"/api/v1/stores/{store_id}", headers=headers).json()["employees"] == 0

        linked_delete = client.delete(f"/api/v1/stores/{store_id}", headers=headers)
        assert linked_delete.status_code == 409

        manager_headers = login("manager@storelisten.demo")
        denied_store = client.post(
            "/api/v1/employees",
            headers=manager_headers,
            json={"name": "Out of scope", "store_id": "store-003", "role": "Sales associate"},
        )
        assert denied_store.status_code == 404

        clean_store = client.post(
            "/api/v1/stores",
            headers=headers,
            json={"name": "Clean CRUD Store", "code": f"C-{suffix}", "city": "Austin", "region": "TX"},
        )
        assert clean_store.status_code == 201
        clean_store_id = clean_store.json()["id"]
        store_ids.append(clean_store_id)
        assert client.delete(f"/api/v1/stores/{clean_store_id}", headers=headers).status_code == 200
    finally:
        db = SessionLocal()
        try:
            db.query(Employee).filter(Employee.id.in_(employee_ids)).delete(synchronize_session=False)
            db.query(Store).filter(Store.id.in_(store_ids)).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()


def test_inventory_and_store_rule_crud_are_persistent_and_scoped():
    headers = login()
    stock = client.post(
        "/api/v1/inventory",
        headers=headers,
        json={"store_id": "store-001", "sku": "case-blue", "name": "Blue case", "cost": 5, "price": 15, "quantity": 2, "par_level": 3},
    )
    assert stock.status_code == 201, stock.text
    item_id = stock.json()["id"]
    listed = client.get("/api/v1/inventory?store_id=store-001", headers=headers).json()
    assert listed["summary"]["low_stock"] >= 1
    assert any(item["id"] == item_id and item["sku"] == "CASE-BLUE" for item in listed["items"])
    updated_stock = client.patch(f"/api/v1/inventory/{item_id}", headers=headers, json={"quantity": 8})
    assert updated_stock.status_code == 200
    assert updated_stock.json()["quantity"] == 8

    rule = client.post(
        "/api/v1/rules",
        headers=headers,
        json={"store_id": "store-001", "name": "Case offer", "dollar_value": 12, "trigger_condition": "Customer chooses a phone", "expected_action": "Offer a case"},
    )
    assert rule.status_code == 201, rule.text
    rule_id = rule.json()["id"]
    assert client.get("/api/v1/rules?store_id=store-001", headers=headers).json()["active_count"] >= 1
    disabled = client.patch(f"/api/v1/rules/{rule_id}", headers=headers, json={"active": False})
    assert disabled.status_code == 200
    assert disabled.json()["active"] is False

    manager_headers = login("manager@storelisten.demo")
    assert client.get(f"/api/v1/inventory?store_id=store-003", headers=manager_headers).status_code == 404
    assert client.post("/api/v1/rules", headers=manager_headers, json={"store_id": "store-003", "name": "Out of scope", "trigger_condition": "Trigger", "expected_action": "Action"}).status_code == 404
    assert client.delete(f"/api/v1/inventory/{item_id}", headers=headers).status_code == 204
    assert client.delete(f"/api/v1/rules/{rule_id}", headers=headers).status_code == 204


def test_active_store_rule_drives_customer_coaching_recommendation(monkeypatch):
    from app.config import settings
    from app.services.intelligence import analyze_and_persist

    monkeypatch.setattr(settings, "ai_provider", "mock")
    conversation_id = f"conv-rule-match-{uuid4().hex}"
    db = SessionLocal()
    try:
        db.add(Conversation(id=conversation_id, store_id="store-001", status="LIVE", primary_language="en", opportunity_status="UNKNOWN"))
        db.add(StoreRule(
            id=f"rule-test-{uuid4().hex[:10]}",
            store_id="store-001",
            name="Phone case offer",
            dollar_value=8,
            trigger_condition="Customer asks about a case",
            expected_action="Show the customer a case compatible with their phone.",
            active=True,
        ))
        db.flush()
        result = analyze_and_persist(
            db,
            conversation_id=conversation_id,
            store_id="store-001",
            employee_id=None,
            original_text="Do you have a phone case?",
            translated_text="Do you have a phone case?",
            language="en",
            speaker_role="customer",
        )
        db.flush()
        recommendation = db.query(SalesRecommendation).filter(SalesRecommendation.conversation_id == conversation_id).one()
        assert result is not None and result.opportunity is True
        assert recommendation.title == "Phone case offer"
        assert recommendation.message == "Show the customer a case compatible with their phone."
        assert recommendation.confidence <= 0.75
    finally:
        db.rollback()
        db.close()


def test_devcore_task_crud_requires_org_admin():
    admin_headers = login("hello@devcore.studio", "Devcore!2026")
    tasks = client.get("/api/v1/devcore/tasks", headers=admin_headers)
    assert tasks.status_code == 200
    created = client.post(
        "/api/v1/devcore/tasks",
        headers=admin_headers,
        json={"title": "Automated route audit", "project_id": "proj-storelisten", "priority": "high"},
    )
    assert created.status_code == 200
    task_id = created.json()["id"]
    updated = client.patch(
        f"/api/v1/devcore/tasks/{task_id}",
        headers=admin_headers,
        json={"status": "review"},
    )
    assert updated.status_code == 200
    assert updated.json()["status"] == "review"
    manager_headers = login("manager@storelisten.demo")
    assert client.get("/api/v1/devcore/tasks", headers=manager_headers).status_code == 403
    assert client.post("/api/v1/devcore/tasks", headers=manager_headers, json={"title": "No"}).status_code == 403
