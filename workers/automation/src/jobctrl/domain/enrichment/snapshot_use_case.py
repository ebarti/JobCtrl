"""Use case orchestrating ``PostingSnapshotSet``.

See ``docs/plans/implemented/2026-05-12-job-search-discovery-rfc.md``
§"Content Acquisition Pipeline" and §"Domain Events".

``CapturePostingSnapshotUseCase`` ties together:

  * the ``ContentAcquisitionService`` (fetch + cascade + active verify),
  * a ``PostingSnapshotSetRepository`` to load/save the aggregate,
  * a ``ContentDedupeService`` to surface duplicate candidates,
  * an ``EventPublisher`` to emit the four PR3 events,
  * an optional ``FilterOverrideAudit`` propagated from the caller.

The use case keeps the existing ``EnrichJobUseCase`` untouched: the
canonical ``JobEnrichment`` invariant is preserved. A first usable
snapshot can still be re-applied to ``JobEnrichment`` via the
``promote_to_job_enrichment`` toggle, but every subsequent snapshot
flows only through ``PostingSnapshotSet``.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Protocol

from jobctrl.domain.enrichment.aggregate import JobEnrichment
from jobctrl.domain.enrichment.snapshot_services import (
    ContentAcquisitionResult,
    ContentAcquisitionService,
    ContentDedupeService,
    DedupeIndexEntry,
)
from jobctrl.domain.enrichment.snapshot_set import (
    ContentDuplicateCandidate,
    PostingSnapshotSet,
)
from jobctrl.domain.enrichment.snapshot_value_objects import (
    ActiveState,
    FilterOverrideAudit,
    QuarantineReason,
    SnapshotApplyUrl,
)
from jobctrl.domain.enrichment.value_objects import ExtractionTier
from jobctrl.domain.events import (
    ContentDuplicateCandidateDetectedPayload,
    JobActiveStateChangedPayload,
    JobEnrichedPayload,
    PostingContentSnapshotCapturedPayload,
    PostingContentSnapshotFailedPayload,
    create_content_duplicate_candidate_detected,
    create_job_active_state_changed,
    create_job_enriched,
    create_posting_content_snapshot_captured,
    create_posting_content_snapshot_failed,
)
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.ports.enrichment import EnrichmentRepository
from jobctrl.domain.ports.events import EventPublisher
from jobctrl.domain.tenant import TenantId

log = logging.getLogger(__name__)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# PostingSnapshotSetRepository port
# ---------------------------------------------------------------------------


class PostingSnapshotSetRepository(Protocol):
    """Persistence port for the ``PostingSnapshotSet`` aggregate.

    All methods are tenant-scoped. ``save`` is an upsert keyed on
    ``(tenant_id, job_id)``. ``load`` returns ``None`` for first-time
    captures so the use case can call ``empty(...)``.
    """

    def load(self, tenant_id: TenantId, job_id: JobId) -> PostingSnapshotSet | None: ...

    def save(self, snapshot_set: PostingSnapshotSet) -> None: ...

    def index_entries(self, tenant_id: TenantId, *, exclude_job_id: JobId | None = None) -> Iterable[DedupeIndexEntry]:
        """Return the dedupe index — the latest snapshot per other job."""
        ...


# ---------------------------------------------------------------------------
# Outcome
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CapturePostingSnapshotOutcome:
    ok: bool
    snapshot_set: PostingSnapshotSet
    captured_snapshot_version: int | None = None
    duplicate_candidates: tuple[ContentDuplicateCandidate, ...] = ()
    active_state_changed: bool = False
    promoted_to_job_enrichment: bool = False
    error_class: str = ""
    error_message: str = ""


# ---------------------------------------------------------------------------
# CapturePostingSnapshotUseCase
# ---------------------------------------------------------------------------


class CapturePostingSnapshotUseCase:
    """Capture a versioned ``PostingContentSnapshot`` and run dedupe.

    The use case never touches ``JobEnrichment`` unless explicitly
    asked (``promote_to_job_enrichment=True``) AND the existing
    aggregate is still ``pending``. This preserves the §4.2 terminal
    invariant — once an attempt succeeds, the aggregate is
    ``Enriched`` and only ``reset()`` reopens it.
    """

    def __init__(
        self,
        *,
        snapshot_repository: PostingSnapshotSetRepository,
        acquisition_service: ContentAcquisitionService,
        dedupe_service: ContentDedupeService | None = None,
        publisher: EventPublisher | None = None,
        enrichment_repository: EnrichmentRepository | None = None,
    ) -> None:
        self._snapshot_repository = snapshot_repository
        self._acquisition = acquisition_service
        self._dedupe = dedupe_service or ContentDedupeService()
        self._publisher = publisher
        self._enrichment_repository = enrichment_repository

    # ------------------------------------------------------------------

    def execute(
        self,
        *,
        tenant_id: TenantId,
        job_id: JobId,
        url: str,
        source_id: str,
        policy_id: str = "unknown",
        filter_override: FilterOverrideAudit | None = None,
        promote_to_job_enrichment: bool = True,
    ) -> CapturePostingSnapshotOutcome:
        """Capture one snapshot for ``(tenant, job)``."""
        snapshot_set = self._snapshot_repository.load(tenant_id, job_id) or (
            PostingSnapshotSet.empty(tenant_id=tenant_id, job_id=job_id, updated_at=_utc_now())
        )
        previous_active = snapshot_set.latest_active_state

        result = self._acquisition.acquire(
            url=url,
            source_id=source_id,
            tenant_id=str(tenant_id),
            job_id=str(job_id),
            policy_id=policy_id,
            filter_override=filter_override,
        )
        if not result.ok:
            return self._record_failure(
                snapshot_set=snapshot_set,
                source_id=source_id,
                result=result,
            )

        # Snapshot recorded; now dedupe + persist + publish.
        # Defensive: ContentAcquisitionService only returns ok=True when
        # description and description_hash are populated; assert for type
        # checker happiness and to fail loud on a future regression.
        assert result.description is not None
        assert result.description_hash is not None
        snapshot_set, captured = snapshot_set.record_snapshot(
            source_id=source_id,
            extraction_tier=result.extraction_tier,
            description_hash=result.description_hash,
            apply_url=result.apply_url,
            active_state=result.active_state,
            confidence=result.confidence,
            quarantine_reason=result.quarantine_reason,
            captured_at=_utc_now(),
            raw_text_hash=result.raw_text_hash,
            filter_override=filter_override,
            evidence=result.evidence,
        )

        # Dedupe candidates against everything else this tenant has seen.
        duplicate_candidates: list[ContentDuplicateCandidate] = []
        index = list(self._snapshot_repository.index_entries(tenant_id, exclude_job_id=job_id))
        findings = self._dedupe.find_candidates(
            job_id=str(job_id),
            description_hash=result.description_hash,
            apply_url=result.apply_url,
            cleaned_text=result.description.text if result.description else None,
            index=index,
        )
        for finding in findings:
            candidate = ContentDuplicateCandidate(
                candidate_job_id=finding.candidate_job_id,
                evidence=finding.evidence,
                confidence=finding.confidence,
                detected_at=_utc_now(),
            )
            before_count = len(snapshot_set.duplicate_candidates)
            snapshot_set = snapshot_set.record_duplicate_candidate(candidate=candidate)
            if len(snapshot_set.duplicate_candidates) > before_count:
                duplicate_candidates.append(candidate)

        # Active-state transition (vs. the previously latest state).
        active_changed = result.active_state is not previous_active

        # Persist and publish.
        self._snapshot_repository.save(snapshot_set)

        promoted = False
        if (
            promote_to_job_enrichment
            and self._enrichment_repository is not None
            and result.description is not None
            and result.active_state is ActiveState.ACTIVE
            and result.quarantine_reason is QuarantineReason.NONE
        ):
            promoted = self._maybe_seed_job_enrichment(
                tenant_id=tenant_id,
                job_id=job_id,
                result=result,
            )

        # Events: capture, optional active-state change, optional dupe candidates.
        self._publish_captured(
            tenant_id=tenant_id,
            job_id=job_id,
            snapshot_version=captured.snapshot_version,
            source_id=source_id,
            extraction_tier=result.extraction_tier,
            captured_at=captured.captured_at,
        )
        if active_changed:
            self._publish_active_state_changed(
                tenant_id=tenant_id,
                job_id=job_id,
                new_state=result.active_state,
                previous_state=previous_active,
                verification_method=result.verification_method,
                verified_at=captured.captured_at,
            )
        for candidate in duplicate_candidates:
            self._publish_duplicate_candidate_detected(
                tenant_id=tenant_id,
                job_id=job_id,
                candidate=candidate,
            )

        return CapturePostingSnapshotOutcome(
            ok=True,
            snapshot_set=snapshot_set,
            captured_snapshot_version=captured.snapshot_version,
            duplicate_candidates=tuple(duplicate_candidates),
            active_state_changed=active_changed,
            promoted_to_job_enrichment=promoted,
        )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _record_failure(
        self,
        *,
        snapshot_set: PostingSnapshotSet,
        source_id: str,
        result: ContentAcquisitionResult,
    ) -> CapturePostingSnapshotOutcome:
        failed_at = _utc_now()
        previous_active = snapshot_set.latest_active_state
        snapshot_set, _ = snapshot_set.record_capture_failure(
            source_id=source_id,
            error_class=result.error_class or "UNKNOWN",
            message=result.error_message,
            retryable=result.retryable,
            failed_at=failed_at,
        )
        active_changed = result.verification_method != "unknown" and result.active_state is not previous_active
        if active_changed:
            snapshot_set, _ = snapshot_set.mark_active_state(
                active_state=result.active_state,
                verified_at=failed_at,
            )
        self._snapshot_repository.save(snapshot_set)
        self._publish_failed(
            tenant_id=snapshot_set.tenant_id,
            job_id=snapshot_set.job_id,
            source_id=source_id,
            error_class=result.error_class or "UNKNOWN",
            retryable=result.retryable,
            failed_at=failed_at,
        )
        if active_changed:
            self._publish_active_state_changed(
                tenant_id=snapshot_set.tenant_id,
                job_id=snapshot_set.job_id,
                new_state=result.active_state,
                previous_state=previous_active,
                verification_method=result.verification_method,
                verified_at=failed_at,
            )
        return CapturePostingSnapshotOutcome(
            ok=False,
            snapshot_set=snapshot_set,
            active_state_changed=active_changed,
            error_class=result.error_class,
            error_message=result.error_message,
        )

    def _maybe_seed_job_enrichment(
        self,
        *,
        tenant_id: TenantId,
        job_id: JobId,
        result: ContentAcquisitionResult,
    ) -> bool:
        """If JobEnrichment is still ``pending``, succeed it from the snapshot.

        Returns True when ``JobEnrichment`` was promoted. Existing
        ``Enriched`` aggregates are LEFT ALONE (canonical invariant).
        Already-running aggregates are not touched either; the legacy
        ``EnrichJobUseCase`` retains that path.
        """
        repo = self._enrichment_repository
        assert repo is not None
        existing = repo.load(tenant_id, job_id)
        if existing is not None and (existing.is_enriched or existing.is_running):
            return False
        aggregate = existing or JobEnrichment.empty(tenant_id=tenant_id, job_id=job_id, updated_at=_utc_now())
        if aggregate.is_failed:
            aggregate = aggregate.reset(reset_at=_utc_now())
        try:
            tier = ExtractionTier.from_optional(result.extraction_tier) or ExtractionTier.JSON_LD
            aggregate = aggregate.start_attempt(
                extraction_tier=tier,
                started_at=_utc_now(),
            )
            assert result.description is not None
            aggregate = aggregate.succeed_attempt(
                full_description=result.description,
                application_url=(_to_application_url(result.apply_url) if result.apply_url is not None else None),
                extraction_tier=tier,
                finished_at=_utc_now(),
            )
            repo.save(aggregate)
            self._publish_job_enriched(aggregate=aggregate, tier=tier)
            return True
        except Exception:  # noqa: BLE001 — never block snapshot persistence
            log.exception(
                "PostingSnapshot promote_to_job_enrichment failed for %s",
                job_id,
            )
            return False

    # ------------------------------------------------------------------
    # Event publication
    # ------------------------------------------------------------------

    def _publish_captured(
        self,
        *,
        tenant_id: TenantId,
        job_id: JobId,
        snapshot_version: int,
        source_id: str,
        extraction_tier: str,
        captured_at: str,
    ) -> None:
        if self._publisher is None:
            return
        try:
            event = create_posting_content_snapshot_captured(
                tenant_id,
                PostingContentSnapshotCapturedPayload(
                    job_id=str(job_id),
                    snapshot_version=snapshot_version,
                    snapshot_ref=f"{job_id}:{snapshot_version}",
                    source_id=source_id,
                    extraction_tier=extraction_tier,
                    captured_at=captured_at,
                ),
            )
            self._publisher.publish(event)
        except Exception:  # noqa: BLE001 — events never block save
            log.exception("Failed to publish PostingContentSnapshotCaptured for %s", job_id)

    def _publish_failed(
        self,
        *,
        tenant_id: TenantId,
        job_id: JobId,
        source_id: str,
        error_class: str,
        retryable: bool,
        failed_at: str,
    ) -> None:
        if self._publisher is None:
            return
        try:
            event = create_posting_content_snapshot_failed(
                tenant_id,
                PostingContentSnapshotFailedPayload(
                    job_id=str(job_id),
                    source_id=source_id,
                    error_class=error_class,
                    retryable=retryable,
                    failed_at=failed_at,
                ),
            )
            self._publisher.publish(event)
        except Exception:  # noqa: BLE001
            log.exception("Failed to publish PostingContentSnapshotFailed for %s", job_id)

    def _publish_active_state_changed(
        self,
        *,
        tenant_id: TenantId,
        job_id: JobId,
        new_state: ActiveState,
        previous_state: ActiveState,
        verification_method: str,
        verified_at: str,
    ) -> None:
        if self._publisher is None:
            return
        try:
            event = create_job_active_state_changed(
                tenant_id,
                JobActiveStateChangedPayload(
                    job_id=str(job_id),
                    active_state=new_state.value,
                    previous_state=previous_state.value,
                    verification_method=verification_method,
                    verified_at=verified_at,
                ),
            )
            self._publisher.publish(event)
        except Exception:  # noqa: BLE001
            log.exception("Failed to publish JobActiveStateChanged for %s", job_id)

    def _publish_duplicate_candidate_detected(
        self,
        *,
        tenant_id: TenantId,
        job_id: JobId,
        candidate: ContentDuplicateCandidate,
    ) -> None:
        if self._publisher is None:
            return
        try:
            event = create_content_duplicate_candidate_detected(
                tenant_id,
                ContentDuplicateCandidateDetectedPayload(
                    job_id=str(job_id),
                    candidate_job_id=candidate.candidate_job_id,
                    evidence=[
                        {
                            "kind": e.kind.value,
                            "matched_value": e.matched_value,
                            "confidence": e.confidence,
                        }
                        for e in candidate.evidence
                    ],
                    confidence=candidate.confidence,
                    detected_at=candidate.detected_at,
                ),
            )
            self._publisher.publish(event)
        except Exception:  # noqa: BLE001
            log.exception("Failed to publish ContentDuplicateCandidateDetected for %s", job_id)

    def _publish_job_enriched(
        self,
        *,
        aggregate: JobEnrichment,
        tier: ExtractionTier,
    ) -> None:
        if self._publisher is None or aggregate.full_description is None:
            return
        try:
            event = create_job_enriched(
                aggregate.tenant_id,
                JobEnrichedPayload(
                    job_id=str(aggregate.job_id),
                    full_description=aggregate.full_description.text,
                    application_url=(aggregate.application_url.value if aggregate.application_url else ""),
                    extraction_tier=tier.value,
                    enriched_at=aggregate.enriched_at or "",
                ),
            )
            self._publisher.publish(event)
        except Exception:  # noqa: BLE001
            log.exception("Failed to publish JobEnriched promotion for %s", aggregate.job_id)


def _to_application_url(snapshot_apply_url: SnapshotApplyUrl):
    """Bridge the per-snapshot apply URL to the canonical aggregate value."""
    from jobctrl.domain.enrichment.value_objects import ApplicationUrl

    return ApplicationUrl(value=snapshot_apply_url.value)


__all__ = [
    "CapturePostingSnapshotOutcome",
    "CapturePostingSnapshotUseCase",
    "PostingSnapshotSetRepository",
]
