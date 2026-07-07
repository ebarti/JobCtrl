"""Pipeline Orchestration use cases — driving ports.

See ddd-target.md S5.7 for CancelStageUseCase, RetryStageUseCase.
No event publication yet (Phase 3 territory).
"""

from __future__ import annotations

from jobctrl.domain.pipeline.repository import PipelineStateRepository
from jobctrl.domain.pipeline.state_machine import (
    StageTransition,
    TransitionRejected,
    transition,
)
from jobctrl.domain.pipeline_types import (
    deserialize_stage,
    serialize_stage_state,
)
from jobctrl.domain.tenant import TenantId


class StageNotFoundError(Exception):
    """Raised when the target job has no pipeline state."""


class CancelStageUseCase:
    """Cancel a stage that is Queued or Running.

    Invokes the state machine with ``Cancel`` trigger, persists via repository.
    """

    def __init__(self, repository: PipelineStateRepository) -> None:
        self._repo = repository

    def execute(
        self,
        tenant_id: TenantId,
        job_url: str,
        stage: str,
        *,
        canceled_at: str = "",
        reason: str | None = None,
    ) -> str:
        """Cancel the given stage.

        Returns the new serialized state string on success.
        Raises ``StageNotFoundError`` if no aggregate exists.
        Raises ``ValueError`` if the transition is rejected.
        """
        agg = self._repo.load(tenant_id, job_url)
        if agg is None:
            raise StageNotFoundError(f"No pipeline state for {job_url}")

        domain_stage = deserialize_stage(stage)
        current = agg.get_stage_state(domain_stage)

        result = transition(
            current,
            StageTransition.Cancel,
            canceled_at=canceled_at,
            reason=reason,
        )
        if isinstance(result, TransitionRejected):
            raise ValueError(result.reason)

        agg.set_stage_state(domain_stage, result)
        self._repo.save(agg)
        return serialize_stage_state(result)


class RetryStageUseCase:
    """Retry (reset) a stage that is in Failed, Exhausted, Canceled, or Stale.

    Invokes the state machine with ``Reset`` trigger, persists via repository.
    """

    def __init__(self, repository: PipelineStateRepository) -> None:
        self._repo = repository

    def execute(
        self,
        tenant_id: TenantId,
        job_url: str,
        stage: str,
        *,
        reset_attempts: bool = False,
        next_action: str | None = None,
    ) -> str:
        """Reset the given stage to Pending.

        Returns the new serialized state string on success.
        Raises ``StageNotFoundError`` if no aggregate exists.
        Raises ``ValueError`` if the transition is rejected.
        """
        agg = self._repo.load(tenant_id, job_url)
        if agg is None:
            raise StageNotFoundError(f"No pipeline state for {job_url}")

        domain_stage = deserialize_stage(stage)
        current = agg.get_stage_state(domain_stage)

        result = transition(
            current,
            StageTransition.Reset,
            reset_attempts=reset_attempts,
            next_action=next_action,
        )
        if isinstance(result, TransitionRejected):
            raise ValueError(result.reason)

        agg.set_stage_state(domain_stage, result)
        self._repo.save(agg)
        return serialize_stage_state(result)
