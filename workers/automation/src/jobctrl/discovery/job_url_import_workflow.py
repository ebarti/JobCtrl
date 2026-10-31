"""Temporal orchestration for importing one explicit job-posting URL."""

from __future__ import annotations
from jobctrl.domain.enrichment.snapshot_services import ActiveStateVerifier

import hashlib
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from jobctrl.infrastructure.enrichment.posting_sources import (
    posting_page_sources as _posting_page_sources,
    rendered_page_text as _rendered_page_text,
)

from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError, CancelledError, is_cancelled_exception

with workflow.unsafe.imports_passed_through():
    from jobctrl.infrastructure.temporal.finalize import (
        emit_workflow_outcome,
        emit_workflow_started,
    )


@dataclass(frozen=True)
class JobUrlImportWorkflowInput:
    tenant_id: str
    url: str
    expected_app_dir: str | None = None
    expected_db_path: str | None = None


@dataclass(frozen=True)
class JobUrlImportActivityOutput:
    outcome: str
    job_id: str | None = None
    item_id: str | None = None
    reason: str | None = None
    imported_at: str | None = None
    already_existed: bool = False


@dataclass(frozen=True)
class JobUrlImportWorkflowResult:
    status: str
    outcome: str | None = None
    job_id: str | None = None
    item_id: str | None = None
    reason: str | None = None
    imported_at: str | None = None
    already_existed: bool = False
    error: str | None = None
    error_code: str | None = None


_IMPORT_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=2),
    maximum_interval=timedelta(seconds=10),
    maximum_attempts=2,
    non_retryable_error_types=["invalid_url", "RuntimeIdentityMismatch"],
)
_DEFAULT_TIMEOUT = timedelta(minutes=10)


class _DeferredEventPublisher:
    """Leave durable event publication to the convergent import boundary."""

    def publish(self, _event: object) -> None:
        return None


@activity.defn(name="job_url_import")
async def job_url_import_activity(
    payload: JobUrlImportWorkflowInput,
) -> JobUrlImportActivityOutput:
    from jobctrl.infrastructure.temporal.run_in_activity import run_blocking_with_heartbeat
    from jobctrl.infrastructure.temporal.runtime_guard import assert_activity_runtime

    assert_activity_runtime(
        expected_app_dir=payload.expected_app_dir,
        expected_db_path=payload.expected_db_path,
    )
    return await run_blocking_with_heartbeat(
        lambda: _execute_job_url_import_and_start_preparation(payload),
        starting_message="job URL import starting",
        progress_message="job URL import still running",
        activity_name="job_url_import",
    )


def _execute_job_url_import_and_start_preparation(
    payload: JobUrlImportWorkflowInput,
    *,
    conn: sqlite3.Connection | None = None,
    fetcher: Any | None = None,
    url_validator: Callable[[str], Any] | None = None,
    workflow_starter: Any | None = None,
) -> JobUrlImportActivityOutput:
    """Import one posting and hand a fresh job to durable preparation.

    Import owns intake and enrichment convergence. Preparation remains a
    separate root workflow so the import workflow may finish without
    terminating score, tailor, cover-letter, or PDF work. Apply is deliberately
    absent from that workflow.
    """
    from jobctrl.database import get_connection
    from jobctrl.domain.identifiers import canonical_job_id
    from jobctrl.domain.tenant import TenantId
    from jobctrl.pipeline.preparation import start_job_preparation_workflow

    connection = conn or get_connection()
    output = execute_job_url_import(
        payload,
        conn=connection,
        fetcher=fetcher,
        url_validator=url_validator,
    )
    if (
        output.outcome == "imported"
        and output.job_id is not None
        and _imported_job_needs_preparation(
            connection,
            tenant_id=payload.tenant_id,
            job_id=output.job_id,
        )
    ):
        start_job_preparation_workflow(
            canonical_job_id(output.job_id),
            tenant_id=TenantId(payload.tenant_id),
            workflow_starter=workflow_starter,
            connection=connection,
        )
    return output


