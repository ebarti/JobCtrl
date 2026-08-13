"""Temporal orchestration for importing one explicit job-posting URL."""

from __future__ import annotations

import hashlib
import math
import re
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from bs4 import BeautifulSoup
from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError, CancelledError

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
_BLOCKED_TITLE_SIGNALS = (
    "access denied",
    "are you a human",
    "captcha",
    "log in",
    "login",
    "sign in",
    "verify you are human",
)
_CSS_JOB_DESCRIPTION_MARKERS = (
    "#job-description",
    "#job_description",
    "#jobDescriptionText",
    ".job-description",
    ".job_description",
    ".job__description",
    '[class*="job-description"]',
    '[class*="jobDescription"]',
    '[data-testid*="description"]',
    '[data-testid="job-description"]',
    ".job-post-container",
    ".ashby-job-posting-description",
    '[class*="posting-description"]',
    '[class*="job-detail"]',
    '[class*="jobDetail"]',
    '[class*="job-content"]',
    '[class*="job-body"]',
    'article[class*="job"]',
    ".job-posting-content",
)
_JOB_SECTION_SIGNALS = (
    "about the role",
    "compensation",
    "how to apply",
    "key details",
    "qualifications",
    "requirements",
    "responsibilities",
    "what we are looking for",
    "what you'll do",
    "what you will do",
)
_GENERIC_EMPLOYER_SUFFIXES = {
    "apply",
    "application",
    "career",
    "careers",
    "job",
    "jobs",
    "job openings",
}


class _DeferredEventPublisher:
    """Leave durable event publication to the convergent import boundary."""

    def publish(self, _event: object) -> None:
        return None


class _EmbeddedAtsJobExtractor:
    """Extract a custom careers page whose application form proves job scope."""

    def extract(self, page: Any) -> Any:
        from jobctrl.domain.enrichment.services import ExtractionResult
        from jobctrl.domain.enrichment.value_objects import FullDescription

        description = _embedded_ats_job_description(page)
        if not description:
            return ExtractionResult(ok=False)
        return ExtractionResult(
            ok=True,
            full_description=FullDescription(text=description),
        )


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
        lambda: execute_job_url_import(payload),
        starting_message="job URL import starting",
        progress_message="job URL import still running",
        activity_name="job_url_import",
    )


