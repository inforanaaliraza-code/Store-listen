from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Organization(Base):
    __tablename__ = "organizations"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(160))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    stores: Mapped[list[Store]] = relationship(back_populates="organization")


class Store(Base):
    __tablename__ = "stores"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id"))
    name: Mapped[str] = mapped_column(String(120), index=True)
    code: Mapped[str] = mapped_column(String(32), index=True)
    city: Mapped[str] = mapped_column(String(80))
    region: Mapped[str] = mapped_column(String(40))
    timezone: Mapped[str] = mapped_column(String(64), default="America/Chicago")
    online: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    organization: Mapped[Organization] = relationship(back_populates="stores")
    devices: Mapped[list[StoreDevice]] = relationship(back_populates="store")
    employees: Mapped[list[Employee]] = relationship(back_populates="store")


class StoreDevice(Base):
    __tablename__ = "store_devices"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    store_id: Mapped[str] = mapped_column(ForeignKey("stores.id"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    status: Mapped[str] = mapped_column(String(40), default="disconnected")
    # pending → approved (admin) before the desktop agent may record/stream.
    approval_status: Mapped[str] = mapped_column(String(24), default="pending", index=True)
    audio_source: Mapped[str] = mapped_column(String(40), default="mock")
    version: Mapped[str] = mapped_column(String(40), default="0.2.0")
    secret_hash: Mapped[str] = mapped_column(String(128))
    last_heartbeat: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cpu_pct: Mapped[float] = mapped_column(Float, default=12.0)
    memory_pct: Mapped[float] = mapped_column(Float, default=34.0)
    audio_status: Mapped[str] = mapped_column(String(40), default="idle")
    microphone_status: Mapped[str] = mapped_column(String(40), default="ok")
    stream_status: Mapped[str] = mapped_column(String(40), default="idle")
    processing_latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    approved_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    store: Mapped[Store] = relationship(back_populates="devices")


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id"), index=True)
    email: Mapped[str] = mapped_column(String(180), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(160))
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(40), index=True)
    store_id: Mapped[str | None] = mapped_column(ForeignKey("stores.id"), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class RolePermission(Base):
    __tablename__ = "permissions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    role: Mapped[str] = mapped_column(String(40), index=True)
    permission: Mapped[str] = mapped_column(String(80))
    __table_args__ = (UniqueConstraint("role", "permission"),)


class Employee(Base):
    __tablename__ = "employees"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    store_id: Mapped[str] = mapped_column(ForeignKey("stores.id"), index=True)
    full_name: Mapped[str] = mapped_column(String(160))
    role_title: Mapped[str] = mapped_column(String(80), default="Sales associate")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    store: Mapped[Store] = relationship(back_populates="employees")


class Conversation(Base):
    __tablename__ = "conversations"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    store_id: Mapped[str] = mapped_column(ForeignKey("stores.id"), index=True)
    employee_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="LIVE", index=True)
    primary_language: Mapped[str] = mapped_column(String(8), default="en")
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    customer_intent: Mapped[str | None] = mapped_column(String(160), nullable=True)
    detected_product: Mapped[str | None] = mapped_column(String(160), nullable=True)
    opportunity_status: Mapped[str] = mapped_column(String(40), default="UNKNOWN")


class ConversationParticipant(Base):
    __tablename__ = "conversation_participants"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id"), index=True)
    speaker_label: Mapped[str] = mapped_column(String(40))
    mapped_role: Mapped[str] = mapped_column(String(40), default="unknown")
    employee_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"), nullable=True)


class TranscriptSegment(Base):
    __tablename__ = "transcript_segments"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id"), index=True)
    speaker_id: Mapped[str] = mapped_column(String(64))
    language: Mapped[str] = mapped_column(String(8))
    original_text: Mapped[str] = mapped_column(Text)
    translated_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    start_time: Mapped[float] = mapped_column(Float, default=0)
    end_time: Mapped[float] = mapped_column(Float, default=0)
    confidence: Mapped[float] = mapped_column(Float, default=0.9)
    is_final: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AudioSession(Base):
    __tablename__ = "audio_sessions"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    store_id: Mapped[str] = mapped_column(ForeignKey("stores.id"))
    device_id: Mapped[str] = mapped_column(ForeignKey("store_devices.id"))
    conversation_id: Mapped[str | None] = mapped_column(ForeignKey("conversations.id"), nullable=True)
    source_type: Mapped[str] = mapped_column(String(40), default="mock")
    retain_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    stored_audio: Mapped[bool] = mapped_column(Boolean, default=False)


class AudioRecording(Base):
    __tablename__ = "audio_recordings"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    store_id: Mapped[str] = mapped_column(ForeignKey("stores.id"), index=True)
    conversation_id: Mapped[str | None] = mapped_column(ForeignKey("conversations.id"), nullable=True, index=True)
    storage_key: Mapped[str] = mapped_column(String(240), unique=True)
    content_type: Mapped[str] = mapped_column(String(80))
    byte_size: Mapped[int] = mapped_column(Integer)
    duration_seconds: Mapped[float] = mapped_column(Float, default=0)
    sequence: Mapped[int] = mapped_column(Integer, default=0)
    speaker_role: Mapped[str] = mapped_column(String(24), default="unknown")
    is_aggregate: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    retain_until: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class CustomerIntent(Base):
    __tablename__ = "customer_intents"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id"), index=True)
    intent: Mapped[str] = mapped_column(String(120))
    product: Mapped[str | None] = mapped_column(String(160), nullable=True)
    confidence: Mapped[float] = mapped_column(Float, default=0.7)
    source: Mapped[str] = mapped_column(String(40), default="mock")


class Product(Base):
    __tablename__ = "products"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    sku: Mapped[str] = mapped_column(String(64), unique=True)
    name: Mapped[str] = mapped_column(String(160))
    category: Mapped[str] = mapped_column(String(80))
    keywords: Mapped[str] = mapped_column(Text, default="")


class StockItem(Base):
    __tablename__ = "stock_items"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    store_id: Mapped[str] = mapped_column(ForeignKey("stores.id"), index=True)
    sku: Mapped[str] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(160))
    cost: Mapped[float] = mapped_column(Float, default=0)
    price: Mapped[float] = mapped_column(Float, default=0)
    quantity: Mapped[int] = mapped_column(Integer, default=0)
    par_level: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (UniqueConstraint("store_id", "sku"),)


