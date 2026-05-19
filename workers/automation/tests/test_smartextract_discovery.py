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
