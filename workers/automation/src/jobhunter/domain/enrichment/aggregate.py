"""JobEnrichment aggregate root.

See ddd-target.md §4.2. ``JobEnrichment`` is the canonical fact about
the enrichment lifecycle for one ``(TenantId, JobId)`` pair. It owns a
list of ``EnrichmentAttempt`` child entities and transitions through
``pending → running → enriched | failed`` per §4.2.

Invariants enforced here:

  * At most one attempt may be ``Running`` at a time (per §4.2 — the
    aggregate boundary is what enforces this; multiple aggregate
    instances cannot exist for the same JobId because the repository
    keys on ``(tenant_id, job_id)``).
  * ``ExtractionTier`` is recorded on every attempt (provenance).
  * Once any attempt succeeds, the aggregate is ``enriched`` and the
    ``full_description`` / ``application_url`` value objects are
    populated. Subsequent attempts are rejected unless ``reset()`` is
    called explicitly.
  * Attempt numbers are monotonically increasing per aggregate (1, 2, …).

The aggregate is immutable; lifecycle helpers return new instances.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any

from jobhunter.domain.enrichment.entities import (
    AttemptStatus,
    EnrichmentAttempt,
)
from jobhunter.domain.enrichment.value_objects import (
    ApplicationUrl,
    EnrichmentError,
    ExtractionTier,
    FullDescription,
)
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.tenant import TenantId


class EnrichmentLifecycle:
    """Pseudo-enum of the four §4.2 aggregate states.

    Implemented as bare string constants so the SQLite adapter
    round-trips without an extra converter and the aggregate's
    ``current_status`` field stays plain ``str``.
    """

    PENDING = "pending"
    RUNNING = "running"
    ENRICHED = "enriched"
    FAILED = "failed"


_VALID_STATUSES: frozenset[str] = frozenset(
    {
        EnrichmentLifecycle.PENDING,
        EnrichmentLifecycle.RUNNING,
        EnrichmentLifecycle.ENRICHED,
        EnrichmentLifecycle.FAILED,
    }
)


# Re-export ``EnrichmentLifecycle`` under a typed alias for callers that
# want a concrete annotation (the strings stay the canonical wire form).
EnrichmentStatus = str


@dataclass(frozen=True)
class JobEnrichment:
    """Aggregate root capturing the enrichment lifecycle for one job.

    Identity: ``(tenant_id, job_id)``. The repository keys on the same
    pair, ensuring a single aggregate instance per job — the foundation
    for the §4.2 "at most one Running attempt" invariant.

    ``attempts`` is the ordered tuple of all attempts so far; the latest
    entry's status carries the same intent as ``current_status``
    (terminal succeed/fail) but is duplicated for query ergonomics.
    """

    tenant_id: TenantId
    job_id: JobId
    current_status: EnrichmentStatus = EnrichmentLifecycle.PENDING
    attempts: tuple[EnrichmentAttempt, ...] = field(default_factory=tuple)
    full_description: FullDescription | None = None
    application_url: ApplicationUrl | None = None
    enriched_at: str | None = None
    extraction_tier: ExtractionTier | None = None
    updated_at: str = ""

    # ------------------------------------------------------------------
    # Invariants
    # ------------------------------------------------------------------

    def __post_init__(self) -> None:
        if self.current_status not in _VALID_STATUSES:
            raise ValueError(
                f"JobEnrichment.current_status must be one of {_VALID_STATUSES!r}, "
                f"got {self.current_status!r}"
            )
        if not isinstance(self.attempts, tuple):
            raise ValueError("JobEnrichment.attempts must be a tuple")

        running_attempts = [a for a in self.attempts if a.running]
        if len(running_attempts) > 1:
            raise ValueError(
                "JobEnrichment may have AT MOST one Running attempt "
                f"(found {len(running_attempts)})"
            )

        # Numbering must be monotonic 1..N (per §4.2 attempt_number is
        # monotonic per aggregate).
        for index, attempt in enumerate(self.attempts, start=1):
            if attempt.attempt_number != index:
                raise ValueError(
                    "JobEnrichment.attempts must be numbered 1..N, "
                    f"position {index} has attempt_number={attempt.attempt_number}"
                )

        # Terminal-state coherence
        if self.current_status == EnrichmentLifecycle.ENRICHED:
            if self.full_description is None:
                raise ValueError(
                    "JobEnrichment.full_description must be set when status == enriched"
                )
            if self.enriched_at is None or not self.enriched_at.strip():
                raise ValueError(
                    "JobEnrichment.enriched_at must be set when status == enriched"
                )
            if self.extraction_tier is None:
                raise ValueError(
                    "JobEnrichment.extraction_tier must be set when status == enriched"
                )

    # ------------------------------------------------------------------
    # Construction helpers
    # ------------------------------------------------------------------

    @classmethod
    def empty(cls, *, tenant_id: TenantId, job_id: JobId, updated_at: str) -> "JobEnrichment":
        """Create a fresh aggregate in the ``pending`` state."""
        return cls(
            tenant_id=tenant_id,
            job_id=job_id,
            current_status=EnrichmentLifecycle.PENDING,
            attempts=(),
            full_description=None,
            application_url=None,
            enriched_at=None,
            extraction_tier=None,
            updated_at=updated_at,
        )

    # ------------------------------------------------------------------
    # Lifecycle transitions — each returns a NEW JobEnrichment
    # ------------------------------------------------------------------

    def start_attempt(
        self,
        *,
        extraction_tier: ExtractionTier,
        started_at: str,
    ) -> "JobEnrichment":
        """Open a new running attempt.

        Rejects the call if there is already a running attempt OR if
        the aggregate is already ``enriched``. The orchestrator must
        ``reset()`` an enriched aggregate before starting a new
        extraction round.
        """
        if self.current_status == EnrichmentLifecycle.ENRICHED:
            raise ValueError(
                "JobEnrichment is already enriched; call reset() before starting again"
            )
        if any(a.running for a in self.attempts):
            raise ValueError(
                "JobEnrichment already has a Running attempt; finish it first"
            )
        next_number = len(self.attempts) + 1
        attempt = EnrichmentAttempt(
            attempt_number=next_number,
            extraction_tier=extraction_tier,
            status=AttemptStatus.RUNNING,
            started_at=started_at,
            finished_at=None,
            error=None,
        )
        return replace(
            self,
            current_status=EnrichmentLifecycle.RUNNING,
            attempts=self.attempts + (attempt,),
            updated_at=started_at,
        )

    def succeed_attempt(
        self,
        *,
        full_description: FullDescription,
        application_url: ApplicationUrl | None,
        extraction_tier: ExtractionTier,
        finished_at: str,
    ) -> "JobEnrichment":
        """Close the running attempt as succeeded and mark the aggregate enriched.

        ``extraction_tier`` is the tier that ACTUALLY succeeded (the
        cascade may try Tier 1 → Tier 2 → Tier 3, then succeed at
        Tier 3 — that's what is recorded). The running attempt's
        ``extraction_tier`` is overwritten with this value to keep the
        record honest.
        """
        if not self.attempts or not self.attempts[-1].running:
            raise ValueError(
                "succeed_attempt called without a Running attempt; "
                "call start_attempt first"
            )
        last = self.attempts[-1]
        finalised = EnrichmentAttempt(
            attempt_number=last.attempt_number,
            extraction_tier=extraction_tier,
            status=AttemptStatus.SUCCEEDED,
            started_at=last.started_at,
            finished_at=finished_at,
            error=None,
        )
        return replace(
            self,
            current_status=EnrichmentLifecycle.ENRICHED,
            attempts=self.attempts[:-1] + (finalised,),
            full_description=full_description,
            application_url=application_url,
            enriched_at=finished_at,
            extraction_tier=extraction_tier,
            updated_at=finished_at,
        )

    def fail_attempt(
        self,
        *,
        error: EnrichmentError,
        finished_at: str,
    ) -> "JobEnrichment":
        """Close the running attempt as failed.

        The aggregate transitions to ``failed`` (it stays open for
        retry — call ``start_attempt`` again to enqueue another
        attempt). The original tier the attempt was opened against is
        preserved on the failed record.
        """
        if not self.attempts or not self.attempts[-1].running:
            raise ValueError(
                "fail_attempt called without a Running attempt; "
                "call start_attempt first"
            )
        last = self.attempts[-1]
        finalised = EnrichmentAttempt(
            attempt_number=last.attempt_number,
            extraction_tier=last.extraction_tier,
            status=AttemptStatus.FAILED,
            started_at=last.started_at,
            finished_at=finished_at,
            error=error,
        )
        return replace(
            self,
            current_status=EnrichmentLifecycle.FAILED,
            attempts=self.attempts[:-1] + (finalised,),
            updated_at=finished_at,
        )

    def reset(self, *, reset_at: str) -> "JobEnrichment":
        """Discard the success state so a fresh extraction round can start.

        Used by orchestration when the user explicitly retries an
        already-enriched job. The attempt history is preserved (audit
        trail) — only the terminal-state fields are cleared.
        """
        return replace(
            self,
            current_status=EnrichmentLifecycle.PENDING,
            full_description=None,
            application_url=None,
            enriched_at=None,
            extraction_tier=None,
            updated_at=reset_at,
        )

    def backfill_application_url(
        self,
        *,
        application_url: ApplicationUrl,
        updated_at: str,
    ) -> "JobEnrichment":
        """Attach a recovered apply URL to an already-enriched aggregate.

        Used when an authenticated follow-up recovers the external apply
        target for a job that was enriched without one. Only
        ``application_url`` changes; ``full_description``, the ``enriched``
        status, ``enriched_at``, the extraction tier, and the attempt
        history are all preserved, so a failed or empty recovery can never
        destroy reviewable material.
        """
        if self.current_status != EnrichmentLifecycle.ENRICHED:
            raise ValueError(
                "backfill_application_url requires an enriched aggregate"
            )
        return replace(
            self,
            application_url=application_url,
            updated_at=updated_at,
        )

    # ------------------------------------------------------------------
    # Predicates
    # ------------------------------------------------------------------

    @property
    def is_enriched(self) -> bool:
        return self.current_status == EnrichmentLifecycle.ENRICHED

    @property
    def is_pending(self) -> bool:
        return self.current_status == EnrichmentLifecycle.PENDING

    @property
    def is_running(self) -> bool:
        return self.current_status == EnrichmentLifecycle.RUNNING

    @property
    def is_failed(self) -> bool:
        return self.current_status == EnrichmentLifecycle.FAILED

    @property
    def attempt_count(self) -> int:
        return len(self.attempts)

    @property
    def last_attempt(self) -> EnrichmentAttempt | None:
        return self.attempts[-1] if self.attempts else None

    # ------------------------------------------------------------------
    # Serialisation (used by the SQLite adapter)
    # ------------------------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        return {
            "tenant_id": str(self.tenant_id),
            "job_id": str(self.job_id),
            "current_status": self.current_status,
            "attempts": [a.to_dict() for a in self.attempts],
            "full_description": (
                self.full_description.text if self.full_description else None
            ),
            "application_url": (
                self.application_url.value if self.application_url else None
            ),
            "enriched_at": self.enriched_at,
            "extraction_tier": (
                self.extraction_tier.value if self.extraction_tier else None
            ),
            "updated_at": self.updated_at,
        }
