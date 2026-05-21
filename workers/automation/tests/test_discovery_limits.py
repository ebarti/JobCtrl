from __future__ import annotations

from types import SimpleNamespace

import pandas as pd
import pytest

from jobhunter.database import close_connection, init_db
from jobhunter.discovery import jobspy


def test_jobspy_limit_runs_one_query_against_scheduled_boards(monkeypatch):
    calls: list[tuple[str, str, list[str], int, int]] = []

    def fake_run_one_search(
        search: dict,
        sites: list[str],
        results_per_site: int,
        *_args,
        limit: int = 0,
        **_kwargs,
    ) -> dict:
        calls.append((search["query"], search["location"], sites, results_per_site, limit))
        return {"new": 1, "existing": 0, "errors": 0}

    monkeypatch.setattr(jobspy, "init_db", lambda: None)
    monkeypatch.setattr(
        jobspy,
        "get_connection",
        lambda: SimpleNamespace(execute=lambda *_args, **_kwargs: SimpleNamespace(fetchone=lambda: [1])),
    )
    monkeypatch.setattr(jobspy, "_run_one_search", fake_run_one_search)

    result = jobspy._full_crawl(
        {
            "queries": [{"query": "platform engineer"}, {"query": "product engineer"}],
            "locations": [{"label": "remote", "location": "Remote"}],
            "defaults": {"results_per_site": 100},
        },
        sites=["indeed", "linkedin"],
        limit=1,
    )

    assert calls == [("platform engineer", "Remote", ["indeed", "linkedin"], 1, 1)]
    assert result["queries"] == 1


def test_jobspy_filters_results_by_target_title(monkeypatch):
    stored_titles: list[str] = []

    def fake_scrape(_kwargs: dict, max_retries: int = 2, backoff: float = 5.0):
        return pd.DataFrame(
            [
                {
                    "job_url": "https://example.test/marketing",
                    "title": "CRM Marketer",
                    "location": "Barcelona, Spain",
                    "site": "indeed",
                },
                {
                    "job_url": "https://example.test/director-engineering",
                    "title": "Director of Engineering",
                    "location": "Barcelona, Spain",
                    "site": "indeed",
                },
            ]
        )

    def fake_store(_conn, df, _source_label: str, limit: int = 0) -> tuple[int, int]:
        stored_titles.extend(df["title"].tolist())
        return len(df), 0

    monkeypatch.setattr(jobspy, "_scrape_with_retry", fake_scrape)
    monkeypatch.setattr(jobspy, "get_connection", lambda: object())
    monkeypatch.setattr(jobspy, "store_jobspy_results", fake_store)

    result = jobspy._run_one_search(
        {"query": "Director of Engineering", "location": "Barcelona, Spain", "remote": True},
        ["indeed"],
        10,
        72,
        None,
        {"country_indeed": "spain"},
        0,
        ["Barcelona, Spain", "Spain", "Europe", "EMEA"],
        ["United States", "Canada"],
        ["Barcelona, Spain"],
        {},
        limit=10,
    )

    assert stored_titles == ["Director of Engineering"]
    assert result["new"] == 1
    assert result["filtered"] == 1


