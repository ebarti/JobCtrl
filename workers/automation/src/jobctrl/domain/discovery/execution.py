"""Discovery execution identity and cohort membership value objects.

One ``DiscoverWorkflow`` execution is identified by its Temporal workflow ID
and Temporal run ID.  Source-family run IDs are deliberately excluded: their
observation rows are mutable and therefore cannot be the authority for
historical execution membership.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from jobctrl.domain.identifiers import JobId


DiscoveryExecutionCohortKind = Literal["observed_this_run", "existing_backlog"]
DiscoveryExecutionWorkPlanState = Literal["pending", "planned", "not_eligible", "failed"]
DiscoveryPreparationStep = Literal["score", "tailor", "cover", "pdf"]

DISCOVERY_EXECUTION_COHORT_KINDS: tuple[DiscoveryExecutionCohortKind, ...] = (
    "observed_this_run",
    "existing_backlog",
)
DISCOVERY_EXECUTION_WORK_PLAN_STATES: tuple[DiscoveryExecutionWorkPlanState, ...] = (
    "pending",
    "planned",
    "not_eligible",
    "failed",
)
DISCOVERY_PREPARATION_STEPS: tuple[DiscoveryPreparationStep, ...] = (
    "score",
    "tailor",
    "cover",
    "pdf",
)

_SAFE_REASON_CODE = re.compile(r"^[a-z0-9][a-z0-9_.:-]{0,79}$")


@dataclass(frozen=True)
class DiscoveryExecutionRef:
    """Serializable immutable identity for one ``DiscoverWorkflow`` run."""

    tenant_id: str
    workflow_id: str
    temporal_run_id: str

    def __post_init__(self) -> None:
        for field_name, value in (
            ("tenant_id", self.tenant_id),
            ("workflow_id", self.workflow_id),
            ("temporal_run_id", self.temporal_run_id),
        ):
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{field_name} must be a non-empty string")

    def safe_summary(self) -> dict[str, str]:
        """Return the bounded identifiers safe for workflow input summaries."""

        return {
            "tenantId": self.tenant_id,
            "workflowId": self.workflow_id,
            "temporalRunId": self.temporal_run_id,
        }


@dataclass(frozen=True)
class DiscoveryExecutionJob:
    """One job's immutable membership and decided work plan in an execution."""

    execution: DiscoveryExecutionRef
    job_id: JobId
    cohort_kind: DiscoveryExecutionCohortKind
    source_family: str | None
    source_run_id: str | None
    preparation_workflow_id: str | None
    work_plan_state: DiscoveryExecutionWorkPlanState
    required_steps: tuple[DiscoveryPreparationStep, ...] | None
    work_plan_reason: str | None
    linked_at: str

    @property
    def required_work_decided(self) -> bool:
        """Whether completion may interpret this row's required-work decision."""

        return self.work_plan_state in {"planned", "not_eligible"}

    @property
    def has_required_work(self) -> bool | None:
        """Return ``None`` while work is undecided or planning failed.

        In particular, a NULL ``required_steps_json`` on ``pending`` or
        ``failed`` is never collapsed into ``False`` / no work.
        """

        if self.work_plan_state == "planned":
            return True
        if self.work_plan_state == "not_eligible":
            return False
        return None


def validate_cohort_kind(value: str) -> DiscoveryExecutionCohortKind:
    if value not in DISCOVERY_EXECUTION_COHORT_KINDS:
        raise ValueError(f"Unknown discovery execution cohort kind: {value}")
    return value  # type: ignore[return-value]


def validate_work_plan_state(value: str) -> DiscoveryExecutionWorkPlanState:
    if value not in DISCOVERY_EXECUTION_WORK_PLAN_STATES:
        raise ValueError(f"Unknown discovery execution work-plan state: {value}")
    return value  # type: ignore[return-value]


def validate_required_steps(steps: list[str] | tuple[str, ...]) -> tuple[DiscoveryPreparationStep, ...]:
    """Return a unique, canonical preparation-step sequence."""

    requested = {str(step) for step in steps}
    invalid = requested.difference(DISCOVERY_PREPARATION_STEPS)
    if invalid:
        raise ValueError(f"Unknown preparation step(s): {', '.join(sorted(invalid))}")
    return tuple(step for step in DISCOVERY_PREPARATION_STEPS if step in requested)


def validate_safe_reason_code(reason: str | None) -> str | None:
    if reason is None:
        return None
    if not _SAFE_REASON_CODE.fullmatch(reason):
        raise ValueError("work_plan_reason must be a bounded safe code")
    return reason
