from __future__ import annotations

import json
import sqlite3
import uuid
from dataclasses import replace
from pathlib import Path

import pytest

from jobctrl.database import init_db
from jobctrl.domain.compensation import (
    ReportedCompensationObservation,
    estimate_market_compensation,
    not_requested_market_estimate,
    parse_posted_compensation,
)
from jobctrl.domain.identifiers import JobId
from jobctrl.infrastructure.compensation import (
    LevelsFyiPublicTarget,
    SqliteMarketCompensationRepository,
    SqlitePostedCompensationRepository,
    load_default_reported_compensation_observations,
    load_euro_top_tech_observations,
    load_reported_compensation_observations,
)
from jobctrl.infrastructure.compensation.sqlite_market_repository import DEFAULT_FACTOR_REASON
from jobctrl.infrastructure.compensation.sqlite_market_repository import (
    EuroTopTechLoadOutcome,
)


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobctrl.db")


def _seed_job(
    conn: sqlite3.Connection,
    *,
    url: str = "https://example.com/jobs/1",
    title: str = "Senior Platform Engineer",
    company: str = "Acme AI",
    location: str = "Remote Europe",
    salary: str | None = "€100,000-€130,000/year",
) -> str:
    job_id = _job_id(url)
    conn.execute(
        "INSERT INTO jobs (tenant_id, job_id, url, title, site, location, salary, description, discovered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ("local", job_id, url, title, company, location, salary, "Synthetic job", "2026-06-19T10:00:00Z"),
    )
    conn.commit()
    return url


def _job_id(url: str) -> JobId:
    return JobId(str(uuid.uuid5(uuid.NAMESPACE_URL, f"local:{url}")))


def _levels() -> ReportedCompensationObservation:
    return ReportedCompensationObservation(
        source_id="levels_fyi",
        source_provenance="licensed",
        company_name="Acme AI",
        role_title="Senior Platform Engineer",
        level_label="Senior",
        company_tier="tier_2_ambitious",
        location="Remote Europe",
        minimum_amount=118_000,
        maximum_amount=142_000,
        sample_count=4,
        attribution="Levels.fyi reported compensation data",
        source_url="https://www.levels.fyi/companies/acme-ai/salaries/software-engineer",
    )


def _glassdoor() -> ReportedCompensationObservation:
    return ReportedCompensationObservation(
        source_id="glassdoor",
        source_provenance="licensed",
        company_name="Acme AI",
        role_title="Senior Platform Engineer",
        level_label="Senior",
        company_tier="tier_2_ambitious",
        location="Madrid, Spain",
        minimum_amount=112_000,
        maximum_amount=136_000,
        sample_count=3,
        attribution="Glassdoor reported compensation data",
        source_url="https://www.glassdoor.com/Salary/Acme-AI-Senior-Platform-Engineer-Salaries.htm",
    )


def test_schema_is_created_by_init_db(conn: sqlite3.Connection) -> None:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'job_market_compensation_estimates'"
    ).fetchone()

    assert row is not None


def test_constructor_does_not_probe_or_mutate_healthy_schema(conn: sqlite3.Connection) -> None:
    statements: list[str] = []
    conn.set_trace_callback(statements.append)

    SqliteMarketCompensationRepository(conn)

    assert statements == []


