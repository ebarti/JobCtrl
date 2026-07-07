"""Shared domain vocabulary for JobCtrl.

Pure data types and value objects — no I/O imports.
"""

from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.pipeline_types import (
    STAGES,
    STAGE_STATE_KINDS,
    Stage,
    StageState,
    Pending,
    Queued,
    Running,
    Succeeded,
    Failed,
    Blocked,
    Skipped,
    Exhausted,
    Stale,
    Canceled,
    serialize_stage,
    deserialize_stage,
    serialize_stage_state,
    deserialize_stage_state_kind,
)
from jobctrl.domain.events import (
    DomainEvent,
    create_domain_event,
)

__all__ = [
    # Tenant
    "TenantId",
    "LOCAL_TENANT",
    # Identifiers
    "JobId",
    # Pipeline
    "STAGES",
    "STAGE_STATE_KINDS",
    "Stage",
    "StageState",
    "Pending",
    "Queued",
    "Running",
    "Succeeded",
    "Failed",
    "Blocked",
    "Skipped",
    "Exhausted",
    "Stale",
    "Canceled",
    "serialize_stage",
    "deserialize_stage",
    "serialize_stage_state",
    "deserialize_stage_state_kind",
    # Events
    "DomainEvent",
    "create_domain_event",
]
