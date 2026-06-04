"""Driven ports for Pipeline Preparation work items."""

from __future__ import annotations

from typing import Protocol

from jobhunter.domain.identifiers import JobId
from jobhunter.domain.preparation import (
    PreparationWorkItem,
    PreparationWorkItemKind,
)
from jobhunter.domain.tenant import TenantId


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

    def claim_next(
        self,
        *,
        tenant_id: TenantId,
        kind: PreparationWorkItemKind | None = None,
        now: str | None = None,
    ) -> PreparationWorkItem | None:
        """Claim the next available queued item and increment its attempts."""
        ...

    def complete(
        self,
        *,
        tenant_id: TenantId,
        item_id: str,
        completed_at: str | None = None,
    ) -> PreparationWorkItem | None:
        """Mark a claimed item completed."""
        ...

    def fail(
        self,
        *,
        tenant_id: TenantId,
        item_id: str,
        error: str,
        failed_at: str | None = None,
        retry_at: str | None = None,
    ) -> PreparationWorkItem | None:
        """Mark a claimed item failed without deleting it."""
        ...

    def retry(
        self,
        *,
        tenant_id: TenantId,
        item_id: str,
        available_at: str | None = None,
        retried_at: str | None = None,
    ) -> PreparationWorkItem | None:
        """Move a failed item back to the queued state."""
        ...

    def recover_running(
        self,
        *,
        tenant_id: TenantId,
        item_id: str,
        available_at: str | None = None,
        recovered_at: str | None = None,
        reason: str = "",
    ) -> PreparationWorkItem | None:
        """Move an orphaned running item back to the queued state."""
        ...


__all__ = ["PreparationWorkItemRepository"]
