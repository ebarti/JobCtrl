"""Driven ports for Pipeline Preparation work items."""

from __future__ import annotations

from typing import Protocol

from jobctl.domain.identifiers import JobId
from jobctl.domain.preparation import (
    PreparationWorkItem,
    PreparationWorkItemKind,
)
from jobctl.domain.tenant import TenantId


class PreparationWorkItemRepository(Protocol):
    """Persistence port for durable internal preparation work items."""

    def enqueue(
        self,
        *,
        tenant_id: TenantId,
        job_id: JobId,
        kind: PreparationWorkItemKind,
        target_version: int,
        source_event_id: str = "",
        available_at: str | None = None,
        now: str | None = None,
    ) -> PreparationWorkItem:
        """Create or return the existing idempotent queued work item."""
        ...


__all__ = ["PreparationWorkItemRepository"]
