from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from jobhunter.database import ensure_market_compensation_tables, init_db
from jobhunter.domain.compensation import (
    PublicMarketBaseline,
    estimate_market_compensation,
    not_requested_market_estimate,
    parse_posted_compensation,
)
from jobhunter.infrastructure.compensation import SqliteMarketCompensationRepository, SqlitePostedCompensationRepository


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobhunter.db")


def _seed_job(
    conn: sqlite3.Connection,
    *,
    url: str = "https://example.com/jobs/1",
    title: str = "Platform Engineer",
    location: str = "Remote Europe",
    salary: str | None = "€80,000-€95,000/year",
) -> str:
    conn.execute(
        "INSERT INTO jobs (url, title, site, location, salary, description, discovered_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (url, title, "Example", location, salary, "Synthetic job", "2026-06-19T10:00:00Z"),
    )
    conn.commit()
    return url


def _esco() -> PublicMarketBaseline:
    return PublicMarketBaseline(
        source_id="esco_occupation_taxonomy",
        occupation_code="2512.1",
        occupation_label="Software developer",
        geography_scope="Europe",
        aggregate_bucket="ESCO software developer",
        minimum_amount=None,
        maximum_amount=None,
        attribution="ESCO public occupation taxonomy",
    )


def _eurostat() -> PublicMarketBaseline:
    return PublicMarketBaseline(
        source_id="eurostat_structure_of_earnings",
        occupation_code="2512.1",
        occupation_label="Software developer",
        geography_scope="EU",
        aggregate_bucket="Eurostat SES software aggregate",
        minimum_amount=72_000,
        maximum_amount=92_000,
        release_year=2024,
        sample_count=900,
        attribution="Eurostat public statistical aggregate",
        seniority_match_score=0.82,
    )


def test_schema_is_created_by_init_db(conn: sqlite3.Connection) -> None:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'job_market_compensation_estimates'"
    ).fetchone()

    assert row is not None
    assert ensure_market_compensation_tables(conn) == []


def test_save_and_read_round_trip_estimated_range(conn: sqlite3.Connection) -> None:
    job_url = _seed_job(conn)
    repo = SqliteMarketCompensationRepository(conn)
    estimate = estimate_market_compensation(
        job_url=job_url,
        title="Platform Engineer",
        location="Remote Europe",
        baselines=(_esco(), _eurostat()),
        estimated_at="2026-06-19T10:00:00Z",
    )

    repo.save_estimate(estimate)
    loaded = repo.get_estimate("local", job_url)

    assert loaded is not None
    assert loaded.estimate_state == "estimated_range"
    assert loaded.currency == "EUR"
    assert loaded.minimum_amount == 72_000
    assert loaded.maximum_amount == 92_000
    assert loaded.confidence_band == estimate.confidence_band
    assert loaded.sources[0].source_id == "eurostat_structure_of_earnings"
    assert loaded.factors
    assert "remote_europe_assumption" in loaded.warnings


@pytest.mark.parametrize(
    ("location", "state", "reason"),
    [
        ("San Francisco, United States", "unsupported", "unsupported_geography"),
        ("Remote Europe", "insufficient_evidence", "missing_salary_observation"),
    ],
)
def test_repository_round_trips_non_range_states(
    conn: sqlite3.Connection,
    location: str,
    state: str,
    reason: str,
) -> None:
    job_url = _seed_job(conn, url=f"https://example.com/jobs/{state}", location=location)
    baselines = (_esco(),) if state == "insufficient_evidence" else (_esco(), _eurostat())
    repo = SqliteMarketCompensationRepository(conn)
    estimate = repo.estimate_and_save_job(
        job_url=job_url,
        title="Platform Engineer",
        location=location,
        baselines=baselines,
        estimated_at="2026-06-19T10:00:00Z",
    )
    loaded = repo.get_estimate("local", job_url)

    assert loaded is not None
    assert loaded.estimate_state == state
    assert loaded.minimum_amount is None
    assert loaded.maximum_amount is None
    assert reason in (*loaded.unsupported_reasons, *loaded.insufficient_reasons)
    assert loaded.estimate_state == estimate.estimate_state


def test_repository_does_not_persist_not_requested_marker(conn: sqlite3.Connection) -> None:
    job_url = _seed_job(conn, url="https://example.com/jobs/not-requested")
    repo = SqliteMarketCompensationRepository(conn)

    with pytest.raises(ValueError, match="not_requested"):
        repo.save_estimate(
            not_requested_market_estimate(
                job_url=job_url,
                estimated_at="2026-06-19T10:00:00Z",
            )
        )

    row = conn.execute("SELECT * FROM job_market_compensation_estimates WHERE job_url = ?", (job_url,)).fetchone()
    assert row is None


def test_backfill_is_idempotent_and_preserves_existing_salary_and_posted_facts(
    conn: sqlite3.Connection,
) -> None:
    job_url = _seed_job(conn, salary="€80,000-€95,000/year")
    posted_repo = SqlitePostedCompensationRepository(conn)
    posted_repo.save_fact(
        parse_posted_compensation(
            "€80,000-€95,000/year",
            job_url=job_url,
            parsed_at="2026-06-19T10:00:00Z",
        )
    )
    repo = SqliteMarketCompensationRepository(conn)

    assert repo.backfill_from_jobs((_esco(), _eurostat()), estimated_at="2026-06-19T10:00:00Z") == 1
    assert repo.backfill_from_jobs((_esco(), _eurostat()), estimated_at="2026-06-19T10:00:00Z") == 1

    market_rows = conn.execute("SELECT * FROM job_market_compensation_estimates WHERE job_url = ?", (job_url,)).fetchall()
    posted_rows = conn.execute("SELECT * FROM job_posted_compensation_facts WHERE job_url = ?", (job_url,)).fetchall()
    salary = conn.execute("SELECT salary FROM jobs WHERE url = ?", (job_url,)).fetchone()["salary"]

    assert len(market_rows) == 1
    assert len(posted_rows) == 1
    assert salary == "€80,000-€95,000/year"


def test_persisted_json_contains_only_safe_public_fields(conn: sqlite3.Connection) -> None:
    job_url = _seed_job(conn)
    repo = SqliteMarketCompensationRepository(conn)
    repo.estimate_and_save_job(
        job_url=job_url,
        title="Platform Engineer",
        location="Remote Europe",
        baselines=(_esco(), _eurostat()),
        estimated_at="2026-06-19T10:00:00Z",
    )

    row = conn.execute(
        """
        SELECT source_snapshot_json, factor_reasons_json, insufficient_reasons_json, warnings_json
        FROM job_market_compensation_estimates WHERE job_url = ?
        """,
        (job_url,),
    ).fetchone()
    serialized = " ".join(str(row[key]).lower() for key in row.keys())

    assert "eurostat_structure_of_earnings" in serialized
    assert "esco_occupation_taxonomy" in serialized
    assert "glassdoor" not in serialized
    assert "levels" not in serialized
    assert "salary.com" not in serialized
    assert "onet" not in serialized
    assert "rawproviderpayload" not in serialized
    assert "/users/" not in serialized
    assert "credential" not in serialized
