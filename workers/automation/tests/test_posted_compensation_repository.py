from __future__ import annotations

import sqlite3
import uuid
from pathlib import Path

import pytest

from jobctrl.database import init_db
from jobctrl.domain.identifiers import JobId
from jobctrl.infrastructure.compensation import (
    SqlitePostedCompensationRepository,
)


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobctrl.db")


def _seed_job(
    conn: sqlite3.Connection,
    *,
    url: str = "https://example.com/jobs/1",
    salary: str | None = "€80,000-€95,000/year",
) -> tuple[str, JobId]:
    job_id = JobId(str(uuid.uuid5(uuid.NAMESPACE_URL, f"local:{url}")))
    conn.execute(
        "INSERT INTO jobs (tenant_id, job_id, url, title, site, salary, description, discovered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("local", job_id, url, "Platform Engineer", "Example", salary, "Synthetic job", "2026-06-19T10:00:00Z"),
    )
    conn.commit()
    return url, job_id


def test_schema_is_created_by_init_db(conn: sqlite3.Connection) -> None:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'job_posted_compensation_facts'"
    ).fetchone()

    assert row is not None


def test_constructor_does_not_probe_or_mutate_healthy_schema(conn: sqlite3.Connection) -> None:
    statements: list[str] = []
    conn.set_trace_callback(statements.append)

    SqlitePostedCompensationRepository(conn)

    assert statements == []


@pytest.mark.parametrize(
    ("schema_sql", "error"),
    (
        (None, "no such table: job_posted_compensation_facts"),
        (
            "CREATE TABLE job_posted_compensation_facts (tenant_id TEXT, job_id TEXT)",
            "no such column: source_field",
        ),
    ),
)
def test_missing_or_malformed_schema_fails_closed_on_first_operation(
    schema_sql: str | None,
    error: str,
) -> None:
    malformed_conn = sqlite3.connect(":memory:")
    if schema_sql is not None:
        malformed_conn.execute(schema_sql)

    repo = SqlitePostedCompensationRepository(malformed_conn)

    with pytest.raises(sqlite3.OperationalError, match=error):
        repo.get_fact("local", JobId("00000000-0000-0000-0000-000000000001"))


def _mark_fact_as_legacy(
    conn: sqlite3.Connection,
    job_id: JobId,
    *,
    parser_version: str = "posted-compensation-v1",
    component: str = "equity",
) -> None:
    conn.execute(
        """
        UPDATE job_posted_compensation_facts
        SET parser_version = ?,
            component = ?,
            confidence = 'medium'
        WHERE tenant_id = 'local' AND job_id = ?
        """,
        (parser_version, component, job_id),
    )
    conn.execute(
        "DELETE FROM job_events WHERE tenant_id = 'local' AND job_id = ?",
        (job_id,),
    )
    conn.commit()


def test_source_text_is_bounded_in_persistence(conn: sqlite3.Connection) -> None:
    _job_url, job_id = _seed_job(conn, salary="€80,000/year " + ("with benefits " * 80))
    from tests.compensation_fakes import pay_extractor

    repo = SqlitePostedCompensationRepository(conn, extractor=pay_extractor(conn, minimum=80000, maximum=80000))

    repo.backfill_from_jobs()
    fact = repo.get_fact("local", job_id)
    row = conn.execute(
        "SELECT warnings_json, source_text FROM job_posted_compensation_facts WHERE tenant_id = ? AND job_id = ?",
        ("local", job_id),
    ).fetchone()

    assert fact is not None
    assert len(fact.source_text or "") <= 280
    assert row["warnings_json"] == '["source_text_truncated"]'
    assert len(row["source_text"]) <= 280
