"""Phase 7 / S-27: EnrichJobUseCase + EnrichBatchUseCase orchestration.

Cover the cascade behaviours:

  * Tier 1 succeeds → JobEnriched event, repository write.
  * Tier 1 fails → Tier 2 succeeds → JobEnriched, recorded tier is the
    actual winner (Tier 2).
  * All tiers fail → EnrichmentFailed event, aggregate persisted as
    failed.
  * Fetcher exception → aggregate persisted as failed with FETCH_ERROR.
  * Batch use case iterates list_pending and aggregates results.
"""

from __future__ import annotations

from dataclasses import dataclass

from jobctl.domain.enrichment import (
    DetailPage,
    EnrichmentLifecycle,
    ExtractionTier,
    JobEnrichment,
)
from jobctl.domain.enrichment.services import ExtractionResult
from jobctl.domain.enrichment.use_cases import (
    EnrichBatchUseCase,
    EnrichJobUseCase,
    TierExtractor,
)
from jobctl.domain.enrichment.value_objects import (
    ApplicationUrl,
    FullDescription,
)
from jobctl.domain.identifiers import JobId
from jobctl.domain.ports.enrichment import DetailPageFetcherPort
from jobctl.domain.ports.events import EventPublisher
from jobctl.domain.tenant import LOCAL_TENANT


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------


class _RecordingPublisher(EventPublisher):
    def __init__(self) -> None:
        self.published: list = []

    def publish(self, event) -> None:  # type: ignore[no-untyped-def]
        self.published.append(event)


class _MemoryEnrichmentRepository:
    """Minimal in-memory ``EnrichmentRepository`` for use-case tests."""

    def __init__(self) -> None:
        self.store: dict[tuple[str, str], JobEnrichment] = {}
        self.pending_ids: list[JobId] = []

    def load(self, tenant_id, job_id):  # type: ignore[no-untyped-def]
        return self.store.get((str(tenant_id), str(job_id)))

    def save(self, enrichment: JobEnrichment) -> None:
        self.store[(str(enrichment.tenant_id), str(enrichment.job_id))] = enrichment

    def list_pending(self, tenant_id, *, limit=0):  # type: ignore[no-untyped-def]
        items = list(self.pending_ids)
        if limit > 0:
            items = items[:limit]
        return items

    def list_failed(self, tenant_id, *, limit=0):  # type: ignore[no-untyped-def]
        return [e for e in self.store.values() if e.is_failed]


class _CannedFetcher(DetailPageFetcherPort):
    def __init__(self, page: DetailPage) -> None:
        self._page = page
        self.calls: list[str] = []

    def fetch(self, url: str) -> DetailPage:
        self.calls.append(url)
        return self._page


class _RaisingFetcher(DetailPageFetcherPort):
    def fetch(self, url: str) -> DetailPage:
        raise RuntimeError("nav timeout")


@dataclass
class _StaticExtractor:
    """Test-only extractor that returns a pre-canned result."""

    result: ExtractionResult

    def extract(self, page: DetailPage) -> ExtractionResult:  # noqa: ARG002 - port shape
        return self.result


# ---------------------------------------------------------------------------
# Cascade behaviour
# ---------------------------------------------------------------------------


def _ok_result(text: str = "Real description") -> ExtractionResult:
    return ExtractionResult(
        ok=True,
        full_description=FullDescription(text=text),
        application_url=ApplicationUrl(value="https://apply"),
    )


def _fail_result() -> ExtractionResult:
    return ExtractionResult(ok=False)


def test_use_case_uses_tier_1_when_it_succeeds() -> None:
    page = DetailPage(url="https://x", html="<p>x</p>")
    fetcher = _CannedFetcher(page)
    publisher = _RecordingPublisher()
    repo = _MemoryEnrichmentRepository()

    use_case = EnrichJobUseCase(
        repository=repo,
        fetcher=fetcher,
        publisher=publisher,
        extractors=(
            TierExtractor(tier=ExtractionTier.JSON_LD, extractor=_StaticExtractor(_ok_result())),
            TierExtractor(tier=ExtractionTier.CSS_SELECTORS, extractor=_StaticExtractor(_fail_result())),
            TierExtractor(tier=ExtractionTier.LLM_ASSISTED, extractor=_StaticExtractor(_fail_result())),
        ),
    )
    outcome = use_case.execute(
        tenant_id=LOCAL_TENANT, job_id=JobId("https://x"), url="https://x"
    )
    assert outcome.ok
    assert outcome.tier_used is ExtractionTier.JSON_LD
    saved = repo.load(LOCAL_TENANT, JobId("https://x"))
    assert saved is not None and saved.is_enriched
    assert saved.extraction_tier is ExtractionTier.JSON_LD
    assert publisher.published and publisher.published[0].event_type == "JobEnriched"


