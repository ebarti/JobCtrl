"""Exact-v7 persistence contract for ``SqliteEnrichmentRepository``.

Enrichment aggregates are identified solely by ``(tenant_id, job_id)``.
Posting URLs are inserted only as current job locators so this suite catches
any accidental regression to URL-shaped persistence identity.
"""

from __future__ import annotations

import sqlite3
import uuid

import pytest

from jobctrl.database import init_db
from jobctrl.domain.enrichment import (
    ApplicationUrl,
    EnrichmentError,
    ExtractionTier,
    FullDescription,
    JobEnrichment,
    PostingSnapshotSet,
)
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.enrichment import SqliteEnrichmentRepository
from jobctrl.infrastructure.enrichment.sqlite_repository import (
    SqlitePostingSnapshotSetRepository,
)


OTHER_TENANT = TenantId("other")
SHARED_URL = "https://example.test/jobs/shared"


@pytest.fixture
def conn(tmp_path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobctrl.db")


def _job_id(*, tenant_id: TenantId, url: str) -> JobId:
    return canonical_job_id(str(uuid.uuid5(uuid.NAMESPACE_URL, f"{tenant_id}:{url}")))


def _insert_job(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    job_id: JobId,
    url: str,
    discovered_at: str = "2026-07-31T12:00:00+00:00",
) -> None:
    conn.execute(
        """
        INSERT INTO jobs (tenant_id, job_id, url, title, company, site, discovered_at)
        VALUES (?, ?, ?, 'Platform Engineer', 'Example', 'example', ?)
        """,
        (str(tenant_id), str(job_id), url, discovered_at),
    )
    conn.execute(
        """
        INSERT INTO job_locators (
            tenant_id, job_id, locator_kind, locator_value,
            is_current, first_seen_at, last_seen_at
        ) VALUES (?, ?, 'posting_url', ?, 1, ?, ?)
        """,
        (str(tenant_id), str(job_id), url, discovered_at, discovered_at),
    )
    conn.commit()


def _enriched(
    *,
    tenant_id: TenantId,
    job_id: JobId,
    description: str = "The full description",
) -> JobEnrichment:
    return (
        JobEnrichment.empty(tenant_id=tenant_id, job_id=job_id, updated_at="t0")
        .start_attempt(extraction_tier=ExtractionTier.JSON_LD, started_at="t0")
        .succeed_attempt(
            full_description=FullDescription(text=description),
            application_url=ApplicationUrl(value="https://example.test/apply"),
            extraction_tier=ExtractionTier.JSON_LD,
            finished_at="t1",
        )
    )


def _failed(*, tenant_id: TenantId, job_id: JobId) -> JobEnrichment:
    return (
        JobEnrichment.empty(tenant_id=tenant_id, job_id=job_id, updated_at="t0")
        .start_attempt(extraction_tier=ExtractionTier.CSS_SELECTORS, started_at="t0")
        .fail_attempt(
            error=EnrichmentError(code="HTTP_404", message="gone", retryable=False),
            finished_at="t1",
        )
    )


def test_save_then_load_round_trips_exact_tenant_job_identity(
    conn: sqlite3.Connection,
) -> None:
    job_id = _job_id(tenant_id=LOCAL_TENANT, url="https://example.test/jobs/1")
    _insert_job(
        conn,
        tenant_id=LOCAL_TENANT,
        job_id=job_id,
        url="https://example.test/jobs/1",
    )
    repo = SqliteEnrichmentRepository(conn)
    original = _enriched(tenant_id=LOCAL_TENANT, job_id=job_id)

    repo.save(original)
    loaded = repo.load(LOCAL_TENANT, job_id)

    assert loaded is not None
    assert loaded.tenant_id == LOCAL_TENANT
    assert loaded.job_id == job_id
    assert loaded.is_enriched
    assert loaded.full_description is not None
    assert loaded.full_description.text == "The full description"
    assert loaded.application_url is not None
    assert loaded.application_url.value == "https://example.test/apply"
    assert loaded.extraction_tier is ExtractionTier.JSON_LD
    assert loaded.attempt_count == 1


def test_save_upserts_only_the_same_tenant_job_pair(conn: sqlite3.Connection) -> None:
    job_id = _job_id(tenant_id=LOCAL_TENANT, url="https://example.test/jobs/1")
    _insert_job(
        conn,
        tenant_id=LOCAL_TENANT,
        job_id=job_id,
        url="https://example.test/jobs/1",
    )
    repo = SqliteEnrichmentRepository(conn)
    repo.save(_enriched(tenant_id=LOCAL_TENANT, job_id=job_id))

    repo.save(_failed(tenant_id=LOCAL_TENANT, job_id=job_id))

    assert conn.execute(
        "SELECT COUNT(*) FROM job_enrichments WHERE tenant_id = ? AND job_id = ?",
        (str(LOCAL_TENANT), str(job_id)),
    ).fetchone()[0] == 1
    loaded = repo.load(LOCAL_TENANT, job_id)
    assert loaded is not None
    assert loaded.is_failed
    assert loaded.attempt_count == 1


def test_save_after_reset_round_trips_the_full_attempt_history(
    conn: sqlite3.Connection,
) -> None:
    job_id = _job_id(tenant_id=LOCAL_TENANT, url="https://example.test/jobs/retry")
    _insert_job(
        conn,
        tenant_id=LOCAL_TENANT,
        job_id=job_id,
        url="https://example.test/jobs/retry",
    )
    repo = SqliteEnrichmentRepository(conn)
    initial = _enriched(tenant_id=LOCAL_TENANT, job_id=job_id)
    retried = (
        initial.reset(reset_at="t2")
        .start_attempt(extraction_tier=ExtractionTier.CSS_SELECTORS, started_at="t3")
        .fail_attempt(
            error=EnrichmentError(code="HTTP_503", message="retry later", retryable=True),
            finished_at="t4",
        )
    )

    repo.save(initial)
    repo.save(retried)

    loaded = repo.load(LOCAL_TENANT, job_id)
    assert loaded is not None
    assert loaded.is_failed
    assert loaded.attempt_count == 2
    assert [attempt.extraction_tier for attempt in loaded.attempts] == [
        ExtractionTier.JSON_LD,
        ExtractionTier.CSS_SELECTORS,
    ]
    assert loaded.attempts[0].succeeded
    assert loaded.attempts[1].failed
    assert loaded.attempts[1].error is not None
    assert loaded.attempts[1].error.code == "HTTP_503"


def test_repository_rejects_url_shaped_job_identity(conn: sqlite3.Connection) -> None:
    repo = SqliteEnrichmentRepository(conn)
    invalid_job_id = JobId("https://example.test/jobs/not-an-id")

    with pytest.raises(ValueError, match="canonical UUID"):
        repo.load(LOCAL_TENANT, invalid_job_id)
    with pytest.raises(ValueError, match="canonical UUID"):
        repo.save(
            JobEnrichment.empty(
                tenant_id=LOCAL_TENANT,
                job_id=invalid_job_id,
                updated_at="t0",
            )
        )


def test_snapshot_set_repository_uses_tenant_scoped_job_id(
    conn: sqlite3.Connection,
) -> None:
    url = "https://example.test/jobs/snapshot"
    job_id = _job_id(tenant_id=LOCAL_TENANT, url=url)
    _insert_job(conn, tenant_id=LOCAL_TENANT, job_id=job_id, url=url)
    repo = SqlitePostingSnapshotSetRepository(conn)
    snapshot_set = PostingSnapshotSet.empty(
        tenant_id=LOCAL_TENANT,
        job_id=job_id,
        updated_at="2026-07-31T12:00:00+00:00",
    )

    repo.save(snapshot_set)

    loaded = repo.load(LOCAL_TENANT, job_id)
    row = conn.execute(
        """
        SELECT job_id
        FROM posting_snapshot_sets
        WHERE tenant_id = ? AND job_id = ?
        """,
        (str(LOCAL_TENANT), str(job_id)),
    ).fetchone()

    assert loaded == snapshot_set
    assert row is not None and row["job_id"] == str(job_id)
    assert "job_url" not in {
        column["name"] for column in conn.execute("PRAGMA table_info(posting_snapshot_sets)")
    }


def test_list_pending_uses_tenant_scoped_job_ids(conn: sqlite3.Connection) -> None:
    enriched_id = _job_id(tenant_id=LOCAL_TENANT, url="https://example.test/jobs/enriched")
    missing_id = _job_id(tenant_id=LOCAL_TENANT, url="https://example.test/jobs/missing")
    pending_id = _job_id(tenant_id=LOCAL_TENANT, url="https://example.test/jobs/pending")
    other_id = _job_id(tenant_id=OTHER_TENANT, url="https://example.test/jobs/other")
    _insert_job(
        conn,
        tenant_id=LOCAL_TENANT,
        job_id=enriched_id,
        url="https://example.test/jobs/enriched",
    )
    _insert_job(
        conn,
        tenant_id=LOCAL_TENANT,
        job_id=missing_id,
        url="https://example.test/jobs/missing",
    )
    _insert_job(
        conn,
        tenant_id=LOCAL_TENANT,
        job_id=pending_id,
        url="https://example.test/jobs/pending",
    )
    _insert_job(
        conn,
        tenant_id=OTHER_TENANT,
        job_id=other_id,
        url="https://example.test/jobs/other",
    )
    repo = SqliteEnrichmentRepository(conn)
    repo.save(_enriched(tenant_id=LOCAL_TENANT, job_id=enriched_id))
    repo.save(
        JobEnrichment.empty(
            tenant_id=LOCAL_TENANT,
            job_id=pending_id,
            updated_at="t0",
        )
    )

    assert set(repo.list_pending(LOCAL_TENANT)) == {missing_id, pending_id}
    assert repo.list_pending(OTHER_TENANT) == [other_id]


def test_list_pending_excludes_running_and_failed_aggregates(
    conn: sqlite3.Connection,
) -> None:
    running_id = _job_id(tenant_id=LOCAL_TENANT, url="https://example.test/jobs/running")
    failed_id = _job_id(tenant_id=LOCAL_TENANT, url="https://example.test/jobs/failed")
    for job_id, url in (
        (running_id, "https://example.test/jobs/running"),
        (failed_id, "https://example.test/jobs/failed"),
    ):
        _insert_job(conn, tenant_id=LOCAL_TENANT, job_id=job_id, url=url)
    repo = SqliteEnrichmentRepository(conn)
    repo.save(
        JobEnrichment.empty(
            tenant_id=LOCAL_TENANT,
            job_id=running_id,
            updated_at="t0",
        ).start_attempt(extraction_tier=ExtractionTier.JSON_LD, started_at="t0")
    )
    repo.save(_failed(tenant_id=LOCAL_TENANT, job_id=failed_id))

    assert repo.list_pending(LOCAL_TENANT) == []


def test_list_failed_returns_aggregate_with_canonical_identity(
    conn: sqlite3.Connection,
) -> None:
    job_id = _job_id(tenant_id=LOCAL_TENANT, url="https://example.test/jobs/failed")
    _insert_job(
        conn,
        tenant_id=LOCAL_TENANT,
        job_id=job_id,
        url="https://example.test/jobs/failed",
    )
    repo = SqliteEnrichmentRepository(conn)
    repo.save(_failed(tenant_id=LOCAL_TENANT, job_id=job_id))

    failures = repo.list_failed(LOCAL_TENANT)

    assert len(failures) == 1
    assert failures[0].tenant_id == LOCAL_TENANT
    assert failures[0].job_id == job_id
    assert failures[0].is_failed
    assert failures[0].last_attempt is not None
    assert failures[0].last_attempt.error is not None
    assert failures[0].last_attempt.error.code == "HTTP_404"


def test_shared_url_never_crosses_tenant_job_identity_on_save_load_or_update(
    conn: sqlite3.Connection,
) -> None:
    local_job_id = _job_id(tenant_id=LOCAL_TENANT, url=SHARED_URL)
    other_job_id = _job_id(tenant_id=OTHER_TENANT, url=SHARED_URL)
    _insert_job(
        conn,
        tenant_id=LOCAL_TENANT,
        job_id=local_job_id,
        url=SHARED_URL,
    )
    _insert_job(
        conn,
        tenant_id=OTHER_TENANT,
        job_id=other_job_id,
        url=SHARED_URL,
    )
    repo = SqliteEnrichmentRepository(conn)
    repo.save(
        _enriched(
            tenant_id=LOCAL_TENANT,
            job_id=local_job_id,
            description="local description",
        )
    )
    repo.save(
        _enriched(
            tenant_id=OTHER_TENANT,
            job_id=other_job_id,
            description="other description",
        )
    )

    repo.save(_failed(tenant_id=LOCAL_TENANT, job_id=local_job_id))

    local = repo.load(LOCAL_TENANT, local_job_id)
    other = repo.load(OTHER_TENANT, other_job_id)
    assert local is not None and local.is_failed
    assert other is not None and other.is_enriched
    assert other.full_description is not None
    assert other.full_description.text == "other description"
    assert repo.load(LOCAL_TENANT, other_job_id) is None