@pytest.mark.parametrize(
    ("schema_sql", "error"),
    (
        (None, "no such table: job_market_compensation_estimates"),
        (
            "CREATE TABLE job_market_compensation_estimates (tenant_id TEXT, job_id TEXT)",
            "no such column: estimate_state",
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

    repo = SqliteMarketCompensationRepository(malformed_conn)

    with pytest.raises(sqlite3.OperationalError, match=error):
        repo.get_estimate("local", JobId("00000000-0000-0000-0000-000000000001"))


def test_save_and_read_round_trip_estimated_company_role_range(conn: sqlite3.Connection) -> None:
    job_url = _seed_job(conn)
    job_id = _job_id(job_url)
    repo = SqliteMarketCompensationRepository(conn)
    estimate = estimate_market_compensation(
        job_id=job_id,
        title="Senior Platform Engineer",
        company="Acme AI",
        location="Remote Europe",
        observations=(_levels(), _glassdoor()),
        estimated_at="2026-06-19T10:00:00Z",
    )

    repo.save_estimate(estimate)
    loaded = repo.get_estimate("local", job_id)

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
    assert len(loaded.evidence) == 2
    evidence_ranges = {(row.minimum_amount, row.maximum_amount) for row in loaded.evidence}
    assert evidence_ranges == {(118_000, 142_000), (112_000, 136_000)}
    assert {row.company_name for row in loaded.evidence} == {"Acme AI"}
    assert {row.role_title for row in loaded.evidence} == {"Senior Platform Engineer"}
    assert {row.source_url for row in loaded.evidence} == {
        "https://www.glassdoor.com/Salary/Acme-AI-Senior-Platform-Engineer-Salaries.htm",
        "https://www.levels.fyi/companies/acme-ai/salaries/software-engineer",
    }
    assert all(row.company_score == 1 for row in loaded.evidence)
    assert "reported_compensation_sample" in loaded.warnings


def test_repository_round_trips_non_range_states(
    conn: sqlite3.Connection,
) -> None:
    job_url = _seed_job(conn, url="https://example.com/jobs/missing_company", company="")
    job_id = _job_id(job_url)
    repo = SqliteMarketCompensationRepository(conn)
    estimate = repo.estimate_and_save_job(
        job_id=job_id,
        title="Senior Platform Engineer",
        company="",
        location="Remote Europe",
        observations=(_levels(), _glassdoor()),
        estimated_at="2026-06-19T10:00:00Z",
    )
    loaded = repo.get_estimate("local", job_id)

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
    job_id = _job_id(job_url)
    repo = SqliteMarketCompensationRepository(conn)

    estimate = repo.estimate_and_save_job(
        job_id=job_id,
        title="Senior Platform Engineer",
        company="Different Company",
        location="Remote Europe",
        observations=(_levels(), _glassdoor()),
        estimated_at="2026-06-19T10:00:00Z",
    )
    loaded = repo.get_estimate("local", job_id)

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
    job_id = _job_id(job_url)
    repo = SqliteMarketCompensationRepository(conn)

    with pytest.raises(ValueError, match="not_requested"):
        repo.save_estimate(
            not_requested_market_estimate(
                job_id=job_id,
                estimated_at="2026-06-19T10:00:00Z",
            )
        )

    row = conn.execute(
        "SELECT * FROM job_market_compensation_estimates WHERE tenant_id = ? AND job_id = ?", ("local", job_id)
    ).fetchone()
    assert row is None


def test_backfill_is_idempotent_and_preserves_existing_salary_and_posted_facts(
    conn: sqlite3.Connection,
) -> None:
    job_url = _seed_job(conn, salary="€100,000-€130,000/year")
    job_id = _job_id(job_url)
    posted_repo = SqlitePostedCompensationRepository(conn)
    posted_repo.save_fact(
        parse_posted_compensation(
            "€100,000-€130,000/year",
            job_id=job_id,
            parsed_at="2026-06-19T10:00:00Z",
        )
    )
    repo = SqliteMarketCompensationRepository(conn)

    assert repo.backfill_from_jobs((_levels(), _glassdoor()), estimated_at="2026-06-19T10:00:00Z") == 1
    assert repo.backfill_from_jobs((_levels(), _glassdoor()), estimated_at="2026-06-19T10:00:00Z") == 1

    market_rows = conn.execute(
        "SELECT * FROM job_market_compensation_estimates WHERE tenant_id = ? AND job_id = ?", ("local", job_id)
    ).fetchall()
    posted_rows = conn.execute(
        "SELECT * FROM job_posted_compensation_facts WHERE tenant_id = ? AND job_id = ?", ("local", job_id)
    ).fetchall()
    salary = conn.execute("SELECT salary FROM jobs WHERE tenant_id = ? AND job_id = ?", ("local", job_id)).fetchone()[
        "salary"
    ]

    assert len(market_rows) == 1
    assert len(posted_rows) == 1
    assert salary == "€100,000-€130,000/year"


def test_backfill_keeps_employer_posted_salary_out_of_market_authority(
    conn: sqlite3.Connection,
) -> None:
    job_url = "https://example.com/jobs/posted-market"
    job_id = _job_id(job_url)
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, site, company, location, salary, description, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "local",
            job_id,
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
            job_id=job_id,
            parsed_at="2026-06-19T10:00:00Z",
        )
    )
    repo = SqliteMarketCompensationRepository(conn)

    assert repo.backfill_from_jobs((), estimated_at="2026-06-19T10:00:00Z") == 1

    estimate = repo.get_estimate("local", job_id)
    assert estimate is not None
    assert estimate.estimate_state == "insufficient_evidence"
    assert estimate.component == "total_compensation"
    assert estimate.company_name == "Acme AI"
    assert estimate.minimum_amount is None
    assert estimate.maximum_amount is None
    assert estimate.sources == ()
    assert "posted_salary_sample" not in estimate.warnings
    posted = SqlitePostedCompensationRepository(conn).get_fact("local", job_id)
    assert posted is not None
    assert posted.annualized_minimum_amount == 100_000
    assert posted.annualized_maximum_amount == 130_000


def test_posted_backfill_extracts_salary_text_from_full_description(
    conn: sqlite3.Connection,
) -> None:
    job_url = "https://example.com/jobs/full-description-salary"
    job_id = _job_id(job_url)
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, site, company, location, salary, full_description, description, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "local",
            job_id,
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

    assert repo.backfill_from_jobs(parsed_at="2026-06-19T10:00:00Z") == 1

    fact = repo.get_fact("local", job_id)
    assert fact is not None
    assert fact.parse_state == "parsed_range"
    assert fact.source_field == "jobs.full_description"
    assert fact.annualized_minimum_amount == 100_000
    assert fact.annualized_maximum_amount == 130_000


def test_backfill_never_falls_back_to_posted_salary_when_reported_rows_are_too_weak(
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
    job_id = _job_id(job_url)
    SqlitePostedCompensationRepository(conn).save_fact(
        parse_posted_compensation(
            "€100,000-€130,000/year",
            job_id=job_id,
            parsed_at="2026-06-19T10:00:00Z",
        )
    )
    weak_reported_observations = (
        ReportedCompensationObservation(
            source_id="euro_top_tech",
            source_provenance="public",
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
            source_provenance="public",
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

    estimate = repo.get_estimate("local", job_id)
    assert estimate is not None
    assert estimate.estimate_state != "estimated_range"
    assert estimate.minimum_amount is None
    assert estimate.maximum_amount is None
    assert all(source.source_id != "posted_salary_text" for source in estimate.sources)
    assert "posted_salary_sample" not in estimate.warnings


def test_backfill_keeps_high_value_missing_period_salary_text_posted_only(
    conn: sqlite3.Connection,
) -> None:
    job_url = _seed_job(
        conn,
        url="https://example.com/jobs/missing-period-salary",
        title="Staff Engineer",
        company="Acme AI",
        salary="Salary to €120,000",
    )
    job_id = _job_id(job_url)
    SqlitePostedCompensationRepository(conn).save_fact(
        parse_posted_compensation(
            "Salary to €120,000",
            job_id=job_id,
            parsed_at="2026-06-19T10:00:00Z",
        )
    )
    repo = SqliteMarketCompensationRepository(conn)

    assert repo.backfill_from_jobs((), estimated_at="2026-06-19T10:00:00Z") == 1

    estimate = repo.get_estimate("local", job_id)
    assert estimate is not None
    assert estimate.estimate_state == "insufficient_evidence"
    assert estimate.minimum_amount is None
    assert estimate.maximum_amount is None
    assert estimate.sources == ()
    posted = SqlitePostedCompensationRepository(conn).get_fact("local", job_id)
    assert posted is not None
    assert posted.maximum_amount == 120_000


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
    job_id = _job_id(job_url)
    SqlitePostedCompensationRepository(conn).save_fact(
        parse_posted_compensation(
            "Referral Bonus: €1500",
            job_id=job_id,
            parsed_at="2026-06-19T10:00:00Z",
        )
    )
    repo = SqliteMarketCompensationRepository(conn)

    assert repo.backfill_from_jobs((), estimated_at="2026-06-19T10:00:00Z") == 1

    estimate = repo.get_estimate("local", job_id)
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
                        "sourceUrl": "https://www.levels.fyi/companies/acme-ai/salaries/software-engineer",
                    },
                    {
                        "source": "glassdoor",
                        "companyName": "Acme AI",
                        "roleTitle": "Senior Platform Engineer",
                        "amount": 125000,
                        "samples": 3,
                        "url": "https://www.glassdoor.com/Salary/Acme-AI-Senior-Platform-Engineer-Salaries.htm",
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
    assert observations[0].source_url == "https://www.levels.fyi/companies/acme-ai/salaries/software-engineer"
    assert observations[1].minimum_amount == 125_000
    assert observations[1].maximum_amount == 125_000
    assert (
        observations[1].source_url == "https://www.glassdoor.com/Salary/Acme-AI-Senior-Platform-Engineer-Salaries.htm"
    )


def test_user_source_settings_enable_levels_feed_without_process_policy_env(
    tmp_path: Path,
) -> None:
    levels_path = tmp_path / "levels.json"
    levels_path.write_text(
        json.dumps(
            [
                {
                    "company": "Acme AI",
                    "role": "Senior Platform Engineer",
                    "amount": 125000,
                }
            ]
        ),
        encoding="utf-8",
    )
    settings_path = tmp_path / "config.json"
    settings_path.write_text(
        json.dumps(
            {
                "compensation_sources": {
                    "levels_fyi": {
                        "enabled": True,
                        "access_mode": "licensed_data_feed",
                        "europe_coverage_confirmed": True,
                    }
                }
            }
        ),
        encoding="utf-8",
    )

    loaded = load_default_reported_compensation_observations(
        include_eurotoptech=False,
        env={"JOBCTRL_LEVELS_FYI_OBSERVATIONS_PATH": str(levels_path)},
        settings_path=settings_path,
    )

    assert loaded.levels_fyi_count == 1
    assert [observation.source_id for observation in loaded.observations] == ["levels_fyi"]


def test_user_source_settings_enable_tokenless_levels_public_pages(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings_path = tmp_path / "config.json"
    settings_path.write_text(
        json.dumps(
            {
                "compensation_sources": {
                    "levels_fyi": {
                        "enabled": True,
                        "access_mode": "public_markdown",
                        "europe_coverage_confirmed": False,
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    captured_targets: list[object] = []
    captured_public_urls: list[str] = []

    def public_fetcher(*_args, **_kwargs):
        def fetch(url: str) -> str:
            captured_public_urls.append(url)
            return ""

        return fetch

    def load_public(
        targets,
        *,
        fetch_text,
        max_pages,
        preserve_source_currency,
        on_load_outcome,
    ):
        captured_targets.extend(targets)
        fetch_text("https://www.levels.fyi/t/software-engineer.md")
        assert max_pages > 0
        assert preserve_source_currency is False
        assert on_load_outcome is not None
        return (
            ReportedCompensationObservation(
                source_id="levels_fyi",
                source_provenance="public",
                company_name="Levels.fyi market aggregate",
                role_title="Software Engineer",
                location="Madrid, Spain",
                level_label="all levels",
                minimum_amount=39_000,
                maximum_amount=77_000,
                release_year=2026,
                snapshot_version="levels-fyi-public-2026",
                sample_count=599,
                attribution="Data source: Levels.fyi (https://www.levels.fyi)",
                source_url="https://www.levels.fyi/t/software-engineer/locations/madrid-esp",
            ),
        )

    monkeypatch.setattr(
        "jobctrl.infrastructure.compensation.sqlite_market_repository.load_levels_fyi_public_observations",
        load_public,
    )
    monkeypatch.setattr(
        "jobctrl.infrastructure.compensation.sqlite_market_repository._levels_fyi_public_fetcher",
        public_fetcher,
    )

    loaded = load_default_reported_compensation_observations(
        levels_fyi_targets=(LevelsFyiPublicTarget("Senior Platform Engineer", "Madrid, Spain"),),
        include_eurotoptech=False,
        env={},
        settings_path=settings_path,
    )

    assert len(captured_targets) == 1
    assert captured_public_urls == ["https://www.levels.fyi/t/software-engineer.md"]
    assert loaded.levels_fyi_count == 1
    assert loaded.levels_fyi_public_count == 1
    assert loaded.licensed_count == 0


def test_blocked_levels_public_pages_are_reported_as_source_unavailable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings_path = tmp_path / "config.json"
    settings_path.write_text(
        json.dumps(
            {
                "compensation_sources": {
                    "levels_fyi": {
                        "enabled": True,
                        "access_mode": "public_markdown",
                        "europe_coverage_confirmed": False,
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        "jobctrl.infrastructure.compensation.sqlite_market_repository._levels_fyi_public_fetcher",
        lambda *_args, **_kwargs: lambda _url: None,
    )

    loaded = load_default_reported_compensation_observations(
        levels_fyi_targets=(LevelsFyiPublicTarget("Software Engineer", "Spain"),),
        include_eurotoptech=False,
        env={},
        settings_path=settings_path,
    )

    assert loaded.observations == ()
    assert loaded.source_errors == ("levels_fyi_public_unavailable",)


@pytest.mark.parametrize(
    ("raw_mode", "expected_public_count"),
    [
        (None, 0),
        ("   ", 0),
        ("public_markdown", 1),
        ("public_api", 0),
    ],
    ids=("absent", "blank", "valid", "invalid"),
)
def test_worker_levels_public_access_mode_semantics(
    raw_mode: str | None,
    expected_public_count: int,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def load_public(*_args, **_kwargs):
        return (
            ReportedCompensationObservation(
                source_id="levels_fyi",
                source_provenance="public",
                company_name="Levels.fyi market aggregate",
                role_title="Software Engineer",
                location="Madrid, Spain",
                level_label="all levels",
                minimum_amount=39_000,
                maximum_amount=77_000,
                release_year=2026,
                snapshot_version="levels-fyi-public-2026",
                sample_count=None,
                attribution="Data source: Levels.fyi (https://www.levels.fyi)",
                source_url="https://www.levels.fyi/t/software-engineer/locations/madrid-esp",
            ),
        )

    monkeypatch.setattr(
        "jobctrl.infrastructure.compensation.sqlite_market_repository.load_levels_fyi_public_observations",
        load_public,
    )
    settings_path = tmp_path / "config.json"
    source_preferences: dict[str, object] = {}
    if raw_mode is not None:
        source_preferences["levels_fyi"] = {
            "enabled": True,
            "access_mode": raw_mode,
            "europe_coverage_confirmed": False,
        }
    settings_path.write_text(
        json.dumps({"compensation_sources": source_preferences}),
        encoding="utf-8",
    )

    loaded = load_default_reported_compensation_observations(
        levels_fyi_targets=(LevelsFyiPublicTarget("Software Engineer", "Madrid, Spain"),),
        include_eurotoptech=False,
        env={},
        settings_path=settings_path,
    )

    assert loaded.levels_fyi_public_count == expected_public_count
    assert loaded.levels_fyi_count == expected_public_count
    assert loaded.licensed_count == 0


def test_automatic_refresh_does_not_enable_levels_without_user_opt_in(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings_path = tmp_path / "config.json"
    settings_path.write_text(
        json.dumps({"compensation_sources": {}}),
        encoding="utf-8",
    )

    monkeypatch.setattr(
        "jobctrl.infrastructure.compensation.sqlite_market_repository.load_levels_fyi_public_observations",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("Levels must remain disabled until the user opts in")
        ),
    )

    loaded = load_default_reported_compensation_observations(
        levels_fyi_targets=(LevelsFyiPublicTarget("Software Engineer", "Madrid, Spain"),),
        include_eurotoptech=False,
        env={},
        settings_path=settings_path,
    )

    assert loaded.levels_fyi_public_count == 0


def test_automatic_refresh_respects_an_explicitly_disabled_levels_preference(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings_path = tmp_path / "config.json"
    settings_path.write_text(
        json.dumps(
            {
                "compensation_sources": {
                    "levels_fyi": {
                        "enabled": False,
                        "access_mode": "public_markdown",
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        "jobctrl.infrastructure.compensation.sqlite_market_repository.load_levels_fyi_public_observations",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("disabled public source must not be called")),
    )

    loaded = load_default_reported_compensation_observations(
        levels_fyi_targets=(LevelsFyiPublicTarget("Software Engineer", "Madrid, Spain"),),
        include_eurotoptech=False,
        env={},
        settings_path=settings_path,
    )

    assert loaded.levels_fyi_public_count == 0


def test_one_public_source_failure_preserves_other_loaded_evidence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings_path = tmp_path / "config.json"
    settings_path.write_text(
        json.dumps(
            {
                "compensation_sources": {
                    "levels_fyi": {
                        "enabled": True,
                        "access_mode": "public_markdown",
                        "europe_coverage_confirmed": False,
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    observation = ReportedCompensationObservation(
        source_id="levels_fyi",
        source_provenance="public",
        company_name="Levels.fyi market aggregate",
        role_title="Software Engineer",
        location="Madrid, Spain",
        level_label="all levels",
        minimum_amount=39_000,
        maximum_amount=77_000,
        snapshot_version="levels-fyi-public-2026",
        attribution="Data source: Levels.fyi (https://www.levels.fyi)",
        source_url="https://www.levels.fyi/t/software-engineer/locations/madrid-esp",
    )
    monkeypatch.setattr(
        "jobctrl.infrastructure.compensation.sqlite_market_repository.load_levels_fyi_public_observations",
        lambda *_args, **_kwargs: (observation,),
    )
    monkeypatch.setattr(
        "jobctrl.infrastructure.compensation.sqlite_market_repository.load_euro_top_tech_observations",
        lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("unavailable")),
    )

    loaded = load_default_reported_compensation_observations(
        levels_fyi_targets=(LevelsFyiPublicTarget("Software Engineer", "Madrid, Spain"),),
        include_eurotoptech=True,
        env={},
        settings_path=settings_path,
    )

    assert loaded.observations == (observation,)
    assert loaded.source_errors == ("euro_top_tech_unavailable",)


def test_blocked_euro_top_tech_first_page_is_reported_as_source_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def unavailable_loader(*, on_load_outcome, **_kwargs):
        on_load_outcome(EuroTopTechLoadOutcome(requested_pages=1, parsed_pages=0))
        return ()

    monkeypatch.setattr(
        "jobctrl.infrastructure.compensation.sqlite_market_repository.load_euro_top_tech_observations",
        unavailable_loader,
    )

    loaded = load_default_reported_compensation_observations(
        include_eurotoptech=True,
        env={},
    )

    assert loaded.observations == ()
    assert loaded.source_errors == ("euro_top_tech_unavailable",)


def test_user_source_settings_can_disable_a_configured_feed(
    tmp_path: Path,
) -> None:
    glassdoor_path = tmp_path / "glassdoor.json"
    glassdoor_path.write_text(
        json.dumps(
            [
                {
                    "company": "Acme AI",
                    "role": "Senior Platform Engineer",
                    "amount": 125000,
                }
            ]
        ),
        encoding="utf-8",
    )
    settings_path = tmp_path / "config.json"
    settings_path.write_text(
        json.dumps(
            {
                "compensation_sources": {
                    "glassdoor": {
                        "enabled": False,
                        "access_mode": "written_permission",
                    }
                }
            }
        ),
        encoding="utf-8",
    )

    loaded = load_default_reported_compensation_observations(
        include_eurotoptech=False,
        env={
            "JOBCTRL_GLASSDOOR_OBSERVATIONS_PATH": str(glassdoor_path),
        },
        settings_path=settings_path,
    )

    assert loaded.glassdoor_count == 0
    assert loaded.observations == ()


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

    def fake_fetch_json(url: str) -> dict:
        assert "api/data-entries" in url
        return payloads.pop(0)

    observations = load_euro_top_tech_observations(max_pages=2, http=fake_fetch_json)

    assert [observation.source_id for observation in observations] == ["euro_top_tech", "euro_top_tech"]
    assert observations[0].company_name == "Airbnb"
    assert observations[0].role_title == "Staff Software Engineer"
    assert observations[0].minimum_amount == 242_000
    assert observations[0].component == "total_compensation"
    assert observations[0].location == "Barcelona, Spain"
    assert observations[0].attribution and "Euro Top Tech" in observations[0].attribution
    assert observations[0].source_url == "https://www.eurotoptech.com/data"
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

    def fake_fetch_json(url: str) -> dict:
        nonlocal calls
        calls += 1
        if calls == 1:
            return payload
        raise RuntimeError("too many requests")

    observations = load_euro_top_tech_observations(max_pages=2, http=fake_fetch_json)

    assert calls == 2
    assert len(observations) == 1
    assert observations[0].source_id == "euro_top_tech"
    assert observations[0].minimum_amount == 242_000


def test_euro_top_tech_importer_reports_a_blocked_first_page() -> None:
    outcomes = []

    observations = load_euro_top_tech_observations(
        max_pages=2,
        http=lambda _url: None,
        on_load_outcome=outcomes.append,
    )

    assert observations == ()
    assert outcomes == [EuroTopTechLoadOutcome(requested_pages=1, parsed_pages=0)]
    assert outcomes[0].unavailable is True


def test_persisted_json_contains_safe_reported_source_fields(conn: sqlite3.Connection) -> None:
    job_url = _seed_job(conn)
    job_id = _job_id(job_url)
    repo = SqliteMarketCompensationRepository(conn)
    repo.estimate_and_save_job(
        job_id=job_id,
        title="Senior Platform Engineer",
        company="Acme AI",
        location="Remote Europe",
        observations=(_levels(), _glassdoor()),
        estimated_at="2026-06-19T10:00:00Z",
    )

    row = conn.execute(
        """
        SELECT source_snapshot_json, factor_reasons_json, insufficient_reasons_json, warnings_json
        FROM job_market_compensation_estimates WHERE tenant_id = ? AND job_id = ?
        """,
        ("local", job_id),
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
        WHERE tenant_id = ? AND job_id = ? AND event_type = 'CompensationFactsUpdated'
        ORDER BY event_id DESC LIMIT 1
        """,
        ("local", job_id),
    ).fetchone()
    payload = json.loads(event["payload_json"])
    assert payload == {
        "jobId": str(job_id),
        "changedSections": ["market"],
        "postedRecordStatus": None,
        "postedParseState": None,
        "marketRecordStatus": "recorded",
        "marketEstimateState": "estimated_range",
        "updatedAt": "2026-06-19T10:00:00Z",
        "stage": "enrich",
        "level": "info",
        "message": "Market compensation estimate updated",
    }
    assert "sources" not in payload
    assert "eurostat" not in json.dumps(payload).lower()


def test_repository_preserves_public_and_licensed_levels_provenance(conn: sqlite3.Connection) -> None:
    job_url = _seed_job(conn, url="https://example.com/jobs/levels-provenance")
    job_id = _job_id(job_url)
    public = ReportedCompensationObservation(
        source_id="levels_fyi",
        source_provenance="public",
        company_name="Acme AI",
        role_title="Senior Platform Engineer",
        level_label="Senior",
        company_tier="tier_2_ambitious",
        location="Remote Europe",
        minimum_amount=120_000,
        maximum_amount=144_000,
        release_year=2026,
        snapshot_version="levels-fyi-public-2026",
        sample_count=None,
        attribution="Data source: Levels.fyi (https://www.levels.fyi)",
        source_url="https://www.levels.fyi/t/software-engineer/locations/europe",
    )
    licensed = replace(
        _levels(),
        snapshot_version="levels-fyi-licensed-2026-q2",
        attribution="Levels.fyi licensed Q2 export",
    )
    repo = SqliteMarketCompensationRepository(conn)

    repo.estimate_and_save_job(
        job_id=job_id,
        title="Senior Platform Engineer",
        company="Acme AI",
        location="Remote Europe",
        observations=(public, licensed),
        estimated_at="2026-07-13T10:00:00Z",
    )

    loaded = repo.get_estimate("local", job_id)
    assert loaded is not None
    assert [(source.source_provenance, source.snapshot_version, source.attribution) for source in loaded.sources] == [
        (
            "public",
            "levels-fyi-public-2026",
            "Data source: Levels.fyi (https://www.levels.fyi)",
        ),
        ("licensed", "levels-fyi-licensed-2026-q2", "Levels.fyi licensed Q2 export"),
    ]
    assert loaded.sources[0].sample_count is None

    stored = json.loads(
        conn.execute(
            "SELECT source_snapshot_json FROM job_market_compensation_estimates WHERE tenant_id = ? AND job_id = ?",
            ("local", job_id),
        ).fetchone()["source_snapshot_json"]
    )
    assert [item["source_provenance"] for item in stored] == ["public", "licensed"]


def test_repository_sanitizes_stale_persisted_source_json_on_read(conn: sqlite3.Connection) -> None:
    job_url = _seed_job(conn, url="https://example.com/jobs/stale-source-json")
    job_id = _job_id(job_url)
    repo = SqliteMarketCompensationRepository(conn)
    conn.execute(
        """
        INSERT INTO job_market_compensation_estimates (
            tenant_id, job_id, estimate_state, currency, period, component,
            minimum_amount, maximum_amount, confidence_band, confidence_score,
            source_count, sample_count, aggregate_bucket, geography_scope,
            occupation_code, occupation_label, seniority_label, source_snapshot_json,
            factor_reasons_json, selected_evidence_json, insufficient_reasons_json, unsupported_reasons_json,
            source_unavailable_reasons_json, warnings_json, estimator_version, estimated_at,
            company_name, normalized_company, role_title, normalized_role, company_tier, match_scope
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "local",
            job_id,
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
            '[{"source_id":"levels_fyi","company_name":"private /Users/local credential",'
            '"source_url":"https://levels.example/private?token=secret",'
            '"role_title":"Senior Platform Engineer","location":"file:///Users/local/private","level_label":"senior",'
            '"company_tier":"tier_2_ambitious","component":"total_compensation","currency":"EUR","period":"year",'
            '"minimum_amount":112000,"maximum_amount":142000,"sample_count":4,"release_year":2026,'
            '"company_score":1,"role_score":0.96,"level_score":0.95,"location_score":0.78,"freshness_score":0.95}]',
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

    loaded = repo.get_estimate("local", job_id)
    serialized = str(loaded).casefold()

    assert loaded is not None
    assert loaded.sources[0].display_name == "Levels.fyi"
    assert loaded.sources[0].snapshot_version == "reported-compensation-import-v1"
    assert loaded.factors[0].reason == DEFAULT_FACTOR_REASON
    assert loaded.factors[1].reason == "Reported compensation sample count: 1."
    assert loaded.evidence[0].company_name == "unknown company"
    assert loaded.evidence[0].role_title == "Senior Platform Engineer"
    assert loaded.evidence[0].location is None
    assert loaded.evidence[0].source_url is None
    assert "rawproviderpayload" not in serialized
    assert "/users/" not in serialized
    assert "credential" not in serialized
    assert "secret" not in serialized