def execute_job_url_import(
    payload: JobUrlImportWorkflowInput,
    *,
    conn: sqlite3.Connection | None = None,
    fetcher: Any | None = None,
    url_validator: Callable[[str], Any] | None = None,
    determination_dependencies: dict | None = None,
) -> JobUrlImportActivityOutput:
    """Fetch, determine page meaning, and ingest one public posting URL.

    Inaccessible or ambiguous pages never create a placeholder job. They enter
    the existing Manual Capture queue so a user can supply the page content.
    """
    from jobctrl.database import get_connection
    from jobctrl.domain.discovery.identity import AtsKind
    from jobctrl.domain.discovery.source_registry import ManualActionReason
    from jobctrl.domain.discovery.use_cases import DiscoverJobsUseCase
    from jobctrl.domain.discovery.value_objects import (
        Employer,
        JobMetadata,
        PostingUrl,
        SearchStrategy,
        Source,
    )
    from jobctrl.domain.enrichment.snapshot_services import ContentAcquisitionService, TierExtractor
    from jobctrl.domain.enrichment.snapshot_use_case import CapturePostingSnapshotUseCase
    from jobctrl.domain.enrichment import ExtractionTier
    from jobctrl.domain.ports.discovery import ScrapedJobPosting
    from jobctrl.domain.tenant import TenantId
    from jobctrl.infrastructure.discovery.production_wiring import (
        DurableJobEventPublisher,
    )
    from jobctrl.infrastructure.discovery.sqlite_repository import SqliteJobRepository
    from jobctrl.infrastructure.enrichment import (
        SqliteEnrichmentRepository,
        SqlitePostingSnapshotSetRepository,
    )
    from jobctrl.infrastructure.enrichment.playwright_fetcher import (
        DetailPageFetchBlocked,
        DetailPageFetchUnavailable,
        PlaywrightDetailPageFetcher,
    )
    from jobctrl.infrastructure.network import validate_public_http_url

    url = payload.url.strip()
    active_url_validator = url_validator or validate_public_http_url
    safety = active_url_validator(url)
    if not safety.allowed:
        raise ApplicationError(
            "Only public HTTP or HTTPS job URLs can be imported.",
            type="invalid_url",
            non_retryable=True,
        )

    connection = conn or get_connection()
    tenant_id = TenantId(payload.tenant_id)
    repository = SqliteJobRepository(connection)
    existing = repository.resolve_by_posting_url(tenant_id, PostingUrl(value=url))
    if existing is None:
        captured = connection.execute(
            """
            SELECT DISTINCT j.job_id
            FROM manual_capture_queue m
            JOIN jobs j ON j.tenant_id=m.tenant_id AND j.job_id=m.job_id
            WHERE m.tenant_id=? AND m.originating_url=? AND m.status='imported'
            """,
            (str(tenant_id), url),
        ).fetchall()
        if len(captured) == 1:
            return _imported_output(
                captured[0][0], already_existed=True, conn=connection, resolved_urls=(url,),
            )
    if existing is not None:
        source_native_id = _manual_import_source_native_id(
            connection,
            tenant_id=str(tenant_id),
            job_id=str(existing.job_id),
        )
        if source_native_id is None:
            return _imported_output(
                existing.job_id,
                already_existed=True,
                conn=connection,
                resolved_urls=(url,),
            )
        _ensure_discovery_events(
            connection,
            repository=repository,
            tenant_id=tenant_id,
            job_id=existing.job_id,
            source_native_id=source_native_id,
        )
        if _ensure_existing_snapshot_event(
            connection,
            tenant_id=tenant_id,
            job_id=existing.job_id,
            source_native_id=source_native_id,
        ):
            _ensure_posted_compensation_fact(
                connection,
                tenant_id=tenant_id,
                job_id=existing.job_id,
                source_native_id=source_native_id,
            )
            if _ensure_imported_job_pipeline_state(
                connection,
                tenant_id=tenant_id,
                job_id=existing.job_id,
                source_native_id=source_native_id,
            ):
                return _imported_output(
                    existing.job_id,
                    already_existed=True,
                    conn=connection,
                    resolved_urls=(url,),
                )
            if not _imported_snapshot_is_preparation_eligible(
                connection,
                tenant_id=tenant_id,
                job_id=existing.job_id,
            ):
                return _imported_output(
                    existing.job_id,
                    already_existed=True,
                    conn=connection,
                    resolved_urls=(url,),
                )

    active_fetcher = fetcher or PlaywrightDetailPageFetcher(raise_on_unavailable=True)
    try:
        page = active_fetcher.fetch(url)
    except DetailPageFetchBlocked as exc:
        manual_reason = _fetch_block_reason(exc.reason_code)
        if manual_reason is not None:
            return _manual_capture_output(connection, url=url, reason=manual_reason)
        if exc.reason_code == "unsafe_redirect":
            raise ApplicationError(
                "Only public HTTP or HTTPS job URLs can be imported.",
                type="invalid_url",
                non_retryable=True,
            ) from exc
        raise ApplicationError(
            "The posting page could not be fetched yet.",
            type="job_url_import_fetch_failed",
        ) from exc
    except DetailPageFetchUnavailable as exc:
        raise ApplicationError(
            "The posting page could not be fetched yet.",
            type="job_url_import_fetch_failed",
        ) from exc
    except Exception as exc:
        raise ApplicationError(
            "The posting page could not be fetched yet.",
            type="job_url_import_fetch_failed",
        ) from exc

    hard_block = _hard_block_reason(page)
    if hard_block is not None:
        return _manual_capture_output(connection, url=url, reason=hard_block)
    if _transient_acquisition_failure(page):
        raise ApplicationError(
            "The posting page could not be fetched yet.",
            type="job_url_import_fetch_failed",
        )

    final_url = str(getattr(page, "final_url", "") or url).strip()
    if not active_url_validator(final_url).allowed:
        raise ApplicationError(
            "Only public HTTP or HTTPS job URLs can be imported.", type="invalid_url", non_retryable=True
        )
    for frame in getattr(page, "embedded_pages", ()):
        if not active_url_validator(frame.final_url or frame.url).allowed:
            raise ApplicationError(
                "The embedded posting source is not public HTTP or HTTPS.", type="invalid_url", non_retryable=True,
            )
    redirected_existing = repository.resolve_by_posting_url(tenant_id, PostingUrl(value=final_url))
    if redirected_existing is not None and final_url != url:
        native_id = _manual_import_source_native_id(
            connection, tenant_id=str(tenant_id), job_id=str(redirected_existing.job_id)
        )
        if native_id is None:
            return _imported_output(
                redirected_existing.job_id, already_existed=True, conn=connection, resolved_urls=(url, final_url)
            )
        _ensure_discovery_events(
            connection,
            repository=repository,
            tenant_id=tenant_id,
            job_id=redirected_existing.job_id,
            source_native_id=native_id,
        )
        if _ensure_existing_snapshot_event(
            connection, tenant_id=tenant_id, job_id=redirected_existing.job_id, source_native_id=native_id
        ):
            _ensure_posted_compensation_fact(
                connection, tenant_id=tenant_id, job_id=redirected_existing.job_id, source_native_id=native_id
            )
            _ensure_imported_job_pipeline_state(
                connection, tenant_id=tenant_id, job_id=redirected_existing.job_id, source_native_id=native_id
            )
            return _imported_output(
                redirected_existing.job_id, already_existed=True, conn=connection, resolved_urls=(url, final_url)
            )

    from jobctrl.infrastructure.determinations import determination_dependencies as configured_dependencies
    from jobctrl.domain.enrichment.page_interpretation import ModelPageInterpreter
    from jobctrl.domain.determinations import DeterminationFailure

    dependencies = determination_dependencies or configured_dependencies(
        connection, tenant_id=str(tenant_id), lane="enrichment"
    )
    rendered = _rendered_page_text(page)
    try:
        prepared_sources = _posting_page_sources(page, entity_id=url)
        page_result, _ = ModelPageInterpreter(**dependencies).interpret(
            entity_id=url,
            text=rendered,
            metadata={
                "url": url,
                "final_url": str(getattr(page, "final_url", url)),
                "http_status": getattr(page, "status", None),
                "status_evidence_complete": getattr(page, "status_evidence_complete", True),
                "status_evidence_reason": getattr(page, "status_evidence_reason", ""),
                "visibility_verified": getattr(page, "status_visibility_verified", False),
                "structured_postings": getattr(page, "json_ld", ()),
                "embedded_pages": [{
                    "url": frame.final_url or frame.url,
                    "status_evidence_complete": frame.status_evidence_complete,
                } for frame in getattr(page, "embedded_pages", ())],
            },
            additional_sources=[source for source in prepared_sources[0] if source.source_id != "rendered_page"],
        )
        if (
            page_result.access_state.value in {"login_required", "challenge"}
            or page_result.page_kind.value != "posting"
            or page_result.availability.value in {"closed", "expired", "removed"}
        ):
            reasons = {
                "login_required": ManualActionReason.LOGIN_REQUIRED,
                "challenge": ManualActionReason.BOT_DETECTION,
            }
            return _manual_capture_output(
                connection,
                url=url,
                reason=reasons.get(page_result.access_state.value, ManualActionReason.AMBIGUOUS_CAREER_SYSTEM),
            )
        extracted = _extract_posting_page(page, dependencies=dependencies, entity_id=url, prepared_sources=prepared_sources)
    except DeterminationFailure as error:
        raise ApplicationError(
            error.code, type="semantic_determination_" + error.code, non_retryable=not error.retryable,
        ) from None

    final_url = str(getattr(page, "final_url", "") or url).strip()
    final_safety = active_url_validator(final_url)
    if not final_safety.allowed:
        raise ApplicationError(
            "Only public HTTP or HTTPS job URLs can be imported.",
            type="invalid_url",
            non_retryable=True,
        )
    canonical_url = final_url
    canonical_existing = repository.resolve_by_posting_url(
        tenant_id,
        PostingUrl(value=canonical_url),
    )
    if canonical_existing is not None:
        source_native_id = _manual_import_source_native_id(
            connection,
            tenant_id=str(tenant_id),
            job_id=str(canonical_existing.job_id),
        )
        if source_native_id is None:
            return _imported_output(
                canonical_existing.job_id,
                already_existed=True,
                conn=connection,
                resolved_urls=(url, canonical_url),
            )
        _ensure_discovery_events(
            connection,
            repository=repository,
            tenant_id=tenant_id,
            job_id=canonical_existing.job_id,
            source_native_id=source_native_id,
        )
        if _ensure_existing_snapshot_event(
            connection,
            tenant_id=tenant_id,
            job_id=canonical_existing.job_id,
            source_native_id=source_native_id,
        ):
            _ensure_posted_compensation_fact(
                connection,
                tenant_id=tenant_id,
                job_id=canonical_existing.job_id,
                source_native_id=source_native_id,
            )
            if _ensure_imported_job_pipeline_state(
                connection,
                tenant_id=tenant_id,
                job_id=canonical_existing.job_id,
                source_native_id=source_native_id,
            ):
                return _imported_output(
                    canonical_existing.job_id,
                    already_existed=True,
                    conn=connection,
                    resolved_urls=(url, canonical_url),
                )
            if not _imported_snapshot_is_preparation_eligible(
                connection,
                tenant_id=tenant_id,
                job_id=canonical_existing.job_id,
            ):
                return _imported_output(
                    canonical_existing.job_id,
                    already_existed=True,
                    conn=connection,
                    resolved_urls=(url, canonical_url),
                )
        identity = canonical_existing
        already_existed = True
    else:
        source_native_id = hashlib.sha256(canonical_url.encode("utf-8")).hexdigest()
        identity = None
        already_existed = False

    application_url = extracted["application_url"]
    if application_url and not active_url_validator(application_url).allowed:
        raise ApplicationError(
            "The extracted application URL is not public HTTP or HTTPS.", type="invalid_url", non_retryable=True
        )

    posting = ScrapedJobPosting(
        posting_url=PostingUrl(value=canonical_url),
        source=Source(board="Direct URL import"),
        employer=(Employer(name=extracted["employer"]) if extracted["employer"] else Employer.unknown()),
        metadata=JobMetadata(
            title=extracted["title"],
            salary=extracted["salary"],
            description=extracted["description"],
            location=extracted["location"],
        ),
        strategy=SearchStrategy.MANUAL,
        source_id="manual_url_import",
        source_native_id=source_native_id,
        canonical_url=canonical_url,
        ats_kind=AtsKind.OTHER,
    )
    if identity is None:
        try:
            DiscoverJobsUseCase(
                repository=repository,
                publisher=_DeferredEventPublisher(),
            ).execute(
                tenant_id=tenant_id,
                postings=(posting,),
                run_id=f"job-url-import:{source_native_id}",
            )
        except BaseException:
            connection.rollback()
            raise
        identity = repository.resolve_by_posting_url(
            tenant_id,
            PostingUrl(value=canonical_url),
        )
    if identity is None:
        raise ApplicationError("Canonical job import was not persisted.", type="job_import_not_persisted", non_retryable=True)
    _ensure_discovery_events(
        connection,
        repository=repository,
        tenant_id=tenant_id,
        job_id=identity.job_id,
        source_native_id=source_native_id,
    )
    _ensure_posted_compensation_fact(
        connection,
        tenant_id=tenant_id,
        job_id=identity.job_id,
        source_native_id=source_native_id,
    )

    class _FetchedPage:
        def fetch(self, _url: str) -> object:
            return page

    acquisition = ContentAcquisitionService(
        active_verifier=ActiveStateVerifier(page_interpreter=ModelPageInterpreter(**dependencies)),
        fetcher=_FetchedPage(),
        extractors=(
            TierExtractor(
                tier=ExtractionTier.JSON_LD,
                extractor=_SelectedPostingExtractor(extracted["description"], application_url),
            ),
        ),
    )
    snapshot_publisher = DurableJobEventPublisher(
        connection,
        stage="enrich",
        idempotency_prefix=_event_prefix(str(tenant_id), source_native_id),
    )
    snapshot_outcome = CapturePostingSnapshotUseCase(
        snapshot_repository=SqlitePostingSnapshotSetRepository(connection),
        acquisition_service=acquisition,
        publisher=snapshot_publisher,
        enrichment_repository=SqliteEnrichmentRepository(connection),
    ).execute(
        tenant_id=tenant_id,
        job_id=identity.job_id,
        url=canonical_url,
        source_id="manual_url_import",
        policy_id="explicit_job_url_import",
        promote_to_job_enrichment=True,
    )
    if not snapshot_outcome.ok or snapshot_outcome.captured_snapshot_version is None:
        raise ApplicationError(
            "The posting snapshot could not be persisted yet.",
            type="job_url_import_snapshot_failed",
        )
    if not _ensure_existing_snapshot_event(
        connection,
        tenant_id=tenant_id,
        job_id=identity.job_id,
        source_native_id=source_native_id,
    ):
        raise ApplicationError(
            "The posting snapshot could not be verified yet.",
            type="job_url_import_snapshot_failed",
        )
    pipeline_ready = _ensure_imported_job_pipeline_state(
        connection,
        tenant_id=tenant_id,
        job_id=identity.job_id,
        source_native_id=source_native_id,
    )
    if not pipeline_ready and _imported_snapshot_is_preparation_eligible(
        connection,
        tenant_id=tenant_id,
        job_id=identity.job_id,
    ):
        raise ApplicationError(
            "The imported posting could not enter the preparation pipeline yet.",
            type="job_url_import_enrichment_failed",
        )
    return _imported_output(
        identity.job_id,
        already_existed=already_existed,
        conn=connection,
        resolved_urls=(url, canonical_url),
    )


