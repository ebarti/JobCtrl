"""PipelineStateRepository — driven port for persisting JobPipelineState aggregates.

See ddd-target.md S5.7.
"""

from __future__ import annotations

from typing import Protocol

from jobctl.domain.pipeline.aggregate import JobPipelineState
from jobctl.domain.tenant import TenantId


class PipelineStateRepository(Protocol):
    """Port: persist and retrieve JobPipelineState aggregates."""

    def load(self, tenant_id: TenantId, job_url: str) -> JobPipelineState | None:
        """Load the aggregate for *job_url*, or ``None`` if not found."""
        ...

    def save(self, state: JobPipelineState) -> None:
        """Persist the aggregate.

        Increments ``state.version`` and writes all stage rows.
        Raises ``OptimisticLockError`` if the stored version differs from
        ``state.version`` (i.e. another writer modified it concurrently).
        """
        ...

    def list_by_stage(
        self,
        tenant_id: TenantId,
        stage: str,
        state_filter: str | None = None,
    ) -> list[JobPipelineState]:
        """Return aggregates filtered by stage (and optionally by state).

        The *stage* and *state_filter* are lowercase serialized strings
        matching the DB representation.
        """
        ...
