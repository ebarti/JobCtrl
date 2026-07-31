from __future__ import annotations

import json
import sqlite3
import uuid
from pathlib import Path

import pytest

from jobctrl.database import init_db
from jobctrl.domain.compensation import parse_posted_compensation
from jobctrl.domain.identifiers import JobId
from jobctrl.infrastructure.compensation import SqlitePostedCompensationRepository


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


def test_upsert_and_read_round_trip(conn: sqlite3.Connection) -> None:
    _job_url, job_id = _seed_job(conn)
    repo = SqlitePostedCompensationRepository(conn)
    fact = parse_posted_compensation(
        "€80,000-€95,000/year",
        job_id=job_id,
        parsed_at="2026-06-19T10:00:00Z",
    )

    repo.save_fact(fact)
    loaded = repo.get_fact("local", job_id)

    assert loaded is not None
    assert loaded.parse_state == "parsed_range"
    assert loaded.source_text == "€80,000-€95,000/year"
    assert loaded.legacy_raw_salary == "€80,000-€95,000/year"
    assert loaded.currency == "EUR"
    assert loaded.minimum_amount == 80_000
    assert loaded.maximum_amount == 95_000
    assert loaded.annualized_minimum_amount == 80_000
    assert loaded.confidence == "high"
    assert loaded.warnings == ()

    event = conn.execute(
        """
        SELECT payload_json FROM job_events
        WHERE tenant_id = ? AND job_id = ? AND event_type = 'CompensationFactsUpdated'
        ORDER BY event_id DESC LIMIT 1
        """,
        ("local", job_id),
    ).fetchone()
    payload = json.loads(event["payload_json"])
    assert payload == {
        "jobId": str(job_id),
        "changedSections": ["posted"],
        "postedRecordStatus": "recorded",
        "postedParseState": "parsed_range",
        "marketRecordStatus": None,
        "marketEstimateState": None,
        "updatedAt": "2026-06-19T10:00:00Z",
        "stage": "enrich",
        "level": "info",
        "message": "Posted compensation fact updated",
    }
    assert "sourceText" not in payload
    assert "€80,000" not in json.dumps(payload)


def test_backfill_is_idempotent_and_preserves_legacy_salary(conn: sqlite3.Connection) -> None:
    job_url, job_id = _seed_job(conn, salary="$180,000/year")
    repo = SqlitePostedCompensationRepository(conn)

    assert repo.backfill_from_jobs(parsed_at="2026-06-19T10:00:00Z") == 1
    assert repo.backfill_from_jobs(parsed_at="2026-06-19T10:00:00Z") == 1

    rows = conn.execute("SELECT * FROM job_posted_compensation_facts WHERE tenant_id = ? AND job_id = ?", ("local", job_id)).fetchall()
    salary = conn.execute("SELECT salary FROM jobs WHERE tenant_id = ? AND job_id = ?", ("local", job_id)).fetchone()["salary"]
    fact = repo.get_fact("local", job_id)

    assert len(rows) == 1
    assert salary == "$180,000/year"
    assert fact is not None
    assert fact.legacy_raw_salary == "$180,000/year"
    assert fact.minimum_amount == 180_000


def test_backfill_records_missing_fact_without_erasing_blank_salary(conn: sqlite3.Connection) -> None:
    _job_url, job_id = _seed_job(conn, salary=None)
    repo = SqlitePostedCompensationRepository(conn)

    repo.backfill_from_jobs(parsed_at="2026-06-19T10:00:00Z")
    fact = repo.get_fact("local", job_id)
    salary = conn.execute("SELECT salary FROM jobs WHERE tenant_id = ? AND job_id = ?", ("local", job_id)).fetchone()["salary"]

    assert fact is not None
    assert fact.parse_state == "missing"
    assert fact.legacy_raw_salary is None
    assert salary is None


def test_backfill_persists_mixed_component_two_amount_text_as_ambiguous(
    conn: sqlite3.Connection,
) -> None:
    _job_url, job_id = _seed_job(conn, salary="Base €90k/year plus bonus €10k/year")
    repo = SqlitePostedCompensationRepository(conn)

    repo.backfill_from_jobs(parsed_at="2026-06-19T10:00:00Z")
    fact = repo.get_fact("local", job_id)
    salary = conn.execute("SELECT salary FROM jobs WHERE tenant_id = ? AND job_id = ?", ("local", job_id)).fetchone()["salary"]

    assert salary == "Base €90k/year plus bonus €10k/year"
    assert fact is not None
    assert fact.parse_state == "ambiguous"
    assert fact.minimum_amount is None
    assert fact.maximum_amount is None
    assert fact.annualized_minimum_amount is None
    assert "ambiguous_multiple_amounts" in fact.warnings


def test_parse_and_save_job_salary_updates_fact_after_rediscovery_preserves_raw_fallback(
    conn: sqlite3.Connection,
) -> None:
    _job_url, job_id = _seed_job(conn, salary="€80,000/year")
    repo = SqlitePostedCompensationRepository(conn)

    repo.parse_and_save_job_salary(job_id, "€80,000/year", parsed_at="2026-06-19T10:00:00Z")
    conn.execute("UPDATE jobs SET salary = COALESCE(NULLIF(?, ''), salary) WHERE tenant_id = ? AND job_id = ?", ("", "local", job_id))
    repo.parse_and_save_job_salary(job_id, conn.execute("SELECT salary FROM jobs WHERE tenant_id = ? AND job_id = ?", ("local", job_id)).fetchone()["salary"])

    salary = conn.execute("SELECT salary FROM jobs WHERE tenant_id = ? AND job_id = ?", ("local", job_id)).fetchone()["salary"]
    fact = repo.get_fact("local", job_id)

    assert salary == "€80,000/year"
    assert fact is not None
    assert fact.legacy_raw_salary == "€80,000/year"
    assert fact.minimum_amount == 80_000


def test_source_text_is_bounded_in_persistence(conn: sqlite3.Connection) -> None:
    _job_url, job_id = _seed_job(conn, salary="€80,000/year " + ("with benefits " * 80))
    repo = SqlitePostedCompensationRepository(conn)

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
