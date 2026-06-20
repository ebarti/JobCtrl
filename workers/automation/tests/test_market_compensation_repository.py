from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from jobhunter.database import ensure_market_compensation_tables, init_db
from jobhunter.domain.compensation import (
    ReportedCompensationObservation,
    estimate_market_compensation,
    not_requested_market_estimate,
    parse_posted_compensation,
)
from jobhunter.infrastructure.compensation import (
    SqliteMarketCompensationRepository,
    SqlitePostedCompensationRepository,
    load_reported_compensation_observations,
)
from jobhunter.infrastructure.compensation.sqlite_market_repository import DEFAULT_FACTOR_REASON


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobhunter.db")


def _seed_job(
    conn: sqlite3.Connection,
    *,
    url: str = "https://example.com/jobs/1",
    title: str = "Senior Platform Engineer",
    company: str = "Acme AI",
    location: str = "Remote Europe",
    salary: str | None = "€100,000-€130,000/year",
) -> str:
    conn.execute(
        "INSERT INTO jobs (url, title, site, location, salary, description, discovered_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (url, title, company, location, salary, "Synthetic job", "2026-06-19T10:00:00Z"),
    )
    conn.commit()
    return url


def _levels() -> ReportedCompensationObservation:
    return ReportedCompensationObservation(
        source_id="levels_fyi",
        company_name="Acme AI",
        role_title="Senior Platform Engineer",
        level_label="Senior",
        company_tier="tier_2_ambitious",
        location="Remote Europe",
        minimum_amount=118_000,
        maximum_amount=142_000,
        sample_count=4,
        attribution="Levels.fyi reported compensation data",
    )


def _glassdoor() -> ReportedCompensationObservation:
    return ReportedCompensationObservation(
        source_id="glassdoor",
        company_name="Acme AI",
        role_title="Senior Platform Engineer",
        level_label="Senior",
        company_tier="tier_2_ambitious",
        location="Madrid, Spain",
        minimum_amount=112_000,
        maximum_amount=136_000,
        sample_count=3,
        attribution="Glassdoor reported compensation data",
    )


def test_schema_is_created_by_init_db(conn: sqlite3.Connection) -> None:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'job_market_compensation_estimates'"
    ).fetchone()

    assert row is not None
    assert ensure_market_compensation_tables(conn) == []


def test_save_and_read_round_trip_estimated_company_role_range(conn: sqlite3.Connection) -> None:
    job_url = _seed_job(conn)
    repo = SqliteMarketCompensationRepository(conn)
    estimate = estimate_market_compensation(
        job_url=job_url,
        title="Senior Platform Engineer",
        company="Acme AI",
        location="Remote Europe",
        observations=(_levels(), _glassdoor()),
        estimated_at="2026-06-19T10:00:00Z",
    )

    repo.save_estimate(estimate)
    loaded = repo.get_estimate("local", job_url)

    assert loaded is not None
    assert loaded.estimate_state == "estimated_range"
    assert loaded.currency == "EUR"
    assert loaded.component == "total_compensation"
    assert loaded.minimum_amount == 112_000
    assert loaded.maximum_amount == 142_000
    assert loaded.company_name == "Acme AI"
    assert loaded.normalized_company == "acme ai"
    assert loaded.normalized_role == "platform engineer"
    assert loaded.company_tier == "tier_2_ambitious"
    assert loaded.match_scope == "exact_company_role"
    assert {source.source_id for source in loaded.sources} == {"levels_fyi", "glassdoor"}
    assert loaded.factors
    assert "reported_compensation_sample" in loaded.warnings


@pytest.mark.parametrize(
    ("company", "state", "reason"),
    [
        ("", "insufficient_evidence", "missing_company"),
        ("Different Company", "insufficient_evidence", "missing_reported_observation"),
    ],
)
def test_repository_round_trips_non_range_states(
    conn: sqlite3.Connection,
    company: str,
    state: str,
    reason: str,
) -> None:
    job_url = _seed_job(conn, url=f"https://example.com/jobs/{reason}", company=company)
    repo = SqliteMarketCompensationRepository(conn)
    estimate = repo.estimate_and_save_job(
        job_url=job_url,
        title="Senior Platform Engineer",
        company=company,
        location="Remote Europe",
        observations=(_levels(), _glassdoor()),
        estimated_at="2026-06-19T10:00:00Z",
    )
    loaded = repo.get_estimate("local", job_url)

    assert loaded is not None
    assert loaded.estimate_state == state
    assert loaded.minimum_amount is None
    assert loaded.maximum_amount is None
    assert reason in loaded.insufficient_reasons
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
    job_url = _seed_job(conn, salary="€100,000-€130,000/year")
    posted_repo = SqlitePostedCompensationRepository(conn)
    posted_repo.save_fact(
        parse_posted_compensation(
            "€100,000-€130,000/year",
            job_url=job_url,
            parsed_at="2026-06-19T10:00:00Z",
        )
    )
    repo = SqliteMarketCompensationRepository(conn)

    assert repo.backfill_from_jobs((_levels(), _glassdoor()), estimated_at="2026-06-19T10:00:00Z") == 1
    assert repo.backfill_from_jobs((_levels(), _glassdoor()), estimated_at="2026-06-19T10:00:00Z") == 1

    market_rows = conn.execute("SELECT * FROM job_market_compensation_estimates WHERE job_url = ?", (job_url,)).fetchall()
    posted_rows = conn.execute("SELECT * FROM job_posted_compensation_facts WHERE job_url = ?", (job_url,)).fetchall()
    salary = conn.execute("SELECT salary FROM jobs WHERE url = ?", (job_url,)).fetchone()["salary"]

    assert len(market_rows) == 1
    assert len(posted_rows) == 1
    assert salary == "€100,000-€130,000/year"