def test_use_case_falls_through_to_tier_2_on_tier_1_failure() -> None:
    fetcher = _CannedFetcher(DetailPage(url="https://x", html="<p>x</p>"))
    publisher = _RecordingPublisher()
    repo = _MemoryEnrichmentRepository()

    use_case = EnrichJobUseCase(
        repository=repo,
        fetcher=fetcher,
        publisher=publisher,
        extractors=(
            TierExtractor(tier=ExtractionTier.JSON_LD, extractor=_StaticExtractor(_fail_result())),
            TierExtractor(
                tier=ExtractionTier.CSS_SELECTORS,
                extractor=_StaticExtractor(_ok_result("CSS-extracted")),
            ),
            TierExtractor(tier=ExtractionTier.LLM_ASSISTED, extractor=_StaticExtractor(_fail_result())),
        ),
    )
    outcome = use_case.execute(
        tenant_id=LOCAL_TENANT, job_id=JobId("https://x"), url="https://x"
    )
    assert outcome.ok
    assert outcome.tier_used is ExtractionTier.CSS_SELECTORS
    saved = repo.load(LOCAL_TENANT, JobId("https://x"))
    assert saved is not None
    assert saved.extraction_tier is ExtractionTier.CSS_SELECTORS
    assert saved.full_description is not None
    assert saved.full_description.text == "CSS-extracted"


def test_use_case_records_failure_when_all_tiers_fail() -> None:
    fetcher = _CannedFetcher(DetailPage(url="https://x", html="<p>x</p>"))
    publisher = _RecordingPublisher()
    repo = _MemoryEnrichmentRepository()

    use_case = EnrichJobUseCase(
        repository=repo,
        fetcher=fetcher,
        publisher=publisher,
        extractors=(
            TierExtractor(tier=ExtractionTier.JSON_LD, extractor=_StaticExtractor(_fail_result())),
            TierExtractor(tier=ExtractionTier.CSS_SELECTORS, extractor=_StaticExtractor(_fail_result())),
            TierExtractor(tier=ExtractionTier.LLM_ASSISTED, extractor=_StaticExtractor(_fail_result())),
        ),
    )
    outcome = use_case.execute(
        tenant_id=LOCAL_TENANT, job_id=JobId("https://x"), url="https://x"
    )
    assert not outcome.ok
    saved = repo.load(LOCAL_TENANT, JobId("https://x"))
    assert saved is not None and saved.is_failed
    assert saved.attempt_count == 1
    assert saved.last_attempt is not None
    assert saved.last_attempt.error is not None
    assert saved.last_attempt.error.code == "EXTRACTION_EXHAUSTED"
    # The recorded tier on the failed attempt is the LAST tier attempted
    assert saved.last_attempt.extraction_tier is ExtractionTier.LLM_ASSISTED
    assert publisher.published and publisher.published[0].event_type == "EnrichmentFailed"


def test_use_case_records_fetch_error_as_failed_attempt() -> None:
    fetcher = _RaisingFetcher()
    publisher = _RecordingPublisher()
    repo = _MemoryEnrichmentRepository()
    use_case = EnrichJobUseCase(
        repository=repo,
        fetcher=fetcher,
        publisher=publisher,
        extractors=(
            TierExtractor(tier=ExtractionTier.JSON_LD, extractor=_StaticExtractor(_fail_result())),
        ),
    )
    outcome = use_case.execute(
        tenant_id=LOCAL_TENANT, job_id=JobId("https://x"), url="https://x"
    )
    assert not outcome.ok
    assert "nav timeout" in outcome.error
    saved = repo.load(LOCAL_TENANT, JobId("https://x"))
    assert saved is not None and saved.is_failed
    assert saved.last_attempt is not None
    assert saved.last_attempt.error is not None
    assert saved.last_attempt.error.code == "FETCH_ERROR"
    assert publisher.published[0].event_type == "EnrichmentFailed"