def _imported_output(
    job_id: object,
    *,
    already_existed: bool,
    conn: sqlite3.Connection,
    resolved_urls: tuple[str, ...],
) -> JobUrlImportActivityOutput:
    _resolve_manual_capture_after_import(
        conn,
        job_id=str(job_id),
        resolved_urls=resolved_urls,
    )
    return JobUrlImportActivityOutput(
        outcome="imported",
        job_id=str(job_id),
        imported_at=datetime.now(timezone.utc).isoformat(),
        already_existed=already_existed,
    )


def _resolve_manual_capture_after_import(
    conn: sqlite3.Connection,
    *,
    job_id: str,
    resolved_urls: tuple[str, ...],
) -> None:
    urls = tuple(dict.fromkeys(url.strip() for url in resolved_urls if url.strip()))
    if not urls:
        return
    placeholders = ", ".join("?" for _ in urls)
    conn.execute(
        f"""
        UPDATE manual_capture_queue
           SET status = 'imported',
               imported_at = ?,
               dismissed_at = NULL,
               captured_url = originating_url,
               future_manual_action_required = 0,
               job_id = ?
         WHERE tenant_id = 'local'
           AND source_id = 'manual_url_import'
           AND status = 'pending'
           AND CASE WHEN json_valid(retry_context_json) THEN
                 json_type(retry_context_json, '$.manual_capture_draft') IS NULL
                 AND json_type(retry_context_json, '$.manual_capture_legacy_owner') IS NULL
               ELSE 0 END
           AND originating_url IN ({placeholders})
        """,
        (datetime.now(timezone.utc).isoformat(), job_id, *urls),
    )
    conn.commit()


