from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from jobhunter.database import ensure_posted_compensation_tables, init_db
from jobhunter.domain.compensation import parse_posted_compensation
from jobhunter.infrastructure.compensation import SqlitePostedCompensationRepository


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobhunter.db")


def _seed_job(
    conn: sqlite3.Connection,
    *,
    url: str = "https://example.com/jobs/1",
    salary: str | None = "€80,000-€95,000/year",
) -> str:
    conn.execute(
        "INSERT INTO jobs (url, title, site, salary, description, discovered_at) VALUES (?, ?, ?, ?, ?, ?)",
        (url, "Platform Engineer", "Example", salary, "Synthetic job", "2026-06-19T10:00:00Z"),
    )
    conn.commit()
    return url


def test_schema_is_created_by_init_db(conn: sqlite3.Connection) -> None:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'job_posted_compensation_facts'"
    ).fetchone()

    assert row is not None
    assert ensure_posted_compensation_tables(conn) == []


def test_upsert_and_read_round_trip(conn: sqlite3.Connection) -> None:
    job_url = _seed_job(conn)
    repo = SqlitePostedCompensationRepository(conn)
    fact = parse_posted_compensation(
        "€80,000-€95,000/year",
        job_url=job_url,
        parsed_at="2026-06-19T10:00:00Z",
    )

    repo.save_fact(fact)
    loaded = repo.get_fact("local", job_url)

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
        WHERE job_url = ? AND event_type = 'CompensationFactsUpdated'
        ORDER BY event_id DESC LIMIT 1
        """,
        (job_url,),
    ).fetchone()
    payload = json.loads(event["payload_json"])
    assert payload == {
        "jobId": job_url,
        "changedSections": ["posted"],
        "postedRecordStatus": "recorded",
        "postedParseState": "parsed_range",
        "marketRecordStatus": None,
        "marketEstimateState": None,
        "updatedAt": "2026-06-19T10:00:00Z",
    }
    assert "sourceText" not in payload
    assert "€80,000" not in json.dumps(payload)


def test_backfill_is_idempotent_and_preserves_legacy_salary(conn: sqlite3.Connection) -> None:
    job_url = _seed_job(conn, salary="$180,000/year")
    repo = SqlitePostedCompensationRepository(conn)

    assert repo.backfill_from_legacy_jobs(parsed_at="2026-06-19T10:00:00Z") == 1
    assert repo.backfill_from_legacy_jobs(parsed_at="2026-06-19T10:00:00Z") == 1

    rows = conn.execute("SELECT * FROM job_posted_compensation_facts WHERE job_url = ?", (job_url,)).fetchall()
    salary = conn.execute("SELECT salary FROM jobs WHERE url = ?", (job_url,)).fetchone()["salary"]
    fact = repo.get_fact("local", job_url)

    assert len(rows) == 1
    assert salary == "$180,000/year"
    assert fact is not None
    assert fact.legacy_raw_salary == "$180,000/year"
    assert fact.minimum_amount == 180_000


def test_backfill_records_missing_fact_without_erasing_blank_salary(conn: sqlite3.Connection) -> None:
    job_url = _seed_job(conn, salary=None)
    repo = SqlitePostedCompensationRepository(conn)

    repo.backfill_from_legacy_jobs(parsed_at="2026-06-19T10:00:00Z")
    fact = repo.get_fact("local", job_url)
    salary = conn.execute("SELECT salary FROM jobs WHERE url = ?", (job_url,)).fetchone()["salary"]

    assert fact is not None
    assert fact.parse_state == "missing"
    assert fact.legacy_raw_salary is None
    assert salary is None


def test_backfill_persists_mixed_component_two_amount_text_as_ambiguous(
    conn: sqlite3.Connection,
) -> None:
    job_url = _seed_job(conn, salary="Base €90k/year plus bonus €10k/year")
    repo = SqlitePostedCompensationRepository(conn)

    repo.backfill_from_legacy_jobs(parsed_at="2026-06-19T10:00:00Z")
    fact = repo.get_fact("local", job_url)
    salary = conn.execute("SELECT salary FROM jobs WHERE url = ?", (job_url,)).fetchone()["salary"]

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
    job_url = _seed_job(conn, salary="€80,000/year")
    repo = SqlitePostedCompensationRepository(conn)

    repo.parse_and_save_job_salary(job_url, "€80,000/year", parsed_at="2026-06-19T10:00:00Z")
    conn.execute("UPDATE jobs SET salary = COALESCE(NULLIF(?, ''), salary) WHERE url = ?", ("", job_url))
    repo.parse_and_save_job_salary(job_url, conn.execute("SELECT salary FROM jobs WHERE url = ?", (job_url,)).fetchone()["salary"])

    salary = conn.execute("SELECT salary FROM jobs WHERE url = ?", (job_url,)).fetchone()["salary"]
    fact = repo.get_fact("local", job_url)

    assert salary == "€80,000/year"
    assert fact is not None
    assert fact.legacy_raw_salary == "€80,000/year"
    assert fact.minimum_amount == 80_000


def test_source_text_is_bounded_in_persistence(conn: sqlite3.Connection) -> None:
    job_url = _seed_job(conn, salary="€80,000/year " + ("with benefits " * 80))
    repo = SqlitePostedCompensationRepository(conn)

    repo.backfill_from_legacy_jobs()
    fact = repo.get_fact("local", job_url)
    row = conn.execute(
        "SELECT warnings_json, source_text FROM job_posted_compensation_facts WHERE job_url = ?",
        (job_url,),
    ).fetchone()

    assert fact is not None
    assert len(fact.source_text or "") <= 280
    assert row["warnings_json"] == '["source_text_truncated"]'
    assert len(row["source_text"]) <= 280
