"""PR3 content snapshot, active verification, dedupe, override, and span coverage."""

from __future__ import annotations

import logging
from dataclasses import dataclass

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import set_tracer_provider

from jobhunter.domain.discovery.source_registry import ContentFilterOverridePolicy
from jobhunter.domain.enrichment import DetailPage, ExtractionTier, JobEnrichment
from jobhunter.domain.enrichment.filter_override import FilterOverrideError, FilterOverrideLogger
from jobhunter.domain.enrichment.services import ExtractionResult, JsonLdExtractor
from jobhunter.domain.enrichment.snapshot_services import (
    ActiveStateVerifier,
    ContentAcquisitionService,
    DedupeIndexEntry,
    TierExtractor,
)
from jobhunter.domain.enrichment.snapshot_set import PostingSnapshotSet
from jobhunter.domain.enrichment.snapshot_use_case import CapturePostingSnapshotUseCase
from jobhunter.domain.enrichment.snapshot_value_objects import (
    ActiveState,
    FilterOverrideAudit,
    QuarantineReason,
    SnapshotApplyUrl,
    SnapshotDescriptionHash,
)
from jobhunter.domain.enrichment.value_objects import ApplicationUrl, FullDescription
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.observability.enrichment_spans import (
    content_render_span,
    llm_fallback_extraction_span,
)


NOW = "2026-05-13T00:00:00+00:00"
JOB_ID = JobId("job-1")
SOURCE_ID = "greenhouse:acme"


@pytest.fixture
def in_memory_exporter(monkeypatch):
    from opentelemetry import trace as trace_api
    from opentelemetry.util._once import Once

    monkeypatch.setattr(trace_api, "_TRACER_PROVIDER_SET_ONCE", Once())
    monkeypatch.setattr(trace_api, "_TRACER_PROVIDER", None)

    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    set_tracer_provider(provider)
    yield exporter
    exporter.clear()


class _RecordingPublisher:
    def __init__(self) -> None:
        self.published: list = []

    def publish(self, event) -> None:  # type: ignore[no-untyped-def]
        self.published.append(event)


class _MemorySnapshotRepository:
    def __init__(self, index: tuple[DedupeIndexEntry, ...] = ()) -> None:
        self.store: dict[tuple[str, str], object] = {}
        self._index = index

    def load(self, tenant_id, job_id):  # type: ignore[no-untyped-def]
        return self.store.get((str(tenant_id), str(job_id)))

    def save(self, snapshot_set) -> None:  # type: ignore[no-untyped-def]
        self.store[(str(snapshot_set.tenant_id), str(snapshot_set.job_id))] = snapshot_set

    def index_entries(self, tenant_id, *, exclude_job_id=None):  # type: ignore[no-untyped-def]
        for entry in self._index:
            if exclude_job_id is not None and entry.candidate_job_id == str(exclude_job_id):
                continue
            yield entry


class _MemoryEnrichmentRepository:
    def __init__(self) -> None:
        self.store: dict[tuple[str, str], JobEnrichment] = {}

    def load(self, tenant_id, job_id):  # type: ignore[no-untyped-def]
        return self.store.get((str(tenant_id), str(job_id)))

    def save(self, enrichment: JobEnrichment) -> None:
        self.store[(str(enrichment.tenant_id), str(enrichment.job_id))] = enrichment

    def list_pending(self, tenant_id, *, limit=0):  # type: ignore[no-untyped-def]
        return ()

    def list_failed(self, tenant_id, *, limit=0):  # type: ignore[no-untyped-def]
        return ()


class _CannedFetcher:
    def __init__(self, page: DetailPage) -> None:
        self._page = page

    def fetch(self, url: str) -> DetailPage:  # noqa: ARG002 - port shape
        return self._page


class _RaisingFetcher:
    def fetch(self, url: str) -> DetailPage:  # noqa: ARG002 - port shape
        raise RuntimeError("nav timeout")


@dataclass
class _StaticExtractor:
    result: ExtractionResult

    def extract(self, page: DetailPage) -> ExtractionResult:  # noqa: ARG002 - port shape
        return self.result


def _long_description() -> str:
    return "Build distributed recruiting systems with Python, Postgres, and TypeScript. " * 8


def _json_ld_page(
    description: str | None = None,
    *,
    valid_through: str = "2999-01-01T00:00:00+00:00",
) -> DetailPage:
    return DetailPage(
        url="https://boards.greenhouse.io/acme/jobs/1",
        status=200,
        json_ld=(
            {
                "@type": "JobPosting",
                "description": description or _long_description(),
                "directApply": True,
                "url": "https://boards.greenhouse.io/acme/jobs/1/apply",
                "validThrough": valid_through,
            },
        ),
    )