def _event_prefix(tenant_id: str, source_native_id: str) -> str:
    tenant_hash = hashlib.sha256(tenant_id.encode("utf-8")).hexdigest()
    return f"job-url-import:{tenant_hash}:{source_native_id}"


def _manual_import_source_native_id(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    job_id: str,
) -> str | None:
    row = conn.execute(
        """
        SELECT source_native_id
        FROM job_source_observations
        WHERE tenant_id = ? AND job_id = ? AND source_id = 'manual_url_import'
        LIMIT 1
        """,
        (tenant_id, job_id),
    ).fetchone()
    if row is None:
        return None
    value = row["source_native_id"] if isinstance(row, sqlite3.Row) else row[0]
    text = str(value or "").strip()
    return text or None


def _ensure_discovery_events(
    conn: sqlite3.Connection,
    *,
    repository: Any,
    tenant_id: Any,
    job_id: Any,
    source_native_id: str,
) -> None:
    from jobctrl.domain.events import (
        CanonicalJobIdentityResolvedPayload,
        JobDiscoveredPayload,
        JobSourceObservedPayload,
        create_canonical_job_identity_resolved,
        create_job_discovered,
        create_job_source_observed,
    )
    from jobctrl.infrastructure.discovery.production_wiring import DurableJobEventPublisher

    job = repository.load(tenant_id, job_id)
    identity = repository.load_canonical_identity(tenant_id, job_id)
    observation = conn.execute(
        """
        SELECT source_observation_id, source_id, source_native_id,
               observed_url, run_id, observed_at
        FROM job_source_observations
        WHERE tenant_id = ? AND job_id = ? AND source_id = 'manual_url_import'
        LIMIT 1
        """,
        (str(tenant_id), str(job_id)),
    ).fetchone()
    if job is None or identity is None or observation is None:
        raise RuntimeError("Manual URL import is missing canonical discovery evidence")

    def observed(key: str, index: int) -> str:
        value = observation[key] if isinstance(observation, sqlite3.Row) else observation[index]
        return str(value or "")

    publisher = DurableJobEventPublisher(
        conn,
        stage="discover",
        idempotency_prefix=_event_prefix(str(tenant_id), source_native_id),
    )
    publisher.publish(
        create_job_discovered(
            tenant_id,
            JobDiscoveredPayload(
                job_id=str(job.job_id),
                posting_url=job.posting_url.value,
                source=job.source.board,
                employer=job.employer.name,
                metadata=job.metadata.to_dict(),
                discovered_at=job.discovered_at,
            ),
        )
    )
    publisher.publish(
        create_canonical_job_identity_resolved(
            tenant_id,
            CanonicalJobIdentityResolvedPayload(
                job_id=str(job.job_id),
                canonical_url=identity.canonical_url,
                ats_kind=identity.ats_kind.value,
                source_native_id=identity.source_native_id,
                confidence=identity.confidence,
            ),
        )
    )
    publisher.publish(
        create_job_source_observed(
            tenant_id,
            JobSourceObservedPayload(
                job_id=str(job.job_id),
                source_observation_id=observed("source_observation_id", 0),
                source_id=observed("source_id", 1),
                source_native_id=observed("source_native_id", 2),
                observed_url=observed("observed_url", 3),
                run_id=observed("run_id", 4),
                observed_at=observed("observed_at", 5),
            ),
        )
    )


