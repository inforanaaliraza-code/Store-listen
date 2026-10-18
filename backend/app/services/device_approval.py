"""Store device admin-approval helpers (Core Deliverable 1)."""

from __future__ import annotations

from app.models import StoreDevice


def device_approval_status(device: StoreDevice | None) -> str:
    if device is None:
        return "rejected"
    if device.revoked:
        return "rejected"
    value = getattr(device, "approval_status", None)
    if value == "rejected":
        return "rejected"
    if value in {"pending", "approved"}:
        return "approved"
    # Legacy devices created before the approval gate.
    return "approved"


def device_is_approved(device: StoreDevice | None) -> bool:
    return device_approval_status(device) == "approved"