class StoreRule(Base):
    __tablename__ = "store_rules"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    store_id: Mapped[str] = mapped_column(ForeignKey("stores.id"), index=True)
    name: Mapped[str] = mapped_column(String(160))
    dollar_value: Mapped[float] = mapped_column(Float, default=0)
    trigger_condition: Mapped[str] = mapped_column(Text)
    expected_action: Mapped[str] = mapped_column(Text)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ProductOpportunity(Base):
    __tablename__ = "product_opportunities"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id"), index=True)
    store_id: Mapped[str] = mapped_column(ForeignKey("stores.id"), index=True)
    employee_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    product_id: Mapped[str | None] = mapped_column(ForeignKey("products.id"), nullable=True)
    customer_intent: Mapped[str] = mapped_column(String(160))
    product_name: Mapped[str] = mapped_column(String(160))
    status: Mapped[str] = mapped_column(String(32), default="OPEN", index=True)
    confidence: Mapped[float] = mapped_column(Float, default=0.7)
    recommendation: Mapped[str] = mapped_column(Text)
    manager_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class SalesRecommendation(Base):
    __tablename__ = "sales_recommendations"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id"), index=True)
    store_id: Mapped[str] = mapped_column(ForeignKey("stores.id"))
    title: Mapped[str] = mapped_column(String(160))
    message: Mapped[str] = mapped_column(Text)
    confidence: Mapped[float] = mapped_column(Float, default=0.8)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class MissedOpportunity(Base):
    __tablename__ = "missed_opportunities"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    opportunity_id: Mapped[str] = mapped_column(ForeignKey("product_opportunities.id"))
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id"))
    reason: Mapped[str] = mapped_column(Text)
    confidence: Mapped[float] = mapped_column(Float, default=0.6)
    requires_review: Mapped[bool] = mapped_column(Boolean, default=True)


class PosTransaction(Base):
    __tablename__ = "pos_transactions"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    store_id: Mapped[str] = mapped_column(ForeignKey("stores.id"), index=True)
    employee_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    amount: Mapped[float] = mapped_column(Float)
    currency: Mapped[str] = mapped_column(String(8), default="USD")
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    provider: Mapped[str] = mapped_column(String(40), default="mock")
    external_id: Mapped[str | None] = mapped_column(String(80), nullable=True)