def _ensure_existing_snapshot_event(
    conn: sqlite3.Connection,
    *,
    tenant_id: Any,
    job_id: Any,
    source_native_id: str,
) -> bool:
    from jobctrl.domain.events import (
        PostingContentSnapshotCapturedPayload,
        create_posting_content_snapshot_captured,
    )
    from jobctrl.infrastructure.discovery.production_wiring import DurableJobEventPublisher
    from jobctrl.infrastructure.enrichment import SqlitePostingSnapshotSetRepository

    snapshot_set = SqlitePostingSnapshotSetRepository(conn).load(tenant_id, job_id)
    latest = snapshot_set.latest_snapshot if snapshot_set is not None else None
    if latest is None:
        return False
    DurableJobEventPublisher(
        conn,
        stage="enrich",
        idempotency_prefix=_event_prefix(str(tenant_id), source_native_id),
    ).publish(
        create_posting_content_snapshot_captured(
            tenant_id,
            PostingContentSnapshotCapturedPayload(
                job_id=str(job_id),
                snapshot_version=latest.snapshot_version,
                snapshot_ref=f"{job_id}:{latest.snapshot_version}",
                source_id=latest.source_id,
                extraction_tier=latest.extraction_tier,
                captured_at=latest.captured_at,
            ),
        )
    )
    return True


def _ensure_posted_compensation_fact(
    conn: sqlite3.Connection,
    *,
    tenant_id: Any,
    job_id: Any,
    source_native_id: str,
) -> None:
    """Project employer-stated pay through the canonical posted-pay parser."""

    from jobctrl.infrastructure.compensation import (
        SqlitePostedCompensationRepository,
        posted_compensation_source_from_job,
    )

    # Canonical intake and its idempotent events are a completed import phase.
    # Optional posted-pay inference must not keep that phase's writer reserved.
    conn.commit()
    row = conn.execute(
        """
        SELECT jobs.job_id, jobs.salary,
               enrichments.full_description AS enrichment_description,
               jobs.full_description, jobs.description
        FROM jobs
        LEFT JOIN job_enrichments AS enrichments
          ON enrichments.tenant_id = jobs.tenant_id
         AND enrichments.job_id = jobs.job_id
         AND enrichments.current_status = 'enriched'
        WHERE jobs.tenant_id = ? AND jobs.job_id = ?
        """,
        (str(tenant_id), str(job_id)),
    ).fetchone()
    if row is None:
        raise RuntimeError("Manual URL import is missing its canonical job row")
    source_text, source_field = posted_compensation_source_from_job(row)
    from jobctrl.domain.determinations import DeterminationFailure

    try:
        SqlitePostedCompensationRepository(conn).parse_and_save_job_salary(
            job_id,
            source_text,
            tenant_id=str(tenant_id),
            source_field=source_field,
            parsed_at=datetime.now(timezone.utc).isoformat(),
            event_idempotency_key=f"{_event_prefix(str(tenant_id), source_native_id)}:posted-compensation",
        )
    except DeterminationFailure:
        # The admitted job survives an unavailable pay extraction. The blocked
        # determination state is already persisted; there is no inferred fact.
        return


