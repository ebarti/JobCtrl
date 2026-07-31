"""Compensation repositories must persist and load by tenant-scoped JobId."""

from __future__ import annotations

import sqlite3

import pytest

from jobctrl.domain.identifiers import JobId
from jobctrl.discovery.jobspy import _upsert_posted_compensation_fact
from jobctrl.infrastructure.compensation.sqlite_market_repository import (
    SqliteMarketCompensationRepository,
)
from jobctrl.infrastructure.compensation.sqlite_repository import (
    SqlitePostedCompensationRepository,
)
from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema


def _connection() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    create_exact_v7_schema(conn)
    return conn


def _insert_job(conn: sqlite3.Connection, *, tenant_id: str, job_id: JobId, url: str, salary: str) -> None:
    conn.execute(
        """
        INSERT INTO jobs (tenant_id, job_id, url, title, company, location, salary, discovered_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            tenant_id,
            job_id,
            url,
            "Senior Platform Engineer",
            "Acme AI",
            "Remote Europe",
            salary,
            "2026-07-31T10:00:00Z",
        ),
    )
    conn.commit()


def test_repositories_scope_compensation_facts_and_estimates_by_tenant_and_job_id() -> None:
    conn = _connection()
    local_job_id = JobId("11111111-1111-4111-8111-111111111111")
    other_job_id = JobId("22222222-2222-4222-8222-222222222222")
    shared_posting_url = "https://example.test/jobs/platform"
    _insert_job(
        conn,
        tenant_id="local",
        job_id=local_job_id,
        url=shared_posting_url,
        salary="€100,000-€130,000/year",
    )
    _insert_job(
        conn,
        tenant_id="other",
        job_id=other_job_id,
        url=shared_posting_url,
        salary="€200,000-€230,000/year",
    )

    posted = SqlitePostedCompensationRepository(conn)
    posted.parse_and_save_job_salary(
        local_job_id,
        "€100,000-€130,000/year",
        tenant_id="local",
        parsed_at="2026-07-31T10:00:00Z",
    )

    fact = posted.get_fact("local", local_job_id)
    assert fact is not None
    assert fact.job_id == local_job_id
    assert posted.get_fact("other", other_job_id) is None

    market = SqliteMarketCompensationRepository(conn)
    assert market.backfill_from_jobs((), tenant_id="local", job_id=local_job_id) == 1

    estimate = market.get_estimate("local", local_job_id)
    assert estimate is not None
    assert estimate.job_id == local_job_id
    assert estimate.minimum_amount == 100_000
    assert market.get_estimate("other", other_job_id) is None


def test_jobspy_posted_compensation_producer_resolves_the_tenant_scoped_job_id() -> None:
    conn = _connection()
    local_job_id = JobId("33333333-3333-4333-8333-333333333333")
    other_job_id = JobId("44444444-4444-4444-8444-444444444444")
    shared_posting_url = "https://example.test/jobs/discovered"
    _insert_job(
        conn,
        tenant_id="local",
        job_id=local_job_id,
        url=shared_posting_url,
        salary="€90,000-€110,000/year",
    )
    _insert_job(
        conn,
        tenant_id="other",
        job_id=other_job_id,
        url=shared_posting_url,
        salary="€150,000-€180,000/year",
    )

    _upsert_posted_compensation_fact(
        conn,
        tenant_id="local",
        job_url=shared_posting_url,
        parsed_at="2026-07-31T10:00:00Z",
    )

    posted = SqlitePostedCompensationRepository(conn)
    assert posted.get_fact("local", local_job_id) is not None
    assert posted.get_fact("other", other_job_id) is None


def test_compensation_repositories_reject_url_shaped_job_ids() -> None:
    conn = _connection()
    url_shaped_id = JobId("https://example.test/jobs/not-an-id")

    with pytest.raises(ValueError, match="canonical UUID"):
        SqlitePostedCompensationRepository(conn).parse_and_save_job_salary(
            url_shaped_id,
            "€100,000/year",
        )

    with pytest.raises(ValueError, match="canonical UUID"):
        SqliteMarketCompensationRepository(conn).get_estimate("local", url_shaped_id)
