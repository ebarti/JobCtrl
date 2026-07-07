"""Durable preparation work-item domain model."""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass
from enum import Enum
from typing import Any

from jobctl.domain.identifiers import JobId
from jobctl.domain.tenant import LOCAL_TENANT, TenantId


class PreparationWorkItemKind(str, Enum):
    SCORE_JOB = "score_job"
    TAILOR_RESUME = "tailor_resume"
    SUPPRESS_TAILORED_ARTIFACTS = "suppress_tailored_artifacts"


class PreparationWorkItemState(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass(frozen=True)
class PreparationWorkItem:
    """One restartable internal Discovery-preparation command."""

    tenant_id: TenantId
    item_id: str
    job_id: JobId
    kind: PreparationWorkItemKind
    target_version: int
    source_event_id: str
    state: PreparationWorkItemState
    idempotency_key: str
    attempts: int
    last_error: str
    created_at: str
    updated_at: str
    available_at: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "tenant_id", TenantId(str(self.tenant_id)))
        item_id = str(self.item_id or "").strip()
        if not item_id:
            raise ValueError("PreparationWorkItem.item_id must be non-empty")
        object.__setattr__(self, "item_id", item_id)
        object.__setattr__(self, "job_id", JobId(str(self.job_id)))
        if not isinstance(self.kind, PreparationWorkItemKind):
            object.__setattr__(self, "kind", PreparationWorkItemKind(str(self.kind)))
        version = _int_or_default(self.target_version, 0)
        if version < 0:
            raise ValueError("PreparationWorkItem.target_version must be >= 0")
        object.__setattr__(self, "target_version", version)
        object.__setattr__(self, "source_event_id", str(self.source_event_id or "").strip())
        if not isinstance(self.state, PreparationWorkItemState):
            object.__setattr__(self, "state", PreparationWorkItemState(str(self.state)))
        key = str(self.idempotency_key or "").strip()
        if not key:
            raise ValueError("PreparationWorkItem.idempotency_key must be non-empty")
        object.__setattr__(self, "idempotency_key", key)
        attempts = _int_or_default(self.attempts, 0)
        if attempts < 0:
            raise ValueError("PreparationWorkItem.attempts must be >= 0")
        object.__setattr__(self, "attempts", attempts)
        object.__setattr__(self, "last_error", str(self.last_error or ""))
        for field_name in ("created_at", "updated_at", "available_at"):
            value = str(getattr(self, field_name) or "").strip()
            if not value:
                raise ValueError(f"PreparationWorkItem.{field_name} must be non-empty")
            object.__setattr__(self, field_name, value)

    @classmethod
    def queued(
        cls,
        *,
        tenant_id: TenantId = LOCAL_TENANT,
        job_id: JobId,
        kind: PreparationWorkItemKind,
        target_version: int,
        source_event_id: str = "",
        created_at: str,
        available_at: str | None = None,
        item_id: str | None = None,
        idempotency_key: str | None = None,
    ) -> "PreparationWorkItem":
        key = idempotency_key or make_preparation_idempotency_key(
            tenant_id=tenant_id,
            job_id=job_id,
            kind=kind,
            target_version=target_version,
            source_event_id=source_event_id,
        )
        return cls(
            tenant_id=tenant_id,
            item_id=item_id or uuid.uuid4().hex,
            job_id=job_id,
            kind=kind,
            target_version=target_version,
            source_event_id=source_event_id,
            state=PreparationWorkItemState.QUEUED,
            idempotency_key=key,
            attempts=0,
            last_error="",
            created_at=created_at,
            updated_at=created_at,
            available_at=available_at or created_at,
        )


def make_preparation_idempotency_key(
    *,
    tenant_id: TenantId,
    job_id: JobId,
    kind: PreparationWorkItemKind,
    target_version: int,
    source_event_id: str = "",
) -> str:
    payload: dict[str, Any] = {
        "tenant_id": str(tenant_id),
        "job_id": str(job_id),
        "kind": PreparationWorkItemKind(kind).value,
        "target_version": int(target_version),
        "source_event_id": str(source_event_id or ""),
    }
    digest = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return f"preparation:{digest}"


def _int_or_default(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


__all__ = [
    "PreparationWorkItem",
    "PreparationWorkItemKind",
    "PreparationWorkItemState",
    "make_preparation_idempotency_key",
]