def test_use_case_skips_already_enriched_aggregate() -> None:
    fetcher = _CannedFetcher(DetailPage(url="https://x", html="<p>x</p>"))
    publisher = _RecordingPublisher()
    repo = _MemoryEnrichmentRepository()

    pre_enriched = (
        JobEnrichment.empty(
            tenant_id=LOCAL_TENANT, job_id=JobId("https://x"), updated_at="t0"
        )
        .start_attempt(extraction_tier=ExtractionTier.JSON_LD, started_at="t0")
        .succeed_attempt(
            full_description=FullDescription(text="already done"),
            application_url=None,
            extraction_tier=ExtractionTier.JSON_LD,
            finished_at="t1",
        )
    )
    repo.save(pre_enriched)

    use_case = EnrichJobUseCase(
        repository=repo,
        fetcher=fetcher,
        publisher=publisher,
        extractors=(
            TierExtractor(tier=ExtractionTier.JSON_LD, extractor=_StaticExtractor(_ok_result())),
        ),
    )
    outcome = use_case.execute(
        tenant_id=LOCAL_TENANT, job_id=JobId("https://x"), url="https://x"
    )
    assert outcome.ok
    assert outcome.tier_used is ExtractionTier.JSON_LD
    assert fetcher.calls == []  # short-circuited
    assert publisher.published == []  # no event re-published


def test_use_case_carries_tier_2_apply_url_into_tier_3_success() -> None:
    """When Tier 2 found an apply URL but failed on description, and
    Tier 3 succeeds without one, we keep the earlier discovery."""
    fetcher = _CannedFetcher(DetailPage(url="https://x", html="<p>x</p>"))
    repo = _MemoryEnrichmentRepository()

    tier2_apply_only = ExtractionResult(
        ok=False,
        full_description=None,
        application_url=ApplicationUrl(value="https://t2-apply"),
    )
    tier3_desc_only = ExtractionResult(
        ok=True,
        full_description=FullDescription(text="LLM description"),
        application_url=None,
    )

    use_case = EnrichJobUseCase(
        repository=repo,
        fetcher=fetcher,
        extractors=(
            TierExtractor(tier=ExtractionTier.JSON_LD, extractor=_StaticExtractor(_fail_result())),
            TierExtractor(tier=ExtractionTier.CSS_SELECTORS, extractor=_StaticExtractor(tier2_apply_only)),
            TierExtractor(tier=ExtractionTier.LLM_ASSISTED, extractor=_StaticExtractor(tier3_desc_only)),
        ),
    )
    outcome = use_case.execute(
        tenant_id=LOCAL_TENANT, job_id=JobId("https://x"), url="https://x"
    )
    assert outcome.ok
    saved = repo.load(LOCAL_TENANT, JobId("https://x"))
    assert saved is not None
    assert saved.application_url is not None
    assert saved.application_url.value == "https://t2-apply"


# ---------------------------------------------------------------------------
# Batch use case
# ---------------------------------------------------------------------------


def test_batch_use_case_iterates_list_pending() -> None:
    fetcher = _CannedFetcher(DetailPage(url="https://x", html="<p>x</p>"))
    repo = _MemoryEnrichmentRepository()
    repo.pending_ids = [JobId("https://example.com/1"), JobId("https://example.com/2")]

    single = EnrichJobUseCase(
        repository=repo,
        fetcher=fetcher,
        extractors=(
            TierExtractor(tier=ExtractionTier.JSON_LD, extractor=_StaticExtractor(_ok_result())),
        ),
    )
    batch = EnrichBatchUseCase(single_job_use_case=single, repository=repo)
    summary = batch.execute(tenant_id=LOCAL_TENANT)
    assert summary.processed == 2
    assert summary.succeeded == 2
    assert summary.failed == 0
    # Two repository rows produced
    assert len(repo.store) == 2
    # Both saved as enriched
    for agg in repo.store.values():
        assert agg.current_status == EnrichmentLifecycle.ENRICHED
