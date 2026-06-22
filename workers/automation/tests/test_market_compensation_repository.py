from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

import jobhunter.infrastructure.compensation.sqlite_market_repository as sqlite_market_repository
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
    load_euro_top_tech_observations,
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


def test_repository_round_trips_non_range_states(
    conn: sqlite3.Connection,
) -> None:
    job_url = _seed_job(conn, url="https://example.com/jobs/missing_company", company="")
    repo = SqliteMarketCompensationRepository(conn)
    estimate = repo.estimate_and_save_job(
        job_url=job_url,
        title="Senior Platform Engineer",
        company="",
        location="Remote Europe",
        observations=(_levels(), _glassdoor()),
        estimated_at="2026-06-19T10:00:00Z",
    )
    loaded = repo.get_estimate("local", job_url)

    assert loaded is not None
    assert loaded.estimate_state == "insufficient_evidence"
    assert loaded.minimum_amount is None
    assert loaded.maximum_amount is None
    assert "missing_company" in loaded.insufficient_reasons
    assert loaded.estimate_state == estimate.estimate_state


def test_repository_round_trips_fallback_ranges_and_confidence_interval(
    conn: sqlite3.Connection,
) -> None:
    job_url = _seed_job(conn, url="https://example.com/jobs/location-fallback", company="Different Company")
    repo = SqliteMarketCompensationRepository(conn)

    estimate = repo.estimate_and_save_job(
        job_url=job_url,
        title="Senior Platform Engineer",
        company="Different Company",
        location="Remote Europe",
        observations=(_levels(), _glassdoor()),
        estimated_at="2026-06-19T10:00:00Z",
    )
    loaded = repo.get_estimate("local", job_url)

    assert loaded is not None
    assert loaded.estimate_state == "estimated_range"
    assert loaded.match_scope == "same_location_role_fallback"
    assert loaded.confidence_interval_minimum_amount == estimate.confidence_interval_minimum_amount
    assert loaded.confidence_interval_maximum_amount == estimate.confidence_interval_maximum_amount
    assert loaded.confidence_interval_minimum_amount is not None
    assert loaded.confidence_interval_minimum_amount < (loaded.minimum_amount or 0)
    assert loaded.confidence_interval_maximum_amount is not None
    assert loaded.confidence_interval_maximum_amount > (loaded.maximum_amount or 0)


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


def test_backfill_derives_market_range_from_posted_salary_fact_and_company_column(
    conn: sqlite3.Connection,
) -> None:
    job_url = "https://example.com/jobs/posted-market"
    conn.execute(
        """
        INSERT INTO jobs (
            url, title, site, company, location, salary, description, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            job_url,
            "Senior Platform Engineer",
            "indeed",
            "Acme AI",
            "Remote Europe",
            "€100,000-€130,000/year",
            "Synthetic job",
            "2026-06-19T10:00:00Z",
        ),
    )
    SqlitePostedCompensationRepository(conn).save_fact(
        parse_posted_compensation(
            "€100,000-€130,000/year",
            job_url=job_url,
            parsed_at="2026-06-19T10:00:00Z",
        )
    )
    repo = SqliteMarketCompensationRepository(conn)

    assert repo.backfill_from_jobs((), estimated_at="2026-06-19T10:00:00Z") == 1

    estimate = repo.get_estimate("local", job_url)
    assert estimate is not None
    assert estimate.estimate_state == "estimated_range"
    assert estimate.component == "base_salary"
    assert estimate.company_name == "Acme AI"
    assert estimate.minimum_amount == 100_000
    assert estimate.maximum_amount == 130_000
    assert estimate.confidence_interval_minimum_amount is not None
    assert estimate.confidence_interval_minimum_amount < estimate.minimum_amount
    assert estimate.confidence_interval_maximum_amount is not None
    assert estimate.confidence_interval_maximum_amount > estimate.maximum_amount
    assert estimate.confidence_band == "low"
    assert "posted_salary_sample" in estimate.warnings
    assert "low_sample_count" in estimate.warnings
    assert estimate.sources[0].source_id == "posted_salary_text"
    assert estimate.sources[0].source_type == "posted_salary"


def test_posted_backfill_extracts_salary_text_from_full_description(
    conn: sqlite3.Connection,
) -> None:
    job_url = "https://example.com/jobs/full-description-salary"
    conn.execute(
        """
        INSERT INTO jobs (
            url, title, site, company, location, salary, full_description, description, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            job_url,
            "Senior Platform Engineer",
            "indeed",
            "Acme AI",
            "Remote Europe",
            "",
            "The base salary range is €100,000-€130,000 per year for this role.",
            "Synthetic job",
            "2026-06-19T10:00:00Z",
        ),
    )
    repo = SqlitePostedCompensationRepository(conn)

    assert repo.backfill_from_legacy_jobs(parsed_at="2026-06-19T10:00:00Z") == 1

    fact = repo.get_fact("local", job_url)
    assert fact is not None
    assert fact.parse_state == "parsed_range"
    assert fact.source_field == "jobs.full_description"
    assert fact.annualized_minimum_amount == 100_000
    assert fact.annualized_maximum_amount == 130_000


