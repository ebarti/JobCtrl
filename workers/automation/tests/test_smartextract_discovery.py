from __future__ import annotations

from pathlib import Path

import pytest

from jobhunter import config
from jobhunter.database import close_connection, init_db
from jobhunter.discovery import smartextract


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