def _ensure_imported_job_pipeline_state(
    conn: sqlite3.Connection,
    *,
    tenant_id: Any,
    job_id: Any,
    source_native_id: str,
) -> bool:
    """Converge one usable import to completed intake and enrichment facts."""
    from jobctrl.state import ensure_job_stage_rows, record_job_event, set_stage_state

    if not _imported_snapshot_is_preparation_eligible(
        conn,
        tenant_id=tenant_id,
        job_id=job_id,
    ):
        return False

    enrichment = _load_or_repair_imported_job_enrichment(
        conn,
        tenant_id=tenant_id,
        job_id=job_id,
        source_native_id=source_native_id,
    )
    if enrichment is None or not enrichment.is_enriched:
        return False
    job_row = conn.execute(
        """
        SELECT discovered_at
        FROM jobs
        WHERE tenant_id = ? AND job_id = ?
        """,
        (str(tenant_id), str(job_id)),
    ).fetchone()
    if job_row is None:
        raise RuntimeError("Manual URL import is missing its canonical job row")
    discovered_at = str((job_row["discovered_at"] if isinstance(job_row, sqlite3.Row) else job_row[0]) or "")
    finished_at = enrichment.enriched_at or datetime.now(timezone.utc).isoformat()
    started_at = enrichment.last_attempt.started_at if enrichment.last_attempt is not None else finished_at
    attempt_count = max(1, enrichment.attempt_count)

    try:
        ensure_job_stage_rows(
            conn,
            job_id,
            tenant_id=tenant_id,
            discovered_at=discovered_at or None,
        )
        discovery_row = conn.execute(
            """
            SELECT state, attempt_count
            FROM job_stage_states
            WHERE tenant_id = ? AND job_id = ? AND stage = 'discover'
            """,
            (str(tenant_id), str(job_id)),
        ).fetchone()
        discovery_state = str(
            (discovery_row["state"] if isinstance(discovery_row, sqlite3.Row) else discovery_row[0])
            if discovery_row is not None
            else ""
        )
        discovery_attempt_count = max(
            1,
            int((discovery_row["attempt_count"] if isinstance(discovery_row, sqlite3.Row) else discovery_row[1]) or 0)
            if discovery_row is not None
            else 1,
        )
        if discovery_state != "succeeded":
            discovery_finished_at = discovered_at or finished_at
            if discovery_state != "running":
                try:
                    set_stage_state(
                        conn,
                        job_id,
                        "discover",
                        "running",
                        tenant_id=tenant_id,
                        attempt_count=discovery_attempt_count,
                        started_at=discovery_finished_at,
                    )
                except ValueError:
                    set_stage_state(
                        conn,
                        job_id,
                        "discover",
                        "running",
                        tenant_id=tenant_id,
                        attempt_count=discovery_attempt_count,
                        started_at=discovery_finished_at,
                        validate_transition=False,
                    )
            set_stage_state(
                conn,
                job_id,
                "discover",
                "succeeded",
                tenant_id=tenant_id,
                attempt_count=discovery_attempt_count,
                started_at=discovery_finished_at,
                finished_at=discovery_finished_at,
            )
        stage_row = conn.execute(
            """
            SELECT state
            FROM job_stage_states
            WHERE tenant_id = ? AND job_id = ? AND stage = 'enrich'
            """,
            (str(tenant_id), str(job_id)),
        ).fetchone()
        stage_state = str(
            (stage_row["state"] if isinstance(stage_row, sqlite3.Row) else stage_row[0])
            if stage_row is not None
            else ""
        )
        if stage_state != "succeeded":
            if stage_state != "running":
                try:
                    set_stage_state(
                        conn,
                        job_id,
                        "enrich",
                        "running",
                        tenant_id=tenant_id,
                        attempt_count=attempt_count,
                        started_at=started_at,
                    )
                except ValueError:
                    set_stage_state(
                        conn,
                        job_id,
                        "enrich",
                        "running",
                        tenant_id=tenant_id,
                        attempt_count=attempt_count,
                        started_at=started_at,
                        validate_transition=False,
                    )
            set_stage_state(
                conn,
                job_id,
                "enrich",
                "succeeded",
                tenant_id=tenant_id,
                attempt_count=attempt_count,
                started_at=started_at,
                finished_at=finished_at,
            )
        record_job_event(
            conn,
            job_id,
            "enrich",
            "StageCompleted",
            tenant_id=tenant_id,
            message="Direct URL import completed posting enrichment.",
            payload={
                "source": "manual_url_import",
                "sourceNativeId": source_native_id,
                "extractionTier": (
                    enrichment.extraction_tier.value if enrichment.extraction_tier is not None else "unknown"
                ),
            },
            occurred_at=finished_at,
            publisher=_DeferredEventPublisher(),
            idempotency_key=(f"{_event_prefix(str(tenant_id), source_native_id)}:enrichment-stage-completed"),
        )
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    return True


