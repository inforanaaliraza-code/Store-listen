from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import tempfile
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from time import perf_counter
from typing import Any, Literal
from uuid import NAMESPACE_URL, uuid4, uuid5

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, Response, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import or_
from sqlalchemy.orm import Session
from pymongo.errors import PyMongoError
from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.database import SessionLocal, get_db

# Finals and live previews use separate pools so a preview burst cannot delay the real transcript.
_final_slots = asyncio.Semaphore(2)
_preview_slots = asyncio.Semaphore(1)


async def _transcribe_audio_file(
    provider: Any,
    path: str,
    language_hint: str | None,
    *,
    wait: bool = True,
    fast: bool = False,
):
    """Run provider.transcribe_file under a global STT slot."""

    def _run():
        try:
            return provider.transcribe_file(path, language_hint, fast=fast)
        except TypeError:
            return provider.transcribe_file(path, language_hint)

    slots = _final_slots if wait else _preview_slots
    if wait:
        async with slots:
            return await run_in_threadpool(_run)
    try:
        await asyncio.wait_for(slots.acquire(), timeout=0.01)
    except TimeoutError:
        return None
    try:
        return await run_in_threadpool(_run)
    finally:
        slots.release()
from app.models import (
    Alert,
    AiProcessingRun,
    AuditLog,
    AudioRecording,
    Conversation,
    ConversationParticipant,
    DailyReport,
    DevcoreTask,
    Employee,
    EmployeePerformance,
    IntegrationConnection,
    PosTransaction,
    PosTransactionItem,
    ProductOpportunity,
    SalesRecommendation,
    StockItem,
    Store,
    StoreDevice,
    StoreRule,
    TranscriptSegment,
    User,
)
from app.providers.ai import generate_conversation_report, get_ai_provider, summarize_daily_report
from app.providers.pos import get_pos_provider
from app.providers.speech import (
    NoSpeechDetected,
    UnsupportedLanguageDetected,
    get_speech_provider,
    normalize_supported_language,
    resolve_speech_provider_name,
)
from app.providers.speech_quality import (
    ENGLISH_TRANSLATION_PENDING,
    detect_transcript_language,
    english_display_text,
    is_recent_duplicate,
)
from app.security import create_access_token, current_user, decode_token, hash_device_secret, new_device_secret, verify_password
from app.services.demo_live import run_live_demo
from app.services.events import hub
from app.services.audio_storage import delete_audio_clip, merge_audio_clips, resolve_audio_clip, save_audio_clip
from app.services.intelligence import analyze_and_persist
from app.services.matching import match_transaction
from app.services.device_approval import device_approval_status, device_is_approved
from app.services.recording_cleanup import delete_recording_entry, delete_recordings_by_ids, wipe_all_conversation_audio
from app.services.store_listener_report import (
    build_interaction_cards_from_conversations,
    build_store_listener_daily_report,
)
from app.services.queries import (
    apply_store_scope,
    dashboard_summary,
    paginate_query,
    report_summary,
    serialize_conversation,
    serialize_conversations,
    serialize_opportunity,
    serialize_store,
    serialize_stores,
)

api = APIRouter(prefix="/api/v1")
health = APIRouter()
logger = logging.getLogger("storelisten.audio")
MAX_AUDIO_BYTES = 20 * 1024 * 1024
ALLOWED_AUDIO_TYPES = {"audio/webm", "audio/ogg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/mpeg"}
WEBSOCKET_AUTH_PROTOCOL = "storelisten.v1"


class LoginBody(BaseModel):
    email: str = Field(min_length=3, max_length=180)
    password: str = Field(min_length=8, max_length=128)


class CrudBody(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class StoreCreate(CrudBody):
    name: str = Field(min_length=1, max_length=120)
    code: str = Field(min_length=1, max_length=32)
    city: str = Field(min_length=1, max_length=80)
    region: str = Field(min_length=1, max_length=40)
    timezone: str = Field(default="America/Chicago", min_length=1, max_length=64)


class StoreUpdate(CrudBody):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    code: str | None = Field(default=None, min_length=1, max_length=32)
    city: str | None = Field(default=None, min_length=1, max_length=80)
    region: str | None = Field(default=None, min_length=1, max_length=40)
    timezone: str | None = Field(default=None, min_length=1, max_length=64)


class StockItemCreate(CrudBody):
    store_id: str = Field(min_length=1, max_length=64)
    sku: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=160)
    cost: float = Field(default=0, ge=0, le=1_000_000)
    price: float = Field(default=0, ge=0, le=1_000_000)
    quantity: int = Field(default=0, ge=0, le=10_000_000)
    par_level: int = Field(default=0, ge=0, le=10_000_000)


class StockItemPatch(CrudBody):
    sku: str | None = Field(default=None, min_length=1, max_length=64)
    name: str | None = Field(default=None, min_length=1, max_length=160)
    cost: float | None = Field(default=None, ge=0, le=1_000_000)
    price: float | None = Field(default=None, ge=0, le=1_000_000)
    quantity: int | None = Field(default=None, ge=0, le=10_000_000)
    par_level: int | None = Field(default=None, ge=0, le=10_000_000)


class StoreRuleCreate(CrudBody):
    store_id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=160)
    dollar_value: float = Field(default=0, ge=0, le=1_000_000)
    trigger_condition: str = Field(min_length=1, max_length=2000)
    expected_action: str = Field(min_length=1, max_length=2000)


class StoreRulePatch(CrudBody):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    dollar_value: float | None = Field(default=None, ge=0, le=1_000_000)
    trigger_condition: str | None = Field(default=None, min_length=1, max_length=2000)
    expected_action: str | None = Field(default=None, min_length=1, max_length=2000)
    active: bool | None = None


class EmployeeCreate(CrudBody):
    name: str = Field(min_length=1, max_length=160)
    store_id: str = Field(min_length=1, max_length=64)
    role: str = Field(default="Sales associate", min_length=1, max_length=80)


class EmployeeUpdate(CrudBody):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    store_id: str | None = Field(default=None, min_length=1, max_length=64)
    role: str | None = Field(default=None, min_length=1, max_length=80)


class OpportunityReview(BaseModel):
    status: Literal["OPEN", "CONVERTED", "MISSED", "UNKNOWN", "REVIEW_REQUIRED"]
    manager_note: str | None = Field(default=None, max_length=500)


class DeviceRegister(BaseModel):
    store_id: str
    name: str = "Store edge device"
    audio_source: str = "mock"


class TaskPatch(BaseModel):
    status: Literal["backlog", "todo", "in_progress", "review", "done"] | None = None
    title: str | None = None
    priority: str | None = None
    assignee: str | None = None
    due_date: str | None = None
    labels: str | None = None


class TaskCreate(BaseModel):
    title: str
    project_id: str = "proj-storelisten"
    status: str = "todo"
    priority: str = "medium"
    assignee: str = ""
    due_date: str | None = None
    labels: str = ""


class PosWebhookBody(BaseModel):
    store_id: str = Field(min_length=1, max_length=64)
    employee_id: str | None = Field(default=None, max_length=64)
    sku: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=160)
    amount: float = Field(ge=0, le=1_000_000)


class DeviceHealthPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")

    cpu_pct: float = Field(ge=0, le=100)
    memory_pct: float = Field(ge=0, le=100)
    audio_status: Literal["streaming", "idle", "degraded", "error"]
    microphone_status: Literal["ok", "disconnected", "low_level", "error"]
    stream_status: Literal["live", "idle", "reconnecting", "error"]
    processing_latency_ms: int = Field(ge=0, le=300_000)
    speaking: bool = False


class AudioSessionStart(BaseModel):
    store_id: str = Field(min_length=1, max_length=64)


class TranscriptSpeakerAssignment(BaseModel):
    speaker_role: Literal["customer", "employee", "unknown"]


class DailyReportGenerate(BaseModel):
    store_id: str = Field(min_length=1, max_length=64)
    business_date: date | None = None


class RecordingsBulkDelete(BaseModel):
    recording_ids: list[str] = Field(default_factory=list, max_length=500)
    wipe_all: bool = False
    store_id: str | None = Field(default=None, max_length=64)
    confirm: str = Field(min_length=1, max_length=64)


def _require_recording_manager(user: User) -> None:
    if user.role not in {"SUPER_ADMIN", "ORG_ADMIN", "STORE_MANAGER"}:
        raise HTTPException(403, "Recording management access required")


def _scoped_record(db: Session, model, record_id: str, user: User):
    return apply_store_scope(db.query(model), model, user).filter(model.id == record_id).first()


def _audio_actor(request: Request, db: Session = Depends(get_db)) -> tuple[User | None, StoreDevice | None]:
    authorization = request.headers.get("authorization", "")
    token = authorization[7:] if authorization.lower().startswith("bearer ") else request.cookies.get("sl_session", "")
    device_id = request.headers.get("x-device-id")
    if not token:
        raise HTTPException(401, "Authentication required")
    if device_id:
        device = db.get(StoreDevice, device_id)
        if device and not device.revoked and secrets.compare_digest(device.secret_hash, hash_device_secret(token)):
            return None, device
    payload = decode_token(token)
    user = db.get(User, payload["sub"])
    if not user or not user.is_active:
        raise HTTPException(401, "Account is inactive")
    return user, None


def _audio_store(db: Session, store_id: str, actor: tuple[User | None, StoreDevice | None]) -> Store | None:
    user, device = actor
    if device:
        return db.get(Store, store_id) if device.store_id == store_id and not device.revoked else None
    return _scoped_record(db, Store, store_id, user)


def _audio_conversation(db: Session, conversation_id: str, store_id: str | None, actor: tuple[User | None, StoreDevice | None]) -> Conversation | None:
    user, device = actor
    if device:
        query = db.query(Conversation).filter(
            Conversation.id == conversation_id,
            Conversation.store_id == device.store_id,
        )
        if store_id:
            query = query.filter(Conversation.store_id == store_id)
        return query.first()
    conversation = _scoped_record(db, Conversation, conversation_id, user)
    return conversation if conversation and (not store_id or conversation.store_id == store_id) else None


