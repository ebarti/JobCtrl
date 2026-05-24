from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Iterator

import pytest

from jobhunter import config
from jobhunter.database import close_connection, init_db
from jobhunter.discovery import workday
from jobhunter.discovery.workday import store_results


@pytest.fixture
def conn(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[sqlite3.Connection]:
    db_path = tmp_path / "jobhunter.db"
    monkeypatch.setattr(config, "DB_PATH", db_path)
    connection = init_db(db_path)
    yield connection
    close_connection(db_path)


def test_workday_store_results_publishes_discovery_events(
    conn: sqlite3.Connection,
) -> None:
    jobs = [
        {
            "title": "Director of Engineering",
            "location": "Barcelona, Spain",
            "external_path": "/External/job/Barcelona/Director-of-Engineering_JR-123",
            "apply_url": "https://acme.wd1.myworkdayjobs.com/External/job/Barcelona/Director-of-Engineering_JR-123",
            "job_req_id": "JR-123",
            "employer_key": "acme",
            "employer_name": "Acme",
            "full_description": "Lead engineering teams building local-first products.",
        }
    ]
    employers = {
        "acme": {
            "name": "Acme",
            "base_url": "https://acme.wd1.myworkdayjobs.com",
            "site_id": "External",
            "_source_id": "workday:acme",
        }
    }

    new, existing = store_results(
        conn,
        jobs,
        employers,
        run_id="discovery:workday:test",
    )

    assert (new, existing) == (1, 0)
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1
    assert (
        conn.execute("SELECT COUNT(*) FROM job_source_observations").fetchone()[0]
        == 1
    )
    event_types = [
        row["event_type"]
        for row in conn.execute(
            "SELECT event_type FROM job_events ORDER BY event_id"
        ).fetchall()
    ]
    assert "JobDiscovered" in event_types
    observed = conn.execute(
        "SELECT payload_json FROM job_events WHERE event_type = 'JobSourceObserved'"
    ).fetchone()
    assert json.loads(observed["payload_json"])["source_id"] == "workday:acme"


def test_workday_search_rejects_loose_title_matches(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_search(_employer: dict, _search_text: str, *, limit: int, offset: int) -> dict:
        assert limit == 20
        assert offset == 0
        return {
            "total": 3,
            "jobPostings": [
                {
                    "title": "Independent Trauma Counsellor",
                    "locationsText": "EMEA - United Kingdom - Remote",
                    "externalPath": "/job/EMEA/Independent-Trauma-Counsellor_R-1",
                },
                {
                    "title": "Director, Investment Consulting",
                    "locationsText": "CAN, Quebec - Full Time Remote",
                    "externalPath": "/job/Canada/Director-Investment-Consulting_R-2",
                },
                {
                    "title": "Director of Engineering",
                    "locationsText": "Remote EMEA",
                    "externalPath": "/job/EMEA/Director-of-Engineering_R-3",
                },
            ],
        }

    monkeypatch.setattr(workday, "workday_search", fake_search)

    jobs = workday.search_employer(
        "acme",
        {
            "name": "Acme",
            "base_url": "https://acme.wd1.myworkdayjobs.com",
            "tenant": "acme",
            "site_id": "External",
        },
        "Director of Engineering",
        accept_locs=["Spain", "Europe", "EMEA"],
        reject_locs=["United States", "Canada"],
    )

    assert [job["title"] for job in jobs] == ["Director of Engineering"]


def test_workday_source_first_search_filters_against_expanded_query_specs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_search(_employer: dict, search_text: str, *, limit: int, offset: int) -> dict:
        assert search_text == ""
        assert limit == 20
        assert offset == 0
        return {
            "total": 3,
            "jobPostings": [
                {
                    "title": "Software Engineer",
                    "locationsText": "Remote EMEA",
                    "externalPath": "/job/EMEA/Software-Engineer_R-1",
                },
                {
                    "title": "Platform Engineering Manager",
                    "locationsText": "Remote EMEA",
                    "externalPath": "/job/EMEA/Platform-Engineering-Manager_R-2",
                },
                {
                    "title": "Account Executive",
                    "locationsText": "Barcelona, Spain",
                    "externalPath": "/job/Spain/Account-Executive_R-3",
                },
            ],
        }

    monkeypatch.setattr(workday, "workday_search", fake_search)

    jobs = workday.search_employer(
        "acme",
        {
            "name": "Acme",
            "base_url": "https://acme.wd1.myworkdayjobs.com",
            "tenant": "acme",
            "site_id": "External",
        },
        "",
        accept_locs=["Spain", "Europe", "EMEA"],
        reject_locs=["United States", "Canada"],
        query_specs=[
            {"query": "Head of Platform", "match_mode": "strict"},
            {"query": "platform director", "match_mode": "recall"},
        ],
    )

    assert [job["title"] for job in jobs] == ["Platform Engineering Manager"]


def test_limited_workday_search_respects_page_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    offsets: list[int] = []

    def fake_search(_employer: dict, _search_text: str, *, limit: int, offset: int) -> dict:
        offsets.append(offset)
        return {
            "total": 100,
            "jobPostings": [
                {
                    "title": "Independent Trauma Counsellor",
                    "locationsText": "Remote EMEA",
                    "externalPath": f"/job/EMEA/Independent-Trauma-Counsellor_{offset}",
                }
            ],
        }

    monkeypatch.setattr(workday, "workday_search", fake_search)

    jobs = workday.search_employer(
        "acme",
        {
            "name": "Acme",
            "base_url": "https://acme.wd1.myworkdayjobs.com",
            "tenant": "acme",
            "site_id": "External",
        },
        "Director of Engineering",
        max_pages=1,
        accept_locs=["Europe", "EMEA"],
        reject_locs=[],
    )

    assert jobs == []
    assert offsets == [0]


def test_limited_workday_crawl_uses_bounded_page_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    assert workday._workday_max_pages_per_employer({}, limit=10) == 1
    assert workday._workday_max_pages_per_employer({"workday_limited_max_pages_per_employer": 3}, limit=10) == 3
    assert workday._workday_max_pages_per_employer({"workday_max_pages_per_employer": 5}, limit=0) == 5


def test_parallel_limited_workday_scrape_enforces_global_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    employers = {
        key: {
            "name": key.upper(),
            "base_url": f"https://{key}.wd1.myworkdayjobs.com",
            "tenant": key,
            "site_id": "External",
        }
        for key in ("acme", "globex", "initech")
    }
    stored_jobs: list[dict] = []

    def fake_search_and_fetch_one(
        employer_key: str,
        _employers: dict,
        _search_text: str,
        _location_filter: bool,
        _accept_locs: list[str],
        _reject_locs: list[str],
        limit: int = 0,
        max_pages_per_employer: int = 25,
    ) -> dict:
        assert limit == 2
        assert max_pages_per_employer == 1
        jobs = [
            {"title": f"Director of Engineering {employer_key} {index}", "employer_key": employer_key}
            for index in range(2)
        ]
        return {"employer": employer_key, "query": "Director of Engineering", "found": len(jobs), "new": 0, "existing": 0, "jobs": jobs}

    def fake_store_results(
        _conn: object,
        jobs: list[dict],
        _employers: dict,
        *,
        limit: int = 0,
        run_id: str | None = None,
    ) -> tuple[int, int]:
        assert limit == 2
        assert run_id == "run-1"
        stored_jobs.extend(jobs)
        return len(jobs), 0

    monkeypatch.setattr(workday, "init_db", lambda: None)
    monkeypatch.setattr(workday, "get_connection", lambda: object())
    monkeypatch.setattr(workday, "_search_and_fetch_one", fake_search_and_fetch_one)
    monkeypatch.setattr(workday, "store_results", fake_store_results)

    result = workday.scrape_employers(
        "Director of Engineering",
        employers,
        workers=3,
        limit=2,
        max_pages_per_employer=1,
        run_id="run-1",
    )

    assert result == {"found": 2, "new": 2, "existing": 0}
    assert len(stored_jobs) == 2
