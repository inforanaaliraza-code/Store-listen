from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class MetricsSnapshot(BaseModel):
    active_stores: int
    online_stores: int
    offline_stores: int
    live_conversations: int
    conversations_today: int
    potential_missed_opportunities: int
    sales_opportunities: int
    converted_opportunities: int
    conversion_rate: float
    average_response_time_seconds: float
    language_distribution: dict[str, int]


class StoreSummary(BaseModel):
    id: str
    name: str
    city: str
    region: str
    online: bool
    device_connected: bool
    open_conversations: int = 0
    employees: int = 0


class OpportunityRecord(BaseModel):
    id: str
    store_id: str
    customer_intent: str
    product: str
    status: Literal["OPEN", "CONVERTED", "MISSED", "UNKNOWN", "REVIEW_REQUIRED"]
    confidence: float
    recommendation: str
    created_at: datetime


class ConversationSummary(BaseModel):
    id: str
    store_id: str
    started_at: datetime
    status: Literal["LIVE", "ENDED"]
    language: str
    product: str
    customer_intent: str
    salesperson: str
    opportunity_status: str


class AlertRecord(BaseModel):
    id: str
    severity: Literal["INFO", "WARNING", "CRITICAL"]
    title: str
    description: str
    store_id: str
    created_at: datetime


class DashboardSummary(BaseModel):
    stores: list[StoreSummary]
    metrics: MetricsSnapshot
    recent_conversations: list[ConversationSummary]
    opportunities: list[OpportunityRecord]
    alerts: list[AlertRecord]