def _snapshot_use_case(
    *,
    page: DetailPage,
    publisher: _RecordingPublisher,
    snapshot_repository: _MemorySnapshotRepository,
    enrichment_repository: _MemoryEnrichmentRepository | None = None,
) -> CapturePostingSnapshotUseCase:
    acquisition = ContentAcquisitionService(
        fetcher=_CannedFetcher(page),
        extractors=(TierExtractor(tier=ExtractionTier.JSON_LD, extractor=JsonLdExtractor()),),
    )
    return CapturePostingSnapshotUseCase(
        snapshot_repository=snapshot_repository,
        acquisition_service=acquisition,
        publisher=publisher,
        enrichment_repository=enrichment_repository,
    )


@pytest.mark.parametrize(
    ("page", "expected_state", "expected_method"),
    (
        (DetailPage(url="https://x", status=404), ActiveState.REMOVED, "http_status"),
        (
            _json_ld_page(valid_through="2000-01-01T00:00:00+00:00"),
            ActiveState.EXPIRED,
            "json_ld_valid_through",
        ),
        (
            _json_ld_page(valid_through="2999-01-01T00:00:00+00:00"),
            ActiveState.ACTIVE,
            "json_ld_valid_through",
        ),
        (
            DetailPage(url="https://x", html="This position is no longer accepting applications."),
            ActiveState.CLOSED,
            "closed_marker",
        ),
        (
            DetailPage(url="https://x", html="<main>Visible role content</main>"),
            ActiveState.ACTIVE,
            "default_body_present",
        ),
    ),
)
def test_active_state_verifier_examples(
    page: DetailPage,
    expected_state: ActiveState,
    expected_method: str,
) -> None:
    assert ActiveStateVerifier().verify(page) == (expected_state, expected_method)


def test_capture_snapshot_publishes_pr3_events_and_spans(in_memory_exporter) -> None:
    description = _long_description()
    expected_hash = SnapshotDescriptionHash.from_text(description)
    snapshot_repository = _MemorySnapshotRepository(
        index=(
            DedupeIndexEntry(
                candidate_job_id="job-2",
                description_hash=expected_hash,
                apply_url=SnapshotApplyUrl(value="https://boards.greenhouse.io/acme/jobs/1/apply/"),
                cleaned_text=description,
            ),
        )
    )
    publisher = _RecordingPublisher()
    use_case = _snapshot_use_case(
        page=_json_ld_page(description),
        publisher=publisher,
        snapshot_repository=snapshot_repository,
    )

    outcome = use_case.execute(
        tenant_id=LOCAL_TENANT,
        job_id=JOB_ID,
        url="https://boards.greenhouse.io/acme/jobs/1",
        source_id=SOURCE_ID,
        policy_id="greenhouse_public_api",
        promote_to_job_enrichment=False,
    )

    assert outcome.ok
    assert outcome.captured_snapshot_version == 1
    assert outcome.active_state_changed
    assert len(outcome.duplicate_candidates) == 1
    saved = snapshot_repository.load(LOCAL_TENANT, JOB_ID)
    assert saved is not None
    assert saved.latest_snapshot is not None
    assert saved.latest_snapshot.description_hash.value == expected_hash.value
    assert saved.duplicate_candidates[0].candidate_job_id == "job-2"

    event_types = [event.event_type for event in publisher.published]
    assert event_types == [
        "PostingContentSnapshotCaptured",
        "JobActiveStateChanged",
        "ContentDuplicateCandidateDetected",
    ]
    active_event = publisher.published[1]
    assert active_event.payload["active_state"] == "active"
    assert active_event.payload["previous_state"] == "unknown"
    assert active_event.payload["verification_method"] == "json_ld_valid_through"

    spans = {span.name: dict(span.attributes or {}) for span in in_memory_exporter.get_finished_spans()}
    assert spans["enrichment.content.acquire"]["tenant.id"] == "local"
    assert spans["enrichment.content.acquire"]["job.id"] == "job-1"
    assert spans["enrichment.content.acquire"]["source.id"] == SOURCE_ID
    assert spans["enrichment.content.acquire"]["policy.id"] == "greenhouse_public_api"
    assert spans["enrichment.content.acquire"]["extraction.tier"] == "json_ld"
    assert spans["enrichment.content.acquire"]["snapshot.hash"] == expected_hash.value
    assert spans["enrichment.active.verify"]["active.state"] == "active"
    assert spans["enrichment.active.verify"]["verification.method"] == "json_ld_valid_through"
    assert "langfuse.observation.input" not in spans["enrichment.content.acquire"]