def _load_or_repair_imported_job_enrichment(
    conn: sqlite3.Connection,
    *,
    tenant_id: Any,
    job_id: Any,
    source_native_id: str,
) -> Any | None:
    """Recover legacy imports only when canonical text matches snapshot proof."""
    from jobctrl.domain.enrichment import ExtractionTier
    from jobctrl.domain.enrichment.aggregate import JobEnrichment
    from jobctrl.domain.enrichment.snapshot_value_objects import SnapshotDescriptionHash
    from jobctrl.domain.enrichment.value_objects import ApplicationUrl, FullDescription
    from jobctrl.domain.events import JobEnrichedPayload, create_job_enriched
    from jobctrl.infrastructure.discovery.production_wiring import DurableJobEventPublisher
    from jobctrl.infrastructure.enrichment import (
        SqliteEnrichmentRepository,
        SqlitePostingSnapshotSetRepository,
    )

    repository = SqliteEnrichmentRepository(conn)
    enrichment = repository.load(tenant_id, job_id)
    if enrichment is not None and enrichment.is_running:
        return None
    if enrichment is None or not enrichment.is_enriched:
        snapshot_set = SqlitePostingSnapshotSetRepository(conn).load(tenant_id, job_id)
        latest = snapshot_set.latest_snapshot if snapshot_set is not None else None
        if latest is None or not _imported_snapshot_is_preparation_eligible(
            conn,
            tenant_id=tenant_id,
            job_id=job_id,
        ):
            return None
        row = conn.execute(
            """
            SELECT full_description, description
            FROM jobs
            WHERE tenant_id = ? AND job_id = ?
            """,
            (str(tenant_id), str(job_id)),
        ).fetchone()
        if row is None:
            return None
        if isinstance(row, sqlite3.Row):
            candidates = (row["full_description"], row["description"])
        else:
            candidates = (row[0], row[1])
        description = next(
            (
                str(candidate).strip()
                for candidate in candidates
                if candidate and SnapshotDescriptionHash.from_text(str(candidate).strip()) == latest.description_hash
            ),
            "",
        )
        if not description:
            return None
        repaired_at = datetime.now(timezone.utc).isoformat()
        base = enrichment or JobEnrichment.empty(
            tenant_id=tenant_id,
            job_id=job_id,
            updated_at=repaired_at,
        )
        if base.is_failed:
            base = base.reset(reset_at=repaired_at)
        tier = ExtractionTier.from_optional(latest.extraction_tier) or ExtractionTier.JSON_LD
        enrichment = base.start_attempt(
            extraction_tier=tier,
            started_at=repaired_at,
        ).succeed_attempt(
            full_description=FullDescription(text=description),
            application_url=(ApplicationUrl(value=latest.apply_url.value) if latest.apply_url is not None else None),
            extraction_tier=tier,
            finished_at=repaired_at,
        )
        repository.save(enrichment)

    if enrichment.full_description is None:
        return None
    DurableJobEventPublisher(
        conn,
        stage="enrich",
        idempotency_prefix=_event_prefix(str(tenant_id), source_native_id),
    ).publish(
        create_job_enriched(
            tenant_id,
            JobEnrichedPayload(
                job_id=str(job_id),
                full_description=enrichment.full_description.text,
                application_url=(enrichment.application_url.value if enrichment.application_url is not None else ""),
                extraction_tier=(
                    enrichment.extraction_tier.value if enrichment.extraction_tier is not None else "unknown"
                ),
                enriched_at=enrichment.enriched_at or "",
            ),
        )
    )
    return enrichment


def _imported_job_needs_preparation(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    job_id: str,
) -> bool:
    """Return True only for a fresh, fully enriched preparation target."""
    if not _imported_snapshot_is_preparation_eligible(
        conn,
        tenant_id=tenant_id,
        job_id=job_id,
    ):
        return False

    rows = conn.execute(
        """
        SELECT stage, state, error_code
        FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ?
          AND stage IN ('discover', 'enrich', 'score', 'tailor', 'cover')
        """,
        (tenant_id, job_id),
    ).fetchall()
    states = {
        str(row["stage"] if isinstance(row, sqlite3.Row) else row[0]): str(
            row["state"] if isinstance(row, sqlite3.Row) else row[1]
        )
        for row in rows
    }
    from jobctrl.infrastructure.materials.cover_letter_policy import COVER_LETTER_DISABLED

    cover_disabled = any(
        row[0] == "cover" and row[1] == "skipped" and row[2] == COVER_LETTER_DISABLED
        for row in rows
    )
    return (
        states.get("discover") == "succeeded"
        and states.get("enrich") == "succeeded"
        and all(states.get(stage) == "pending" for stage in ("score", "tailor"))
        and (states.get("cover") == "pending" or cover_disabled)
    )


def _imported_snapshot_is_preparation_eligible(
    conn: sqlite3.Connection,
    *,
    tenant_id: Any,
    job_id: Any,
) -> bool:
    """Return whether the latest immutable snapshot may feed preparation."""
    from jobctrl.domain.enrichment.snapshot_value_objects import (
        ActiveState,
        QuarantineReason,
    )
    from jobctrl.infrastructure.enrichment import SqlitePostingSnapshotSetRepository

    snapshot_set = SqlitePostingSnapshotSetRepository(conn).load(tenant_id, job_id)
    latest = snapshot_set.latest_snapshot if snapshot_set is not None else None
    return bool(
        latest is not None
        and latest.active_state in {ActiveState.ACTIVE, ActiveState.UNKNOWN}
        and latest.quarantine_reason in {QuarantineReason.NONE, QuarantineReason.UNKNOWN_ACTIVE_STATE}
    )


def _fetch_block_reason(reason_code: str) -> Any | None:
    from jobctrl.domain.discovery.source_registry import ManualActionReason

    return {
        "robots_disallowed": ManualActionReason.ROBOTS_DISALLOWED,
        "rate_limited": ManualActionReason.RATE_LIMIT,
        "rate_limit": ManualActionReason.RATE_LIMIT,
        "bot_detection": ManualActionReason.BOT_DETECTION,
        "response_limit": ManualActionReason.AMBIGUOUS_CAREER_SYSTEM,
    }.get(reason_code)


