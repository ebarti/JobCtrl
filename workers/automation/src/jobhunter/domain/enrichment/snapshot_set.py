"""PostingSnapshotSet aggregate.

See RFC §"Domain Model Additions" and §"Content Acquisition Pipeline".

``PostingSnapshotSet`` is the Enrichment-owned aggregate that captures
the recurring detail-refresh, active-state, and content-dedupe
lifecycle for one ``(TenantId, JobId)`` posting *without* changing the
``JobEnrichment`` terminal ``Enriched`` invariant.

Invariants enforced here:

  * ``snapshots`` is monotonic 1..N, identified by ``snapshot_version``.
  * ``latest_active_state`` matches the active state on the most recent
    snapshot.
  * The aggregate is immutable; lifecycle helpers return new instances.

Lifecycle methods on the aggregate cover the four PR3 events:

  * ``record_snapshot`` — append a fresh ``PostingContentSnapshot``;
    callers translate this into ``PostingContentSnapshotCaptured``.
  * ``record_capture_failure`` — record a failed capture attempt
    without producing a snapshot; callers translate this into
    ``PostingContentSnapshotFailed``. Failures do not bump the
    snapshot counter.
  * ``mark_active_state`` — update the latest snapshot's active state
    only (no new content); callers emit ``JobActiveStateChanged`` if
    the state changed.
  * ``record_duplicate_candidate`` — register a content-duplicate
    candidate against another job; callers emit
    ``ContentDuplicateCandidateDetected``. The candidates are stored
    on the aggregate so the next read can list pending duplicate
    candidates without consulting an event log.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any

from jobhunter.domain.enrichment.snapshot_value_objects import (
    ActiveState,
    DuplicateEvidence,
    PostingContentSnapshot,
    QuarantineReason,
)
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.tenant import TenantId


# ---------------------------------------------------------------------------
# Failure metadata
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SnapshotCaptureFailure:
    """Per-attempt failure recorded on the aggregate.

    Failures don't bump the snapshot counter; they accumulate as a
    parallel history so Operations can build retry-policy projections
    without listening to events alone.
    """

    error_class: str
    message: str
    retryable: bool
    failed_at: str
    source_id: str

    def __post_init__(self) -> None:
        if not isinstance(self.error_class, str) or not self.error_class.strip():
            raise ValueError(
                "SnapshotCaptureFailure.error_class must be a non-empty string"
            )
        if not isinstance(self.message, str):
            raise ValueError("SnapshotCaptureFailure.message must be a string")
        if not isinstance(self.retryable, bool):
            raise ValueError("SnapshotCaptureFailure.retryable must be a bool")
        if not isinstance(self.failed_at, str) or not self.failed_at.strip():
            raise ValueError(
                "SnapshotCaptureFailure.failed_at must be a non-empty timestamp"
            )
        if not isinstance(self.source_id, str) or not self.source_id.strip():
            raise ValueError(
                "SnapshotCaptureFailure.source_id must be a non-empty string"
            )

    def to_dict(self) -> dict[str, Any]:
        return {
            "error_class": self.error_class,
            "message": self.message,
            "retryable": self.retryable,
            "failed_at": self.failed_at,
            "source_id": self.source_id,
        }


# ---------------------------------------------------------------------------
# Duplicate candidate
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ContentDuplicateCandidate:
    """A pending content-duplicate candidate held on the aggregate.

    Discovery confirms or rejects the link via ``DuplicateJobLink``.
    Until then, this record carries enough evidence for the dedupe
    queue UI to surface the pairing.
    """

    candidate_job_id: str
    evidence: tuple[DuplicateEvidence, ...]
    confidence: float
    detected_at: str

    def __post_init__(self) -> None:
        if not isinstance(self.candidate_job_id, str) or not self.candidate_job_id.strip():
            raise ValueError(
                "ContentDuplicateCandidate.candidate_job_id must be a non-empty string"
            )
        if not isinstance(self.evidence, tuple) or not self.evidence:
            raise ValueError(
                "ContentDuplicateCandidate.evidence must be a non-empty tuple"
            )
        for item in self.evidence:
            if not isinstance(item, DuplicateEvidence):
                raise ValueError(
                    "ContentDuplicateCandidate.evidence items must be DuplicateEvidence"
                )
        if not 0.0 <= self.confidence <= 1.0:
            raise ValueError(
                "ContentDuplicateCandidate.confidence must be between 0 and 1"
            )
        if not isinstance(self.detected_at, str) or not self.detected_at.strip():
            raise ValueError(
                "ContentDuplicateCandidate.detected_at must be a non-empty timestamp"
            )

    def to_dict(self) -> dict[str, Any]:
        return {
            "candidate_job_id": self.candidate_job_id,
            "evidence": [
                {
                    "kind": e.kind.value,
                    "matched_value": e.matched_value,
                    "confidence": e.confidence,
                }
                for e in self.evidence
            ],
            "confidence": self.confidence,
            "detected_at": self.detected_at,
        }


# ---------------------------------------------------------------------------
# Aggregate root
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PostingSnapshotSet:
    """Enrichment-owned aggregate of versioned content snapshots.

    Identity: ``(tenant_id, job_id)``. The aggregate keeps a strictly
    monotonic snapshot history, an active-state cache, the failure
    log, and pending content-duplicate candidates.

    The aggregate's invariants are intentionally narrower than
    ``JobEnrichment``: snapshots may continue to accumulate after a
    successful first capture, and recurring active-state transitions
    are NOT lifecycle terminals — only the per-snapshot record is
    immutable once written.
    """

    tenant_id: TenantId
    job_id: JobId
    snapshots: tuple[PostingContentSnapshot, ...] = field(default_factory=tuple)
    failures: tuple[SnapshotCaptureFailure, ...] = field(default_factory=tuple)
    duplicate_candidates: tuple[ContentDuplicateCandidate, ...] = field(default_factory=tuple)
    latest_active_state: ActiveState = ActiveState.UNKNOWN
    updated_at: str = ""

    # ------------------------------------------------------------------
    # Invariants
    # ------------------------------------------------------------------

    def __post_init__(self) -> None:
        if not isinstance(self.snapshots, tuple):
            raise ValueError("PostingSnapshotSet.snapshots must be a tuple")
        if not isinstance(self.failures, tuple):
            raise ValueError("PostingSnapshotSet.failures must be a tuple")
        if not isinstance(self.duplicate_candidates, tuple):
            raise ValueError(
                "PostingSnapshotSet.duplicate_candidates must be a tuple"
            )
        if not isinstance(self.latest_active_state, ActiveState):
            raise ValueError(
                "PostingSnapshotSet.latest_active_state must be an ActiveState"
            )
        for index, snapshot in enumerate(self.snapshots, start=1):
            if snapshot.snapshot_version != index:
                raise ValueError(
                    "PostingSnapshotSet.snapshots must be numbered 1..N, "
                    f"position {index} has snapshot_version={snapshot.snapshot_version}"
                )
        if self.snapshots:
            tail_state = self.snapshots[-1].active_state
            if tail_state is not self.latest_active_state:
                raise ValueError(
                    "PostingSnapshotSet.latest_active_state must equal the most "
                    f"recent snapshot's active_state ({tail_state.value!r}, "
                    f"got {self.latest_active_state.value!r})"
                )

    # ------------------------------------------------------------------
    # Construction helpers
    # ------------------------------------------------------------------

    @classmethod
    def empty(
        cls,
        *,
        tenant_id: TenantId,
        job_id: JobId,
        updated_at: str,
    ) -> "PostingSnapshotSet":
        """Create a fresh aggregate with no snapshots yet."""
        return cls(
            tenant_id=tenant_id,
            job_id=job_id,
            snapshots=(),
            failures=(),
            duplicate_candidates=(),
            latest_active_state=ActiveState.UNKNOWN,
            updated_at=updated_at,
        )

    # ------------------------------------------------------------------
    # Lifecycle transitions — each returns a NEW aggregate
    # ------------------------------------------------------------------

    def record_snapshot(
        self,
        *,
        source_id: str,
        extraction_tier: str,
        description_hash: object,  # SnapshotDescriptionHash
        apply_url: object | None,  # SnapshotApplyUrl | None
        active_state: ActiveState,
        confidence: object,  # SnapshotConfidence
        quarantine_reason: QuarantineReason,
        captured_at: str,
        raw_text_hash: str = "",
        filter_override: object | None = None,  # FilterOverrideAudit | None
        evidence: tuple[str, ...] = (),
    ) -> tuple["PostingSnapshotSet", PostingContentSnapshot]:
        """Append a new snapshot.

        Returns ``(new_aggregate, snapshot)``. The snapshot version is
        derived from the current count + 1. The aggregate's
        ``latest_active_state`` is updated to the snapshot's
        ``active_state``.
        """
        snapshot = PostingContentSnapshot(
            snapshot_version=len(self.snapshots) + 1,
            source_id=source_id,
            extraction_tier=extraction_tier,
            description_hash=description_hash,  # type: ignore[arg-type]
            apply_url=apply_url,  # type: ignore[arg-type]
            active_state=active_state,
            confidence=confidence,  # type: ignore[arg-type]
            quarantine_reason=quarantine_reason,
            captured_at=captured_at,
            raw_text_hash=raw_text_hash,
            filter_override=filter_override,  # type: ignore[arg-type]
            evidence=evidence,
        )
        new_agg = replace(
            self,
            snapshots=self.snapshots + (snapshot,),
            latest_active_state=snapshot.active_state,
            updated_at=captured_at,
        )
        return new_agg, snapshot

    def record_capture_failure(
        self,
        *,
        source_id: str,
        error_class: str,
        message: str,
        retryable: bool,
        failed_at: str,
    ) -> tuple["PostingSnapshotSet", SnapshotCaptureFailure]:
        """Record a failure without bumping the snapshot counter."""
        failure = SnapshotCaptureFailure(
            error_class=error_class,
            message=message,
            retryable=retryable,
            failed_at=failed_at,
            source_id=source_id,
        )
        new_agg = replace(
            self,
            failures=self.failures + (failure,),
            updated_at=failed_at,
        )
        return new_agg, failure

    def mark_active_state(
        self,
        *,
        active_state: ActiveState,
        verified_at: str,
    ) -> tuple["PostingSnapshotSet", ActiveState | None]:
        """Update the aggregate's active state without a new snapshot.

        Returns ``(new_aggregate, previous_state)`` when the state
        actually changes; returns ``(self, None)`` when the new state
        equals the current one (idempotent).

        If snapshots exist, the most recent snapshot's ``active_state``
        is also rewritten to the new value so the aggregate invariant
        ("``latest_active_state`` matches the tail snapshot")
        continues to hold.
        """
        if active_state is self.latest_active_state:
            return self, None
        previous = self.latest_active_state
        if self.snapshots:
            tail = self.snapshots[-1]
            new_tail = replace(tail, active_state=active_state)
            new_snapshots = self.snapshots[:-1] + (new_tail,)
        else:
            new_snapshots = self.snapshots
        new_agg = replace(
            self,
            snapshots=new_snapshots,
            latest_active_state=active_state,
            updated_at=verified_at,
        )
        return new_agg, previous

    def record_duplicate_candidate(
        self,
        *,
        candidate: ContentDuplicateCandidate,
    ) -> "PostingSnapshotSet":
        """Append a duplicate candidate.

        Idempotent on ``(candidate_job_id)``: if the same candidate is
        already present we keep the existing record and return self.
        Discovery confirms or rejects via ``DuplicateJobLink``.
        """
        for existing in self.duplicate_candidates:
            if existing.candidate_job_id == candidate.candidate_job_id:
                return self
        return replace(
            self,
            duplicate_candidates=self.duplicate_candidates + (candidate,),
            updated_at=candidate.detected_at,
        )

    # ------------------------------------------------------------------
    # Predicates
    # ------------------------------------------------------------------

    @property
    def snapshot_count(self) -> int:
        return len(self.snapshots)

    @property
    def latest_snapshot(self) -> PostingContentSnapshot | None:
        return self.snapshots[-1] if self.snapshots else None

    @property
    def has_quarantined_snapshot(self) -> bool:
        return any(s.is_quarantined for s in self.snapshots)

    # ------------------------------------------------------------------
    # Serialisation
    # ------------------------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        return {
            "tenant_id": str(self.tenant_id),
            "job_id": str(self.job_id),
            "snapshots": [s.to_dict() for s in self.snapshots],
            "failures": [f.to_dict() for f in self.failures],
            "duplicate_candidates": [d.to_dict() for d in self.duplicate_candidates],
            "latest_active_state": self.latest_active_state.value,
            "updated_at": self.updated_at,
        }


__all__ = [
    "ContentDuplicateCandidate",
    "PostingSnapshotSet",
    "SnapshotCaptureFailure",
]
