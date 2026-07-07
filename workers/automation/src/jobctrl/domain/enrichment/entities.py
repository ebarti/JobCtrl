"""Enrichment child entity — ``EnrichmentAttempt``.

See ddd-target.md §4.2. ``EnrichmentAttempt`` is a non-root entity owned
by the ``JobEnrichment`` aggregate. Each attempt corresponds to one
invocation of the three-tier extraction cascade. The aggregate enforces
the "at most one Running attempt" invariant; the entity itself is just
a frozen record.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any

from jobctrl.domain.enrichment.value_objects import (
    EnrichmentError,
    ExtractionTier,
)


class AttemptStatus(str, Enum):
    """Lifecycle of one enrichment attempt.

    Per §4.2: ``Running`` → ``Succeeded`` | ``Failed``. The terminal
    states are written when ``finished_at`` is set; ``Running`` carries
    a non-null ``started_at`` and a null ``finished_at``.
    """

    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"

    @classmethod
    def from_optional(cls, value: Any) -> "AttemptStatus | None":
        if value is None:
            return None
        text = str(value).strip().lower()
        if not text:
            return None
        for member in cls:
            if member.value == text:
                return member
        return None


@dataclass(frozen=True)
class EnrichmentAttempt:
    """One round of the three-tier extraction cascade.

    Per §4.2:

      attempt_number   — monotonic per (tenant_id, job_id), starting at 1.
      extraction_tier  — which tier was used (or attempted last).
      status           — running / succeeded / failed.
      started_at       — ISO-8601 timestamp the attempt started.
      finished_at      — ISO-8601 timestamp the attempt finished
                         (None when status == running).
      error            — populated only when status == failed.
    """

    attempt_number: int
    extraction_tier: ExtractionTier
    status: AttemptStatus
    started_at: str
    finished_at: str | None = None
    error: EnrichmentError | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.attempt_number, int) or self.attempt_number < 1:
            raise ValueError(
                f"EnrichmentAttempt.attempt_number must be >= 1, got {self.attempt_number!r}"
            )
        if not isinstance(self.extraction_tier, ExtractionTier):
            raise ValueError("EnrichmentAttempt.extraction_tier must be an ExtractionTier")
        if not isinstance(self.status, AttemptStatus):
            raise ValueError("EnrichmentAttempt.status must be an AttemptStatus")
        if not isinstance(self.started_at, str) or not self.started_at.strip():
            raise ValueError(
                "EnrichmentAttempt.started_at must be a non-empty ISO-8601 timestamp"
            )
        if self.status is AttemptStatus.RUNNING and self.finished_at is not None:
            raise ValueError(
                "EnrichmentAttempt.finished_at must be None when status == running"
            )
        if self.status is not AttemptStatus.RUNNING and (
            self.finished_at is None or not self.finished_at.strip()
        ):
            raise ValueError(
                "EnrichmentAttempt.finished_at must be a non-empty timestamp when terminal"
            )
        if self.status is AttemptStatus.FAILED and self.error is None:
            raise ValueError("EnrichmentAttempt.error must be set when status == failed")
        if self.status is not AttemptStatus.FAILED and self.error is not None:
            raise ValueError(
                "EnrichmentAttempt.error must be None unless status == failed"
            )

    # ------------------------------------------------------------------
    # Convenience
    # ------------------------------------------------------------------

    @property
    def succeeded(self) -> bool:
        return self.status is AttemptStatus.SUCCEEDED

    @property
    def failed(self) -> bool:
        return self.status is AttemptStatus.FAILED

    @property
    def running(self) -> bool:
        return self.status is AttemptStatus.RUNNING

    def to_dict(self) -> dict[str, Any]:
        return {
            "attempt_number": self.attempt_number,
            "extraction_tier": self.extraction_tier.value,
            "status": self.status.value,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "error": self.error.to_dict() if self.error else None,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "EnrichmentAttempt":
        tier = ExtractionTier.from_optional(data.get("extraction_tier"))
        if tier is None:
            raise ValueError(
                f"EnrichmentAttempt: unknown extraction_tier {data.get('extraction_tier')!r}"
            )
        status = AttemptStatus.from_optional(data.get("status"))
        if status is None:
            raise ValueError(
                f"EnrichmentAttempt: unknown status {data.get('status')!r}"
            )
        error_data = data.get("error")
        error = (
            EnrichmentError(
                code=str(error_data.get("code", "")),
                message=str(error_data.get("message", "")),
                retryable=bool(error_data.get("retryable", True)),
            )
            if error_data
            else None
        )
        return cls(
            attempt_number=int(data["attempt_number"]),
            extraction_tier=tier,
            status=status,
            started_at=str(data["started_at"]),
            finished_at=(
                str(data["finished_at"]) if data.get("finished_at") is not None else None
            ),
            error=error,
        )