def test_importer_loads_levels_and_glassdoor_observations(tmp_path: Path) -> None:
    path = tmp_path / "reported-comp.json"
    path.write_text(
        json.dumps(
            {
                "observations": [
                    {
                        "sourceId": "levels.fyi",
                        "company": "Acme AI",
                        "role": "Senior Platform Engineer",
                        "totalCompensationMin": "€118,000",
                        "totalCompensationMax": "€142,000",
                        "companyTier": "tier_2",
                        "sampleCount": 4,
                    },
                    {
                        "source": "glassdoor",
                        "companyName": "Acme AI",
                        "roleTitle": "Senior Platform Engineer",
                        "amount": 125000,
                        "samples": 3,
                    },
                    {"source": "unknown", "company": "Acme AI", "role": "Ignored", "amount": 1},
                ]
            }
        ),
        encoding="utf-8",
    )

    observations = load_reported_compensation_observations(path)

    assert [observation.source_id for observation in observations] == ["levels_fyi", "glassdoor"]
    assert observations[0].minimum_amount == 118_000
    assert observations[0].maximum_amount == 142_000
    assert observations[0].company_tier == "tier_2_ambitious"
    assert observations[1].minimum_amount == 125_000
    assert observations[1].maximum_amount == 125_000


def test_persisted_json_contains_safe_reported_source_fields(conn: sqlite3.Connection) -> None:
    job_url = _seed_job(conn)
    repo = SqliteMarketCompensationRepository(conn)
    repo.estimate_and_save_job(
        job_url=job_url,
        title="Senior Platform Engineer",
        company="Acme AI",
        location="Remote Europe",
        observations=(_levels(), _glassdoor()),
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

    assert "levels_fyi" in serialized
    assert "glassdoor" in serialized
    assert "rawproviderpayload" not in serialized
    assert "/users/" not in serialized
    assert "credential" not in serialized
    assert "secret" not in serialized


def test_repository_sanitizes_stale_persisted_source_json_on_read(conn: sqlite3.Connection) -> None:
    job_url = _seed_job(conn, url="https://example.com/jobs/stale-source-json")
    repo = SqliteMarketCompensationRepository(conn)
    conn.execute(
        """
        INSERT INTO job_market_compensation_estimates (
            tenant_id, job_url, estimate_state, currency, period, component,
            minimum_amount, maximum_amount, confidence_band, confidence_score,
            source_count, sample_count, aggregate_bucket, geography_scope,
            occupation_code, occupation_label, seniority_label, source_snapshot_json,
            factor_reasons_json, insufficient_reasons_json, unsupported_reasons_json,
            source_unavailable_reasons_json, warnings_json, estimator_version, estimated_at,
            company_name, normalized_company, role_title, normalized_role, company_tier, match_scope
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "local",
            job_url,
            "estimated_range",
            "EUR",
            "year",
            "total_compensation",
            112_000,
            142_000,
            "medium",
            0.82,
            1,
            7,
            "reported company-role compensation",
            "/Users/private",
            "acme ai",
            "platform engineer",
            "senior",
            '[{"source_id":"levels_fyi","display_name":"Levels.fyi private payload",'
            '"source_type":"reported_compensation","release_year":2026,"snapshot_version":"rawProviderPayload",'
            '"geography_scope":"/Users/private","aggregate_bucket":"private page","attribution":"credential secret",'
            '"sample_count":7}]',
            '[{"name":"company","score":1,"band":"high","reason":"private /Users/local credential"}]',
            "[]",
            "[]",
            "[]",
            '["reported_compensation_sample"]',
            "company-role-reported-compensation-v1",
            "2026-06-19T10:00:00Z",
            "Acme AI",
            "acme ai",
            "Senior Platform Engineer",
            "platform engineer",
            "tier_2_ambitious",
            "exact_company_role",
        ),
    )
    conn.commit()

    loaded = repo.get_estimate("local", job_url)
    serialized = str(loaded).casefold()

    assert loaded is not None
    assert loaded.sources[0].display_name == "Levels.fyi"
    assert loaded.sources[0].snapshot_version == "reported-compensation-import-v1"
    assert loaded.factors[0].reason == DEFAULT_FACTOR_REASON
    assert "rawproviderpayload" not in serialized
    assert "/users/" not in serialized
    assert "credential" not in serialized
    assert "secret" not in serialized
