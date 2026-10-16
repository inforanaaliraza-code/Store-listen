from uuid import uuid4

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.models import StoreDevice
from app.services.device_approval import device_is_approved
from app.services.store_listener_report import build_store_listener_daily_report

client = TestClient(app)


def login() -> dict[str, str]:
    response = client.post("/api/v1/auth/login", json={"email": "admin@storelisten.demo", "password": "StoreListen!2026"})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['token']}"}


def test_pending_device_requires_admin_approval_before_recording():
    headers = login()
    registered = client.post(
        "/api/v1/devices/register",
        headers=headers,
        json={"store_id": "store-001", "name": f"Approval gate {uuid4().hex[:6]}", "audio_source": "microphone"},
    )
    assert registered.status_code == 200, registered.text
    payload = registered.json()
    device_id = payload["device_id"]
    device_headers = {
        "Authorization": f"Bearer {payload['device_secret']}",
        "X-Device-ID": device_id,
    }
    try:
        pending = client.get("/api/v1/devices/pending", headers=headers)
        assert pending.status_code == 200
        assert any(item["id"] == device_id for item in pending.json()["devices"])

        status = client.get(f"/api/v1/devices/{device_id}/approval", headers=device_headers)
        assert status.status_code == 200
        assert status.json()["approved"] is False
        assert status.json()["approval_status"] == "pending"

        assert client.post("/api/v1/audio/sessions", headers=device_headers, json={"store_id": "store-001"}).status_code == 403

        approved = client.post(f"/api/v1/devices/{device_id}/approve", headers=headers)
        assert approved.status_code == 200
        assert approved.json()["approval_status"] == "approved"
        assert client.get(f"/api/v1/devices/{device_id}/approval", headers=device_headers).json()["approved"] is True
        started = client.post("/api/v1/audio/sessions", headers=device_headers, json={"store_id": "store-001"})
        assert started.status_code == 200, started.text
        conversation_id = started.json()["conversation_id"]
        assert client.post(f"/api/v1/audio/sessions/{conversation_id}/finish", headers=device_headers).status_code == 200
    finally:
        db = SessionLocal()
        try:
            device = db.get(StoreDevice, device_id)
            if device:
                db.delete(device)
                db.commit()
        finally:
            db.close()


def test_reject_device_keeps_recording_blocked():
    headers = login()
    registered = client.post(
        "/api/v1/devices/register",
        headers=headers,
        json={"store_id": "store-001", "name": f"Reject gate {uuid4().hex[:6]}", "audio_source": "microphone"},
    )
    device_id = registered.json()["device_id"]
    device_headers = {
        "Authorization": f"Bearer {registered.json()['device_secret']}",
        "X-Device-ID": device_id,
    }
    try:
        rejected = client.post(f"/api/v1/devices/{device_id}/reject", headers=headers)
        assert rejected.status_code == 200
        assert rejected.json()["approval_status"] == "rejected"
        assert client.post("/api/v1/audio/sessions", headers=device_headers, json={"store_id": "store-001"}).status_code == 403
        db = SessionLocal()
        try:
            assert device_is_approved(db.get(StoreDevice, device_id)) is False
        finally:
            db.close()
    finally:
        db = SessionLocal()
        try:
            device = db.get(StoreDevice, device_id)
            if device:
                db.delete(device)
                db.commit()
        finally:
            db.close()


def test_store_listener_daily_report_has_six_kpis_and_sections():
    report = build_store_listener_daily_report(
        store_name="North Star",
        store_location="Dallas, TX",
        report={
            "business_date": "2026-10-16",
            "generatedAt": "2026-10-16T22:00:00+00:00",
            "metrics": {
                "revenue_by_currency": {"USD": 400},
                "sales_count": 2,
                "conversations": 4,
                "potential_missed_opportunities": 1,
                "converted_opportunities": 1,
            },
            "daily_analysis": {
                "sales_summary": "Solid day with charger demand.",
                "interaction_summary": "Most conversations stayed productive.",
                "potential_unconverted_opportunities": 1,
                "top_intents": [{"intent": "buy_charger", "count": 3}],
                "provider_summary": {
                    "summary": "4 customers attended with $400 in sales.",
                    "findings": ["One missed accessory upsell", "Charger was the top ask"],
                },
            },
        },
        low_stock_count=2,
        redacted_count=1,
    )
    assert report["brand"] == "STORE LISTENER"
    assert set(report["kpis"]) == {"revenue", "missed", "conversations", "avg_ticket", "low_stock", "redacted"}
    assert report["kpis"]["revenue"]["value"] == "$400"
    assert report["kpis"]["conversations"]["value"] == "4"
    assert report["executive_summary"]
    assert report["key_points"]
    assert report["sentiment"]["positive"] + report["sentiment"]["neutral"] + report["sentiment"]["negative"] == 100
    assert report["actions_for_tomorrow"]
    assert report["interactions"]