def test_backfill_falls_back_to_posted_salary_when_reported_rows_are_too_weak(
    conn: sqlite3.Connection,
) -> None:
    job_url = _seed_job(
        conn,
        url="https://example.com/jobs/reported-too-weak",
        title="Staff AI Engineer",
        company="Acme AI",
        location="Remote Europe",
        salary="€100,000-€130,000/year",
    )
    SqlitePostedCompensationRepository(conn).save_fact(
        parse_posted_compensation(
            "€100,000-€130,000/year",
            job_url=job_url,
            parsed_at="2026-06-19T10:00:00Z",
        )
    )
    weak_reported_observations = (
        ReportedCompensationObservation(
            source_id="euro_top_tech",
            company_name="Unrelated Company",
            role_title="Staff AI Engineer",
            minimum_amount=30_000,
            maximum_amount=30_000,
            component="total_compensation",
            location="Berlin, Germany",
            level_label="Staff",
            sample_count=1,
            attribution="Euro Top Tech public crowdsourced compensation data",
        ),
        ReportedCompensationObservation(
            source_id="euro_top_tech",
            company_name="Different Company",
            role_title="Staff AI Engineer",
            minimum_amount=250_000,
            maximum_amount=250_000,
            component="total_compensation",
            location="Madrid, Spain",
            level_label="Staff",
            sample_count=1,
            attribution="Euro Top Tech public crowdsourced compensation data",
        ),
    )
    repo = SqliteMarketCompensationRepository(conn)

    assert repo.backfill_from_jobs(weak_reported_observations, estimated_at="2026-06-19T10:00:00Z") == 1

    estimate = repo.get_estimate("local", job_url)
    assert estimate is not None
    assert estimate.estimate_state == "estimated_range"
    assert estimate.component == "base_salary"
    assert estimate.minimum_amount == 100_000
    assert estimate.maximum_amount == 130_000
    assert estimate.sources[0].source_id == "posted_salary_text"


def test_backfill_uses_high_value_missing_period_salary_text_as_annual_market_evidence(
    conn: sqlite3.Connection,
) -> None:
    job_url = _seed_job(
        conn,
        url="https://example.com/jobs/missing-period-salary",
        title="Staff Engineer",
        company="Acme AI",
        salary="Salary to €120,000",
    )
    SqlitePostedCompensationRepository(conn).save_fact(
        parse_posted_compensation(
            "Salary to €120,000",
            job_url=job_url,
            parsed_at="2026-06-19T10:00:00Z",
        )
    )
    repo = SqliteMarketCompensationRepository(conn)

    assert repo.backfill_from_jobs((), estimated_at="2026-06-19T10:00:00Z") == 1

    estimate = repo.get_estimate("local", job_url)
    assert estimate is not None
    assert estimate.estimate_state == "estimated_range"
    assert estimate.minimum_amount == 120_000
    assert estimate.maximum_amount == 120_000
    assert estimate.confidence_interval_minimum_amount is not None
    assert estimate.confidence_interval_minimum_amount < 120_000