def test_jobspy_remote_search_rejects_non_remote_country_only_location(monkeypatch):
    stored_locations: list[str] = []

    def fake_scrape(_kwargs: dict, max_retries: int = 2, backoff: float = 5.0):
        return pd.DataFrame(
            [
                {
                    "job_url": "https://example.test/la-rinconada",
                    "title": "Chief Information Officer",
                    "location": "La Rinconada, AN, ES",
                    "is_remote": False,
                    "site": "indeed",
                },
                {
                    "job_url": "https://example.test/barcelona",
                    "title": "Chief Information Officer",
                    "location": "Barcelona, CT, ES",
                    "is_remote": False,
                    "site": "indeed",
                },
                {
                    "job_url": "https://example.test/remote-spain",
                    "title": "Chief Information Officer",
                    "location": "Spain",
                    "is_remote": True,
                    "site": "indeed",
                },
            ]
        )

    def fake_store(_conn, df, _source_label: str, limit: int = 0) -> tuple[int, int]:
        stored_locations.extend(df["location"].tolist())
        return len(df), 0

    monkeypatch.setattr(jobspy, "_scrape_with_retry", fake_scrape)
    monkeypatch.setattr(jobspy, "get_connection", lambda: object())
    monkeypatch.setattr(jobspy, "store_jobspy_results", fake_store)

    result = jobspy._run_one_search(
        {"query": "Chief Information Officer", "location": "Spain", "remote": True},
        ["indeed"],
        10,
        72,
        None,
        {"country_indeed": "spain"},
        0,
        ["Barcelona, Spain", "Spain", "Europe", "EMEA"],
        ["United States", "Canada"],
        ["Barcelona, Spain"],
        {},
        limit=10,
    )

    assert stored_locations == ["Barcelona, CT, ES", "Spain"]
    assert result["new"] == 2
    assert result["filtered"] == 1


def test_jobspy_linkedin_location_parser_tolerates_unknown_country():
    from bs4 import BeautifulSoup
    from jobspy.linkedin import LinkedIn

    jobspy._patch_jobspy_linkedin_location_parser()

    metadata = BeautifulSoup(
        """
        <div class="base-search-card__metadata">
          <span class="job-search-card__location">Sarajevo, Federation, Bosnia and Herzegovina</span>
        </div>
        """,
        "html.parser",
    )

    location = LinkedIn()._get_location(metadata)

    assert location.display_location() == "Sarajevo, Federation, Bosnia and Herzegovina"


def test_jobspy_stores_company_and_backfills_existing_job(tmp_path):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        first = pd.DataFrame(
            [
                {
                    "job_url": "https://www.linkedin.com/jobs/view/1",
                    "title": "Head of Engineering",
                    "company": "Keyrock",
                    "location": "Barcelona, Spain",
                    "site": "linkedin",
                }
            ]
        )
        assert jobspy.store_jobspy_results(conn, first, "Head of Engineering", limit=10) == (1, 0)
        row = conn.execute(
            "SELECT company FROM jobs WHERE url = ?", ("https://www.linkedin.com/jobs/view/1",)
        ).fetchone()
        assert row["company"] == "Keyrock"

        conn.execute("UPDATE jobs SET company = '' WHERE url = ?", ("https://www.linkedin.com/jobs/view/1",))
        conn.commit()
        duplicate = pd.DataFrame(
            [
                {
                    "job_url": "https://www.linkedin.com/jobs/view/1",
                    "title": "Head of Engineering",
                    "company": "Keyrock",
                    "location": "Barcelona, Spain",
                    "site": "linkedin",
                }
            ]
        )

        assert jobspy.store_jobspy_results(conn, duplicate, "Head of Engineering", limit=10) == (0, 1)
        row = conn.execute(
            "SELECT company FROM jobs WHERE url = ?", ("https://www.linkedin.com/jobs/view/1",)
        ).fetchone()
        assert row["company"] == "Keyrock"
        event = conn.execute(
            "SELECT event_type FROM job_events WHERE job_url = ? ORDER BY event_id DESC LIMIT 1",
            ("https://www.linkedin.com/jobs/view/1",),
        ).fetchone()
        assert event["event_type"] == "JobMetadataUpdated"
    finally:
        close_connection(db_path)


def test_jobspy_missing_dependency_is_not_reported_as_empty_success(monkeypatch):
    def missing_jobspy(_kwargs: dict, max_retries: int = 2, backoff: float = 5.0):
        raise ImportError("python-jobspy is not installed")

    monkeypatch.setattr(jobspy, "_scrape_with_retry", missing_jobspy)

    with pytest.raises(ImportError, match="python-jobspy"):
        jobspy._run_one_search(
            {"query": "Director of Engineering", "location": "Barcelona, Spain", "remote": True},
            ["indeed"],
            10,
            72,
            None,
            {"country_indeed": "spain"},
            0,
            ["Barcelona, Spain"],
            [],
            [],
            {},
            limit=10,
        )
