from fastapi.testclient import TestClient

from app.config import settings
from app.main import app

client = TestClient(app)


def test_health_endpoint():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_readiness_reports_actual_environment_and_demo_mode():
    response = client.get("/ready")
    assert response.status_code == 200
    expected_mode = "demo" if settings.demo_mode else settings.app_env.lower()
    assert response.json()["mode"] == expected_mode


def test_readiness_does_not_call_non_demo_development_production(monkeypatch):
    monkeypatch.setattr(settings, "app_env", "development")
    monkeypatch.setattr(settings, "demo_mode", False)
    response = client.get("/ready")
    assert response.status_code == 200
    assert response.json()["mode"] == "development"


def test_dashboard_requires_auth():
    response = client.get("/api/v1/dashboard/summary")
    assert response.status_code == 401