def test_repeat_capture_does_not_republish_existing_duplicate_candidate() -> None:
    description = _long_description()
    expected_hash = SnapshotDescriptionHash.from_text(description)
    repository = _MemorySnapshotRepository(
        index=(
            DedupeIndexEntry(
                candidate_job_id="job-2",
                description_hash=expected_hash,
                apply_url=SnapshotApplyUrl(value="https://boards.greenhouse.io/acme/jobs/1/apply"),
                cleaned_text=description,
            ),
        )
    )
    publisher = _RecordingPublisher()
    use_case = _snapshot_use_case(
        page=_json_ld_page(description),
        publisher=publisher,
        snapshot_repository=repository,
    )

    first = use_case.execute(
        tenant_id=LOCAL_TENANT,
        job_id=JOB_ID,
        url="https://boards.greenhouse.io/acme/jobs/1",
        source_id=SOURCE_ID,
        promote_to_job_enrichment=False,
    )
    second = use_case.execute(
        tenant_id=LOCAL_TENANT,
        job_id=JOB_ID,
        url="https://boards.greenhouse.io/acme/jobs/1",
        source_id=SOURCE_ID,
        promote_to_job_enrichment=False,
    )

    assert len(first.duplicate_candidates) == 1
    assert second.duplicate_candidates == ()
    assert [event.event_type for event in publisher.published].count(
        "ContentDuplicateCandidateDetected"
    ) == 1


def test_render_and_llm_fallback_spans_record_non_sensitive_metadata(in_memory_exporter) -> None:
    with content_render_span(
        tenant_id="local",
        job_id="job-1",
        source_id=SOURCE_ID,
        render_result="ok",
        http_status_code=200,
    ):
        pass
    with llm_fallback_extraction_span(
        tenant_id="local",
        job_id="job-1",
        source_id=SOURCE_ID,
        schema_version="job-posting-v1",
        parse_result="ok",
    ):
        pass

    spans = {span.name: dict(span.attributes or {}) for span in in_memory_exporter.get_finished_spans()}
    render_attrs = spans["enrichment.content.render"]
    assert render_attrs["tenant.id"] == "local"
    assert render_attrs["source.id"] == SOURCE_ID
    assert render_attrs["render.result"] == "ok"
    assert render_attrs["http.status_code"] == 200
    assert "http.url" not in render_attrs
    assert "langfuse.observation.input" not in render_attrs

    llm_attrs = spans["enrichment.content.llm_fallback"]
    assert llm_attrs["tenant.id"] == "local"
    assert llm_attrs["source.id"] == SOURCE_ID
    assert llm_attrs["extraction.tier"] == "llm_assisted"
    assert llm_attrs["schema.version"] == "job-posting-v1"
    assert llm_attrs["parse.result"] == "ok"
    assert "langfuse.observation.input" not in llm_attrs


def test_snapshot_failure_records_failure_event_without_bumping_version() -> None:
    acquisition = ContentAcquisitionService(
        fetcher=_RaisingFetcher(),
        extractors=(
            TierExtractor(
                tier=ExtractionTier.JSON_LD,
                extractor=_StaticExtractor(ExtractionResult(ok=False)),
            ),
        ),
    )
    repository = _MemorySnapshotRepository()
    publisher = _RecordingPublisher()
    use_case = CapturePostingSnapshotUseCase(
        snapshot_repository=repository,
        acquisition_service=acquisition,
        publisher=publisher,
    )

    outcome = use_case.execute(
        tenant_id=LOCAL_TENANT,
        job_id=JOB_ID,
        url="https://boards.greenhouse.io/acme/jobs/1",
        source_id=SOURCE_ID,
        promote_to_job_enrichment=False,
    )

    assert not outcome.ok
    assert outcome.snapshot_set.snapshot_count == 0
    assert outcome.snapshot_set.failures[0].error_class == "FETCH_ERROR"
    assert [event.event_type for event in publisher.published] == ["PostingContentSnapshotFailed"]
    assert publisher.published[0].payload["retryable"] is True


