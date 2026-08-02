"""JobPipelineState aggregate — the collection of stage states for one job.

See ddd-target.md S4.7.  Identity: (TenantId, JobId).
The aggregate holds a dict mapping each Stage to its current StageState,
plus a ``version`` counter for optimistic locking (S8.6).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.pipeline_types import (
    Pending,
    Stage,
    StageState,
)
from jobctrl.domain.tenant import TenantId


class OptimisticLockError(Exception):
    """Raised when a save conflicts with a concurrent modification."""

    def __init__(self, job_id: JobId, expected_version: int, actual_version: int) -> None:
        self.job_id = canonical_job_id(str(job_id))
        self.expected_version = expected_version
        self.actual_version = actual_version
        super().__init__(
            f"Optimistic lock conflict on {self.job_id}: expected version {expected_version}, found {actual_version}"
        )


@dataclass
class JobPipelineState:
    """Aggregate root for one job's pipeline progress.

    ``stages`` maps each ``Stage`` to its current ``StageState``.
    ``version`` is bumped on every successful save; callers must
    pass the loaded version back on save so the repository can
    detect conflicts.
    """

    tenant_id: TenantId
    job_id: JobId
    stages: dict[Stage, StageState] = field(default_factory=dict)
    version: int = 0

    def __post_init__(self) -> None:
        self.job_id = canonical_job_id(str(self.job_id))

    # -- convenience helpers --------------------------------------------------

    def get_stage_state(self, stage: Stage) -> StageState:
        """Return the state for *stage*, defaulting to ``Pending()``."""
        return self.stages.get(stage, Pending())

    def set_stage_state(self, stage: Stage, state: StageState) -> None:
        """Mutate the stage state in place (aggregate-internal mutation)."""
        self.stages[stage] = state

    @classmethod
    def new_for_job(cls, tenant_id: TenantId, job_id: JobId) -> JobPipelineState:
        """Create a brand-new aggregate with every stage set to Pending."""
        return cls(
            tenant_id=tenant_id,
            job_id=canonical_job_id(str(job_id)),
            stages={stage: Pending() for stage in Stage},
            version=0,
        )
