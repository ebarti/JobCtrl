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
                "location": "Remote EMEA",
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

        stored = conn.execute("SELECT title FROM jobs").fetchall()
        assert [row[0] if isinstance(row, tuple) else row["title"] for row in stored] == ["Director of Engineering"]
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