def test_backfill_rejects_bonus_only_missing_period_salary_text_as_market_evidence(
    conn: sqlite3.Connection,
) -> None:
    job_url = _seed_job(
        conn,
        url="https://example.com/jobs/referral-bonus",
        title="Staff AI Engineer",
        company="Acme AI",
        salary="Referral Bonus: €1500",
    )
    SqlitePostedCompensationRepository(conn).save_fact(
        parse_posted_compensation(
            "Referral Bonus: €1500",
            job_url=job_url,
            parsed_at="2026-06-19T10:00:00Z",
        )
    )
    repo = SqliteMarketCompensationRepository(conn)

    assert repo.backfill_from_jobs((), estimated_at="2026-06-19T10:00:00Z") == 1

    estimate = repo.get_estimate("local", job_url)
    assert estimate is not None
    assert estimate.estimate_state == "insufficient_evidence"
    assert estimate.minimum_amount is None
    assert estimate.maximum_amount is None


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


def test_importer_loads_euro_top_tech_public_data(monkeypatch: pytest.MonkeyPatch) -> None:
    payloads = [
        {
            "rows": [
                {
                    "country": "Spain",
                    "city": "Barcelona",
                    "jobTitle": "Staff Software Engineer",
                    "company": "Airbnb",
                    "seniority": "Staff / Engineering Manager",
                    "preTaxTC": 242000,
                    "submittedMonth": "2026-06",
                },
                {
                    "country": "India",
                    "city": "Pune",
                    "jobTitle": "Software Engineer",
                    "company": "Filtered",
                    "seniority": "Mid-Level",
                    "preTaxTC": 25000,
                    "submittedMonth": "2026-06",
                },
            ],
            "hasMore": True,
            "nextCursor": "cursor-2",
        },
        {
            "rows": [
                {
                    "country": "Germany",
                    "city": "Munich",
                    "jobTitle": None,
                    "company": None,
                    "seniority": "Senior",
                    "preTaxTC": 102000,
                    "submittedMonth": "2026-06",
                }
            ],
            "hasMore": False,
        },
    ]

    def fake_fetch_json(url: str, *, timeout_seconds: float) -> dict:
        assert timeout_seconds > 0
        assert "api/data-entries" in url
        return payloads.pop(0)

    monkeypatch.setattr(sqlite_market_repository, "_fetch_json", fake_fetch_json)

    observations = load_euro_top_tech_observations(max_pages=2)

    assert [observation.source_id for observation in observations] == ["euro_top_tech", "euro_top_tech"]
    assert observations[0].company_name == "Airbnb"
    assert observations[0].role_title == "Staff Software Engineer"
    assert observations[0].minimum_amount == 242_000
    assert observations[0].component == "total_compensation"
    assert observations[0].location == "Barcelona, Spain"
    assert observations[0].attribution and "Euro Top Tech" in observations[0].attribution
    assert observations[1].company_name == "Euro Top Tech community"
    assert observations[1].role_title == "Senior Software Engineer"


def test_euro_top_tech_importer_keeps_loaded_rows_when_later_page_is_throttled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = {
        "rows": [
            {
                "country": "Spain",
                "city": "Barcelona",
                "jobTitle": "Staff Software Engineer",
                "company": "Airbnb",
                "seniority": "Staff / Engineering Manager",
                "preTaxTC": 242000,
                "submittedMonth": "2026-06",
            }
        ],
        "hasMore": True,
        "nextCursor": "cursor-2",
    }
    calls = 0

    def fake_fetch_json(url: str, *, timeout_seconds: float) -> dict:
        nonlocal calls
        calls += 1
        if calls == 1:
            return payload
        raise RuntimeError("too many requests")

    monkeypatch.setattr(sqlite_market_repository, "_fetch_json", fake_fetch_json)

    observations = load_euro_top_tech_observations(max_pages=2)

    assert calls == 2
    assert len(observations) == 1
    assert observations[0].source_id == "euro_top_tech"
    assert observations[0].minimum_amount == 242_000


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
        "changedSections": ["market"],
        "postedRecordStatus": None,
        "postedParseState": None,
        "marketRecordStatus": "recorded",
        "marketEstimateState": "estimated_range",
        "updatedAt": "2026-06-19T10:00:00Z",
    }
    assert "sources" not in payload
    assert "eurostat" not in json.dumps(payload).lower()


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
            '[{"name":"company","score":1,"band":"high","reason":"private /Users/local credential"},'
            '{"name":"sample","score":0.5,"band":"low","reason":"Reported compensation sample count: 1."}]',
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
    assert loaded.factors[1].reason == "Reported compensation sample count: 1."
    assert "rawproviderpayload" not in serialized
    assert "/users/" not in serialized
    assert "credential" not in serialized
    assert "secret" not in serialized
