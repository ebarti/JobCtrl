"""Driven ports for the Scoring context.

See ddd-target.md §5.4 (``ScoreRepository``, ``LlmPort``).

This module re-exports ``LlmPort`` from its canonical home in
``jobhunter.domain.ports.llm`` for callers that want a single Scoring-
context import; the LLM port itself is shared with Materials and Apply
contexts.
"""

from __future__ import annotations

from typing import Protocol

from jobhunter.domain.identifiers import JobId
from jobhunter.domain.scoring.aggregate import JobScore
from jobhunter.domain.scoring.policy import ScoringPolicy
from jobhunter.domain.tenant import TenantId

# Re-export the shared LLM port — Scoring is one of its consumers.
from jobhunter.domain.ports.llm import LlmMessage, LlmPort, LlmRole

__all__ = [
    "ScoreRepository",
    "ScoringPolicyRepository",
    "LlmPort",
    "LlmMessage",
    "LlmRole",
]


class ScoreRepository(Protocol):
    """Persistence port for the ``JobScore`` aggregate.

    All methods are tenant-scoped. Local adapters accept ``tenant_id`` and
    ignore it (single-tenant); hosted adapters use it for row isolation.

    Versioning contract:

      * ``save`` enforces that ``score.version`` is exactly one greater
        than the latest persisted version for ``(tenant_id, job_id)``,
        or ``1`` when none exists. Skipping a version raises
        ``ValueError`` so callers cannot silently overwrite history.
      * ``load`` returns the LATEST version (the canonical current
        score). Older versions remain in the table for audit and may be
        surfaced through ``list_versions`` once cloud rollout calls for
        it.
    """

    def load(self, tenant_id: TenantId, job_id: JobId) -> JobScore | None:
        """Return the latest persisted ``JobScore``, or ``None``."""
        ...

    def save(self, score: JobScore) -> None:
        """Persist a new ``JobScore`` version.

        The repository is responsible for ensuring uniqueness on
        ``(tenant_id, job_id, version)``. Callers obtain the next version
        either by calling ``next_version()`` on a loaded aggregate or by
        starting at version=1 via ``JobScore.initial``.
        """
        ...

    def list_pending(self, tenant_id: TenantId, *, limit: int = 0) -> list[JobId]:
        """Return ``JobId``s that have a description but no score yet.

        ``limit=0`` means no upper bound. Implementations may join against
        the ``jobs`` table to discover pending work; the public contract is
        only that the returned IDs are scorable.
        """
        ...

    def list_by_score_range(
        self,
        tenant_id: TenantId,
        *,
        min_score: int,
        max_score: int = 10,
    ) -> list[JobScore]:
        """Return latest-version scores whose ``fit_score`` is within range."""
        ...


class ScoringPolicyRepository(Protocol):
    """Persistence port for the current versioned scoring policy."""

    def get_current(self, tenant_id: TenantId) -> ScoringPolicy:
        """Return the current ``ScoringPolicy`` for the tenant.

        Implementations may synthesize and persist the default policy when
        none exists yet.
        """
        ...

    def save(self, policy: ScoringPolicy) -> None:
        """Persist a ``ScoringPolicy`` version."""
        ...
