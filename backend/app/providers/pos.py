from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import uuid4


@dataclass
class PosItem:
    sku: str
    name: str
    quantity: int
    unit_price: float


@dataclass
class PosSale:
    id: str
    store_id: str
    employee_id: str | None
    amount: float
    currency: str
    occurred_at: datetime
    items: list[PosItem]
    provider: str


class POSProvider(ABC):
    name = "abstract"

    @abstractmethod
    def simulate_sale(self, store_id: str, employee_id: str | None, sku: str, name: str, amount: float) -> PosSale:
        raise NotImplementedError


class MockPOSProvider(POSProvider):
    name = "mock"

    def simulate_sale(self, store_id: str, employee_id: str | None, sku: str, name: str, amount: float) -> PosSale:
        return PosSale(
            id=f"txn-{uuid4().hex[:8]}",
            store_id=store_id,
            employee_id=employee_id,
            amount=amount,
            currency="USD",
            occurred_at=datetime.now(UTC),
            items=[PosItem(sku, name, 1, amount)],
            provider="mock",
        )


def get_pos_provider(name: str) -> POSProvider:
    if name == "mock":
        return MockPOSProvider()
    raise ValueError(f"Unsupported POS_PROVIDER: {name}. No real POS adapter is configured for this vendor.")
