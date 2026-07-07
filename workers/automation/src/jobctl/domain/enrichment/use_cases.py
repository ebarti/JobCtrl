"""Enrichment use cases — application-layer orchestration.

See ddd-target.md §3.2 (Enrichment context) and §5.2 (driving ports).

Two use cases live here:

  ``EnrichJobUseCase``    — given a (TenantId, JobId, posting URL),
                            walks the three-tier extraction cascade,
                            persists the resulting ``JobEnrichment``
                            aggregate via ``EnrichmentRepository``,
                            and publishes ``JobEnriched`` /
                            ``EnrichmentFailed``.
  ``EnrichBatchUseCase``  — wraps ``EnrichJobUseCase`` over the
                            repository's ``list_pending`` queue.

Both use cases accept their dependencies (fetcher, extractors,
repository, publisher) as constructor arguments so tests can swap
fakes without monkey-patching.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Sequence

from jobctl.domain.enrichment.aggregate import JobEnrichment
from jobctl.domain.enrichment.services import (
    CssSelectorExtractor,
    ExtractionResult,
    JsonLdExtractor,
    LlmExtractor,
)
from jobctl.domain.enrichment.value_objects import (
    EnrichmentError,
    ExtractionTier,
)
from jobctl.domain.events import (
    EnrichmentFailedPayload,
    JobEnrichedPayload,
    create_enrichment_failed,
    create_job_enriched,
)
from jobctl.domain.identifiers import JobId
from jobctl.domain.ports.enrichment import (
    DetailPageFetcherPort,
    EnrichmentRepository,
)
from jobctl.domain.ports.events import EventPublisher
from jobctl.domain.tenant import LOCAL_TENANT, TenantId

log = logging.getLogger(__name__)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Cascade strategy — pure data tying tier ⇒ extractor instance
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TierExtractor:
    """One step in the extraction cascade."""

    tier: ExtractionTier
    extractor: object  # has ``.extract(DetailPage) -> ExtractionResult``


# ---------------------------------------------------------------------------
# EnrichJobOutcome
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EnrichJobOutcome:
    """Result of one ``EnrichJobUseCase.execute`` call.

    ``ok=True`` and ``enrichment`` populated when at least one tier
    produced a usable description. ``ok=False`` and ``error``
    populated when every tier failed — in that case the aggregate
    was still persisted (with the failed attempt recorded) so the
    queue selectors can find the failed row.
    """

    ok: bool
    enrichment: JobEnrichment
    tier_used: ExtractionTier | None = None
    error: str = ""


# ---------------------------------------------------------------------------
# EnrichJobUseCase
# ---------------------------------------------------------------------------


class EnrichJobUseCase:
    """Run the three-tier extraction cascade for one job.

    The use case owns the transaction boundary: fetch the detail page
    once, walk the cascade, build the new ``JobEnrichment`` state
    transitions, persist via ``EnrichmentRepository``, then publish.
    """

    def __init__(
        self,
        *,
        repository: EnrichmentRepository,
        fetcher: DetailPageFetcherPort,
        extractors: Sequence[TierExtractor] | None = None,
        publisher: EventPublisher | None = None,
    ) -> None:
        self._repository = repository
        self._fetcher = fetcher
        self._publisher = publisher
        if extractors is None:
            raise ValueError(
                "EnrichJobUseCase requires explicit extractors. Use "
                "default_extractors(llm) for the canonical Tier 1→2→3 cascade."
            )
        if not extractors:
            raise ValueError("EnrichJobUseCase requires at least one extractor")
        self._extractors = tuple(extractors)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def execute(
        self,
        *,
        tenant_id: TenantId,
        job_id: JobId,
        url: str,
    ) -> EnrichJobOutcome:
        """Enrich one job.

        Loads the existing aggregate (or starts a fresh ``empty``
        one), walks the cascade, and persists the terminal state.
        ``url`` is the URL to navigate — typically the Job
        aggregate's ``PostingUrl.value`` resolved to absolute form.
        """
        existing = self._repository.load(tenant_id, job_id)
        if existing is None:
            aggregate = JobEnrichment.empty(
                tenant_id=tenant_id,
                job_id=job_id,
                updated_at=_utc_now(),
            )
        elif existing.is_enriched:
            # Already done — return the loaded aggregate without
            # re-running the cascade. Callers that want to force a
            # rescore must reset() the aggregate first.
            return EnrichJobOutcome(
                ok=True,
                enrichment=existing,
                tier_used=existing.extraction_tier,
            )
        else:
            aggregate = existing

        # Open the running attempt against the FIRST tier; the actual
        # tier-that-succeeded gets recorded on succeed_attempt.
        first_tier = self._extractors[0].tier
        started_at = _utc_now()
        aggregate = aggregate.start_attempt(
            extraction_tier=first_tier,
            started_at=started_at,
        )

        try:
            page = self._fetcher.fetch(url)
        except Exception as exc:  # noqa: BLE001 — translate into failed attempt
            log.warning("EnrichJobUseCase: fetch error %s: %s", url, exc)
            error = EnrichmentError(
                code="FETCH_ERROR",
                message=str(exc)[:500],
                retryable=True,
            )
            failed = aggregate.fail_attempt(error=error, finished_at=_utc_now())
            self._repository.save(failed)
            self._publish_failed(failed, error)
            return EnrichJobOutcome(
                ok=False,
                enrichment=failed,
                tier_used=None,
                error=error.message,
            )

        # Walk the cascade
        last_tier_attempted: ExtractionTier = first_tier
        last_apply_url = None
        for step in self._extractors:
            last_tier_attempted = step.tier
            try:
                result: ExtractionResult = step.extractor.extract(page)  # type: ignore[attr-defined]
            except Exception as exc:  # noqa: BLE001
                log.warning(
                    "EnrichJobUseCase: extractor %s raised: %s",
                    step.tier.value,
                    exc,
                )
                continue
            if result.application_url is not None:
                last_apply_url = result.application_url
            if result.ok and result.full_description is not None:
                # Carry over an apply URL discovered by an earlier
                # tier when the winning tier didn't produce one.
                final_apply = result.application_url or last_apply_url
                finished_at = _utc_now()
                succeeded = aggregate.succeed_attempt(
                    full_description=result.full_description,
                    application_url=final_apply,
                    extraction_tier=step.tier,
                    finished_at=finished_at,
                )
                self._repository.save(succeeded)
                self._publish_enriched(succeeded)
                return EnrichJobOutcome(
                    ok=True,
                    enrichment=succeeded,
                    tier_used=step.tier,
                )

        # Every tier failed — record a failed attempt with the last
        # tier as the "extraction_tier" so the audit row carries which
        # tier was final.
        finished_at = _utc_now()
        error = EnrichmentError(
            code="EXTRACTION_EXHAUSTED",
            message=f"All extraction tiers failed (last: {last_tier_attempted.value})",
            retryable=True,
        )
        # Mutate the running attempt's tier to match the actual final
        # tier before failing — keeps the recorded provenance honest.
        running = aggregate.attempts[-1]
        if running.extraction_tier != last_tier_attempted:
            from jobctl.domain.enrichment.entities import (
                AttemptStatus,
                EnrichmentAttempt,
            )

            replaced = EnrichmentAttempt(
                attempt_number=running.attempt_number,
                extraction_tier=last_tier_attempted,
                status=AttemptStatus.RUNNING,
                started_at=running.started_at,
                finished_at=None,
                error=None,
            )
            from dataclasses import replace as _replace

            aggregate = _replace(
                aggregate,
                attempts=aggregate.attempts[:-1] + (replaced,),
            )
        failed = aggregate.fail_attempt(error=error, finished_at=finished_at)
        self._repository.save(failed)
        self._publish_failed(failed, error)
        return EnrichJobOutcome(
            ok=False,
            enrichment=failed,
            tier_used=last_tier_attempted,
            error=error.message,
        )

    # ------------------------------------------------------------------
    # Event publishing
    # ------------------------------------------------------------------

    def _publish_enriched(self, agg: JobEnrichment) -> None:
        if self._publisher is None or agg.full_description is None:
            return
        try:
            event = create_job_enriched(
                agg.tenant_id,
                JobEnrichedPayload(
                    job_id=str(agg.job_id),
                    full_description=agg.full_description.text,
                    application_url=(
                        agg.application_url.value if agg.application_url else ""
                    ),
                    extraction_tier=(
                        agg.extraction_tier.value
                        if agg.extraction_tier
                        else ""
                    ),
                    enriched_at=agg.enriched_at or "",
                ),
            )
            self._publisher.publish(event)
        except Exception:  # noqa: BLE001 — events never block save
            log.exception("Failed to publish JobEnriched for %s", agg.job_id)

    def _publish_failed(self, agg: JobEnrichment, error: EnrichmentError) -> None:
        if self._publisher is None:
            return
        try:
            event = create_enrichment_failed(
                agg.tenant_id,
                EnrichmentFailedPayload(
                    job_id=str(agg.job_id),
                    error=error.message,
                    attempt_number=agg.attempt_count,
                ),
            )
            self._publisher.publish(event)
        except Exception:  # noqa: BLE001
            log.exception("Failed to publish EnrichmentFailed for %s", agg.job_id)


# ---------------------------------------------------------------------------
# Default cascade builder
# ---------------------------------------------------------------------------


def default_extractors(*, llm) -> tuple[TierExtractor, ...]:  # type: ignore[no-untyped-def]
    """Construct the canonical Tier 1 → Tier 2 → Tier 3 cascade.

    The LLM port is required because Tier 3 always uses an LLM. The
    use case orders the cascade from cheapest tier to most expensive
    so the legacy "JSON-LD first, then CSS, then LLM" behaviour is
    preserved.
    """
    return (
        TierExtractor(tier=ExtractionTier.JSON_LD, extractor=JsonLdExtractor()),
        TierExtractor(
            tier=ExtractionTier.CSS_SELECTORS, extractor=CssSelectorExtractor()
        ),
        TierExtractor(
            tier=ExtractionTier.LLM_ASSISTED, extractor=LlmExtractor(llm=llm)
        ),
    )


# ---------------------------------------------------------------------------
# EnrichBatchUseCase
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BatchEnrichmentSummary:
    """Aggregate result of a batch enrichment run."""

    processed: int
    succeeded: int
    failed: int
    tier_counts: dict[str, int]


class EnrichBatchUseCase:
    """Enrich a batch of pending jobs by iterating the queue.

    The batch use case asks the repository for pending jobs (per
    ``EnrichmentRepository.list_pending``) and runs the single-job
    use case for each. The cascade is identical to the single-job
    flow; the wrapper exists to give CLI / pipeline callers a one-
    call entry point.
    """

    def __init__(
        self,
        *,
        single_job_use_case: EnrichJobUseCase,
        repository: EnrichmentRepository,
    ) -> None:
        self._single = single_job_use_case
        self._repository = repository

    def execute(
        self,
        *,
        tenant_id: TenantId = LOCAL_TENANT,
        limit: int = 0,
        url_resolver: object | None = None,
    ) -> BatchEnrichmentSummary:
        """Enrich every pending job, returning a summary.

        ``url_resolver`` is an optional callable that receives a
        ``JobId`` (the legacy URL) and returns the absolute URL to
        navigate. When omitted, the JobId is used verbatim.
        """
        ids = self._repository.list_pending(tenant_id, limit=limit)
        return self._run(tenant_id=tenant_id, ids=ids, url_resolver=url_resolver)

    def _run(
        self,
        *,
        tenant_id: TenantId,
        ids: Iterable[JobId],
        url_resolver: object | None,
    ) -> BatchEnrichmentSummary:
        processed = succeeded = failed = 0
        per_tier: dict[str, int] = {
            ExtractionTier.JSON_LD.value: 0,
            ExtractionTier.CSS_SELECTORS.value: 0,
            ExtractionTier.LLM_ASSISTED.value: 0,
        }
        for job_id in ids:
            url = (
                url_resolver(job_id)  # type: ignore[operator]
                if callable(url_resolver)
                else str(job_id)
            )
            outcome = self._single.execute(
                tenant_id=tenant_id, job_id=job_id, url=str(url)
            )
            processed += 1
            if outcome.ok:
                succeeded += 1
                if outcome.tier_used:
                    per_tier[outcome.tier_used.value] = (
                        per_tier.get(outcome.tier_used.value, 0) + 1
                    )
            else:
                failed += 1
        return BatchEnrichmentSummary(
            processed=processed,
            succeeded=succeeded,
            failed=failed,
            tier_counts=per_tier,
        )


__all__ = [
    "BatchEnrichmentSummary",
    "EnrichBatchUseCase",
    "EnrichJobOutcome",
    "EnrichJobUseCase",
    "TierExtractor",
    "default_extractors",
]
