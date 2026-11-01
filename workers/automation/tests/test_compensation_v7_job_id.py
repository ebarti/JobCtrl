"""Compensation repositories must persist and load by tenant-scoped JobId."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from jobctrl.domain.identifiers import JobId
from jobctrl.discovery.jobspy import _upsert_posted_compensation_fact
from jobctrl.discovery.job_url_import_workflow import _ensure_posted_compensation_fact
from jobctrl.infrastructure.compensation.sqlite_market_repository import (
    SqliteMarketCompensationRepository,
)
from jobctrl.infrastructure.compensation.sqlite_repository import (
    SqlitePostedCompensationRepository,
)
from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema
from tests.compensation_fakes import pay_extractor, record_job_interpretation


def _connection() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    create_exact_v14_schema(conn)
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

    posted = SqlitePostedCompensationRepository(conn, extractor=pay_extractor(conn, minimum=100000, maximum=130000))
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

    record_job_interpretation(conn, local_job_id)
    market = SqliteMarketCompensationRepository(conn)
    assert market.backfill_from_jobs((), tenant_id="local", job_id=local_job_id) == 1

    estimate = market.get_estimate("local", local_job_id)
    assert estimate is not None
    assert estimate.job_id == local_job_id
    assert estimate.estimate_state == "insufficient_evidence"
    assert estimate.minimum_amount is None
    assert estimate.sources == ()
    assert market.get_estimate("other", other_job_id) is None


def test_jobspy_posted_compensation_producer_resolves_the_tenant_scoped_job_id(monkeypatch) -> None:
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

    original = SqlitePostedCompensationRepository
    monkeypatch.setattr(
        "jobctrl.infrastructure.compensation.SqlitePostedCompensationRepository",
        lambda connection: original(connection, extractor=pay_extractor(connection, minimum=90000, maximum=110000)),
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


@pytest.mark.parametrize("producer", ["jobspy", "url_import"])
def test_discovery_posted_pay_selects_current_enriched_description(monkeypatch, producer: str) -> None:
    conn = _connection()
    job_id = JobId("66666666-6666-4666-8666-666666666666")
    url = "https://example.test/jobs/enriched"
    _insert_job(conn, tenant_id="local", job_id=job_id, url=url, salary="EUR 70000/year")
    _insert_job(conn, tenant_id="other", job_id=job_id, url=url, salary="EUR 120000/year")
    conn.execute(
        "UPDATE jobs SET salary=NULL, full_description='EUR 70000/year' WHERE tenant_id='local' AND job_id=?",
        (job_id,),
    )
    conn.execute(
        "INSERT INTO job_enrichments (tenant_id,job_id,current_status,full_description,updated_at) "
        "VALUES ('local',?,'enriched','EUR 90000/year','2026-01-01')",
        (job_id,),
    )
    conn.execute(
        "INSERT INTO job_enrichments (tenant_id,job_id,current_status,full_description,updated_at) "
        "VALUES ('other',?,'enriched','EUR 120000/year','2026-01-01')",
        (job_id,),
    )
    conn.commit()
    original = SqlitePostedCompensationRepository
    monkeypatch.setattr(
        "jobctrl.infrastructure.compensation.SqlitePostedCompensationRepository",
        lambda connection: original(connection, extractor=pay_extractor(connection, minimum=90000, maximum=90000)),
    )

    if producer == "jobspy":
        _upsert_posted_compensation_fact(conn, tenant_id="local", job_url=url, parsed_at="2026-10-19T20:00:00Z")
    else:
        _ensure_posted_compensation_fact(
            conn, tenant_id="local", job_id=job_id, source_native_id="synthetic-enriched",
        )

    fact = original(conn).get_fact("local", job_id)
    assert fact is not None
    assert (fact.source_field, fact.minimum_amount) == ("job_enrichments.full_description", 90000)
    conn.close()


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


@pytest.mark.parametrize("producer", ["jobspy", "url_import"])
@pytest.mark.parametrize("source_changes", [False, True])
def test_discovery_posted_pay_inference_releases_the_intake_writer(
    tmp_path: Path, monkeypatch, producer: str, source_changes: bool,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    create_exact_v14_schema(conn)
    job_id = JobId("55555555-5555-4555-8555-555555555555")
    url = "https://example.test/jobs/writer-boundary"
    _insert_job(conn, tenant_id="local", job_id=job_id, url=url, salary="€90,000-€110,000/year")
    if source_changes:
        conn.execute("UPDATE jobs SET salary='€80,000-€95,000/year' WHERE job_id=?", (job_id,))
        conn.commit()
        SqlitePostedCompensationRepository(
            conn, extractor=pay_extractor(conn, minimum=80000, maximum=95000),
        ).parse_and_save_job_salary(job_id, "€80,000-€95,000/year")
        conn.execute("UPDATE jobs SET salary='€90,000-€110,000/year' WHERE job_id=?", (job_id,))
        conn.commit()
    wrapped = pay_extractor(conn, minimum=90000, maximum=110000)
    observed = []

    class WriterCheckingExtractor:
        def extract(self, *args, **kwargs):
            assert not conn.in_transaction, "Inference must not retain the intake writer"
            with sqlite3.connect(db_path, timeout=0) as other:
                if source_changes:
                    other.execute("UPDATE jobs SET salary='€100,000-€120,000/year' WHERE job_id=?", (job_id,))
                else:
                    other.execute("UPDATE jobs SET title=title WHERE job_id=?", (job_id,))
            observed.append("independent_writer_committed")
            return wrapped.extract(*args, **kwargs)

    original = SqlitePostedCompensationRepository
    monkeypatch.setattr(
        "jobctrl.infrastructure.compensation.SqlitePostedCompensationRepository",
        lambda connection: original(connection, extractor=WriterCheckingExtractor()),
    )
    conn.execute("UPDATE jobs SET description='Completed synthetic intake' WHERE job_id=?", (job_id,))

    if producer == "jobspy":
        _upsert_posted_compensation_fact(
            conn, tenant_id="local", job_url=url, parsed_at="2026-10-19T20:00:00Z",
            write_fence=lambda: conn.execute("UPDATE jobs SET title=title WHERE job_id=?", (job_id,)),
        )
    else:
        _ensure_posted_compensation_fact(
            conn, tenant_id="local", job_id=job_id, source_native_id="synthetic-writer-boundary",
        )

    assert observed == ["independent_writer_committed"]
    fact = original(conn).get_fact("local", job_id)
    assert fact is not None
    assert fact.minimum_amount == (80000 if source_changes else 90000)
    assert conn.execute(
        "SELECT COUNT(*) FROM job_events WHERE job_id=? AND event_type='CompensationFactsUpdated'", (job_id,),
    ).fetchone()[0] == 1
    conn.close()
