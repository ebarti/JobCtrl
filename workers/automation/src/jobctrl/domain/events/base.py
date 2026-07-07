"""DomainEvent base dataclass.

Every domain event carries the envelope fields (event_type, tenant_id,
occurred_at) plus a payload dict with context-specific data.
Events are immutable facts named in past tense.

See ddd-target.md §2 (Modeling Principles), §6.1 (Integration Backbone).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from jobctrl.domain.tenant import TenantId


@dataclass(frozen=True)
class DomainEvent:
    """Base domain event with envelope fields."""

    event_type: str
    tenant_id: TenantId
    occurred_at: str
    payload: dict[str, Any] = field(default_factory=dict)


def create_domain_event(
    event_type: str,
    tenant_id: TenantId,
    payload: dict[str, Any] | None = None,
    occurred_at: str | None = None,
) -> DomainEvent:
    """Create a domain event with auto-generated occurred_at."""
    return DomainEvent(
        event_type=event_type,
        tenant_id=tenant_id,
        occurred_at=occurred_at or datetime.now(timezone.utc).isoformat(),
        payload=payload or {},
    )