def execute_job_url_import(
    payload: JobUrlImportWorkflowInput,
    *,
    conn: sqlite3.Connection | None = None,
    fetcher: Any | None = None,
    url_validator: Callable[[str], Any] | None = None,
) -> JobUrlImportActivityOutput:
    """Fetch, deterministically extract, and ingest one public posting URL.

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
    from jobctrl.domain.enrichment.services import CssSelectorExtractor, JsonLdExtractor
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
        _repair_stored_import_identity(
            connection,
            tenant_id=tenant_id,
            job_id=existing.job_id,
            source_native_id=source_native_id,
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

    extracted = _extract_posting_page(page)
    if extracted is None:
        return _manual_capture_output(
            connection,
            url=url,
            reason=_content_block_reason(page) or ManualActionReason.AMBIGUOUS_CAREER_SYSTEM,
        )

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
        _repair_stored_import_identity(
            connection,
            tenant_id=tenant_id,
            job_id=canonical_existing.job_id,
            source_native_id=source_native_id,
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
        raise RuntimeError("Job URL import did not persist a canonical JobId")
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
        fetcher=_FetchedPage(),
        extractors=(
            TierExtractor(tier=ExtractionTier.JSON_LD, extractor=JsonLdExtractor()),
            TierExtractor(
                tier=ExtractionTier.CSS_SELECTORS,
                extractor=_EmbeddedAtsJobExtractor(),
            ),
            TierExtractor(tier=ExtractionTier.CSS_SELECTORS, extractor=CssSelectorExtractor()),
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


def _repair_stored_import_identity(
    conn: sqlite3.Connection,
    *,
    tenant_id: object,
    job_id: object,
    source_native_id: str,
) -> bool:
    """Converge legacy CSS-import wrappers without refetching the posting."""
    row = conn.execute(
        """
        SELECT title, company
        FROM jobs
        WHERE tenant_id = ? AND job_id = ?
        """,
        (str(tenant_id), str(job_id)),
    ).fetchone()
    if row is None:
        return False
    if isinstance(row, sqlite3.Row):
        stored_title = str(row["title"] or "").strip()
        stored_company = str(row["company"] or "").strip()
    else:
        stored_title = str(row[0] or "").strip()
        stored_company = str(row[1] or "").strip()
    normalized = _application_heading_identity(stored_title)
    if normalized is None:
        return False
    title, employer = normalized
    company = stored_company or employer
    if title == stored_title and company == stored_company:
        return False

    from jobctrl.state import record_job_event

    savepoint = "job_url_import_identity_repair"
    released = False
    conn.execute(f"SAVEPOINT {savepoint}")
    try:
        conn.execute(
            """
            UPDATE jobs
            SET title = ?, company = ?
            WHERE tenant_id = ? AND job_id = ?
            """,
            (title, company, str(tenant_id), str(job_id)),
        )
        changed_fields = {"title": True}
        if not stored_company:
            changed_fields["company"] = True
        record_job_event(
            conn,
            job_id,
            "discover",
            "JobMetadataUpdated",
            tenant_id=tenant_id,
            message="Imported job identity normalized from its source heading.",
            payload={
                "changedFields": changed_fields,
                "source": "manual_url_import",
            },
            publisher=_DeferredEventPublisher(),
            idempotency_key=f"{_event_prefix(str(tenant_id), source_native_id)}:identity-normalization-v1",
        )
        conn.execute(f"RELEASE SAVEPOINT {savepoint}")
        released = True
        conn.commit()
    except BaseException:
        if released:
            conn.rollback()
        else:
            conn.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
            conn.execute(f"RELEASE SAVEPOINT {savepoint}")
        raise
    return True


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

    row = conn.execute(
        """
        SELECT job_id, salary, full_description, description
        FROM jobs
        WHERE tenant_id = ? AND job_id = ?
        """,
        (str(tenant_id), str(job_id)),
    ).fetchone()
    if row is None:
        raise RuntimeError("Manual URL import is missing its canonical job row")
    source_text, source_field = posted_compensation_source_from_job(row)
    SqlitePostedCompensationRepository(conn).parse_and_save_job_salary(
        job_id,
        source_text,
        tenant_id=str(tenant_id),
        source_field=source_field,
        parsed_at=datetime.now(timezone.utc).isoformat(),
        event_idempotency_key=f"{_event_prefix(str(tenant_id), source_native_id)}:posted-compensation",
    )


def _fetch_block_reason(reason_code: str) -> Any | None:
    from jobctrl.domain.discovery.source_registry import ManualActionReason

    return {
        "robots_disallowed": ManualActionReason.ROBOTS_DISALLOWED,
        "rate_limited": ManualActionReason.RATE_LIMIT,
        "rate_limit": ManualActionReason.RATE_LIMIT,
        "bot_detection": ManualActionReason.BOT_DETECTION,
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


def _content_block_reason(page: Any) -> Any | None:
    from jobctrl.domain.discovery.source_registry import ManualActionReason

    text = " ".join(
        (
            str(getattr(page, "page_title", "") or ""),
            BeautifulSoup(str(getattr(page, "html", "") or ""), "html.parser").get_text(" ", strip=True)[:5000],
        )
    ).casefold()
    if "captcha" in text or "are you a human" in text or "verify you are human" in text:
        return ManualActionReason.CAPTCHA
    if "access denied" in text or "unusual traffic" in text:
        return ManualActionReason.BOT_DETECTION
    if "log in" in text or "login" in text or "sign in" in text:
        return ManualActionReason.LOGIN_REQUIRED
    if "paywall" in text or "subscribe to continue" in text:
        return ManualActionReason.PAYWALL
    return None


def _extract_posting_page(page: Any) -> dict[str, str] | None:
    from jobctrl.domain.enrichment.services import CssSelectorExtractor, JsonLdExtractor

    structured: list[tuple[dict[str, Any], Any]] = []
    for posting in _find_job_postings(getattr(page, "json_ld", ())):
        title = _text(posting.get("title"))
        if not title:
            continue
        result = JsonLdExtractor().extract(replace(page, json_ld=(posting,)))
        if result.ok and result.full_description is not None:
            structured.append((posting, result))

    selected: tuple[dict[str, Any], Any] | None = None
    page_urls = {
        _comparable_url(str(getattr(page, "url", "") or "")),
        _comparable_url(str(getattr(page, "final_url", "") or "")),
    }
    page_urls.discard("")
    matching = [
        candidate for candidate in structured if _comparable_url(str(candidate[0].get("url") or "")) in page_urls
    ]
    if len(matching) == 1:
        selected = matching[0]
    elif len(structured) == 1 and not _comparable_url(str(structured[0][0].get("url") or "")):
        selected = structured[0]
    elif len(structured) > 1:
        return None

    if selected is not None:
        posting, result = selected
        title = _text(posting.get("title"))
        employer = _employer_name(posting)
        salary = _salary_text(posting)
        location = _location_text(posting)
    else:
        if _has_explicit_css_job_description(page):
            result = CssSelectorExtractor().extract(page)
        else:
            result = _EmbeddedAtsJobExtractor().extract(page)
        title, employer = _css_page_identity(page)
        salary = ""
        location = _css_page_location(page)
        posting = None
        if not result.ok or result.full_description is None:
            return None

    if not title or any(signal in title.casefold() for signal in _BLOCKED_TITLE_SIGNALS):
        return None
    return {
        "title": title[:500],
        "employer": employer[:500],
        "salary": salary[:500],
        "description": result.full_description.text,
        "location": location[:500],
    }


def _find_job_postings(value: Any) -> tuple[dict[str, Any], ...]:
    found: list[dict[str, Any]] = []
    if isinstance(value, dict):
        type_value = value.get("@type")
        types = type_value if isinstance(type_value, list) else [type_value]
        if "JobPosting" in types:
            found.append(value)
        graph = value.get("@graph")
        if isinstance(graph, list):
            found.extend(_find_job_postings(graph))
    elif isinstance(value, (list, tuple)):
        for item in value:
            found.extend(_find_job_postings(item))
    return tuple(found)


def _has_explicit_css_job_description(page: Any) -> bool:
    html = str(getattr(page, "html", "") or "")
    if not html:
        return False
    soup = BeautifulSoup(html, "html.parser")
    for selector in _CSS_JOB_DESCRIPTION_MARKERS:
        try:
            element = soup.select_one(selector)
        except Exception:
            continue
        if element is not None and len(element.get_text(" ", strip=True)) >= 100:
            return True
    return False


def _embedded_ats_job_description(page: Any) -> str:
    """Return body text only for a strongly identified individual job page.

    Some employers render the posting in a custom ``#content`` block and embed
    the ATS application form alongside it. The form container, individual-job
    URL, H1, and multiple job-section headings together provide the proof that
    a generic content block alone cannot.
    """

    html = str(getattr(page, "html", "") or "")
    if not html or not _has_individual_job_path(page):
        return ""
    soup = BeautifulSoup(html, "html.parser")
    heading = soup.select_one("h1")
    content = soup.select_one("#content")
    application = soup.select_one("#grnhse_app")
    if heading is None or content is None or application is None:
        return ""
    title = heading.get_text(" ", strip=True)
    description = content.get_text(" ", strip=True)
    if not title or len(description) < 500:
        return ""
    section_headings = " ".join(element.get_text(" ", strip=True).casefold() for element in content.select("h2, h3"))
    matched_sections = sum(signal in section_headings for signal in _JOB_SECTION_SIGNALS)
    return description if matched_sections >= 2 else ""


def _has_individual_job_path(page: Any) -> bool:
    for candidate in (
        str(getattr(page, "final_url", "") or ""),
        str(getattr(page, "url", "") or ""),
    ):
        try:
            path = urlsplit(candidate).path
        except ValueError:
            continue
        if re.search(r"/(?:careers|jobs?)/(?:job/)?[^/]+/?$", path, re.IGNORECASE):
            return True
    return False


def _css_page_identity(page: Any) -> tuple[str, str]:
    html = str(getattr(page, "html", "") or "")
    soup = BeautifulSoup(html, "html.parser")
    heading = soup.select_one("h1")
    heading_text = heading.get_text(" ", strip=True) if heading is not None else ""
    page_title = re.sub(r"\s+", " ", str(getattr(page, "page_title", "") or "")).strip()
    for candidate in (heading_text, page_title):
        identity = _application_heading_identity(candidate)
        if identity is not None:
            return identity

    title = heading_text or _clean_page_title(page_title)
    return title, _page_title_employer(page_title, title)


def _application_heading_identity(value: str) -> tuple[str, str] | None:
    match = re.fullmatch(
        r"Job Application for\s+(.+?)\s+at\s+(.+)",
        re.sub(r"\s+", " ", value).strip(),
        flags=re.IGNORECASE,
    )
    if match is None:
        return None
    title = _text(match.group(1))
    employer = _text(match.group(2))
    return (title, employer) if title and employer else None


def _page_title_employer(page_title: str, title: str) -> str:
    for separator in (" | ", " — ", " - "):
        prefix = f"{title}{separator}"
        if not page_title.casefold().startswith(prefix.casefold()):
            continue
        employer = _text(page_title[len(prefix) :])
        if employer.casefold() not in _GENERIC_EMPLOYER_SUFFIXES:
            return employer
    return ""


def _css_page_location(page: Any) -> str:
    soup = BeautifulSoup(str(getattr(page, "html", "") or ""), "html.parser")
    for selector in (
        "h1 + .location",
        ".app-title + .location",
        '[data-testid="job-location"]',
    ):
        element = soup.select_one(selector)
        if element is None:
            continue
        location = element.get_text(" ", strip=True).strip(" •·|-")
        if location:
            return location
    return ""


def _comparable_url(value: str) -> str:
    text = value.strip()
    if not text:
        return ""
    try:
        parsed = urlsplit(text)
    except ValueError:
        return text
    if not parsed.scheme or not parsed.netloc:
        return text
    path = parsed.path.rstrip("/") or "/"
    return urlunsplit((parsed.scheme.casefold(), parsed.netloc.casefold(), path, parsed.query, ""))


def _employer_name(posting: dict[str, Any] | None) -> str:
    if not posting:
        return ""
    organization = posting.get("hiringOrganization")
    return _text(organization.get("name")) if isinstance(organization, dict) else ""


def _location_text(posting: dict[str, Any] | None) -> str:
    if not posting:
        return ""
    if _text(posting.get("jobLocationType")).casefold() == "telecommute":
        return "Remote"
    locations = posting.get("jobLocation")
    values = locations if isinstance(locations, list) else [locations]
    parts: list[str] = []
    for value in values:
        if not isinstance(value, dict):
            continue
        address = value.get("address")
        if not isinstance(address, dict):
            continue
        formatted = ", ".join(
            part
            for part in (
                _text(address.get("addressLocality")),
                _text(address.get("addressRegion")),
                _text(address.get("addressCountry")),
            )
            if part
        )
        if formatted and formatted not in parts:
            parts.append(formatted)
    return "; ".join(parts)


def _salary_text(posting: dict[str, Any] | None) -> str:
    if not posting:
        return ""
    salary = posting.get("baseSalary")
    if not isinstance(salary, dict):
        return ""
    currency = _text(salary.get("currency"))
    value = salary.get("value")
    if isinstance(value, dict):
        minimum = _number_text(value.get("minValue"))
        maximum = _number_text(value.get("maxValue"))
        exact = _number_text(value.get("value"))
        amount = f"{minimum}-{maximum}" if minimum and maximum else minimum or maximum or exact
        unit = _text(value.get("unitText")).casefold()
    else:
        amount = _number_text(value)
        unit = ""
    if not amount:
        return ""
    period = {"year": "year", "month": "month", "week": "week", "day": "day", "hour": "hour"}.get(unit)
    priced = " ".join(part for part in (currency, amount) if part)
    return f"{priced}/{period}" if period else priced


def _number_text(value: Any) -> str:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return ""
    numeric = float(value)
    if not math.isfinite(numeric):
        return ""
    return str(int(value)) if numeric.is_integer() else str(value)


def _text(value: Any) -> str:
    return BeautifulSoup(str(value or ""), "html.parser").get_text(" ", strip=True)


def _clean_page_title(value: str) -> str:
    title = re.sub(r"\s+", " ", value).strip()
    for separator in (" | ", " — ", " - "):
        if separator in title:
            title = title.split(separator, 1)[0].strip()
    return title


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
        except CancelledError:
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
            raise
        except ActivityError as exc:
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