class PosTransactionItem(Base):
    __tablename__ = "pos_transaction_items"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    transaction_id: Mapped[str] = mapped_column(ForeignKey("pos_transactions.id"), index=True)
    product_id: Mapped[str | None] = mapped_column(ForeignKey("products.id"), nullable=True)
    sku: Mapped[str] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(160))
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    unit_price: Mapped[float] = mapped_column(Float)


class ConversationPosMatch(Base):
    __tablename__ = "conversation_pos_matches"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id"), index=True)
    transaction_id: Mapped[str] = mapped_column(ForeignKey("pos_transactions.id"))
    opportunity_id: Mapped[str | None] = mapped_column(ForeignKey("product_opportunities.id"), nullable=True)
    confidence: Mapped[float] = mapped_column(Float)
    method: Mapped[str] = mapped_column(String(80), default="time_product_store")
    certain: Mapped[bool] = mapped_column(Boolean, default=False)


class EmployeePerformance(Base):
    __tablename__ = "employee_performance"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    period: Mapped[str] = mapped_column(String(16), default="daily")
    conversations_handled: Mapped[int] = mapped_column(Integer, default=0)
    opportunities_detected: Mapped[int] = mapped_column(Integer, default=0)
    opportunities_converted: Mapped[int] = mapped_column(Integer, default=0)
    potential_missed: Mapped[int] = mapped_column(Integer, default=0)
    avg_response_seconds: Mapped[float] = mapped_column(Float, default=0)
    conversion_rate: Mapped[float] = mapped_column(Float, default=0)


class StorePerformance(Base):
    __tablename__ = "store_performance"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    store_id: Mapped[str] = mapped_column(ForeignKey("stores.id"), index=True)
    period: Mapped[str] = mapped_column(String(16), default="daily")
    conversations: Mapped[int] = mapped_column(Integer, default=0)
    opportunities: Mapped[int] = mapped_column(Integer, default=0)
    converted: Mapped[int] = mapped_column(Integer, default=0)
    missed: Mapped[int] = mapped_column(Integer, default=0)
    conversion_rate: Mapped[float] = mapped_column(Float, default=0)


class DailyReport(Base):
    __tablename__ = "daily_reports"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    store_id: Mapped[str | None] = mapped_column(ForeignKey("stores.id"), nullable=True)
    period: Mapped[str] = mapped_column(String(16), default="daily")
    payload_json: Mapped[str] = mapped_column(Text)
    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Alert(Base):
    __tablename__ = "alerts"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    store_id: Mapped[str | None] = mapped_column(ForeignKey("stores.id"), nullable=True)
    severity: Mapped[str] = mapped_column(String(16), default="INFO")
    title: Mapped[str] = mapped_column(String(180))
    description: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    acknowledged: Mapped[bool] = mapped_column(Boolean, default=False)


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    actor_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    action: Mapped[str] = mapped_column(String(80))
    entity: Mapped[str] = mapped_column(String(80))
    entity_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    detail: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AiProcessingRun(Base):
    __tablename__ = "ai_processing_runs"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id"), index=True)
    provider: Mapped[str] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(24), default="completed")
    input_excerpt: Mapped[str] = mapped_column(Text, default="")
    output_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class IntegrationConnection(Base):
    __tablename__ = "integration_connections"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    kind: Mapped[str] = mapped_column(String(40))
    provider: Mapped[str] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(24), default="mock")
    notes: Mapped[str] = mapped_column(Text, default="")


class DevcoreProject(Base):
    __tablename__ = "devcore_projects"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(160))
    client: Mapped[str] = mapped_column(String(160))
    status: Mapped[str] = mapped_column(String(32), default="active")


class DevcoreTask(Base):
    __tablename__ = "devcore_tasks"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("devcore_projects.id"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(24), default="todo", index=True)
    priority: Mapped[str] = mapped_column(String(16), default="medium")
    assignee: Mapped[str] = mapped_column(String(120), default="")
    due_date: Mapped[str | None] = mapped_column(String(32), nullable=True)
    labels: Mapped[str] = mapped_column(String(200), default="")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
