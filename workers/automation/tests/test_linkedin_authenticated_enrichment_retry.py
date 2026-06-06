from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pytest

from jobhunter.database import init_db
from jobhunter.domain.enrichment import (
    ApplicationUrl,
    EnrichmentError,
    ExtractionTier,
    FullDescription,
    JobEnrichment,
)
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.enrichment.detail import (
    _apply_authenticated_linkedin_apply_url,
    _reset_authenticated_linkedin_retry_candidates,
)
from jobhunter.infrastructure.enrichment import SqliteEnrichmentRepository


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobhunter.db")


class _Resolver:
    def __init__(self, application_url: str | None) -> None:
        self.application_url = application_url
        self.calls: list[str] = []

    def resolve_loaded_page(self, page: object, url: str) -> str | None:  # noqa: ARG002
        self.calls.append(url)
        return self.application_url


def _seed_discovered(conn: sqlite3.Connection, url: str, site: str) -> None:
    conn.execute(
        "INSERT INTO jobs (url, title, site, discovered_at) VALUES (?, ?, ?, ?)",
        (url, "Engineer", site, "2026-01-01T00:00:00+00:00"),
    )
    conn.commit()


def _save_enriched(
    conn: sqlite3.Connection,
    url: str,
    *,
    application_url: str | None,
    attempts: int = 1,
) -> None:
    repo = SqliteEnrichmentRepository(conn)
    now = datetime.now(timezone.utc).isoformat()
    aggregate = JobEnrichment.empty(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(url),
        updated_at=now,
    )
    for attempt_index in range(attempts):
        aggregate = aggregate.start_attempt(
            extraction_tier=ExtractionTier.JSON_LD,
            started_at=now,
        ).succeed_attempt(
            full_description=FullDescription(text="A complete LinkedIn description"),
            application_url=(
                ApplicationUrl(value=application_url) if application_url else None
            ),
            extraction_tier=ExtractionTier.JSON_LD,
            finished_at=now,
        )
        if attempt_index < attempts - 1:
            aggregate = aggregate.reset(reset_at=now)
    repo.save(aggregate)


def _save_failed(
    conn: sqlite3.Connection,
    url: str,
    *,
    retryable: bool,
    attempts: int = 1,
) -> None:
    repo = SqliteEnrichmentRepository(conn)
    now = datetime.now(timezone.utc).isoformat()
    aggregate = JobEnrichment.empty(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(url),
        updated_at=now,
    )
    for attempt_index in range(attempts):
        aggregate = aggregate.start_attempt(
            extraction_tier=ExtractionTier.LLM_ASSISTED,
            started_at=now,
        ).fail_attempt(
            error=EnrichmentError(
                code="DETAIL_ERROR",
                message="no data extracted",
                retryable=retryable,
            ),
            finished_at=now,
        )
        if attempt_index < attempts - 1:
            aggregate = aggregate.reset(reset_at=now)
    repo.save(aggregate)


def test_authenticated_apply_url_upgrades_partial_linkedin_enrichment() -> None:
    resolver = _Resolver("https://jobs.ashbyhq.com/acme/role")
    result = _apply_authenticated_linkedin_apply_url(
        site="linkedin",
        url="https://www.linkedin.com/jobs/view/123",
        cascade_result={
            "status": "partial",
            "full_description": "Complete description",
            "application_url": None,
        },
        resolver=resolver,
        page=object(),
    )

    assert result["status"] == "ok"
    assert result["application_url"] == "https://jobs.ashbyhq.com/acme/role"
    assert result["authenticated_apply_url_method"] == "authenticated_browser"
    assert resolver.calls == ["https://www.linkedin.com/jobs/view/123"]


def test_authenticated_apply_url_does_not_run_for_non_linkedin() -> None:
    resolver = _Resolver("https://jobs.ashbyhq.com/acme/role")
    result = _apply_authenticated_linkedin_apply_url(
        site="indeed",
        url="https://example.com/jobs/123",
        cascade_result={
            "status": "partial",
            "full_description": "Complete description",
            "application_url": None,
        },
        resolver=resolver,
        page=object(),
    )

    assert result["application_url"] is None
    assert resolver.calls == []


def test_retry_candidates_reset_linkedin_failed_and_missing_apply_rows(
    conn: sqlite3.Connection,
) -> None:
    missing_url = "https://www.linkedin.com/jobs/view/1"
    failed_url = "https://www.linkedin.com/jobs/view/2"
    has_apply_url = "https://www.linkedin.com/jobs/view/3"
    indeed_url = "https://example.com/jobs/4"
    _seed_discovered(conn, missing_url, "linkedin")
    _seed_discovered(conn, failed_url, "linkedin")
    _seed_discovered(conn, has_apply_url, "linkedin")
    _seed_discovered(conn, indeed_url, "indeed")
    _save_enriched(conn, missing_url, application_url=None)
    _save_failed(conn, failed_url, retryable=True)
    _save_enriched(conn, has_apply_url, application_url="https://apply.example/3")
    _save_enriched(conn, indeed_url, application_url=None)

    reset_count = _reset_authenticated_linkedin_retry_candidates(conn)

    assert reset_count == 2
    repo = SqliteEnrichmentRepository(conn)
    assert repo.load(LOCAL_TENANT, JobId(missing_url)).is_pending  # type: ignore[union-attr]
    assert repo.load(LOCAL_TENANT, JobId(failed_url)).is_pending  # type: ignore[union-attr]
    assert repo.load(LOCAL_TENANT, JobId(has_apply_url)).is_enriched  # type: ignore[union-attr]
    assert repo.load(LOCAL_TENANT, JobId(indeed_url)).is_enriched  # type: ignore[union-attr]


def test_retry_candidates_skip_nonretryable_and_exhausted_rows(
    conn: sqlite3.Connection,
) -> None:
    nonretryable_url = "https://www.linkedin.com/jobs/view/nonretryable"
    exhausted_url = "https://www.linkedin.com/jobs/view/exhausted"
    _seed_discovered(conn, nonretryable_url, "linkedin")
    _seed_discovered(conn, exhausted_url, "linkedin")
    _save_failed(conn, nonretryable_url, retryable=False)
    _save_enriched(conn, exhausted_url, application_url=None, attempts=3)

    reset_count = _reset_authenticated_linkedin_retry_candidates(conn)

    assert reset_count == 0
    repo = SqliteEnrichmentRepository(conn)
    assert repo.load(LOCAL_TENANT, JobId(nonretryable_url)).is_failed  # type: ignore[union-attr]
    assert repo.load(LOCAL_TENANT, JobId(exhausted_url)).is_enriched  # type: ignore[union-attr]