def test_failed_capture_still_records_verified_active_state_change() -> None:
    acquisition = ContentAcquisitionService(
        fetcher=_CannedFetcher(DetailPage(url="https://x", status=404)),
        extractors=(
            TierExtractor(
                tier=ExtractionTier.JSON_LD,
                extractor=_StaticExtractor(ExtractionResult(ok=False)),
            ),
        ),
    )
    repository = _MemorySnapshotRepository()
    publisher = _RecordingPublisher()
    use_case = CapturePostingSnapshotUseCase(
        snapshot_repository=repository,
        acquisition_service=acquisition,
        publisher=publisher,
    )

    outcome = use_case.execute(
        tenant_id=LOCAL_TENANT,
        job_id=JOB_ID,
        url="https://boards.greenhouse.io/acme/jobs/1",
        source_id=SOURCE_ID,
        promote_to_job_enrichment=False,
    )

    assert not outcome.ok
    assert outcome.active_state_changed
    assert outcome.snapshot_set.latest_active_state is ActiveState.REMOVED
    assert [event.event_type for event in publisher.published] == [
        "PostingContentSnapshotFailed",
        "JobActiveStateChanged",
    ]
    active_event = publisher.published[1]
    assert active_event.payload["active_state"] == "removed"
    assert active_event.payload["previous_state"] == "unknown"
    assert active_event.payload["verification_method"] == "http_status"


def test_low_confidence_capture_is_quarantined_without_override() -> None:
    acquisition = ContentAcquisitionService(
        fetcher=_CannedFetcher(
            DetailPage(url="https://x", html="<main>Visible role content</main>", status=200)
        ),
        extractors=(
            TierExtractor(
                tier=ExtractionTier.LLM_ASSISTED,
                extractor=_StaticExtractor(
                    ExtractionResult(ok=True, full_description=FullDescription(text="Short description"))
                ),
            ),
        ),
    )

    result = acquisition.acquire(url="https://x", source_id=SOURCE_ID, tenant_id="local", job_id="job-1")

    assert result.ok
    assert result.confidence.value == "low"
    assert result.active_state is ActiveState.ACTIVE
    assert result.quarantine_reason is QuarantineReason.LOW_CONFIDENCE_EXTRACTION


def test_filter_override_audit_admits_low_confidence_snapshot(caplog) -> None:
    caplog.set_level(logging.INFO)
    audit = FilterOverrideLogger().record(
        source_id=SOURCE_ID,
        policy=ContentFilterOverridePolicy(
            allowed=True,
            requires_reason=True,
            allowed_filters=("low_confidence_extraction",),
        ),
        overridden_filter="low_confidence_extraction",
        reason="user approved trusted source",
        requested_by="user:eloi",
        overridden_at=NOW,
    )
    assert audit.source_id == SOURCE_ID
    assert "filter_override.applied" in caplog.text

    acquisition = ContentAcquisitionService(
        fetcher=_CannedFetcher(
            DetailPage(url="https://x", html="<main>Visible role content</main>", status=200)
        ),
        extractors=(
            TierExtractor(
                tier=ExtractionTier.LLM_ASSISTED,
                extractor=_StaticExtractor(
                    ExtractionResult(ok=True, full_description=FullDescription(text="Short description"))
                ),
            ),
        ),
    )
    result = acquisition.acquire(
        url="https://x",
        source_id=SOURCE_ID,
        tenant_id="local",
        job_id="job-1",
        filter_override=audit,
    )

    assert result.ok
    assert result.quarantine_reason is QuarantineReason.NONE
    assert result.description_hash is not None
    snapshot_set = snapshot_set_from_result(result, audit)
    assert snapshot_set.latest_snapshot is not None
    override = snapshot_set.latest_snapshot.to_dict()["filter_override"]
    assert override == {
        "source_id": SOURCE_ID,
        "overridden_filter": "low_confidence_extraction",
        "reason": "user approved trusted source",
        "requested_by": "user:eloi",
        "overridden_at": NOW,
    }


def snapshot_set_from_result(result, audit: FilterOverrideAudit):  # type: ignore[no-untyped-def]
    snapshot_set = PostingSnapshotSet.empty(tenant_id=LOCAL_TENANT, job_id=JOB_ID, updated_at=NOW)
    assert result.description_hash is not None
    snapshot_set, _ = snapshot_set.record_snapshot(
        source_id=SOURCE_ID,
        extraction_tier=result.extraction_tier,
        description_hash=result.description_hash,
        apply_url=result.apply_url,
        active_state=result.active_state,
        confidence=result.confidence,
        quarantine_reason=result.quarantine_reason,
        captured_at=NOW,
        filter_override=audit,
        evidence=result.evidence,
    )
    return snapshot_set