def _utc_datetime(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _require_devcore_admin(user: User) -> None:
    if user.role not in {"SUPER_ADMIN", "ORG_ADMIN"}:
        raise HTTPException(403, "Devcore workspace requires an organization administrator")


def _require_organization_admin(user: User) -> None:
    if user.role not in {"SUPER_ADMIN", "ORG_ADMIN"}:
        raise HTTPException(403, "Organization administrator access required")


def _employee_store_for_write(db: Session, store_id: str, user: User) -> Store:
    store = _scoped_record(db, Store, store_id, user)
    if not store:
        raise HTTPException(404, "Store not found")
    if user.role not in {"SUPER_ADMIN", "ORG_ADMIN", "STORE_MANAGER"}:
        raise HTTPException(403, "Store management access required")
    return store


@health.get("/health")
async def healthcheck() -> dict[str, Any]:
    # Async so Render probes never wait behind Whisper threadpool work.
    return {"status": "ok", "app": "store-listen-api", "demo_mode": settings.demo_mode}


@health.get("/ready")
def ready(db: Session = Depends(get_db)) -> dict[str, Any]:
    try:
        db.ping()
    except PyMongoError as error:
        logger.exception("Readiness database check failed")
        raise HTTPException(status_code=503, detail="Database unavailable") from error
    return {
        "status": "ready",
        "mode": "demo" if settings.demo_mode else settings.app_env.lower(),
        "dependencies": {
            "database": "connected",
            "redis": "optional",
            "ai": settings.ai_provider,
            "speech": settings.speech_provider,
            "speech_resolved": resolve_speech_provider_name(),
            "pos": settings.pos_provider,
        },
    }


@health.get("/metrics")
def metrics() -> dict[str, Any]:
    return {"requests_total": 0, "demo_mode": settings.demo_mode, "provider_ai": settings.ai_provider}


@api.post("/auth/login")
def login(body: LoginBody, response: Response, db: Session = Depends(get_db)) -> dict[str, Any]:
    user = db.query(User).filter(User.email == body.email.lower()).first()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    token = create_access_token(user.id, {"role": user.role, "org": user.organization_id})
    response.set_cookie("sl_session", token, httponly=True, samesite="lax", max_age=60 * 60 * 12)
    db.add(AuditLog(id=f"aud-{uuid4().hex[:10]}", actor_id=user.id, action="login", entity="user", entity_id=user.id))
    db.commit()
    return {
        "token": token,
        "user": {
            "id": user.id,
            "email": user.email,
            "full_name": user.full_name,
            "role": user.role,
            "store_id": user.store_id,
            "organization_id": user.organization_id,
        },
    }


@api.post("/auth/logout")
def logout(response: Response) -> dict[str, str]:
    response.delete_cookie("sl_session")
    return {"status": "signed_out"}


@api.get("/auth/me")
def me(user: User = Depends(current_user)) -> dict[str, Any]:
    return {
        "id": user.id,
        "email": user.email,
        "full_name": user.full_name,
        "role": user.role,
        "store_id": user.store_id,
        "organization_id": user.organization_id,
    }


@api.get("/dashboard/summary")
def summary(db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    return dashboard_summary(db, user)


@api.get("/inventory")
def list_inventory(
    store_id: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    query = apply_store_scope(db.query(StockItem), StockItem, user)
    if store_id:
        if not _scoped_record(db, Store, store_id, user):
            raise HTTPException(404, "Store not found")
        query = query.filter(StockItem.store_id == store_id)
    items = query.order_by(StockItem.name, StockItem.sku).all()
    return {
        "items": [
            {
                "id": item.id,
                "store_id": item.store_id,
                "sku": item.sku,
                "name": item.name,
                "cost": item.cost,
                "price": item.price,
                "quantity": item.quantity,
                "par_level": item.par_level,
            }
            for item in items
        ],
        "summary": {
            "items": len(items),
            "units_on_hand": sum(item.quantity for item in items),
            "inventory_value": round(sum(item.cost * item.quantity for item in items), 2),
            "low_stock": sum(item.quantity <= item.par_level for item in items),
        },
    }


@api.post("/inventory", status_code=201)
def create_inventory_item(
    body: StockItemCreate,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    _employee_store_for_write(db, body.store_id, user)
    sku = body.sku.upper()
    if db.query(StockItem).filter(StockItem.store_id == body.store_id, StockItem.sku == sku).first():
        raise HTTPException(409, "That SKU already exists in this store")
    item = StockItem(id=f"stock-{uuid4().hex[:12]}", **{**body.model_dump(exclude={"store_id"}), "sku": sku}, store_id=body.store_id)
    db.add(item)
    db.add(AuditLog(id=f"aud-{uuid4().hex[:10]}", actor_id=user.id, action="stock.created", entity="stock_item", entity_id=item.id, detail=sku))
    db.commit()
    return {"id": item.id, "store_id": item.store_id, "sku": item.sku, "name": item.name, "cost": item.cost, "price": item.price, "quantity": item.quantity, "par_level": item.par_level}


@api.patch("/inventory/{item_id}")
def update_inventory_item(
    item_id: str,
    body: StockItemPatch,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    item = _scoped_record(db, StockItem, item_id, user)
    if not item:
        raise HTTPException(404, "Stock item not found")
    _employee_store_for_write(db, item.store_id, user)
    changes = {key: value for key, value in body.model_dump(exclude_unset=True).items() if value is not None}
    if not changes:
        raise HTTPException(422, "Provide at least one non-empty field to update")
    if "sku" in changes:
        changes["sku"] = changes["sku"].upper()
        duplicate = db.query(StockItem).filter(StockItem.store_id == item.store_id, StockItem.sku == changes["sku"], StockItem.id != item.id).first()
        if duplicate:
            raise HTTPException(409, "That SKU already exists in this store")
    for key, value in changes.items():
        setattr(item, key, value)
    db.add(AuditLog(id=f"aud-{uuid4().hex[:10]}", actor_id=user.id, action="stock.updated", entity="stock_item", entity_id=item.id, detail=",".join(changes)))
    db.commit()
    return {"id": item.id, "store_id": item.store_id, "sku": item.sku, "name": item.name, "cost": item.cost, "price": item.price, "quantity": item.quantity, "par_level": item.par_level}


@api.delete("/inventory/{item_id}", status_code=204)
def delete_inventory_item(item_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)) -> Response:
    item = _scoped_record(db, StockItem, item_id, user)
    if not item:
        raise HTTPException(404, "Stock item not found")
    _employee_store_for_write(db, item.store_id, user)
    db.add(AuditLog(id=f"aud-{uuid4().hex[:10]}", actor_id=user.id, action="stock.deleted", entity="stock_item", entity_id=item.id, detail=item.sku))
    db.delete(item)
    db.commit()
    return Response(status_code=204)


@api.get("/rules")
def list_store_rules(
    store_id: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    query = apply_store_scope(db.query(StoreRule), StoreRule, user)
    if store_id:
        if not _scoped_record(db, Store, store_id, user):
            raise HTTPException(404, "Store not found")
        query = query.filter(StoreRule.store_id == store_id)
    rules = query.order_by(StoreRule.created_at.desc(), StoreRule.name).all()
    return {
        "rules": [
            {
                "id": rule.id,
                "store_id": rule.store_id,
                "name": rule.name,
                "dollar_value": rule.dollar_value,
                "trigger_condition": rule.trigger_condition,
                "expected_action": rule.expected_action,
                "active": rule.active,
            }
            for rule in rules
        ],
        "active_count": sum(rule.active for rule in rules),
    }


@api.post("/rules", status_code=201)
def create_store_rule(body: StoreRuleCreate, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    _employee_store_for_write(db, body.store_id, user)
    rule = StoreRule(id=f"rule-{uuid4().hex[:12]}", **body.model_dump())
    db.add(rule)
    db.add(AuditLog(id=f"aud-{uuid4().hex[:10]}", actor_id=user.id, action="rule.created", entity="store_rule", entity_id=rule.id, detail=rule.name))
    db.commit()
    return {"id": rule.id, "store_id": rule.store_id, "name": rule.name, "dollar_value": rule.dollar_value, "trigger_condition": rule.trigger_condition, "expected_action": rule.expected_action, "active": rule.active}


@api.patch("/rules/{rule_id}")
def update_store_rule(rule_id: str, body: StoreRulePatch, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    rule = _scoped_record(db, StoreRule, rule_id, user)
    if not rule:
        raise HTTPException(404, "Rule not found")
    _employee_store_for_write(db, rule.store_id, user)
    changes = {key: value for key, value in body.model_dump(exclude_unset=True).items() if value is not None}
    if not changes:
        raise HTTPException(422, "Provide at least one non-empty field to update")
    for key, value in changes.items():
        setattr(rule, key, value)
    db.add(AuditLog(id=f"aud-{uuid4().hex[:10]}", actor_id=user.id, action="rule.updated", entity="store_rule", entity_id=rule.id, detail=",".join(changes)))
    db.commit()
    return {"id": rule.id, "store_id": rule.store_id, "name": rule.name, "dollar_value": rule.dollar_value, "trigger_condition": rule.trigger_condition, "expected_action": rule.expected_action, "active": rule.active}


@api.delete("/rules/{rule_id}", status_code=204)
def delete_store_rule(rule_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)) -> Response:
    rule = _scoped_record(db, StoreRule, rule_id, user)
    if not rule:
        raise HTTPException(404, "Rule not found")
    _employee_store_for_write(db, rule.store_id, user)
    db.add(AuditLog(id=f"aud-{uuid4().hex[:10]}", actor_id=user.id, action="rule.deleted", entity="store_rule", entity_id=rule.id, detail=rule.name))
    db.delete(rule)
    db.commit()
    return Response(status_code=204)


@api.get("/stores")
def list_stores(
    q: str | None = Query(default=None, max_length=100),
    online: bool | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    query = apply_store_scope(db.query(Store), Store, user)
    if q:
        needle = f"%{q}%"
        query = query.filter((Store.name.ilike(needle)) | (Store.city.ilike(needle)) | (Store.region.ilike(needle)))
    if online is not None:
        query = query.filter(Store.online.is_(online))
    stores_page = paginate_query(query.order_by(Store.name, Store.id), page, page_size)
    stores_page["items"] = serialize_stores(stores_page["items"], db)
    return {"stores": stores_page}


@api.get("/stores/{store_id}")
def store_detail(store_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    store = _scoped_record(db, Store, store_id, user)
    if not store:
        raise HTTPException(404, "Store not found")
    payload = serialize_store(store, db)
    payload["conversations"] = [
        serialize_conversation(item, db)
        for item in apply_store_scope(db.query(Conversation), Conversation, user).filter(Conversation.store_id == store_id).all()
    ]
    return payload


@api.post("/stores", status_code=201)
def create_store(body: StoreCreate, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    _require_organization_admin(user)
    if not user.organization_id:
        raise HTTPException(400, "User is not assigned to an organization")
    duplicate = db.query(Store).filter(Store.organization_id == user.organization_id, Store.code == body.code).first()
    if duplicate:
        raise HTTPException(409, "A store with this code already exists in the organization")
    store = Store(
        id=f"store-{uuid4().hex[:12]}",
        organization_id=user.organization_id,
        name=body.name,
        code=body.code,
        city=body.city,
        region=body.region,
        timezone=body.timezone,
    )
    db.add(store)
    db.add(AuditLog(id=f"aud-{uuid4().hex[:10]}", actor_id=user.id, action="store.created", entity="store", entity_id=store.id, detail=store.code))
    db.commit()
    db.refresh(store)
    return serialize_store(store, db)


@api.patch("/stores/{store_id}")
def update_store(store_id: str, body: StoreUpdate, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    _require_organization_admin(user)
    store = _scoped_record(db, Store, store_id, user)
    if not store:
        raise HTTPException(404, "Store not found")
    changes = body.model_dump(exclude_unset=True)
    if not changes or any(value is None for value in changes.values()):
        raise HTTPException(422, "Provide at least one non-empty field to update")
    if "code" in changes:
        duplicate = db.query(Store).filter(
            Store.organization_id == store.organization_id,
            Store.code == changes["code"],
            Store.id != store.id,
        ).first()
        if duplicate:
            raise HTTPException(409, "A store with this code already exists in the organization")
    for field, value in changes.items():
        setattr(store, field, value)
    db.add(AuditLog(id=f"aud-{uuid4().hex[:10]}", actor_id=user.id, action="store.updated", entity="store", entity_id=store.id, detail=",".join(changes)))
    db.commit()
    db.refresh(store)
    return serialize_store(store, db)


@api.delete("/stores/{store_id}")
def delete_store(store_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    _require_organization_admin(user)
    store = _scoped_record(db, Store, store_id, user)
    if not store:
        raise HTTPException(404, "Store not found")
    if db.has_references(Store, store.id):
        raise HTTPException(409, "Store has linked operational records and cannot be deleted")
    db.add(AuditLog(id=f"aud-{uuid4().hex[:10]}", actor_id=user.id, action="store.deleted", entity="store", entity_id=store.id, detail=store.code))
    db.delete(store)
    db.commit()
    return {"id": store_id, "deleted": True}


@api.get("/recordings")
def recordings_library(
    store_id: str | None = Query(default=None, max_length=64),
    conversation_status: Literal["LIVE", "ENDED"] | None = None,
    from_date: date | None = Query(default=None),
    to_date: date | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    query = apply_store_scope(db.query(AudioRecording), AudioRecording, user)
    if store_id:
        if not _scoped_record(db, Store, store_id, user):
            raise HTTPException(404, "Store not found")
        query = query.filter(AudioRecording.store_id == store_id)
    aggregate_query = apply_store_scope(db.query(AudioRecording), AudioRecording, user).filter(
        AudioRecording.is_aggregate.is_(True)
    )
    if store_id:
        aggregate_query = aggregate_query.filter(AudioRecording.store_id == store_id)
    aggregate_conversation_ids = {
        recording.conversation_id
        for recording in aggregate_query.all()
        if recording.conversation_id
    }
    if aggregate_conversation_ids:
        query = query.filter(or_(
            AudioRecording.is_aggregate.is_(True),
            AudioRecording.conversation_id.not_in(aggregate_conversation_ids),
            AudioRecording.conversation_id.is_(None),
        ))
    if from_date:
        query = query.filter(AudioRecording.captured_at >= datetime.combine(from_date, datetime.min.time(), tzinfo=UTC))
    if to_date:
        query = query.filter(AudioRecording.captured_at < datetime.combine(to_date + timedelta(days=1), datetime.min.time(), tzinfo=UTC))
    if conversation_status:
        scoped_conversations = apply_store_scope(db.query(Conversation), Conversation, user)
        conversation_ids = [
            conversation.id
            for conversation in scoped_conversations.filter(Conversation.status == conversation_status).all()
        ]
        query = query.filter(AudioRecording.conversation_id.in_(conversation_ids))

    total = query.count()
    rows = query.order_by(AudioRecording.captured_at.desc(), AudioRecording.sequence.desc()).offset(
        (page - 1) * page_size
    ).limit(page_size).all()
    conversation_ids = list({row.conversation_id for row in rows if row.conversation_id})
    conversations_by_id = {
        conversation.id: conversation
        for conversation in db.query(Conversation).filter(Conversation.id.in_(conversation_ids)).all()
    } if conversation_ids else {}
    store_ids = list({row.store_id for row in rows})
    stores_by_id = {
        store.id: store
        for store in db.query(Store).filter(Store.id.in_(store_ids)).all()
    } if store_ids else {}
    transcript_by_conversation: dict[str, str] = {}
    analysis_by_conversation: dict[str, str] = {}
    if conversation_ids:
        for segment in db.query(TranscriptSegment).filter(
            TranscriptSegment.conversation_id.in_(conversation_ids)
        ).order_by(TranscriptSegment.start_time.asc()).all():
            english_text = english_display_text(segment.original_text, segment.translated_text, segment.language)
            transcript_by_conversation.setdefault(
                segment.conversation_id,
                english_text,
            )
        for run in db.query(AiProcessingRun).filter(AiProcessingRun.conversation_id.in_(conversation_ids)).all():
            if run.status == "completed":
                analysis_by_conversation[run.conversation_id] = "analyzed"
            elif run.conversation_id not in analysis_by_conversation:
                analysis_by_conversation[run.conversation_id] = "unavailable"
        for opportunity in db.query(ProductOpportunity).filter(
            ProductOpportunity.conversation_id.in_(conversation_ids)
        ).all():
            analysis_by_conversation[opportunity.conversation_id] = "analyzed"
        for recommendation in db.query(SalesRecommendation).filter(
            SalesRecommendation.conversation_id.in_(conversation_ids)
        ).all():
            analysis_by_conversation[recommendation.conversation_id] = "analyzed"

    return {
        "recordings": [
            {
                "id": row.id,
                "captured_at": _utc_datetime(row.captured_at).isoformat(),
                "duration_seconds": row.duration_seconds,
                "byte_size": row.byte_size,
                "sequence": row.sequence,
                "speaker_role": row.speaker_role,
                "store_id": row.store_id,
                "store_name": stores_by_id[row.store_id].name if row.store_id in stores_by_id else row.store_id,
                "conversation_id": row.conversation_id,
                "conversation_status": conversations_by_id[row.conversation_id].status
                if row.conversation_id in conversations_by_id else "UNKNOWN",
                "transcript_snippet": transcript_by_conversation.get(row.conversation_id or "", ""),
                "analysis_status": analysis_by_conversation.get(row.conversation_id or "", "pending"),
                "audio_available": _utc_datetime(row.retain_until) > datetime.now(UTC),
                "playback_path": f"/api/v1/audio/recordings/{row.id}",
                "conversation_path": f"/conversations/{row.conversation_id}" if row.conversation_id else None,
            }
            for row in rows
        ],
        "page": page,
        "page_size": page_size,
        "total": total,
        "pages": (total + page_size - 1) // page_size,
    }


@api.delete("/recordings/{recording_id}")
def delete_recording(
    recording_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    _require_recording_manager(user)
    recording = _scoped_record(db, AudioRecording, recording_id, user)
    if not recording:
        raise HTTPException(404, "Recording not found")
    deleted = delete_recording_entry(db, recording)
    db.add(AuditLog(
        id=f"aud-{uuid4().hex[:10]}",
        actor_id=user.id,
        action="recording.deleted",
        entity="audio_recording",
        entity_id=recording_id,
        detail=f"conversations={deleted.get('conversations', 0)};recordings={deleted.get('recordings', 0)}",
    ))
    db.commit()
    return {"id": recording_id, "deleted": True, "counts": deleted}


@api.post("/recordings/bulk-delete")
def bulk_delete_recordings(
    body: RecordingsBulkDelete,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    _require_recording_manager(user)
    if body.wipe_all:
        if body.confirm != "DELETE ALL RECORDINGS":
            raise HTTPException(400, 'Confirm wipe with confirm="DELETE ALL RECORDINGS"')
        if user.role == "STORE_MANAGER":
            store_id = user.store_id
            if not store_id:
                raise HTTPException(403, "Store manager wipe requires an assigned store")
            if body.store_id and body.store_id != store_id:
                raise HTTPException(403, "Store managers can only wipe their own store")
        else:
            store_id = body.store_id
            if store_id and not _scoped_record(db, Store, store_id, user):
                raise HTTPException(404, "Store not found")
        result = wipe_all_conversation_audio(db, store_id=store_id)
        db.add(AuditLog(
            id=f"aud-{uuid4().hex[:10]}",
            actor_id=user.id,
            action="recording.wipe_all",
            entity="audio_recording",
            entity_id=store_id or "all",
            detail=f"conversations={result['deleted'].get('conversations', 0)};recordings={result['deleted'].get('recordings', 0)}",
        ))
        db.commit()
        return {"wipe_all": True, **result}

    if body.confirm != "DELETE":
        raise HTTPException(400, 'Confirm bulk delete with confirm="DELETE"')
    if not body.recording_ids:
        raise HTTPException(400, "Select at least one recording to delete")

    scoped_ids = [
        recording.id
        for recording in apply_store_scope(db.query(AudioRecording), AudioRecording, user)
        .filter(AudioRecording.id.in_(list(dict.fromkeys(body.recording_ids))))
        .all()
    ]
    result = delete_recordings_by_ids(db, scoped_ids)
    db.add(AuditLog(
        id=f"aud-{uuid4().hex[:10]}",
        actor_id=user.id,
        action="recording.bulk_deleted",
        entity="audio_recording",
        entity_id=",".join(scoped_ids[:8]) or "none",
        detail=f"matched={result['matched']};conversations={result['deleted'].get('conversations', 0)}",
    ))
    db.commit()
    return {"wipe_all": False, **result}


@api.get("/conversations")
def conversations(
    store_id: str | None = None,
    status: str | None = None,
    language: str | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    query = apply_store_scope(db.query(Conversation), Conversation, user)
    if store_id:
        query = query.filter(Conversation.store_id == store_id)
    if status:
        query = query.filter(Conversation.status == status)
    if language:
        query = query.filter(Conversation.primary_language == language)
    conversation_page = paginate_query(query.order_by(Conversation.started_at.desc()), page, page_size)
    conversation_page["items"] = serialize_conversations(conversation_page["items"], db)
    return {"conversations": conversation_page}


@api.get("/conversations/{conversation_id}")
def conversation_detail(conversation_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    item = _scoped_record(db, Conversation, conversation_id, user)
    if not item:
        raise HTTPException(404, "Conversation not found")
    payload = serialize_conversation(item, db)
    payload["opportunities"] = [
        serialize_opportunity(row)
        for row in apply_store_scope(db.query(ProductOpportunity), ProductOpportunity, user)
        .filter(ProductOpportunity.conversation_id == conversation_id)
        .all()
    ]
    analysis_runs = db.query(AiProcessingRun).filter(AiProcessingRun.conversation_id == conversation_id).all()
    report_run = db.get(AiProcessingRun, _conversation_report_run_id(conversation_id))
    conversation_report = None
    if report_run and report_run.status == "completed":
        try:
            saved_report = json.loads(report_run.output_json)
            if saved_report.get("kind") == "conversation_report":
                conversation_report = saved_report.get("report")
        except (TypeError, json.JSONDecodeError):
            conversation_report = None
    saved_opportunities = payload["opportunities"]
    saved_recommendations = db.query(SalesRecommendation).filter(
        SalesRecommendation.conversation_id == conversation_id
    ).all()
    payload["analysis_status"] = (
        "analyzed" if conversation_report or any(run.status == "completed" for run in analysis_runs) or saved_opportunities or saved_recommendations
        else "unavailable" if analysis_runs
        else "pending"
    )
    payload["analysis_run_count"] = len(analysis_runs)
    payload["conversation_report"] = conversation_report
    payload["recommendations"] = [
        {
            "id": item.id,
            "title": item.title,
            "message": item.message,
            "confidence": item.confidence,
        }
        for item in saved_recommendations
    ]
    return payload


@api.post("/conversations/{conversation_id}/analysis")
def generate_conversation_analysis(
    conversation_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    conversation = _scoped_record(db, Conversation, conversation_id, user)
    if not conversation:
        raise HTTPException(404, "Conversation not found")
    segments = db.query(TranscriptSegment).filter(
        TranscriptSegment.conversation_id == conversation_id
    ).order_by(TranscriptSegment.start_time.asc()).all()
    if not segments:
        raise HTTPException(409, "This conversation does not have transcript segments to analyze yet.")

    participants = db.query(ConversationParticipant).filter(
        ConversationParticipant.conversation_id == conversation_id
    ).all()
    customer_speakers = {"speaker-customer"}
    for participant in participants:
        if participant.mapped_role == "customer":
            customer_speakers.add("speaker-customer")

    prior_runs = db.query(AiProcessingRun).filter(AiProcessingRun.conversation_id == conversation_id).all()
    prior_opportunities = db.query(ProductOpportunity).filter(
        ProductOpportunity.conversation_id == conversation_id
    ).all()
    prior_recommendations = db.query(SalesRecommendation).filter(
        SalesRecommendation.conversation_id == conversation_id
    ).all()
    has_saved_analysis = bool(prior_opportunities or prior_recommendations)
    if not any(segment.speaker_id in customer_speakers for segment in segments) and not prior_runs and not has_saved_analysis:
        raise HTTPException(409, "No operator-attributed customer speech is available to analyze.")
    completed_excerpts = {run.input_excerpt for run in prior_runs if run.status == "completed"}
    attempted_excerpts: set[str] = set()
    processed_segments = 0
    segments_to_process = [] if has_saved_analysis and not prior_runs else segments
    for segment in segments_to_process:
        excerpt = segment.original_text[:280]
        if segment.speaker_id not in customer_speakers or excerpt in completed_excerpts or excerpt in attempted_excerpts:
            continue
        attempted_excerpts.add(excerpt)
        result = analyze_and_persist(
            db,
            conversation_id=conversation.id,
            store_id=conversation.store_id,
            employee_id=conversation.employee_id,
            original_text=segment.original_text,
            translated_text=segment.translated_text or segment.original_text,
            language=segment.language,
            speaker_role="customer",
        )
        processed_segments += 1
        if result and result.opportunity:
            conversation.customer_intent = result.intent
            conversation.detected_product = result.product
            conversation.opportunity_status = "OPEN"

    db.commit()
    runs = db.query(AiProcessingRun).filter(AiProcessingRun.conversation_id == conversation_id).all()
    analysis_status = (
        "analyzed" if any(run.status == "completed" for run in runs) or prior_opportunities or prior_recommendations
        else "unavailable" if runs
        else "pending"
    )
    opportunities = apply_store_scope(db.query(ProductOpportunity), ProductOpportunity, user).filter(
        ProductOpportunity.conversation_id == conversation_id
    ).all()
    recommendations = db.query(SalesRecommendation).filter(
        SalesRecommendation.conversation_id == conversation_id
    ).all()
    return {
        "conversation_id": conversation_id,
        "analysis_status": analysis_status,
        "processed_segments": processed_segments,
        "total_segments": len(segments),
        "opportunities": [serialize_opportunity(item) for item in opportunities],
        "recommendations": [
            {
                "id": item.id,
                "title": item.title,
                "message": item.message,
                "confidence": item.confidence,
            }
            for item in recommendations
        ],
        "caveat": "AI-generated signals are estimates for human review, not proof of customer intent or employee performance.",
    }


def _conversation_report_run_id(conversation_id: str) -> str:
    return f"report-{uuid5(NAMESPACE_URL, f'storelisten-conversation-report:{conversation_id}').hex}"


@api.post("/conversations/{conversation_id}/report")
def generate_conversation_report_for_conversation(
    conversation_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    conversation = _scoped_record(db, Conversation, conversation_id, user)
    if not conversation:
        raise HTTPException(404, "Conversation not found")
    if not (settings.gemini_api_key or "").strip() and not (settings.groq_api_key or "").strip():
        raise HTTPException(503, "Add GEMINI_API_KEY or GROQ_API_KEY to generate conversation reports.")

    segments = db.query(TranscriptSegment).filter(
        TranscriptSegment.conversation_id == conversation_id
    ).order_by(TranscriptSegment.start_time.asc()).all()
    transcript_generated = False
    if not segments:
        recordings = db.query(AudioRecording).filter(
            AudioRecording.conversation_id == conversation_id,
            AudioRecording.retain_until > datetime.now(UTC),
        ).order_by(AudioRecording.sequence.asc(), AudioRecording.captured_at.asc()).all()
        if not recordings:
            raise HTTPException(409, "This conversation has no retained audio or transcript to analyze.")
        speech_provider = get_speech_provider(settings.speech_provider)
        offset = 0.0
        for recording in recordings:
            try:
                speech_result = speech_provider.transcribe_file(resolve_audio_clip(recording.storage_key))
            except (FileNotFoundError, NoSpeechDetected, UnsupportedLanguageDetected):
                offset += max(recording.duration_seconds, 0.0)
                continue
            except Exception as exc:
                logger.exception("Report transcription failed conversation_id=%s recording_id=%s", conversation_id, recording.id)
                raise HTTPException(503, "Transcription failed while preparing the report. Check the speech provider and retained audio, then retry.") from exc
            speaker_id = (
                "speaker-customer" if recording.speaker_role == "customer"
                else "speaker-employee-recorded" if recording.speaker_role == "employee"
                else "speaker-unknown"
            )
            db.add(TranscriptSegment(
                id=f"seg-report-{uuid4().hex[:16]}",
                conversation_id=conversation_id,
                speaker_id=speaker_id,
                language=speech_result.language,
                original_text=speech_result.original_text,
                translated_text=speech_result.translated_text,
                start_time=offset,
                end_time=offset + max(recording.duration_seconds, 0.0),
                confidence=speech_result.confidence,
                is_final=True,
            ))
            offset += max(recording.duration_seconds, 0.0)
            transcript_generated = True
        if transcript_generated:
            db.commit()
            segments = db.query(TranscriptSegment).filter(
                TranscriptSegment.conversation_id == conversation_id
            ).order_by(TranscriptSegment.start_time.asc()).all()
        if not segments:
            raise HTTPException(409, "No speech could be transcribed from the retained recordings.")

    transcript = []
    for segment in segments:
        role = "customer" if segment.speaker_id == "speaker-customer" else "employee" if segment.speaker_id.startswith("speaker-employee-") else "unknown"
        spoken = (segment.original_text or "").strip()
        english = (segment.translated_text or "").strip()
        transcript.append({
            "role": role,
            "language": segment.language,
            "time_seconds": round(segment.start_time, 2),
            "text": english or spoken,
            "original_text": spoken,
        })
    try:
        report = generate_conversation_report(transcript)
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(503, str(exc)) from exc
    except Exception as exc:
        logger.exception("Conversation report generation failed conversation_id=%s", conversation_id)
        raise HTTPException(502, "The report provider could not generate this report. Check provider access and retry.") from exc

    report_payload = {
        "summary": report.summary,
        "customer_needs": report.customer_needs,
        "customer_sentiment": report.customer_sentiment,
        "products_discussed": report.products_discussed,
        "opportunity_type": report.opportunity_type,
        "opportunity_summary": report.opportunity_summary,
        "recommendation": report.recommendation,
        "evidence": report.evidence,
        "confidence": report.confidence,
    }
    report_id = _conversation_report_run_id(conversation_id)
    saved_run = db.get(AiProcessingRun, report_id)
    if saved_run:
        saved_run.provider = report.provider
        saved_run.status = "completed"
        saved_run.input_excerpt = "[conversation-report] " + " ".join(item["text"] for item in transcript)[:280]
        saved_run.output_json = json.dumps({"kind": "conversation_report", "report": report_payload})
    else:
        db.add(AiProcessingRun(
            id=report_id,
            conversation_id=conversation_id,
            provider=report.provider,
            status="completed",
            input_excerpt="[conversation-report] " + " ".join(item["text"] for item in transcript)[:280],
            output_json=json.dumps({"kind": "conversation_report", "report": report_payload}),
        ))
    db.add(AuditLog(
        id=f"audit-{uuid4().hex[:12]}",
        actor_id=user.id,
        action="conversation.report.generate",
        entity="conversation_report",
        entity_id=conversation_id,
        detail=f"provider={report.provider};segments={len(segments)}",
    ))
    db.commit()
    return {
        "conversation_id": conversation_id,
        "analysis_status": "analyzed",
        "report": report_payload,
        "transcript_generated": transcript_generated,
        "transcript_segments": len(segments),
        "provider": report.provider,
        "caveat": "AI-generated findings are estimates for human review. Unknown speaker attribution is not inferred.",
    }


@api.get("/conversations/{conversation_id}/transcript")
def transcript(
    conversation_id: str,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    if not _scoped_record(db, Conversation, conversation_id, user):
        raise HTTPException(404, "Transcript not found")
    segment_query = db.query(TranscriptSegment).filter(TranscriptSegment.conversation_id == conversation_id)
    total = segment_query.count()
    segments = segment_query.order_by(
        TranscriptSegment.start_time.asc(),
        TranscriptSegment.created_at.asc(),
        TranscriptSegment.id.asc(),
    ).offset((page - 1) * page_size).limit(page_size).all()
    participants = (
        db.query(ConversationParticipant)
        .filter(ConversationParticipant.conversation_id == conversation_id)
        .all()
    )
    speaker_details: dict[str, dict[str, str | None]] = {}
    for participant in participants:
        canonical_speaker_id = (
            "speaker-customer"
            if participant.mapped_role == "customer"
            else f"speaker-{participant.employee_id}"
            if participant.employee_id
            else participant.speaker_label
        )
        speaker_details[canonical_speaker_id] = {
            "speaker_label": participant.speaker_label,
            "speaker_role": participant.mapped_role,
            "employee_id": participant.employee_id,
        }
    return {
        "conversation_id": conversation_id,
        "total": total,
        "page": page,
        "page_size": page_size,
        "segments": [
            {
                "id": row.id,
                "speaker_id": row.speaker_id,
                **speaker_details.get(row.speaker_id, {
                    "speaker_label": "Speaker (unassigned)",
                    "speaker_role": "unknown",
                    "employee_id": None,
                }),
                "language": row.language,
                "original_text": row.original_text,
                "translated_text": row.translated_text,
                "english_text": english_display_text(row.original_text, row.translated_text, row.language),
                "start_time": row.start_time,
                "end_time": row.end_time,
                "confidence": row.confidence,
                "is_final": row.is_final,
            }
            for row in segments
        ],
    }


@api.patch("/conversations/{conversation_id}/transcript/{segment_id}/speaker")
def assign_transcript_speaker(
    conversation_id: str,
    segment_id: str,
    body: TranscriptSpeakerAssignment,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    conversation = _scoped_record(db, Conversation, conversation_id, user)
    if not conversation:
        raise HTTPException(404, "Transcript not found")
    segment = db.query(TranscriptSegment).filter(
        TranscriptSegment.id == segment_id,
        TranscriptSegment.conversation_id == conversation_id,
    ).first()
    if not segment:
        raise HTTPException(404, "Transcript segment not found")
    completed_analysis = db.query(AiProcessingRun).filter(
        AiProcessingRun.conversation_id == conversation_id,
        AiProcessingRun.status == "completed",
    ).first()
    saved_opportunity = db.query(ProductOpportunity).filter(
        ProductOpportunity.conversation_id == conversation_id,
    ).first()
    saved_recommendation = db.query(SalesRecommendation).filter(
        SalesRecommendation.conversation_id == conversation_id,
    ).first()
    if completed_analysis or saved_opportunity or saved_recommendation:
        raise HTTPException(409, "Speaker attribution cannot be changed after analysis is complete.")

    if body.speaker_role == "unknown":
        segment.speaker_id = "speaker-unknown"
        db.commit()
        return {
            "segment_id": segment_id,
            "speaker_id": segment.speaker_id,
            "speaker_label": "Speaker (unassigned)",
            "speaker_role": "unknown",
            "employee_id": None,
        }

    participant = db.query(ConversationParticipant).filter(
        ConversationParticipant.conversation_id == conversation_id,
        ConversationParticipant.mapped_role == body.speaker_role,
        ConversationParticipant.employee_id.is_(None),
    ).first()
    if not participant:
        speaker_label = "Customer (operator selected)" if body.speaker_role == "customer" else "Representative (operator selected)"
        participant = ConversationParticipant(
            id=f"participant-{uuid4().hex}",
            conversation_id=conversation_id,
            speaker_label=speaker_label,
            mapped_role=body.speaker_role,
        )
        db.add(participant)
    segment.speaker_id = "speaker-customer" if body.speaker_role == "customer" else participant.speaker_label
    db.commit()
    return {
        "segment_id": segment_id,
        "speaker_id": segment.speaker_id,
        "speaker_label": participant.speaker_label,
        "speaker_role": participant.mapped_role,
        "employee_id": participant.employee_id,
    }


@api.post("/audio/sessions")
async def start_audio_session(body: AudioSessionStart, db: Session = Depends(get_db), actor: tuple[User | None, StoreDevice | None] = Depends(_audio_actor)) -> dict[str, Any]:
    if not _audio_store(db, body.store_id, actor):
        raise HTTPException(404, "Store not found")
    _user, device = actor
    if device is not None and not device_is_approved(device):
        raise HTTPException(
            403,
            f"Recording is blocked because this device is {device_approval_status(device)} or revoked.",
        )
    conversation = Conversation(
        id=f"conv-{uuid4().hex[:12]}",
        store_id=body.store_id,
        data_source="live",
        status="LIVE",
        primary_language="und",
        opportunity_status="UNKNOWN",
        started_at=datetime.now(UTC),
    )
    db.add(conversation)
    db.commit()
    await hub.publish(f"store:{body.store_id}", {
        "event": "conversation.started",
        "conversationId": conversation.id,
        "storeId": body.store_id,
        "status": conversation.status,
        "timestamp": conversation.started_at.isoformat() if conversation.started_at else datetime.now(UTC).isoformat(),
    })
    return {"conversation_id": conversation.id, "store_id": body.store_id, "status": conversation.status}


@api.post("/audio/sessions/{conversation_id}/finish")
async def finish_audio_session(conversation_id: str, db: Session = Depends(get_db), actor: tuple[User | None, StoreDevice | None] = Depends(_audio_actor)) -> dict[str, Any]:
    conversation = _audio_conversation(db, conversation_id, None, actor)
    if not conversation:
        raise HTTPException(404, "Audio session not found")
    recordings = db.query(AudioRecording).filter(
        AudioRecording.conversation_id == conversation_id
    ).order_by(AudioRecording.sequence.asc(), AudioRecording.captured_at.asc()).all()
    master = next((recording for recording in recordings if getattr(recording, "is_aggregate", False)), None)
    source_recordings = [recording for recording in recordings if not getattr(recording, "is_aggregate", False)]
    if not master and source_recordings:
        try:
            merged_audio = await run_in_threadpool(merge_audio_clips, source_recordings)
            captured_at = min(_utc_datetime(recording.captured_at) for recording in source_recordings)
            retain_until = max(_utc_datetime(recording.retain_until) for recording in source_recordings)
            storage_key = save_audio_clip(merged_audio, "audio/webm", captured_at)
            master = AudioRecording(
                id=f"audio-{uuid4().hex[:16]}",
                store_id=conversation.store_id,
                conversation_id=conversation.id,
                storage_key=storage_key,
                content_type="audio/webm",
                byte_size=len(merged_audio),
                duration_seconds=sum(max(recording.duration_seconds, 0) for recording in source_recordings),
                sequence=0,
                speaker_role="unknown",
                is_aggregate=True,
                captured_at=captured_at,
                retain_until=retain_until,
            )
            db.add(master)
            db.commit()
        except Exception as exc:
            db.rollback()
            logger.exception("Overall conversation audio merge failed conversation_id=%s", conversation_id)
            raise HTTPException(503, "Could not combine the conversation clips. The original clips were preserved; retry Stop Recording.") from exc

    if master and source_recordings:
        for recording in source_recordings:
            delete_audio_clip(recording.storage_key)
            db.delete(recording)
        db.commit()

    if conversation.status == "LIVE":
        conversation.status = "ENDED"
        conversation.ended_at = datetime.now(UTC)
        db.commit()
        await hub.publish(f"store:{conversation.store_id}", {
            "event": "conversation.ended",
            "conversationId": conversation.id,
            "storeId": conversation.store_id,
            "status": conversation.status,
            "timestamp": conversation.ended_at.isoformat() if conversation.ended_at else datetime.now(UTC).isoformat(),
        })
    return {
        "conversation_id": conversation.id,
        "status": conversation.status,
        "ended_at": conversation.ended_at.isoformat() if conversation.ended_at else None,
        "recording_id": master.id if master else None,
        "recordings": 1 if master else 0,
    }


@api.post("/audio/transcribe/preview")
async def preview_audio_transcription(
    store_id: str = Form(..., min_length=1, max_length=64),
    conversation_id: str = Form(..., min_length=1, max_length=64),
    capture_sequence: int = Form(default=0, ge=0, le=10_000_000),
    preview_sequence: int = Form(default=0, ge=0, le=10_000_000),
    language_hint: str | None = Form(default=None, max_length=8),
    audio: UploadFile = File(...),
    db: Session = Depends(get_db),
    actor: tuple[User | None, StoreDevice | None] = Depends(_audio_actor),
) -> dict[str, Any]:
    """Optional provisional transcript. Disabled by default so final Whisper stays on the fast path."""
    if not settings.whisper_preview_enabled:
        # Drain the upload so clients do not hang, but never burn CPU on a second Whisper pass.
        await audio.read(MAX_AUDIO_BYTES + 1)
        return {
            "segment": None,
            "preview_sequence": preview_sequence,
            "transcription_ms": 0,
            "preview_status": "disabled_for_latency",
        }
    store = _audio_store(db, store_id, actor)
    if not store:
        raise HTTPException(404, "Store not found")
    conversation = _audio_conversation(db, conversation_id, store_id, actor)
    if not conversation or conversation.status != "LIVE":
        raise HTTPException(404, "Live audio session not found")
    content_type = (audio.content_type or "").split(";")[0].lower()
    if content_type not in ALLOWED_AUDIO_TYPES:
        raise HTTPException(415, "Unsupported audio format. Record audio as WebM/Opus or upload WAV, OGG, or MP4 audio.")
    audio_bytes = await audio.read(MAX_AUDIO_BYTES + 1)
    if not audio_bytes:
        raise HTTPException(422, "The audio preview is empty.")
    if len(audio_bytes) > MAX_AUDIO_BYTES:
        raise HTTPException(413, "Audio preview exceeds the 20 MB limit.")
    if language_hint:
        language_hint = normalize_supported_language(language_hint)
        if language_hint is None:
            raise HTTPException(422, "Language hint must be a supported language code.")

    suffix = {"audio/webm": ".webm", "audio/ogg": ".ogg", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mp4": ".m4a", "audio/mpeg": ".mp3"}[content_type]
    provider = get_speech_provider(settings.speech_provider)
    started = perf_counter()
    fd, temp_path = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as audio_file:
            audio_file.write(audio_bytes)
        # Fast preview skips the costly English translation pass and never publishes foreign source text.
        result = await _transcribe_audio_file(provider, temp_path, language_hint, wait=False, fast=True)
        if result is None:
            return {
                "segment": None,
                "preview_sequence": preview_sequence,
                "transcription_ms": 0,
                "preview_status": "busy",
            }
            result.language = detect_transcript_language(result.original_text, result.language, language_hint)
    except (NoSpeechDetected, UnsupportedLanguageDetected):
        return {"segment": None, "preview_sequence": preview_sequence, "transcription_ms": round((perf_counter() - started) * 1000)}
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc
    finally:
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            pass

    english_text = english_display_text(result.original_text, result.translated_text, result.language)
    if english_text == ENGLISH_TRANSLATION_PENDING:
        return {
            "segment": None,
            "preview_sequence": preview_sequence,
            "transcription_ms": round((perf_counter() - started) * 1000),
            "preview_status": "english_translation_pending",
        }

    transcription_ms = round((perf_counter() - started) * 1000)
    event = {
        "event": "transcript.partial",
        "conversationId": conversation.id,
        "storeId": store_id,
        "segmentId": f"preview-{conversation.id}-{capture_sequence}",
        "captureSequence": capture_sequence,
        "previewSequence": preview_sequence,
        "speakerLabel": "Live transcript",
        "language": result.language,
        "originalText": result.original_text,
        "translatedText": result.translated_text,
        "englishText": english_text,
        "confidence": result.confidence,
        "isFinal": False,
        "source": f"{provider.name}_preview",
        "transcriptionMs": transcription_ms,
        "timestamp": datetime.now(UTC).isoformat(),
    }
    await hub.publish(f"store:{store_id}", event)
    return {"segment": event, "preview_sequence": preview_sequence, "transcription_ms": transcription_ms}


@api.post("/audio/transcribe")
async def transcribe_audio(
    store_id: str = Form(..., min_length=1, max_length=64),
    speaker_role: Literal["customer", "employee", "unknown"] = Form(default="unknown"),
    employee_id: str | None = Form(default=None, max_length=64),
    conversation_id: str | None = Form(default=None, max_length=64),
    language_hint: str | None = Form(default=None, max_length=8),
    capture_sequence: int = Form(default=0, ge=0, le=10_000_000),
    duration_seconds: float = Form(default=8, gt=0, le=60),
    session_offset_seconds: float = Form(default=0, ge=0, le=86_400),
    audio: UploadFile = File(...),
    db: Session = Depends(get_db),
    actor: tuple[User | None, StoreDevice | None] = Depends(_audio_actor),
) -> dict[str, Any]:
    user, device = actor
    store = _audio_store(db, store_id, actor)
    if not store:
        raise HTTPException(404, "Store not found")
    employee = None
    if device and (speaker_role != "unknown" or employee_id):
        raise HTTPException(403, "Store devices must submit mixed audio with unknown speaker attribution.")
    if speaker_role == "employee":
        if not employee_id:
            raise HTTPException(422, "Select a staff member before recording a staff turn.")
        employee = _scoped_record(db, Employee, employee_id, user)
        if not employee or employee.store_id != store_id:
            raise HTTPException(404, "Staff member not found for this store")
    elif employee_id:
        raise HTTPException(422, "Only an employee turn can include a staff member.")
    content_type = (audio.content_type or "").split(";")[0].lower()
    if content_type not in ALLOWED_AUDIO_TYPES:
        raise HTTPException(415, "Unsupported audio format. Record audio as WebM/Opus or upload WAV, OGG, or MP4 audio.")
    audio_bytes = await audio.read(MAX_AUDIO_BYTES + 1)
    if not audio_bytes:
        raise HTTPException(422, "The audio recording is empty.")
    if len(audio_bytes) > MAX_AUDIO_BYTES:
        raise HTTPException(413, "Audio chunk exceeds the 20 MB limit.")
    if language_hint:
        language_hint = normalize_supported_language(language_hint)
        if language_hint is None:
            raise HTTPException(422, "Language hint must be a supported language code.")

    if conversation_id:
        conversation = _audio_conversation(db, conversation_id, store_id, actor)
        if not conversation or conversation.store_id != store_id:
            raise HTTPException(404, "Conversation not found for this store")
    else:
        conversation = (
            db.query(Conversation)
            .filter(Conversation.store_id == store_id, Conversation.status == "LIVE")
            .order_by(Conversation.started_at.desc())
            .first()
        )
        if not conversation:
            conversation = Conversation(
                id=f"conv-{uuid4().hex[:12]}",
                store_id=store_id,
                data_source="live",
                status="LIVE",
                primary_language=language_hint or "und",
                opportunity_status="UNKNOWN",
                started_at=datetime.now(UTC),
            )
            db.add(conversation)
            db.flush()

    captured_at = datetime.now(UTC)
    storage_key = save_audio_clip(audio_bytes, content_type, captured_at)
    audio_recording = AudioRecording(
        id=f"audio-{uuid4().hex[:16]}",
        store_id=store_id,
        conversation_id=conversation.id,
        storage_key=storage_key,
        content_type=content_type,
        byte_size=len(audio_bytes),
        duration_seconds=duration_seconds,
        sequence=capture_sequence,
        speaker_role=speaker_role,
        captured_at=captured_at,
        retain_until=captured_at + timedelta(days=settings.audio_retention_days),
    )
    try:
        db.add(audio_recording)
        db.commit()
    except Exception:
        db.rollback()
        delete_audio_clip(storage_key)
        raise

    extension = {"audio/webm": ".webm", "audio/ogg": ".ogg", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mp4": ".m4a", "audio/mpeg": ".mp3"}[content_type]
    provider = get_speech_provider(settings.speech_provider)
    transcription_started = perf_counter()
    transcription_ms = 0
    try:
        fd, temp_path = tempfile.mkstemp(suffix=extension)
        try:
            with os.fdopen(fd, "wb") as audio_file:
                audio_file.write(audio_bytes)
                audio_file.flush()
            result = await _transcribe_audio_file(provider, temp_path, language_hint, wait=True)
            transcription_ms = round((perf_counter() - transcription_started) * 1000)
            detected_language = normalize_supported_language(
                detect_transcript_language(result.original_text, result.language, language_hint)
            )
            if detected_language is None:
                raise UnsupportedLanguageDetected(result.language or "und")
            result.language = detected_language
        finally:
            try:
                os.unlink(temp_path)
            except FileNotFoundError:
                pass
    except UnsupportedLanguageDetected as exc:
        transcription_ms = round((perf_counter() - transcription_started) * 1000)
        return {
            "conversation_id": conversation.id,
            "segment": None,
            "speech_provider": provider.name,
            "analysis": None,
            "analysis_status": "unsupported_language",
            "detected_language": exc.language,
            "transcription_ms": transcription_ms,
            "raw_audio_stored": True,
            "audio_recording_id": audio_recording.id,
        }
    except NoSpeechDetected:
        transcription_ms = round((perf_counter() - transcription_started) * 1000)
        return {
            "conversation_id": conversation.id,
            "segment": None,
            "speech_provider": provider.name,
            "analysis": None,
            "analysis_status": "no_speech",
            "transcription_ms": transcription_ms,
            "raw_audio_stored": True,
            "audio_recording_id": audio_recording.id,
        }
    except RuntimeError as exc:
        db.rollback()
        raise HTTPException(503, str(exc)) from exc
    except ValueError as exc:
        db.rollback()
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        db.rollback()
        logger.exception("Speech transcription failed store_id=%s provider=%s", store_id, provider.name)
        raise HTTPException(502, "Speech transcription failed. Check audio format and SPEECH_PROVIDER / API key configuration.") from exc

    if is_recent_duplicate(conversation.id, result.original_text):
        transcription_ms = round((perf_counter() - transcription_started) * 1000)
        return {
            "conversation_id": conversation.id,
            "segment": None,
            "speech_provider": provider.name,
            "analysis": None,
            "analysis_status": "no_speech",
            "transcription_ms": transcription_ms,
            "raw_audio_stored": True,
            "audio_recording_id": audio_recording.id,
        }

    segment_id = f"seg-{uuid4().hex[:12]}"
    safe_speaker_id = "speaker-customer" if speaker_role == "customer" else f"speaker-{employee.id}" if employee else "speaker-unknown"
    speaker_label = f"Staff: {employee.full_name} (operator selected)" if employee else "Customer (operator selected)" if speaker_role == "customer" else "Speaker"
    participant = (
        db.query(ConversationParticipant)
        .filter(
            ConversationParticipant.conversation_id == conversation.id,
            ConversationParticipant.mapped_role == speaker_role,
            ConversationParticipant.employee_id == (employee.id if employee else None),
        )
        .first()
    )
    if participant:
        participant.speaker_label = speaker_label
    else:
        db.add(
            ConversationParticipant(
                id=f"participant-{uuid4().hex[:12]}",
                conversation_id=conversation.id,
                speaker_label=speaker_label,
                mapped_role=speaker_role,
                employee_id=employee.id if employee else None,
            )
        )
    db.add(
        TranscriptSegment(
            id=segment_id,
            conversation_id=conversation.id,
            speaker_id=safe_speaker_id,
            language=result.language,
            original_text=result.original_text,
            translated_text=result.translated_text,
            start_time=session_offset_seconds,
            end_time=session_offset_seconds + duration_seconds,
            confidence=result.confidence,
            is_final=True,
        )
    )
    conversation.primary_language = result.language
    event_payload = {
        "event": "transcript.final",
        "conversationId": conversation.id,
        "segmentId": segment_id,
        "storeId": store_id,
        "captureSequence": capture_sequence,
        "speakerId": safe_speaker_id,
        "speakerLabel": speaker_label,
        "speakerRole": speaker_role,
        "employeeId": employee.id if employee else None,
        "language": result.language,
        "originalText": result.original_text,
        "translatedText": result.translated_text,
        "englishText": english_display_text(result.original_text, result.translated_text, result.language),
        "confidence": result.confidence,
        "isFinal": True,
        "source": provider.name,
        "transcriptionMs": transcription_ms,
        "timestamp": datetime.now(UTC).isoformat(),
    }
    db.commit()
    # Publish transcript immediately so dashboards update before slower AI analysis.
    await hub.publish(f"store:{store_id}", event_payload)

    analysis_payload = None
    analysis_status = "speaker_unattributed" if speaker_role == "unknown" else "unavailable_check_ai_provider_and_key"
    if speaker_role != "unknown":
        # Mock AI is instantaneous — keep it inline for tests/demo.
        # Real cloud AI runs after the HTTP response so transcripts stay snappy.
        if settings.ai_provider == "mock":
            ai_result = await run_in_threadpool(
                analyze_and_persist,
                db,
                conversation_id=conversation.id,
                store_id=store_id,
                employee_id=conversation.employee_id,
                original_text=result.original_text,
                translated_text=result.translated_text,
                language=result.language,
                speaker_role=speaker_role,
            )
            if ai_result is not None:
                db.commit()
                analysis_payload = {
                    "intent": ai_result.intent,
                    "product": ai_result.product,
                    "opportunity": ai_result.opportunity,
                    "recommendation": ai_result.recommendation,
                    "confidence": ai_result.confidence,
                    "provider": settings.ai_provider,
                }
                analysis_status = "available"
        else:
            analysis_status = "pending"
            conversation_id_for_ai = conversation.id
            employee_id_for_ai = conversation.employee_id
            original_text = result.original_text
            translated_text = result.translated_text
            language = result.language

            async def _analyze_after_response() -> None:
                try:
                    def _run() -> Any:
                        with SessionLocal() as ai_db:
                            ai_result = analyze_and_persist(
                                ai_db,
                                conversation_id=conversation_id_for_ai,
                                store_id=store_id,
                                employee_id=employee_id_for_ai,
                                original_text=original_text,
                                translated_text=translated_text,
                                language=language,
                                speaker_role=speaker_role,
                            )
                            if ai_result is not None:
                                ai_db.commit()
                            return ai_result

                    ai_result = await run_in_threadpool(_run)
                    if ai_result is not None:
                        await hub.publish(
                            f"store:{store_id}",
                            {
                                "event": "analysis.ready",
                                "conversationId": conversation_id_for_ai,
                                "segmentId": segment_id,
                                "storeId": store_id,
                                "intent": ai_result.intent,
                                "product": ai_result.product,
                                "opportunity": ai_result.opportunity,
                                "recommendation": ai_result.recommendation,
                                "confidence": ai_result.confidence,
                                "provider": settings.ai_provider,
                                "timestamp": datetime.now(UTC).isoformat(),
                            },
                        )
                except Exception:
                    logger.exception("Background AI analysis failed conversation_id=%s", conversation_id_for_ai)

            asyncio.create_task(_analyze_after_response())

    return {
        "conversation_id": conversation.id,
        "segment": event_payload,
        "speech_provider": provider.name,
        "transcription_ms": transcription_ms,
        "analysis": analysis_payload,
        "analysis_status": analysis_status,
        "raw_audio_stored": True,
        "audio_recording_id": audio_recording.id,
    }


@api.post("/audio/coaching/{conversation_id}")
async def live_coaching_suggestions(
    conversation_id: str,
    db: Session = Depends(get_db),
    actor: tuple[User | None, StoreDevice | None] = Depends(_audio_actor),
) -> dict[str, Any]:
    conversation = _audio_conversation(db, conversation_id, None, actor)
    if not conversation:
        raise HTTPException(404, "Live conversation not found")
    _user, device = actor
    if device is not None and not device_is_approved(device):
        raise HTTPException(403, "This device is not approved for live coaching.")

    segments = db.query(TranscriptSegment).filter(
        TranscriptSegment.conversation_id == conversation_id
    ).order_by(
        TranscriptSegment.start_time.desc(),
        TranscriptSegment.created_at.desc(),
        TranscriptSegment.id.desc(),
    ).limit(5).all()
    context_lines = [
        english_display_text(segment.original_text, segment.translated_text, segment.language)
        for segment in reversed(segments)
    ]
    context_lines = [line for line in context_lines if line and line != ENGLISH_TRANSLATION_PENDING]
    if not context_lines:
        raise HTTPException(409, "No English conversation text is ready for coaching yet.")

    context = "\n".join(f"Recent turn {index + 1}: {line}" for index, line in enumerate(context_lines))
    provider_name = "mock" if settings.demo_mode else settings.ai_provider
    provider = get_ai_provider(provider_name)
    try:
        analysis = await run_in_threadpool(
            provider.analyze,
            original_text=context,
            translated_text=context,
            language="en",
            speaker_role="unknown",
        )
    except Exception as exc:
        logger.info("Live coaching unavailable provider=%s conversation_id=%s", provider_name, conversation_id)
        raise HTTPException(503, "Live coaching is temporarily unavailable. Keep listening; the transcript is still saved.") from exc

    recent_text = " ".join(context_lines[-2:]).casefold()
    alerts: list[dict[str, str]] = []
    if any(term in recent_text for term in ("available", "in stock", "do you have", "do you carry", "stock")):
        alerts.append({
            "title": "Check availability",
            "message": "Verify live inventory before promising the item is in stock.",
        })
    if any(term in recent_text for term in ("how much", "price", "cost", "discount")):
        alerts.append({
            "title": "Confirm current price",
            "message": "Check the current SKU price and any active offer before quoting.",
        })
    if analysis.confidence < 0.6:
        alerts.append({
            "title": "Clarify before recommending",
            "message": "The conversation is not clear enough yet; ask one short follow-up question.",
        })
    alerts.extend(
        {"title": "Customer concern", "message": objection[:240]}
        for objection in analysis.objections[:2]
        if objection.strip()
    )
    return {
        "conversation_id": conversation_id,
        "context_turns": len(context_lines),
        "suggestion": {
            "title": "Suggested response",
            "message": (analysis.recommendation or "Acknowledge the customer and ask one clarifying question.")[:500],
            "confidence": max(0.0, min(1.0, analysis.confidence)),
        },
        "alerts": alerts,
        "updated_at": datetime.now(UTC).isoformat(),
    }


@api.get("/conversations/{conversation_id}/audio")
def conversation_audio(
    conversation_id: str,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    if not _scoped_record(db, Conversation, conversation_id, user):
        raise HTTPException(404, "Conversation not found")
    query = db.query(AudioRecording).filter(AudioRecording.conversation_id == conversation_id)
    aggregate_recordings = query.filter(AudioRecording.is_aggregate.is_(True)).all()
    if aggregate_recordings:
        query = query.filter(AudioRecording.is_aggregate.is_(True))
    total = query.count()
    recordings = query.order_by(AudioRecording.captured_at.desc(), AudioRecording.sequence.desc()).offset((page - 1) * page_size).limit(page_size).all()
    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "recordings": [
            {
                "id": recording.id,
                "captured_at": recording.captured_at.isoformat(),
                "duration_seconds": recording.duration_seconds,
                "byte_size": recording.byte_size,
                "sequence": recording.sequence,
                "speaker_role": recording.speaker_role,
                "playback_path": f"/api/v1/audio/recordings/{recording.id}",
            }
            for recording in recordings
        ]
    }


@api.get("/audio/recordings/{recording_id}")
def play_audio_recording(recording_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    recording = db.get(AudioRecording, recording_id)
    if not recording or not _scoped_record(db, Store, recording.store_id, user):
        raise HTTPException(404, "Audio recording not found")
    if _utc_datetime(recording.retain_until) <= datetime.now(UTC):
        raise HTTPException(410, "Audio recording retention period has expired")
    try:
        path = resolve_audio_clip(recording.storage_key)
    except FileNotFoundError as exc:
        raise HTTPException(410, "This audio is gone. Earlier clips lived on temporary cloud disk and were erased on restart. Record again; new clips are kept in the database and will play back.") from exc
    return FileResponse(path, media_type=recording.content_type, headers={"Cache-Control": "private, no-store"})


@api.get("/opportunities")
def opportunities(
    store_id: str | None = None,
    status: str | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    query = apply_store_scope(db.query(ProductOpportunity), ProductOpportunity, user)
    if store_id:
        query = query.filter(ProductOpportunity.store_id == store_id)
    if status:
        query = query.filter(ProductOpportunity.status == status)
    opportunity_page = paginate_query(query.order_by(ProductOpportunity.created_at.desc()), page, page_size)
    opportunity_page["items"] = [serialize_opportunity(row) for row in opportunity_page["items"]]
    return {"opportunities": opportunity_page}


@api.patch("/opportunities/{opportunity_id}")
def review_opportunity(opportunity_id: str, body: OpportunityReview, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    if user.role not in {"SUPER_ADMIN", "ORG_ADMIN", "STORE_MANAGER", "SUPERVISOR"}:
        raise HTTPException(403, "Review requires a manager role")
    opportunity = _scoped_record(db, ProductOpportunity, opportunity_id, user)
    if not opportunity:
        raise HTTPException(404, "Opportunity not found")
    opportunity.status = body.status
    opportunity.manager_note = body.manager_note
    opportunity.reviewed_at = datetime.now(UTC)
    db.add(AuditLog(id=f"aud-{uuid4().hex[:10]}", actor_id=user.id, action="opportunity.review", entity="opportunity", entity_id=opportunity_id, detail=body.status))
    db.commit()
    return serialize_opportunity(opportunity)


@api.get("/sales-intelligence")
def sales_intelligence(db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    rows = apply_store_scope(db.query(SalesRecommendation), SalesRecommendation, user).all()
    return {
        "recommendations": [
            {
                "id": row.id,
                "conversation_id": row.conversation_id,
                "store_id": row.store_id,
                "title": row.title,
                "message": row.message,
                "confidence": row.confidence,
                "label": "AI-assisted recommendation",
            }
            for row in rows
        ]
    }


def _require_live_daily_report_config() -> None:
    if settings.demo_mode:
        raise HTTPException(503, "Daily reports are disabled in demo mode. Set DEMO_MODE=false to use live records.")
    if settings.ai_provider == "mock":
        raise HTTPException(503, "Daily reports require a real AI provider. Configure AI_PROVIDER and its API key.")


def _is_live_daily_report(payload: dict[str, Any]) -> bool:
    provider_summary = (payload.get("daily_analysis") or {}).get("provider_summary") or {}
    return (
        payload.get("dataMode") == "live"
        and provider_summary.get("provider") not in {None, "", "mock", "demo"}
        and provider_summary.get("status") == "completed"
    )


@api.get("/reports/history")
def report_history(
    store_id: str | None = Query(default=None, max_length=64),
    limit: int = Query(default=60, ge=1, le=200),
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    if settings.demo_mode:
        return {"reports": []}
    query = apply_store_scope(db.query(DailyReport), DailyReport, user)
    if store_id:
        if not _scoped_record(db, Store, store_id, user):
            raise HTTPException(404, "Store not found")
        query = query.filter(DailyReport.store_id == store_id)
    rows = query.order_by(DailyReport.generated_at.desc()).limit(limit).all()
    store_names = {
        store.id: store.name
        for store in apply_store_scope(db.query(Store), Store, user).all()
    }
    reports = []
    for row in rows:
        payload = json.loads(row.payload_json)
        if not _is_live_daily_report(payload):
            continue
        reports.append({
            "id": row.id,
            "store_id": row.store_id,
            "store_name": store_names.get(row.store_id, "All stores"),
            "business_date": payload.get("business_date"),
            "generated_at": row.generated_at.isoformat() if row.generated_at else None,
            "report_status": payload.get("reportStatus", "generated"),
            "summary": payload.get("daily_analysis", {}).get("provider_summary", {}).get("summary", ""),
        })
    return {"reports": reports}


@api.get("/reports/{period}")
def reports(
    period: Literal["daily", "weekly", "monthly"],
    store_id: str | None = Query(default=None, max_length=64),
    business_date: date | None = Query(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    if period == "daily" and settings.demo_mode:
        _require_live_daily_report_config()
    if store_id and not _scoped_record(db, Store, store_id, user):
        raise HTTPException(404, "Store not found")
    report = report_summary(db, user, period, store_id, business_date)
    report_id = f"daily-{store_id}-{report['business_date']}" if period == "daily" and store_id else None
    saved = db.get(DailyReport, report_id) if report_id else None
    if saved:
        saved_payload = json.loads(saved.payload_json)
        if period != "daily" or _is_live_daily_report(saved_payload):
            return saved_payload
    return {
        "reportType": period,
        **({"reportStatus": "not_generated"} if period == "daily" else {}),
        "generatedAt": datetime.now(UTC).isoformat(),
        "pos_provider": settings.pos_provider,
        **report,
    }


@api.post("/reports/daily/generate")
def generate_daily_report(
    body: DailyReportGenerate,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    if user.role not in {"SUPER_ADMIN", "ORG_ADMIN", "STORE_MANAGER", "SUPERVISOR"}:
        raise HTTPException(403, "Daily report generation requires a manager role")
    _require_live_daily_report_config()
    store = _scoped_record(db, Store, body.store_id, user)
    if not store:
        raise HTTPException(404, "Store not found")
    report = report_summary(db, user, "daily", store.id, body.business_date)
    metrics = report.get("metrics") or {}
    if not metrics.get("conversations") and not metrics.get("sales_data_available"):
        raise HTTPException(409, "No live conversations or real POS transactions are available for this business date.")
    try:
        report["daily_analysis"]["provider_summary"] = summarize_daily_report(report)
    except Exception as exc:
        logger.exception("Daily report AI summary failed store_id=%s", store.id)
        message = str(exc)
        safe_provider_errors = (
            "GEMINI_API_KEY is missing.",
            "Set AI_PROVIDER=gemini to enable Gemini analysis.",
            "Gemini report generation failed with HTTP ",
            "Gemini report service could not be reached.",
            "Gemini returned an empty analysis",
            "Gemini returned invalid structured JSON.",
        )
        detail = message if isinstance(exc, RuntimeError) and message.startswith(safe_provider_errors) else (
            "The configured AI provider is unavailable; the report was not saved with a fabricated fallback."
        )
        raise HTTPException(503, detail) from exc
    generated_at = datetime.now(UTC).isoformat()
    low_stock = db.query(StockItem).filter(
        StockItem.store_id == store.id,
        StockItem.quantity <= StockItem.par_level,
    ).count()
    conversation_rows = apply_store_scope(db.query(Conversation), Conversation, user).filter(
        Conversation.store_id == store.id,
        Conversation.started_at >= datetime.fromisoformat(report["range_start"]),
        Conversation.started_at < datetime.fromisoformat(report["range_end"]),
    ).order_by(Conversation.started_at.asc()).all()
    conversation_ids = [row.id for row in conversation_rows]
    segments_by_conversation: dict[str, list] = {}
    if conversation_ids:
        for segment in db.query(TranscriptSegment).filter(
            TranscriptSegment.conversation_id.in_(conversation_ids)
        ).order_by(TranscriptSegment.start_time.asc()).all():
            segments_by_conversation.setdefault(segment.conversation_id, []).append(segment)
    opportunities_by_conversation: dict[str, list] = {}
    reports_by_conversation: dict[str, dict[str, Any]] = {}
    if conversation_ids:
        conversation_analysis_runs = db.query(AiProcessingRun).filter(
            AiProcessingRun.conversation_id.in_(conversation_ids),
            AiProcessingRun.status == "completed",
        ).all()
        real_analysis_conversation_ids = {
            run.conversation_id for run in conversation_analysis_runs
            if str(getattr(run, "provider", "")).casefold() not in {"", "mock", "demo"}
        }
        for opportunity in db.query(ProductOpportunity).filter(
            ProductOpportunity.conversation_id.in_(conversation_ids)
        ).all():
            if opportunity.conversation_id not in real_analysis_conversation_ids:
                continue
            opportunities_by_conversation.setdefault(opportunity.conversation_id, []).append(opportunity)
        analysis_runs = db.query(AiProcessingRun).filter(
            AiProcessingRun.conversation_id.in_(conversation_ids),
            AiProcessingRun.status == "completed",
            AiProcessingRun.input_excerpt.like("[conversation-report]%"),
        ).order_by(AiProcessingRun.created_at.desc()).all()
        for run in analysis_runs:
            if run.provider in {"mock", "demo"}:
                continue
            try:
                saved = json.loads(run.output_json)
            except (TypeError, ValueError):
                continue
            if saved.get("kind") == "conversation_report" and run.conversation_id not in reports_by_conversation:
                report_details = saved.get("report")
                if isinstance(report_details, dict):
                    reports_by_conversation[run.conversation_id] = report_details
    location = ", ".join(part for part in [getattr(store, "city", None), getattr(store, "region", None)] if part)
    interactions = build_interaction_cards_from_conversations(
        conversation_rows,
        store_name=store.name,
        store_location=location,
        timezone_name=report.get("timezone", "UTC"),
        segments_by_conversation=segments_by_conversation,
        opportunities_by_conversation=opportunities_by_conversation,
        reports_by_conversation=reports_by_conversation,
    )
    store_listener = build_store_listener_daily_report(
        store_name=store.name,
        store_location=location,
        report={**report, "generatedAt": generated_at},
        provider_summary=report["daily_analysis"].get("provider_summary"),
        low_stock_count=low_stock,
        interactions=interactions,
    )
    payload = {
        "reportType": "daily",
        "reportStatus": "generated",
        "generatedAt": generated_at,
        "store_id": store.id,
        "store_name": store.name,
        **report,
        "pos_provider": settings.pos_provider,
        "store_listener": store_listener,
    }
    report_id = f"daily-{store.id}-{report['business_date']}"
    saved = db.get(DailyReport, report_id)
    if saved:
        saved.payload_json = json.dumps(payload)
        saved.generated_at = datetime.now(UTC)
    else:
        db.add(DailyReport(
            id=report_id,
            store_id=store.id,
            period="daily",
            payload_json=json.dumps(payload),
            generated_at=datetime.now(UTC),
        ))
    db.add(AuditLog(
        id=f"aud-{uuid4().hex[:10]}",
        actor_id=user.id,
        action="report.daily.generate",
        entity="daily_report",
        entity_id=report_id,
        detail=f"store={store.id};business_date={report['business_date']}",
    ))
    db.commit()
    return payload


@api.get("/alerts")
def alerts(db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    rows = apply_store_scope(db.query(Alert), Alert, user).order_by(Alert.created_at.desc()).all()
    return {
        "alerts": [
            {
                "id": row.id,
                "severity": row.severity,
                "title": row.title,
                "description": row.description,
                "store_id": row.store_id,
                "created_at": row.created_at.isoformat() if row.created_at else None,
            }
            for row in rows
        ]
    }


@api.get("/employees")
def employees(store_id: str | None = None, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    query = apply_store_scope(db.query(Employee), Employee, user).filter(Employee.active.is_(True))
    if store_id:
        query = query.filter(Employee.store_id == store_id)
    return {
        "employees": [{"id": row.id, "name": row.full_name, "store_id": row.store_id, "role": row.role_title, "active": row.active} for row in query.all()],
        "metrics_are_ai_assisted": True,
    }


@api.post("/employees", status_code=201)
def create_employee(body: EmployeeCreate, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    _employee_store_for_write(db, body.store_id, user)
    employee = Employee(
        id=f"employee-{uuid4().hex[:12]}",
        store_id=body.store_id,
        full_name=body.name,
        role_title=body.role,
    )
    db.add(employee)
    db.add(AuditLog(id=f"aud-{uuid4().hex[:10]}", actor_id=user.id, action="employee.created", entity="employee", entity_id=employee.id, detail=employee.store_id))
    db.commit()
    db.refresh(employee)
    return {"id": employee.id, "name": employee.full_name, "store_id": employee.store_id, "role": employee.role_title, "active": employee.active}


@api.patch("/employees/{employee_id}")
def update_employee(employee_id: str, body: EmployeeUpdate, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    employee = _scoped_record(db, Employee, employee_id, user)
    if not employee or not employee.active:
        raise HTTPException(404, "Employee not found")
    _employee_store_for_write(db, employee.store_id, user)
    changes = body.model_dump(exclude_unset=True)
    if not changes or any(value is None for value in changes.values()):
        raise HTTPException(422, "Provide at least one non-empty field to update")
    if "store_id" in changes:
        _employee_store_for_write(db, changes["store_id"], user)
    if "name" in changes:
        employee.full_name = changes.pop("name")
    if "role" in changes:
        employee.role_title = changes.pop("role")
    if "store_id" in changes:
        employee.store_id = changes["store_id"]
    db.add(AuditLog(id=f"aud-{uuid4().hex[:10]}", actor_id=user.id, action="employee.updated", entity="employee", entity_id=employee.id, detail="employee profile"))
    db.commit()
    db.refresh(employee)
    return {"id": employee.id, "name": employee.full_name, "store_id": employee.store_id, "role": employee.role_title, "active": employee.active}


@api.delete("/employees/{employee_id}")
def delete_employee(employee_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    employee = _scoped_record(db, Employee, employee_id, user)
    if not employee or not employee.active:
        raise HTTPException(404, "Employee not found")
    _employee_store_for_write(db, employee.store_id, user)
    employee.active = False
    db.add(AuditLog(id=f"aud-{uuid4().hex[:10]}", actor_id=user.id, action="employee.deactivated", entity="employee", entity_id=employee.id, detail=employee.store_id))
    db.commit()
    return {"id": employee.id, "active": False}


@api.get("/employees/{employee_id}")
def employee_detail(employee_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    employee = _scoped_record(db, Employee, employee_id, user)
    if not employee:
        raise HTTPException(404, "Employee not found")
    return {"id": employee.id, "name": employee.full_name, "store_id": employee.store_id, "role": employee.role_title, "active": employee.active}


@api.get("/employees/{employee_id}/performance")
def employee_performance(employee_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    employee = _scoped_record(db, Employee, employee_id, user)
    if not employee:
        raise HTTPException(404, "Employee not found")
    perf = db.query(EmployeePerformance).filter(EmployeePerformance.employee_id == employee_id).first()
    return {
        "employeeId": employee_id,
        "name": employee.full_name,
        "storeId": employee.store_id,
        "conversationsHandled": perf.conversations_handled if perf else 0,
        "opportunitiesDetected": perf.opportunities_detected if perf else 0,
        "opportunitiesConverted": perf.opportunities_converted if perf else 0,
        "potentialMissed": perf.potential_missed if perf else 0,
        "conversionRate": perf.conversion_rate if perf else 0,
        "averageResponseTimeSeconds": perf.avg_response_seconds if perf else 0,
        "aiAssistedMetric": True,
        "caveat": "AI-assisted metrics. Not an objective performance score.",
    }


@api.get("/pos/transactions")
def pos_transactions(store_id: str | None = None, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    query = apply_store_scope(db.query(PosTransaction), PosTransaction, user)
    if store_id:
        query = query.filter(PosTransaction.store_id == store_id)
    items = []
    for txn in query.order_by(PosTransaction.occurred_at.desc()).all():
        line = db.query(PosTransactionItem).filter(PosTransactionItem.transaction_id == txn.id).first()
        items.append(
            {
                "id": txn.id,
                "store_id": txn.store_id,
                "employee_id": txn.employee_id,
                "product": line.name if line else "Item",
                "amount": txn.amount,
                "currency": txn.currency,
                "created_at": txn.occurred_at.isoformat() if txn.occurred_at else None,
                "provider": txn.provider,
            }
        )
    return {"transactions": items, "provider": settings.pos_provider, "dataMode": "demo"}


@api.post("/pos/demo")
def create_demo_transaction(db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    if not _scoped_record(db, Store, "store-001", user):
        raise HTTPException(404, "Store not found")
    sale = get_pos_provider(settings.pos_provider).simulate_sale("store-001", "employee-001", "CHG-USBC", "USB-C Charger", 19.99)
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
    match = match_transaction(db, txn)
    db.commit()
    return {
        "transaction": {"id": txn.id, "product": "USB-C Charger", "amount": 19.99, "store_id": txn.store_id},
        "match": {"confidence": match.confidence, "conversation_id": match.conversation_id} if match else None,
        "provider": "mock",
        "dataMode": "demo",
    }


@api.post("/pos/webhook")
def pos_webhook(payload: PosWebhookBody, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    if not _scoped_record(db, Store, payload.store_id, user):
        raise HTTPException(404, "Store not found")
    sale = get_pos_provider("mock").simulate_sale(
        payload.store_id,
        payload.employee_id,
        payload.sku,
        payload.name,
        payload.amount,
    )
    txn = PosTransaction(id=sale.id, store_id=sale.store_id, employee_id=sale.employee_id, amount=sale.amount, occurred_at=sale.occurred_at, provider="mock")
    db.add(txn)
    db.add(PosTransactionItem(id=f"item-{sale.id}", transaction_id=sale.id, sku=sale.items[0].sku, name=sale.items[0].name, unit_price=sale.items[0].unit_price))
    match = match_transaction(db, txn)
    db.commit()
    return {"accepted": True, "transaction_id": txn.id, "matched": bool(match)}


@api.get("/analytics")
def analytics(db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    summary = dashboard_summary(db, user)
    return {"metrics": summary["metrics"], "stores": summary["stores"], "store_performance": summary["store_performance"], "dataMode": "demo"}


@api.get("/settings")
def settings_view(db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    devices = apply_store_scope(db.query(StoreDevice), StoreDevice, user).all()
    integrations = db.query(IntegrationConnection).all()
    users_query = db.query(User).filter(User.organization_id == user.organization_id)
    if user.role not in {"SUPER_ADMIN", "ORG_ADMIN"}:
        users_query = users_query.filter(User.id == user.id)
    return {
        "demo_mode": settings.demo_mode,
        "providers": {"ai": settings.ai_provider, "speech": settings.speech_provider, "pos": settings.pos_provider, "storage": settings.storage_provider},
        "retention": {"audio_days": settings.audio_retention_days, "transcript_days": settings.transcript_retention_days, "raw_audio_stored_by_default": False},
        "stores": serialize_stores(apply_store_scope(db.query(Store), Store, user).all(), db),
        "devices": [
            {
                "id": device.id,
                "store_id": device.store_id,
                "status": device.status,
                "audio_source": device.audio_source,
                "version": device.version,
                "cpu_pct": device.cpu_pct,
                "memory_pct": device.memory_pct,
                "audio_status": device.audio_status,
                "microphone_status": device.microphone_status,
                "stream_status": device.stream_status,
            }
            for device in devices
        ],
        "roles": ["SUPER_ADMIN", "ORG_ADMIN", "STORE_MANAGER", "SUPERVISOR", "EMPLOYEE", "VIEWER"],
        "users": [
            {"id": row.id, "email": row.email, "full_name": row.full_name, "role": row.role, "store_id": row.store_id}
            for row in users_query.all()
        ],
        "integrations": [{"kind": row.kind, "provider": row.provider, "status": row.status, "notes": row.notes} for row in integrations],
        "ai": {
            "provider": settings.ai_provider,
            "speech_provider": settings.speech_provider,
            "supports_original_transcript": True,
            "supports_english_translation": True,
            "provider_note": "Client notes mention Gork/Grok; provider choice remains unconfirmed. MockAIProvider is active unless AI_PROVIDER is a keyed vendor.",
        },
        "security": {
            "authentication": "jwt+httpOnly-cookie",
            "rbac": "enabled",
            "websocket_authentication": "token-query",
            "secrets_exposed": False,
        },
    }


@api.post("/devices/register")
def register_device(body: DeviceRegister, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    _employee_store_for_write(db, body.store_id, user)
    raw = new_device_secret()
    device = StoreDevice(
        id=f"device-{uuid4().hex[:8]}",
        store_id=body.store_id,
        name=body.name,
        status="registered",
        approval_status="approved",
        audio_source=body.audio_source,
        secret_hash=hash_device_secret(raw),
    )
    db.add(device)
    db.add(AuditLog(
        id=f"aud-{uuid4().hex[:10]}",
        actor_id=user.id,
        action="device.registered",
        entity="store_device",
        entity_id=device.id,
        detail=f"{body.store_id};approved",
    ))
    db.commit()
    return {
        "device_id": device.id,
        "device_secret": raw,
        "approval_status": device_approval_status(device),
        "note": "Device registered and ready to record. No separate admin approval is required.",
    }


def _serialize_device_approval(db: Session, device: StoreDevice) -> dict[str, Any]:
    store = db.get(Store, device.store_id)
    return {
        "id": device.id,
        "name": device.name,
        "store_id": device.store_id,
        "store_name": store.name if store else device.store_id,
        "store_city": getattr(store, "city", "") if store else "",
        "store_region": getattr(store, "region", "") if store else "",
        "status": device.status,
        "approval_status": device_approval_status(device),
        "audio_source": device.audio_source,
        "version": device.version,
        "last_heartbeat": device.last_heartbeat.isoformat() if device.last_heartbeat else None,
        "revoked": bool(device.revoked),
        "approved_at": device.approved_at.isoformat() if getattr(device, "approved_at", None) else None,
    }


@api.get("/devices/pending")
def list_pending_devices(db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    _require_organization_admin(user)
    rows = [
        device
        for device in apply_store_scope(db.query(StoreDevice), StoreDevice, user).all()
        if device_approval_status(device) == "pending" and not device.revoked
    ]
    rows.sort(key=lambda item: item.name.lower())
    return {"devices": [_serialize_device_approval(db, device) for device in rows], "total": len(rows)}


@api.get("/devices/{device_id}/approval")
def get_device_approval(
    device_id: str,
    db: Session = Depends(get_db),
    actor: tuple[User | None, StoreDevice | None] = Depends(_audio_actor),
) -> dict[str, Any]:
    user, device_actor = actor
    device = db.get(StoreDevice, device_id)
    if not device:
        raise HTTPException(404, "Device not found")
    if device_actor and device_actor.id != device.id:
        raise HTTPException(403, "Device credentials do not match this device")
    if user and not _scoped_record(db, StoreDevice, device_id, user):
        raise HTTPException(404, "Device not found")
    return {
        "device_id": device.id,
        "approval_status": device_approval_status(device),
        "approved": device_is_approved(device),
        "status": device.status,
        "revoked": bool(device.revoked),
    }


@api.post("/devices/{device_id}/approve")
async def approve_device(device_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    _require_organization_admin(user)
    device = _scoped_record(db, StoreDevice, device_id, user)
    if not device:
        raise HTTPException(404, "Device not found")
    if device.revoked:
        raise HTTPException(409, "Revoked devices cannot be approved")
    device.approval_status = "approved"
    device.status = "registered"
    device.approved_at = datetime.now(UTC)
    device.approved_by = user.id
    db.add(AuditLog(
        id=f"aud-{uuid4().hex[:10]}",
        actor_id=user.id,
        action="device.approved",
        entity="store_device",
        entity_id=device.id,
        detail=device.store_id,
    ))
    db.commit()
    await hub.publish(f"store:{device.store_id}", {
        "event": "device.approved",
        "deviceId": device.id,
        "storeId": device.store_id,
        "approvalStatus": "approved",
        "timestamp": datetime.now(UTC).isoformat(),
    })
    return _serialize_device_approval(db, device)


@api.post("/devices/{device_id}/reject")
async def reject_device(device_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    _require_organization_admin(user)
    device = _scoped_record(db, StoreDevice, device_id, user)
    if not device:
        raise HTTPException(404, "Device not found")
    device.approval_status = "rejected"
    device.status = "rejected"
    device.approved_at = None
    device.approved_by = user.id
    db.add(AuditLog(
        id=f"aud-{uuid4().hex[:10]}",
        actor_id=user.id,
        action="device.rejected",
        entity="store_device",
        entity_id=device.id,
        detail=device.store_id,
    ))
    db.commit()
    await hub.publish(f"store:{device.store_id}", {
        "event": "device.rejected",
        "deviceId": device.id,
        "storeId": device.store_id,
        "approvalStatus": "rejected",
        "timestamp": datetime.now(UTC).isoformat(),
    })
    return _serialize_device_approval(db, device)


@api.post("/devices/{device_id}/revoke")
def revoke_device(device_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, str]:
    device = _scoped_record(db, StoreDevice, device_id, user)
    if not device:
        raise HTTPException(404, "Device not found")
    _employee_store_for_write(db, device.store_id, user)
    device.revoked = True
    device.status = "revoked"
    device.approval_status = "rejected"
    db.add(AuditLog(
        id=f"aud-{uuid4().hex[:10]}",
        actor_id=user.id,
        action="device.revoked",
        entity="store_device",
        entity_id=device.id,
        detail=device.store_id,
    ))
    db.commit()
    return {"device_id": device.id, "status": device.status}


@api.post("/demo/replay")
async def replay_demo(store_id: str = "store-001", user: User = Depends(current_user)) -> dict[str, Any]:
    with SessionLocal() as db:
        if not _scoped_record(db, Store, store_id, user):
            raise HTTPException(404, "Store not found")
    asyncio.create_task(run_live_demo(store_id))
    return {"status": "started", "store_id": store_id, "scenario": "spanish_iphone_charger"}


@api.get("/devcore/tasks")
def devcore_tasks(db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    _require_devcore_admin(user)
    rows = db.query(DevcoreTask).order_by(DevcoreTask.sort_order.asc()).all()
    return {
        "tasks": [
            {
                "id": row.id,
                "project_id": row.project_id,
                "title": row.title,
                "description": row.description,
                "status": row.status,
                "priority": row.priority,
                "assignee": row.assignee,
                "due_date": row.due_date,
                "labels": row.labels,
            }
            for row in rows
        ]
    }


@api.post("/devcore/tasks")
def create_task(body: TaskCreate, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    _require_devcore_admin(user)
    task = DevcoreTask(id=f"task-{uuid4().hex[:8]}", **body.model_dump())
    db.add(task)
    db.commit()
    return {"id": task.id, **body.model_dump()}


@api.patch("/devcore/tasks/{task_id}")
def patch_task(task_id: str, body: TaskPatch, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    _require_devcore_admin(user)
    task = db.get(DevcoreTask, task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(task, field, value)
    db.commit()
    return {"id": task.id, "status": task.status, "title": task.title}


def _websocket_token(websocket: WebSocket) -> str:
    protocols = [str(item) for item in websocket.scope.get("subprotocols", [])]
    if len(protocols) >= 2 and protocols[0] == WEBSOCKET_AUTH_PROTOCOL and protocols[1]:
        return protocols[1]
    query_token = str(websocket.query_params.get("token") or "").strip()
    if query_token:
        return query_token
    return str(websocket.cookies.get("sl_session") or "")


async def _ws_auth(websocket: WebSocket) -> User | None:
    token = _websocket_token(websocket)
    if not token:
        await websocket.close(code=4401)
        return None
    from fastapi import HTTPException
    from app.security import decode_token

    db = SessionLocal()
    try:
        payload = decode_token(token)
        user = db.get(User, payload["sub"])
        if not user:
            await websocket.close(code=4401)
            return None
        return user
    except HTTPException:
        await websocket.close(code=4401)
        return None
    finally:
        db.close()


@health.websocket("/ws/dashboard")
async def ws_dashboard(websocket: WebSocket):
    user = await _ws_auth(websocket)
    if not user:
        return
    if user.role not in {"SUPER_ADMIN", "ORG_ADMIN"}:
        await websocket.close(code=4403)
        return
    await hub.connect("dashboard", websocket, subprotocol=WEBSOCKET_AUTH_PROTOCOL if websocket.scope.get("subprotocols", []) else None)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        await hub.disconnect("dashboard", websocket)


@health.websocket("/ws/stores/{store_id}")
async def ws_store(websocket: WebSocket, store_id: str):
    user = await _ws_auth(websocket)
    if not user:
        return
    with SessionLocal() as db:
        if not _scoped_record(db, Store, store_id, user):
            await websocket.close(code=4403)
            return
    await hub.connect(f"store:{store_id}", websocket, subprotocol=WEBSOCKET_AUTH_PROTOCOL if websocket.scope.get("subprotocols", []) else None)
    try:
        while True:
            message = await websocket.receive_text()
            if message in {"ping", "keepalive"}:
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        await hub.disconnect(f"store:{store_id}", websocket)


@health.websocket("/ws/device/{device_id}")
async def ws_device(websocket: WebSocket, device_id: str):
    protocols = websocket.scope.get("subprotocols", [])
    token = protocols[1] if len(protocols) == 2 and protocols[0] == WEBSOCKET_AUTH_PROTOCOL else None
    if not token:
        await websocket.close(code=4401)
        return
    db = SessionLocal()
    try:
        device = db.get(StoreDevice, device_id)
        if not device or device.revoked or not secrets.compare_digest(device.secret_hash, hash_device_secret(token)):
            await websocket.close(code=4401)
            return
        await websocket.accept(subprotocol=WEBSOCKET_AUTH_PROTOCOL)
        while True:
            raw_payload = await websocket.receive_json()
            try:
                payload = DeviceHealthPayload.model_validate(raw_payload)
            except ValidationError:
                await websocket.close(code=1008, reason="Invalid device health payload")
                return
            values = payload.model_dump()
            speaking = bool(values.pop("speaking", False))
            for field, value in values.items():
                if hasattr(device, field):
                    setattr(device, field, value)
            device.last_heartbeat = datetime.now(UTC)
            device.status = "connected"
            db.commit()
            event = {
                "event": "device.health.updated",
                "deviceId": device_id,
                "storeId": device.store_id,
                **values,
                "speaking": speaking,
                "status": "connected",
                "timestamp": device.last_heartbeat.isoformat(),
            }
            await hub.publish(f"store:{device.store_id}", event)
            if speaking:
                await hub.publish(f"store:{device.store_id}", {
                    "event": "voice.detected",
                    "deviceId": device_id,
                    "storeId": device.store_id,
                    "conversationId": None,
                    "label": "Voice detected",
                    "status": "speaking",
                    "timestamp": device.last_heartbeat.isoformat(),
                })
    except WebSocketDisconnect:
        db.rollback()
        if device and not device.revoked:
            db.refresh(device)
            if not device.revoked:
                device.status = "heartbeat_missing"
                device.audio_status = "idle"
                device.microphone_status = "disconnected"
                device.stream_status = "idle"
                db.commit()
                await hub.publish(f"store:{device.store_id}", {
                    "event": "device.health.updated",
                    "deviceId": device.id,
                    "storeId": device.store_id,
                    "status": device.status,
                    "audio_status": device.audio_status,
                    "microphone_status": device.microphone_status,
                    "stream_status": device.stream_status,
                    "timestamp": datetime.now(UTC).isoformat(),
                })
    finally:
        db.close()
