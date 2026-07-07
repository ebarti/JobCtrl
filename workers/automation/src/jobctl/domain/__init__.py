"""Shared domain vocabulary for JobCtl.

Pure data types and value objects — no I/O imports.
"""

from jobctl.domain.tenant import LOCAL_TENANT, TenantId
from jobctl.domain.identifiers import JobId
from jobctl.domain.pipeline_types import (
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
from jobctl.domain.events import (
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
