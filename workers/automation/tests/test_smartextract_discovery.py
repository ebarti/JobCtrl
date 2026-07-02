from __future__ import annotations

from pathlib import Path

import pytest

from jobhunter import config
from jobhunter.database import close_connection, init_db
from jobhunter.discovery import smartextract
from jobhunter.domain.discovery import (
    AtsKind,
    JobMetadata,
    PostingUrl,
    SearchStrategy,
    Source,
)
from jobhunter.domain.discovery.use_cases import DiscoverJobsUseCase
from jobhunter.domain.ports.discovery import ScrapedJobPosting
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.discovery import SqliteJobRepository
from jobhunter.infrastructure.discovery.production_wiring import DurableJobEventPublisher


def _ats_posting(
    *,
    canonical_url: str,
    description: str,
    board: str = "Acme",
    title: str = "Staff Platform Engineer",
    source_id: str = "greenhouse:acme",
    source_native_id: str = "gh-1",
    location: str = "Remote - US",
) -> ScrapedJobPosting:
    return ScrapedJobPosting(
        posting_url=PostingUrl(value=canonical_url),
        source=Source(board=board),
        metadata=JobMetadata(title=title, description=description, location=location),
        strategy=SearchStrategy.WORKDAY_API,
        source_id=source_id,
        source_native_id=source_native_id,
        canonical_url=canonical_url,
        ats_kind=AtsKind.GREENHOUSE,
    )