def _manual_capture_output(
    conn: sqlite3.Connection,
    *,
    url: str,
    reason: Any,
) -> JobUrlImportActivityOutput:
    from jobctrl.infrastructure.discovery.production_wiring import (
        enqueue_manual_capture_for_job_url_import,
    )

    item_id = enqueue_manual_capture_for_job_url_import(
        conn,
        originating_url=url,
        reason=reason,
    )
    return JobUrlImportActivityOutput(
        outcome="manual_capture_required",
        item_id=item_id,
        reason=reason.value,
    )


def _hard_block_reason(page: Any) -> Any | None:
    from jobctrl.domain.discovery.source_registry import ManualActionReason

    status = getattr(page, "status", None)
    if status == 401:
        return ManualActionReason.LOGIN_REQUIRED
    if status == 403:
        return ManualActionReason.BOT_DETECTION
    if status == 429:
        return ManualActionReason.RATE_LIMIT
    return None


def _transient_acquisition_failure(page: Any) -> bool:
    status = getattr(page, "status", None)
    if isinstance(status, int) and 500 <= status <= 599:
        return True
    if status is not None:
        return False
    return not any(
        (
            str(getattr(page, "page_title", "") or "").strip(),
            str(getattr(page, "html", "") or "").strip(),
            tuple(getattr(page, "json_ld", ()) or ()),
        )
    )


@workflow.defn(name="JobUrlImportWorkflow")
class JobUrlImportWorkflow:
    @workflow.run
    async def run(self, payload: JobUrlImportWorkflowInput) -> JobUrlImportWorkflowResult:
        started_at = workflow.now()
        await emit_workflow_started(
            tenant_id=payload.tenant_id,
            workflow_type="JobUrlImportWorkflow",
            input_summary={"hasUrl": bool(payload.url)},
            started_at=started_at,
            expected_app_dir=payload.expected_app_dir,
            expected_db_path=payload.expected_db_path,
        )
        try:
            output = await workflow.execute_activity(
                job_url_import_activity,
                payload,
                start_to_close_timeout=_DEFAULT_TIMEOUT,
                retry_policy=_IMPORT_RETRY,
            )
        except (CancelledError, ActivityError) as exc:
            if is_cancelled_exception(exc):
                await emit_workflow_outcome(
                    tenant_id=payload.tenant_id,
                    workflow_type="JobUrlImportWorkflow",
                    status="canceled",
                    started_at=started_at,
                    error_code="workflow_canceled",
                    error_message="Workflow canceled by request.",
                    expected_app_dir=payload.expected_app_dir,
                    expected_db_path=payload.expected_db_path,
                )
                raise CancelledError("Workflow canceled by request.") from exc
            assert isinstance(exc, ActivityError)
            error_code = _activity_error_code(exc) or "job_url_import_failed"
            message = (
                "Job URL import failed on the worker."
                if error_code == "job_url_import_failed"
                else str(exc.cause or exc)
            )
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type="JobUrlImportWorkflow",
                status="failed",
                started_at=started_at,
                error_code=error_code,
                error_message=message,
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
            )
            return JobUrlImportWorkflowResult(status="failed", error=message, error_code=error_code)

        await emit_workflow_outcome(
            tenant_id=payload.tenant_id,
            workflow_type="JobUrlImportWorkflow",
            status="succeeded",
            started_at=started_at,
            expected_app_dir=payload.expected_app_dir,
            expected_db_path=payload.expected_db_path,
        )
        return JobUrlImportWorkflowResult(
            status="succeeded",
            outcome=output.outcome,
            job_id=output.job_id,
            item_id=output.item_id,
            reason=output.reason,
            imported_at=output.imported_at,
            already_existed=output.already_existed,
        )


def job_url_import_workflow_id(tenant_id: str, url: str) -> str:
    tenant_hash = hashlib.sha256(tenant_id.encode("utf-8")).hexdigest()
    url_hash = hashlib.sha256(url.strip().encode("utf-8")).hexdigest()
    return f"job-url-import-{tenant_hash}-{url_hash}"


def _activity_error_code(exc: ActivityError) -> str | None:
    cause = exc.cause
    if isinstance(cause, ApplicationError):
        return cause.type or None
    return None


__all__ = [
    "JobUrlImportActivityOutput",
    "JobUrlImportWorkflow",
    "JobUrlImportWorkflowInput",
    "JobUrlImportWorkflowResult",
    "execute_job_url_import",
    "job_url_import_activity",
    "job_url_import_workflow_id",
]


def _extract_posting_page(page, *, dependencies, entity_id, prepared_sources=None):
    from jobctrl.domain.enrichment.page_interpretation import ModelPagePostingExtractor

    sources, origins = prepared_sources or _posting_page_sources(page, entity_id=entity_id)
    result, _ = ModelPagePostingExtractor(**dependencies).extract(entity_id=entity_id, sources=sources, source_urls=origins)
    return {name: getattr(result, name).value for name in type(result).model_fields}


class _SelectedPostingExtractor:
    def __init__(self, description, application_url):
        self._description, self._application_url = description, application_url

    def extract(self, _page):
        from jobctrl.domain.enrichment.services import ExtractionResult
        from jobctrl.domain.enrichment.value_objects import FullDescription, ApplicationUrl

        return ExtractionResult(
            ok=True,
            full_description=FullDescription(text=self._description),
            application_url=ApplicationUrl(value=self._application_url) if self._application_url else None,
        )