def test_filter_override_rejects_disallowed_policy() -> None:
    with pytest.raises(FilterOverrideError):
        FilterOverrideLogger().record(
            source_id=SOURCE_ID,
            policy=ContentFilterOverridePolicy(
                allowed=False,
                requires_reason=True,
                allowed_filters=("low_confidence_extraction",),
            ),
            overridden_filter="low_confidence_extraction",
            reason="user approved trusted source",
            requested_by="user:eloi",
            overridden_at=NOW,
        )


def test_quarantined_snapshot_does_not_promote_to_job_enrichment() -> None:
    acquisition = ContentAcquisitionService(
        fetcher=_CannedFetcher(
            DetailPage(url="https://x", html="<main>Visible role content</main>", status=200)
        ),
        extractors=(
            TierExtractor(
                tier=ExtractionTier.LLM_ASSISTED,
                extractor=_StaticExtractor(
                    ExtractionResult(
                        ok=True,
                        full_description=FullDescription(text="Short description"),
                        application_url=ApplicationUrl(value="https://apply"),
                    )
                ),
            ),
        ),
    )
    enrichment_repository = _MemoryEnrichmentRepository()
    publisher = _RecordingPublisher()
    use_case = CapturePostingSnapshotUseCase(
        snapshot_repository=_MemorySnapshotRepository(),
        acquisition_service=acquisition,
        publisher=publisher,
        enrichment_repository=enrichment_repository,
    )

    outcome = use_case.execute(
        tenant_id=LOCAL_TENANT,
        job_id=JOB_ID,
        url="https://boards.greenhouse.io/acme/jobs/1",
        source_id=SOURCE_ID,
        promote_to_job_enrichment=True,
    )

    assert outcome.ok
    assert not outcome.promoted_to_job_enrichment
    assert enrichment_repository.load(LOCAL_TENANT, JOB_ID) is None
    assert "JobEnriched" not in [event.event_type for event in publisher.published]


def test_inactive_snapshot_does_not_promote_to_job_enrichment() -> None:
    enrichment_repository = _MemoryEnrichmentRepository()
    publisher = _RecordingPublisher()
    use_case = _snapshot_use_case(
        page=_json_ld_page(valid_through="2000-01-01T00:00:00+00:00"),
        publisher=publisher,
        snapshot_repository=_MemorySnapshotRepository(),
        enrichment_repository=enrichment_repository,
    )

    outcome = use_case.execute(
        tenant_id=LOCAL_TENANT,
        job_id=JOB_ID,
        url="https://boards.greenhouse.io/acme/jobs/1",
        source_id=SOURCE_ID,
        promote_to_job_enrichment=True,
    )

    assert outcome.ok
    assert outcome.snapshot_set.latest_active_state is ActiveState.EXPIRED
    assert not outcome.promoted_to_job_enrichment
    assert enrichment_repository.load(LOCAL_TENANT, JOB_ID) is None
    assert "JobEnriched" not in [event.event_type for event in publisher.published]


def test_later_snapshots_do_not_reopen_enriched_job_enrichment() -> None:
    enrichment_repository = _MemoryEnrichmentRepository()
    existing = (
        JobEnrichment.empty(tenant_id=LOCAL_TENANT, job_id=JOB_ID, updated_at=NOW)
        .start_attempt(extraction_tier=ExtractionTier.JSON_LD, started_at=NOW)
        .succeed_attempt(
            full_description=FullDescription(text="Original enriched description"),
            application_url=ApplicationUrl(value="https://old-apply"),
            extraction_tier=ExtractionTier.JSON_LD,
            finished_at=NOW,
        )
    )
    enrichment_repository.save(existing)
    repository = _MemorySnapshotRepository()
    use_case = _snapshot_use_case(
        page=_json_ld_page(),
        publisher=_RecordingPublisher(),
        snapshot_repository=repository,
        enrichment_repository=enrichment_repository,
    )

    outcome = use_case.execute(
        tenant_id=LOCAL_TENANT,
        job_id=JOB_ID,
        url="https://boards.greenhouse.io/acme/jobs/1",
        source_id=SOURCE_ID,
        promote_to_job_enrichment=True,
    )

    assert outcome.ok
    assert not outcome.promoted_to_job_enrichment
    saved = enrichment_repository.load(LOCAL_TENANT, JOB_ID)
    assert saved is existing
    assert saved.full_description is not None
    assert saved.full_description.text == "Original enriched description"