def test_smart_extract_store_filters_title_and_location(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobhunter.db"
    monkeypatch.setattr(config, "DB_PATH", db_path)
    conn = init_db(db_path)
    try:
        jobs = [
            {
                "url": "https://example.com/trauma-counsellor",
                "title": "Independent Trauma Counsellor",
                "location": "Remote EMEA",
            },
            {
                "url": "https://example.com/director-investment",
                "title": "Director, Investment Consulting",
                "location": "CAN, Quebec - Full Time Remote",
            },
            {
                "url": "https://example.com/director-engineering",
                "title": "Director of Engineering",
                "company": "ExampleCo",
                "location": "Remote EMEA",
                "description": "Lead engineering teams building reliable distributed systems.",
            },
        ]

        assert smartextract._store_jobs_filtered(
            conn,
            jobs,
            "Example",
            "api_response",
            ["Spain", "Europe", "EMEA"],
            ["United States", "Canada"],
            query="Director of Engineering",
        ) == (1, 0)

        stored = conn.execute("SELECT title, company FROM jobs").fetchall()
        assert [(row["title"], row["company"]) for row in stored] == [("Director of Engineering", "ExampleCo")]
    finally:
        close_connection(db_path)


def test_smart_extract_static_site_filters_against_all_target_queries(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobhunter.db"
    monkeypatch.setattr(config, "DB_PATH", db_path)
    conn = init_db(db_path)
    try:
        jobs = [
            {
                "url": "https://example.com/crm-marketer",
                "title": "CRM Marketer",
                "location": "Barcelona, Spain",
            },
            {
                "url": "https://example.com/head-engineering",
                "title": "Head of Engineering",
                "location": "Barcelona, Spain",
                "description": "Lead engineering managers and platform teams in Barcelona.",
            },
        ]

        assert smartextract._store_jobs_filtered(
            conn,
            jobs,
            "Techstars Jobs",
            "static",
            ["Barcelona, Spain", "Spain", "Europe", "EMEA"],
            ["United States", "Canada"],
            query=["Director of Engineering", "Head of Engineering"],
        ) == (1, 0)

        stored = conn.execute("SELECT title FROM jobs").fetchall()
        assert [row[0] if isinstance(row, tuple) else row["title"] for row in stored] == ["Head of Engineering"]
    finally:
        close_connection(db_path)


def test_smart_extract_static_site_uses_recall_match_mode(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobhunter.db"
    monkeypatch.setattr(config, "DB_PATH", db_path)
    conn = init_db(db_path)
    try:
        jobs = [
            {
                "url": "https://example.com/software-engineer",
                "title": "Software Engineer",
                "location": "Spain",
                "description": "Build product features for a remote team.",
            },
            {
                "url": "https://example.com/head-technology",
                "title": "Head of Technology",
                "location": "Spain",
                "description": "Lead engineering and technology strategy in Spain.",
            },
        ]

        assert smartextract._store_jobs_filtered(
            conn,
            jobs,
            "Wellfound",
            "static",
            ["Spain", "Europe", "EMEA"],
            ["United States", "Canada"],
            query=[{"query": "technology director", "match_mode": "recall", "tier": 1}],
        ) == (1, 0)

        stored = conn.execute("SELECT title FROM jobs").fetchall()
        assert [row["title"] for row in stored] == ["Head of Technology"]
    finally:
        close_connection(db_path)


def test_smart_extract_target_builder_uses_source_capability() -> None:
    search_cfg = {
        "queries": [
            {"query": "Director of Engineering", "tier": 1},
            {"query": "technology director", "tier": 1, "match_mode": "recall"},
        ],
        "locations": [{"location": "Spain"}],
    }
    sites = [
        {"name": "Wellfound", "url": "https://wellfound.com/location/spain", "type": "static"},
        {
            "name": "WelcomeToTheJungle",
            "url": "https://www.welcometothejungle.com/en/jobs?query={query_encoded}",
            "type": "search",
        },
        {
            "name": "SourceFirstSearchUrl",
            "url": "https://example.com/jobs?q={query_encoded}&l={location_encoded}",
            "type": "search",
            "query_mode": "source_first",
        },
    ]

    targets = smartextract.build_scrape_targets(sites=sites, search_cfg=search_cfg)

    assert [target["name"] for target in targets] == [
        "Wellfound",
        "WelcomeToTheJungle",
        "WelcomeToTheJungle",
        "SourceFirstSearchUrl",
    ]
    assert targets[0]["query_mode"] == "source_first"
    assert targets[0]["query"] is None
    expected_query_specs = [
        {
            "query": "Director of Engineering",
            "match_mode": "strict",
            "tier": 1,
            "target_track": "",
            "seniority_floor": "",
        },
        {
            "query": "technology director",
            "match_mode": "recall",
            "tier": 1,
            "target_track": "",
            "seniority_floor": "",
        },
    ]
    assert targets[0]["queries"] == expected_query_specs
    assert targets[1]["query"] == "Director of Engineering"
    assert targets[1]["query_spec"] == expected_query_specs[0]
    assert targets[2]["query"] == "technology director"
    assert targets[2]["query_spec"] == expected_query_specs[1]
    assert targets[3]["url"] == "https://example.com/jobs?q=&l=Spain"
    assert targets[3]["queries"] == targets[0]["queries"]


def test_smart_extract_store_filters_jobs_without_descriptions(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobhunter.db"
    monkeypatch.setattr(config, "DB_PATH", db_path)
    conn = init_db(db_path)
    try:
        jobs = [
            {
                "url": "https://example.com/head-engineering-empty",
                "title": "Head of Engineering",
                "location": "Barcelona, Spain",
                "description": "",
            },
            {
                "url": "https://example.com/head-engineering-none",
                "title": "Head of Engineering",
                "location": "Barcelona, Spain",
                "description": "None",
            },
            {
                "url": "https://example.com/head-engineering-nan",
                "title": "Head of Engineering",
                "location": "Barcelona, Spain",
                "description": "nan",
            },
            {
                "url": "https://example.com/head-engineering-pandas-na",
                "title": "Head of Engineering",
                "location": "Barcelona, Spain",
                "description": "<NA>",
            },
            {
                "url": "https://example.com/head-engineering",
                "title": "Head of Engineering",
                "location": "Barcelona, Spain",
                "description": "Lead engineering teams and own platform delivery.",
            },
        ]

        assert smartextract._store_jobs_filtered(
            conn,
            jobs,
            "Startup.jobs",
            "api_response",
            ["Barcelona, Spain", "Spain", "Europe", "EMEA"],
            ["United States", "Canada"],
            query="Head of Engineering",
        ) == (1, 0)

        stored = conn.execute("SELECT url, description FROM jobs").fetchall()
        assert [(row["url"], row["description"]) for row in stored] == [
            ("https://example.com/head-engineering", "Lead engineering teams and own platform delivery.")
        ]
    finally:
        close_connection(db_path)


def test_smart_extract_updates_existing_serialized_null_description(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobhunter.db"
    monkeypatch.setattr(config, "DB_PATH", db_path)
    conn = init_db(db_path)
    try:
        url = "https://example.com/head-engineering"
        conn.execute(
            """
            INSERT INTO jobs (
                url, title, company, description, location, site, strategy, discovered_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                url,
                "Head of Engineering",
                "Startup.jobs",
                "None",
                "Barcelona, Spain",
                "Startup.jobs",
                "api_response",
                "2026-05-20T00:00:00+00:00",
            ),
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS jobhunter_deleted_jobs (
                job_url TEXT PRIMARY KEY,
                deleted_at TEXT NOT NULL,
                reason TEXT,
                restored_at TEXT,
                FOREIGN KEY(job_url) REFERENCES jobs(url)
            )
            """
        )
        conn.execute(
            """
            INSERT INTO jobhunter_deleted_jobs (job_url, deleted_at, reason, restored_at)
            VALUES (?, ?, ?, NULL)
            """,
            (url, "2026-05-20T00:00:00+00:00", "missing_description"),
        )
        conn.commit()

        assert smartextract._store_jobs_filtered(
            conn,
            [
                {
                    "url": url,
                    "title": "Head of Engineering",
                    "location": "Barcelona, Spain",
                    "description": "Lead engineering teams and own platform delivery.",
                }
            ],
            "Startup.jobs",
            "api_response",
            ["Barcelona, Spain", "Spain", "Europe", "EMEA"],
            ["United States", "Canada"],
            query="Head of Engineering",
        ) == (0, 1)

        stored = conn.execute(
            """
            SELECT j.description, d.restored_at
            FROM jobs j
            JOIN jobhunter_deleted_jobs d ON d.job_url = j.url
            WHERE j.url = ?
            """,
            (url,),
        ).fetchone()
        assert stored["description"] == "Lead engineering teams and own platform delivery."
        assert stored["restored_at"] is not None
    finally:
        close_connection(db_path)


def test_smart_extract_refreshes_existing_title_location_before_restore(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobhunter.db"
    monkeypatch.setattr(config, "DB_PATH", db_path)
    conn = init_db(db_path)
    try:
        url = "https://example.com/shared-url"
        conn.execute(
            """
            INSERT INTO jobs (
                url, title, company, description, location, site, strategy, discovered_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                url,
                "Sales Director, Platform Services",
                "",
                "None",
                "United States",
                "Startup.jobs",
                "api_response",
                "2026-05-20T00:00:00+00:00",
            ),
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS jobhunter_deleted_jobs (
                job_url TEXT PRIMARY KEY,
                deleted_at TEXT NOT NULL,
                reason TEXT,
                restored_at TEXT,
                FOREIGN KEY(job_url) REFERENCES jobs(url)
            )
            """
        )
        conn.execute(
            """
            INSERT INTO jobhunter_deleted_jobs (job_url, deleted_at, reason, restored_at)
            VALUES (?, ?, ?, NULL)
            """,
            (url, "2026-05-20T00:00:00+00:00", "title/location mismatch"),
        )
        conn.commit()

        assert smartextract._store_jobs_filtered(
            conn,
            [
                {
                    "url": url,
                    "title": "Head of Engineering",
                    "company": "Acme",
                    "location": "Barcelona, Spain",
                    "description": "Lead engineering teams and own platform delivery.",
                }
            ],
            "Startup.jobs",
            "api_response",
            ["Barcelona, Spain", "Spain", "Europe", "EMEA"],
            ["United States", "Canada"],
            query="Head of Engineering",
        ) == (0, 1)

        stored = conn.execute(
            """
            SELECT j.title, j.company, j.description, j.location, d.restored_at
            FROM jobs j
            JOIN jobhunter_deleted_jobs d ON d.job_url = j.url
            WHERE j.url = ?
            """,
            (url,),
        ).fetchone()
        assert dict(stored) == {
            "title": "Head of Engineering",
            "company": "Acme",
            "description": "Lead engineering teams and own platform delivery.",
            "location": "Barcelona, Spain",
            "restored_at": stored["restored_at"],
        }
        assert stored["restored_at"] is not None
    finally:
        close_connection(db_path)


def test_smart_extract_store_normalizes_relative_urls(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobhunter.db"
    monkeypatch.setattr(config, "DB_PATH", db_path)
    conn = init_db(db_path)
    try:
        jobs = [
            {
                "url": "/head-of-platform-engineering-dlocal-7946484",
                "title": "Head of Platform Engineering",
                "company": "dLocal",
                "location": "Spain",
                "description": "Lead platform engineering teams for payment infrastructure.",
            },
        ]

        assert smartextract._store_jobs_filtered(
            conn,
            jobs,
            "Startup.jobs",
            "api_response",
            ["Spain", "Europe", "EMEA"],
            ["United States", "Canada"],
            query="Head of Platform Engineering",
            source_url="https://startup.jobs/?q=Head+of+Platform+Engineering&remote=true",
        ) == (1, 0)

        row = conn.execute("SELECT url, company FROM jobs").fetchone()
        assert row["url"] == "https://startup.jobs/head-of-platform-engineering-dlocal-7946484"
        assert row["company"] == "dLocal"
    finally:
        close_connection(db_path)


def test_smart_extract_dedups_against_ats_first_content_owner(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Smart Extract must merge onto an ATS-first owner instead of double-storing.

    The ATS row is created by the use case with ``jobs.company`` NULL and the
    employer in ``jobs.site``; Smart Extract then rediscovers the same posting
    from a different URL. Without a content-owner check the direct-SQL insert
    would create a second aggregate (double scoring/tailoring spend).
    """
    db_path = tmp_path / "jobhunter.db"
    monkeypatch.setattr(config, "DB_PATH", db_path)
    conn = init_db(db_path)
    try:
        description = "Own the platform engineering roadmap for local-first developer tooling."
        owner_url = "https://boards.greenhouse.io/acme/jobs/staff-eng"
        repository = SqliteJobRepository(conn)
        use_case = DiscoverJobsUseCase(
            repository=repository,
            publisher=DurableJobEventPublisher(conn, stage="discover"),
            clock=lambda: "2026-05-12T00:00:00Z",
        )
        use_case.execute(
            tenant_id=LOCAL_TENANT,
            postings=[_ats_posting(canonical_url=owner_url, description=description)],
            run_id="run-ats",
        )
        assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1

        result = smartextract._store_jobs_filtered(
            conn,
            [
                {
                    "url": "https://careers.acme.com/staff-platform-engineer",
                    "title": "Staff Platform Engineer",
                    "company": "Acme",
                    "location": "Barcelona, Spain",
                    "description": description,
                }
            ],
            "Acme Careers",
            "static",
            ["Barcelona, Spain", "Spain", "Europe", "EMEA"],
            ["United States", "Canada"],
            query="Staff Platform Engineer",
        )

        assert result == (0, 1)
        assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1
        link = conn.execute(
            "SELECT surviving_job_id, reason, confidence FROM job_duplicate_links"
        ).fetchone()
        assert link["surviving_job_id"] == owner_url
        assert link["reason"] == "content_fingerprint_match"
        assert link["confidence"] == 0.95
        linked_events = conn.execute(
            "SELECT COUNT(*) FROM job_events WHERE event_type = 'DuplicateJobLinked'"
        ).fetchone()[0]
        assert linked_events == 1
        observations = repository.list_observations(LOCAL_TENANT, owner_url)
        assert "smartextract:Acme Careers" in {obs.source_id for obs in observations}
    finally:
        close_connection(db_path)


def test_ats_dedups_against_smart_extract_first_content_owner(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The reverse direction: a later ATS scrape must merge onto a Smart Extract owner."""
    db_path = tmp_path / "jobhunter.db"
    monkeypatch.setattr(config, "DB_PATH", db_path)
    conn = init_db(db_path)
    try:
        description = "Own the platform engineering roadmap for local-first developer tooling."
        smart_url = "https://careers.acme.com/staff-platform-engineer"
        result = smartextract._store_jobs_filtered(
            conn,
            [
                {
                    "url": smart_url,
                    "title": "Staff Platform Engineer",
                    "company": "Acme",
                    "location": "Barcelona, Spain",
                    "description": description,
                }
            ],
            "Acme Careers",
            "static",
            ["Barcelona, Spain", "Spain", "Europe", "EMEA"],
            ["United States", "Canada"],
            query="Staff Platform Engineer",
        )
        assert result == (1, 0)
        assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1

        repository = SqliteJobRepository(conn)
        use_case = DiscoverJobsUseCase(
            repository=repository,
            publisher=DurableJobEventPublisher(conn, stage="discover"),
            clock=lambda: "2026-05-12T00:00:00Z",
        )
        summary = use_case.execute(
            tenant_id=LOCAL_TENANT,
            postings=[
                _ats_posting(
                    canonical_url="https://boards.greenhouse.io/acme/jobs/staff-eng",
                    description=description,
                )
            ],
            run_id="run-ats",
        )

        assert summary.new_jobs == 0
        assert summary.duplicates_linked == 1
        assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1
        link = conn.execute(
            "SELECT surviving_job_id, reason FROM job_duplicate_links"
        ).fetchone()
        assert link["surviving_job_id"] == smart_url
        assert link["reason"] == "content_fingerprint_match"
    finally:
        close_connection(db_path)


def test_smart_extract_api_response_extracts_company() -> None:
    intel = {
        "api_responses": [
            {
                "url": "https://startup.jobs/api/search",
                "_raw_data": {
                    "jobs": [
                        {
                            "title": "Director of Engineering",
                            "company": {"name": "ExampleCo"},
                            "description": "Lead engineering teams.",
                            "location": "Spain",
                            "slug": "/director-engineering-exampleco",
                        }
                    ]
                },
            }
        ]
    }
    plan = {
        "extraction": {
            "url_pattern": "/api/search",
            "items_path": "jobs",
            "title": "title",
            "company": "company",
            "description": "description",
            "location": "location",
            "url": "slug",
        }
    }

    assert smartextract.execute_api_response(intel, plan) == [
        {
            "title": "Director of Engineering",
            "company": "ExampleCo",
            "salary": None,
            "description": "Lead engineering teams.",
            "location": "Spain",
            "url": "/director-engineering-exampleco",
        }
    ]
