from __future__ import annotations

import json
import threading
from types import SimpleNamespace

import pandas as pd
import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.discovery import jobspy, smartextract, workday
from jobctrl.domain.discovery import (
    AtsKind,
    Employer,
    JobMetadata,
    PostingUrl,
    SearchStrategy,
    Source,
)
from jobctrl.domain.discovery.use_cases import DiscoverJobsUseCase
from jobctrl.domain.identifiers import generate_job_id
from jobctrl.domain.ports.discovery import ScrapedJobPosting
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.compensation import SqlitePostedCompensationRepository
from jobctrl.infrastructure.discovery import SqliteJobRepository
from jobctrl.infrastructure.discovery.production_wiring import DurableJobEventPublisher
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder


_JOBSPY_DESCRIPTION = "Lead engineering, platform, security, and delivery teams in Spain. " * 8


def _jobspy_frame(rows: list[dict]) -> pd.DataFrame:
    return pd.DataFrame([{"description": _JOBSPY_DESCRIPTION, **row} for row in rows])


def _stable_job_id(conn, job_url: str) -> str:
    row = conn.execute(
        "SELECT job_id FROM jobs WHERE tenant_id = ? AND url = ?",
        (str(LOCAL_TENANT), job_url),
    ).fetchone()
    assert row is not None
    return str(row["job_id"])


def test_jobspy_limit_stops_after_one_new_job(monkeypatch):
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

    assert calls == [("platform engineer", "Remote", ["indeed", "linkedin"], 100, 1)]
    assert result["queries"] == 1


def test_jobspy_emits_source_progress(monkeypatch):
    snapshots: list[dict[str, object]] = []

    def fake_run_one_search(
        search: dict,
        _sites: list[str],
        _results_per_site: int,
        *_args,
        **_kwargs,
    ) -> dict:
        if search["query"] == "platform engineer":
            return {"new": 0, "existing": 1, "errors": 0, "filtered": 2, "total": 3}
        return {"new": 1, "existing": 0, "errors": 0, "filtered": 0, "total": 1}

    monkeypatch.setattr(jobspy, "init_db", lambda: None)
    monkeypatch.setattr(
        jobspy,
        "get_connection",
        lambda: SimpleNamespace(execute=lambda *_args, **_kwargs: SimpleNamespace(fetchone=lambda: [2])),
    )
    monkeypatch.setattr(jobspy, "_run_one_search", fake_run_one_search)

    result = jobspy._full_crawl(
        {
            "queries": [{"query": "platform engineer"}, {"query": "product engineer"}],
            "locations": [{"label": "barcelona", "location": "Barcelona, Spain"}],
            "defaults": {"results_per_site": 100},
        },
        sites=["indeed"],
        limit=10,
        progress_callback=snapshots.append,
    )

    assert result["new"] == 1
    assert result["existing"] == 1
    assert snapshots[0] == {
        "completed": 0,
        "total": 2,
        "unit": "searches",
        "new_jobs": 0,
        "existing_jobs": 0,
        "filtered_jobs": 0,
        "errors": 0,
        "raw_total": 0,
        "message": "JobStreaming search started",
        "current_query": "platform engineer",
        "current_location": "Barcelona, Spain",
    }
    assert snapshots[-1] == {
        "completed": 2,
        "total": 2,
        "unit": "searches",
        "new_jobs": 1,
        "existing_jobs": 1,
        "filtered_jobs": 2,
        "errors": 0,
        "raw_total": 4,
        "message": "JobStreaming search completed",
        "current_query": "product engineer",
        "current_location": "Barcelona, Spain",
    }


def test_jobspy_cooperatively_cancels_before_next_search(monkeypatch):
    cancel_event = threading.Event()
    cancel_event.set()
    monkeypatch.setattr(jobspy, "init_db", lambda: None)
    monkeypatch.setattr(jobspy, "_run_one_search", lambda *_args, **_kwargs: pytest.fail("search should not start"))

    with pytest.raises(jobspy.DiscoveryCancelled):
        jobspy._full_crawl(
            {
                "queries": [{"query": "platform engineer"}],
                "locations": [{"label": "barcelona", "location": "Barcelona, Spain"}],
                "defaults": {"results_per_site": 100},
            },
            sites=["indeed"],
            cancel_event=cancel_event,
        )


def test_jobspy_limit_does_not_let_existing_jobs_starve_later_queries(monkeypatch):
    calls: list[tuple[str, int, int]] = []

    def fake_run_one_search(
        search: dict,
        _sites: list[str],
        results_per_site: int,
        *_args,
        limit: int = 0,
        **_kwargs,
    ) -> dict:
        calls.append((search["query"], results_per_site, limit))
        if search["query"] == "exact role":
            return {"new": 0, "existing": 1, "errors": 0, "filtered": 0, "total": 1}
        return {"new": 1, "existing": 0, "errors": 0, "filtered": 0, "total": 1}

    monkeypatch.setattr(jobspy, "init_db", lambda: None)
    monkeypatch.setattr(
        jobspy,
        "get_connection",
        lambda: SimpleNamespace(execute=lambda *_args, **_kwargs: SimpleNamespace(fetchone=lambda: [2])),
    )
    monkeypatch.setattr(jobspy, "_run_one_search", fake_run_one_search)

    result = jobspy._full_crawl(
        {
            "queries": [{"query": "exact role"}, {"query": "recall role", "match_mode": "recall"}],
            "locations": [{"label": "remote", "location": "Remote"}],
            "defaults": {"results_per_site": 100},
        },
        sites=["linkedin"],
        limit=1,
    )

    assert calls == [("exact role", 100, 1), ("recall role", 100, 1)]
    assert result["new"] == 1
    assert result["existing"] == 1
    assert result["queries"] == 2


def test_jobspy_does_not_treat_board_error_count_as_failed_query_count(monkeypatch):
    calls = 0

    def fake_run_one_search(*_args, **_kwargs) -> dict:
        nonlocal calls
        calls += 1
        if calls == 1:
            return {
                "new": 0,
                "existing": 0,
                "errors": 2,
                "filtered": 0,
                "total": 0,
                "all_sites_failed": True,
            }
        return {
            "new": 0,
            "existing": 0,
            "errors": 0,
            "filtered": 0,
            "total": 0,
            "all_sites_failed": False,
        }

    monkeypatch.setattr(jobspy, "init_db", lambda: None)
    monkeypatch.setattr(
        jobspy,
        "get_connection",
        lambda: SimpleNamespace(
            execute=lambda *_args, **_kwargs: SimpleNamespace(fetchone=lambda: [0])
        ),
    )
    monkeypatch.setattr(jobspy, "_run_one_search", fake_run_one_search)

    result = jobspy._full_crawl(
        {
            "queries": [{"query": "first"}, {"query": "second"}],
            "locations": [{"location": "Remote"}],
            "defaults": {"results_per_site": 10},
        },
        sites=["indeed", "linkedin"],
    )

    assert result["errors"] == 2
    assert result["failed_queries"] == 1
    assert result["queries"] == 2


def test_jobspy_filters_results_by_target_title(monkeypatch):
    stored_titles: list[str] = []

    def fake_scrape(_kwargs: dict, max_retries: int = 2, backoff: float = 5.0):
        return _jobspy_frame(
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

    def fake_store(_conn, df, _source_label: str, limit: int = 0, run_id: str = "jobspy") -> tuple[int, int]:
        assert run_id == "jobspy"
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


def test_jobspy_recall_title_filter_accepts_leadership_variants(monkeypatch):
    stored_titles: list[str] = []

    def fake_scrape(_kwargs: dict, max_retries: int = 2, backoff: float = 5.0):
        return _jobspy_frame(
            [
                {
                    "job_url": "https://example.test/head-technology",
                    "title": "Head of Technology",
                    "location": "Barcelona, Spain",
                    "site": "indeed",
                },
                {
                    "job_url": "https://example.test/software-engineer",
                    "title": "Software Engineer",
                    "location": "Barcelona, Spain",
                    "site": "indeed",
                },
                {
                    "job_url": "https://example.test/product-marketing-director",
                    "title": "Product Marketing Director",
                    "location": "Barcelona, Spain",
                    "site": "indeed",
                },
            ]
        )

    def fake_store(_conn, df, _source_label: str, limit: int = 0, run_id: str = "jobspy") -> tuple[int, int]:
        assert run_id == "jobspy"
        stored_titles.extend(df["title"].tolist())
        return len(df), 0

    monkeypatch.setattr(jobspy, "_scrape_with_retry", fake_scrape)
    monkeypatch.setattr(jobspy, "get_connection", lambda: object())
    monkeypatch.setattr(jobspy, "store_jobspy_results", fake_store)

    result = jobspy._run_one_search(
        {
            "query": "technology director",
            "location": "Barcelona, Spain",
            "remote": False,
            "match_mode": "recall",
        },
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

    assert stored_titles == ["Head of Technology"]
    assert result["new"] == 1
    assert result["filtered"] == 2


def test_jobspy_remote_search_rejects_non_remote_country_only_location(monkeypatch):
    stored_locations: list[str] = []

    def fake_scrape(_kwargs: dict, max_retries: int = 2, backoff: float = 5.0):
        return _jobspy_frame(
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

    def fake_store(_conn, df, _source_label: str, limit: int = 0, run_id: str = "jobspy") -> tuple[int, int]:
        assert run_id == "jobspy"
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


def test_jobspy_retains_partial_results_and_counts_typed_board_failure(monkeypatch):
    from jobctrl.infrastructure.discovery.jobstreaming_gateway import (
        JobStreamingBatch,
        JobStreamingFailure,
    )

    frame = _jobspy_frame(
        [
            {
                "job_url": "https://example.test/director-engineering",
                "title": "Director of Engineering",
                "location": "Barcelona, Spain",
                "site": "indeed",
            }
        ]
    )
    batch = JobStreamingBatch(
        frame=frame,
        failures=(
            JobStreamingFailure(
                site="linkedin",
                code="rate_limited",
                error_type="RateLimitError",
                message="slow down",
                retryable=True,
                reset_checkpoint=False,
            ),
        ),
        warnings=(),
        completed=False,
    )
    stored: list[str] = []
    monkeypatch.setattr(jobspy, "_scrape_with_retry", lambda *_args, **_kwargs: batch)
    monkeypatch.setattr(jobspy, "get_connection", lambda: object())
    monkeypatch.setattr(
        jobspy,
        "store_jobspy_results",
        lambda _conn, df, *_args, **_kwargs: (stored.extend(df["title"].tolist()) or 1, 0),
    )

    result = jobspy._run_one_search(
        {"query": "Director of Engineering", "location": "Barcelona, Spain"},
        ["indeed", "linkedin"],
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

    assert stored == ["Director of Engineering"]
    assert result["new"] == 1
    assert result["errors"] == 1


def test_jobspy_dedups_against_ats_first_canonical_employer(tmp_path):
    """JobSpy dedup uses the canonical employer, independently of the source."""
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        owner_url = "https://boards.greenhouse.io/acme/jobs/staff-eng"
        repository = SqliteJobRepository(conn)
        use_case = DiscoverJobsUseCase(
            repository=repository,
            publisher=DurableJobEventPublisher(conn, stage="discover"),
            clock=lambda: "2026-05-12T00:00:00Z",
        )
        use_case.execute(
            tenant_id=LOCAL_TENANT,
            postings=[
                ScrapedJobPosting(
                    posting_url=PostingUrl(value=owner_url),
                    source=Source(board="greenhouse"),
                    employer=Employer(name="Acme"),
                    metadata=JobMetadata(
                        title="Staff Platform Engineer",
                        description=_JOBSPY_DESCRIPTION,
                        location="Remote",
                    ),
                    strategy=SearchStrategy.WORKDAY_API,
                    source_id="greenhouse:acme",
                    source_native_id="gh-1",
                    canonical_url=owner_url,
                    ats_kind=AtsKind.GREENHOUSE,
                )
            ],
            run_id="run-ats",
        )
        stored = conn.execute(
            "SELECT company, site FROM jobs WHERE url = ?", (owner_url,)
        ).fetchone()
        assert stored["company"] == "Acme"
        assert stored["site"] == "greenhouse"

        frame = _jobspy_frame(
            [
                {
                    "job_url": "https://www.linkedin.com/jobs/view/1",
                    "title": "Staff Platform Engineer",
                    "company": "Acme",
                    "location": "Barcelona, Spain",
                    "site": "linkedin",
                }
            ]
        )
        assert jobspy.store_jobspy_results(conn, frame, "Staff Platform Engineer", limit=10) == (0, 1)
        assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1
        link = conn.execute(
            "SELECT surviving_job_id FROM job_duplicate_links"
        ).fetchone()
        assert link["surviving_job_id"] == _stable_job_id(conn, owner_url)
    finally:
        close_connection(db_path)


def test_jobspy_keeps_distinct_roles_at_same_employer_separate(tmp_path):
    """Distinct roles must not merge onto an ATS owner via JobSpy.

    Content matching gates on normalized title AND canonical employer. Two
    genuinely different roles at the same employer with
    near-identical (well above 0.83 shingle) descriptions must remain separate
    Jobs -- the title gate short-circuits before the shared description could
    fingerprint- or shingle-match.
    """
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        shared_description = (
            "Lead platform reliability, security, and delivery initiatives "
            "across Spain and the wider EMEA region. " * 12
        )
        owner_url = "https://boards.greenhouse.io/acme/jobs/staff-platform-eng"
        repository = SqliteJobRepository(conn)
        use_case = DiscoverJobsUseCase(
            repository=repository,
            publisher=DurableJobEventPublisher(conn, stage="discover"),
            clock=lambda: "2026-05-12T00:00:00Z",
        )
        use_case.execute(
            tenant_id=LOCAL_TENANT,
            postings=[
                ScrapedJobPosting(
                    posting_url=PostingUrl(value=owner_url),
                    source=Source(board="greenhouse"),
                    employer=Employer(name="Acme"),
                    metadata=JobMetadata(
                        title="Staff Platform Engineer",
                        description=shared_description,
                        location="Remote",
                    ),
                    strategy=SearchStrategy.WORKDAY_API,
                    source_id="greenhouse:acme",
                    source_native_id="gh-1",
                    canonical_url=owner_url,
                    ats_kind=AtsKind.GREENHOUSE,
                )
            ],
            run_id="run-ats",
        )
        stored = conn.execute(
            "SELECT company, site FROM jobs WHERE url = ?", (owner_url,)
        ).fetchone()
        assert stored["company"] == "Acme"
        assert stored["site"] == "greenhouse"

        frame = _jobspy_frame(
            [
                {
                    "job_url": "https://www.linkedin.com/jobs/view/2",
                    "title": "Staff Data Scientist",
                    "company": "Acme",
                    "location": "Barcelona, Spain",
                    "site": "linkedin",
                    "description": shared_description,
                }
            ]
        )
        assert jobspy.store_jobspy_results(conn, frame, "Staff Data Scientist", limit=10) == (1, 0)
        assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 2
        assert conn.execute("SELECT COUNT(*) FROM job_duplicate_links").fetchone()[0] == 0
    finally:
        close_connection(db_path)


def test_jobspy_stores_company_and_backfills_existing_job(tmp_path):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        first = _jobspy_frame(
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
        duplicate = _jobspy_frame(
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
            "SELECT event_type FROM job_events WHERE job_id = ? AND event_type = 'JobMetadataUpdated' LIMIT 1",
            (_stable_job_id(conn, "https://www.linkedin.com/jobs/view/1"),),
        ).fetchone()
        assert event["event_type"] == "JobMetadataUpdated"
    finally:
        close_connection(db_path)


def test_jobspy_store_filters_rows_without_descriptions_before_limit(tmp_path):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        results = _jobspy_frame(
            [
                {
                    "job_url": "https://www.linkedin.com/jobs/view/no-description",
                    "title": "Head of Engineering",
                    "company": "Missing Description Co",
                    "description": "",
                    "location": "Barcelona, Spain",
                    "site": "linkedin",
                },
                {
                    "job_url": "https://www.linkedin.com/jobs/view/with-description",
                    "title": "Head of Engineering",
                    "company": "With Description Co",
                    "location": "Barcelona, Spain",
                    "site": "linkedin",
                },
            ]
        )

        assert jobspy.store_jobspy_results(conn, results, "Head of Engineering", limit=1) == (1, 0)
        urls = {row["url"] for row in conn.execute("SELECT url FROM jobs").fetchall()}
        assert urls == {"https://www.linkedin.com/jobs/view/with-description"}
    finally:
        close_connection(db_path)


def test_jobspy_rejects_location_mismatches_before_discovery_persistence(tmp_path):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    search_cfg = {
        "queries": [{"query": "Software Engineer", "tier": 1}],
        "locations": [{"location": "Spain"}],
        "location_accept": ["Spain", "Europe", "European Union", "EU", "EMEA"],
        "location_reject_non_remote": [
            "India",
            "Poland",
            "United Kingdom",
            "UK",
            "United States",
        ],
        "location": {
            "accept_patterns": ["Spain", "Europe", "European Union", "EU", "EMEA"],
            "reject_patterns": [
                "India",
                "Poland",
                "United Kingdom",
                "UK",
                "United States",
            ],
        },
    }
    results = _jobspy_frame(
        [
            {
                "job_url": "https://www.linkedin.com/jobs/view/india",
                "title": "Software Engineer (India)",
                "company": "Acai",
                "location": "Remote",
                "site": "linkedin",
                "is_remote": True,
            },
            {
                "job_url": "https://www.linkedin.com/jobs/view/spain",
                "title": "Software Engineer",
                "company": "Barcelona Tech",
                "location": "Spain",
                "site": "linkedin",
                "is_remote": True,
            },
        ]
    )

    try:
        assert jobspy.store_jobspy_results(
            conn,
            results,
            "Software Engineer",
            limit=10,
            search_cfg=search_cfg,
        ) == (1, 0)
        rows = conn.execute("SELECT url, title, location FROM jobs ORDER BY url").fetchall()
        assert [(row["url"], row["title"], row["location"]) for row in rows] == [
            ("https://www.linkedin.com/jobs/view/spain", "Software Engineer", "Spain (Remote)")
        ]
        assert conn.execute("SELECT COUNT(*) FROM jobctrl_deleted_jobs").fetchone()[0] == 0
    finally:
        close_connection(db_path)


def test_jobspy_store_filters_null_description_sentinels(tmp_path):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        results = _jobspy_frame(
            [
                {
                    "job_url": "https://www.linkedin.com/jobs/view/none-description",
                    "title": "Head of Engineering",
                    "company": "None Description Co",
                    "description": None,
                    "location": "Barcelona, Spain",
                    "site": "linkedin",
                },
                {
                    "job_url": "https://www.linkedin.com/jobs/view/na-description",
                    "title": "Head of Engineering",
                    "company": "NA Description Co",
                    "description": pd.NA,
                    "location": "Barcelona, Spain",
                    "site": "linkedin",
                },
                {
                    "job_url": "https://www.linkedin.com/jobs/view/string-none-description",
                    "title": "Head of Engineering",
                    "company": "String None Description Co",
                    "description": "None",
                    "location": "Barcelona, Spain",
                    "site": "linkedin",
                },
            ]
        )

        assert jobspy.store_jobspy_results(conn, results, "Head of Engineering", limit=10) == (0, 0)
        assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
    finally:
        close_connection(db_path)


def test_jobspy_existing_row_refreshes_metadata_before_restore(tmp_path):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    url = "https://www.linkedin.com/jobs/view/stale"
    try:
        job_id = str(generate_job_id())
        conn.execute(
            """
            INSERT INTO jobs (
                tenant_id, job_id, url, title, company, description, location, site, strategy, discovered_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(LOCAL_TENANT),
                job_id,
                url,
                "Stale Support Role",
                "",
                "",
                "United States (Remote)",
                "linkedin",
                "jobspy",
                "2026-05-20T00:00:00+00:00",
            ),
        )
        conn.execute(
            """
            INSERT INTO job_locators (
                tenant_id, job_id, locator_kind, locator_value, is_current,
                first_seen_at, last_seen_at, retired_at
            ) VALUES (?, ?, 'posting_url', ?, 1, ?, ?, NULL)
            """,
            (
                str(LOCAL_TENANT),
                job_id,
                url,
                "2026-05-20T00:00:00+00:00",
                "2026-05-20T00:00:00+00:00",
            ),
        )
        conn.execute(
            """
            INSERT INTO jobctrl_deleted_jobs (
                tenant_id, job_id, deleted_at, reason, restored_at
            ) VALUES (?, ?, ?, ?, NULL)
            """,
            (
                str(LOCAL_TENANT),
                _stable_job_id(conn, url),
                "2026-05-21T00:00:00+00:00",
                "stale invalid row",
            ),
        )
        conn.commit()

        description = ("Lead engineering teams in Spain. " * 12).strip()
        rediscovered = _jobspy_frame(
            [
                {
                    "job_url": url,
                    "title": "Head of Engineering",
                    "company": "Keyrock",
                    "location": "Barcelona, Spain",
                    "site": "linkedin",
                    "description": description,
                }
            ]
        )

        assert jobspy.store_jobspy_results(conn, rediscovered, "Head of Engineering", limit=1) == (0, 1)
        row = conn.execute(
            "SELECT title, company, description, full_description, location FROM jobs WHERE url = ?",
            (url,),
        ).fetchone()
        assert dict(row) == {
            "title": "Head of Engineering",
            "company": "Keyrock",
            "description": description,
            "full_description": description,
            "location": "Barcelona, Spain",
        }
        tombstone = conn.execute(
            "SELECT restored_at FROM jobctrl_deleted_jobs WHERE tenant_id = ? AND job_id = ?",
            (str(LOCAL_TENANT), _stable_job_id(conn, url)),
        ).fetchone()
        assert tombstone["restored_at"] is not None
    finally:
        close_connection(db_path)


def test_jobspy_store_limit_counts_new_jobs_not_existing_observations(tmp_path):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        existing = _jobspy_frame(
            [
                {
                    "job_url": "https://www.linkedin.com/jobs/view/existing",
                    "title": "Head of Engineering",
                    "company": "Acme",
                    "location": "Barcelona, Spain",
                    "site": "linkedin",
                }
            ]
        )
        assert jobspy.store_jobspy_results(conn, existing, "Head of Engineering", limit=1) == (1, 0)

        mixed = _jobspy_frame(
            [
                {
                    "job_url": "https://www.linkedin.com/jobs/view/existing",
                    "title": "Head of Engineering",
                    "company": "Acme",
                    "location": "Barcelona, Spain",
                    "site": "linkedin",
                },
                {
                    "job_url": "https://www.linkedin.com/jobs/view/new",
                    "title": "Head of Technology",
                    "company": "AstraZeneca",
                    "location": "Barcelona, Spain",
                    "site": "linkedin",
                },
                {
                    "job_url": "https://www.linkedin.com/jobs/view/second-new",
                    "title": "Technology Director",
                    "company": "AstraZeneca",
                    "location": "Barcelona, Spain",
                    "site": "linkedin",
                },
            ]
        )

        assert jobspy.store_jobspy_results(conn, mixed, "technology director", limit=1) == (1, 1)
        urls = {
            row["url"]
            for row in conn.execute(
                "SELECT url FROM jobs WHERE url LIKE 'https://www.linkedin.com/jobs/view/%'"
            ).fetchall()
        }
        assert "https://www.linkedin.com/jobs/view/existing" in urls
        assert "https://www.linkedin.com/jobs/view/new" in urls
        assert "https://www.linkedin.com/jobs/view/second-new" not in urls
    finally:
        close_connection(db_path)


def test_smartextract_store_limit_counts_new_jobs_not_existing_observations(tmp_path):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        existing_job = {
            "url": "https://jobs.example/existing",
            "title": "Head of Engineering",
            "company": "Acme",
            "location": "Barcelona, Spain",
            "description": "Lead engineering teams.",
        }
        assert smartextract._store_jobs_filtered(
            conn,
            [existing_job],
            "Example",
            "json_ld",
            ["Barcelona, Spain"],
            [],
            limit=1,
            source_url="https://jobs.example/",
        ) == (1, 0)

        new_job = {
            "url": "https://jobs.example/new",
            "title": "Head of Technology",
            "company": "Acme",
            "location": "Barcelona, Spain",
            "description": "Lead technology teams.",
        }
        second_new_job = {
            "url": "https://jobs.example/second-new",
            "title": "Technology Director",
            "company": "Acme",
            "location": "Barcelona, Spain",
            "description": "Lead platform teams.",
        }

        assert smartextract._store_jobs_filtered(
            conn,
            [existing_job, new_job, second_new_job],
            "Example",
            "json_ld",
            ["Barcelona, Spain"],
            [],
            limit=1,
            source_url="https://jobs.example/",
        ) == (1, 1)
        urls = {row["url"] for row in conn.execute("SELECT url FROM jobs").fetchall()}
        assert "https://jobs.example/existing" in urls
        assert "https://jobs.example/new" in urls
        assert "https://jobs.example/second-new" not in urls
    finally:
        close_connection(db_path)


def test_workday_store_limit_counts_new_jobs_not_existing_observations(tmp_path):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    employers = {
        "acme": {
            "base_url": "https://acme.wd1.myworkdayjobs.com",
            "site_id": "careers",
            "name": "Acme",
        }
    }
    try:
        existing_job = {
            "title": "Head of Engineering",
            "location": "Barcelona, Spain",
            "external_path": "/job/existing",
            "employer_key": "acme",
            "employer_name": "Acme",
            "full_description": "Lead engineering teams. " * 20,
        }
        assert workday.store_results(conn, [existing_job], employers, limit=1) == (1, 0)

        new_job = {
            "title": "Head of Technology",
            "location": "Barcelona, Spain",
            "external_path": "/job/new",
            "employer_key": "acme",
            "employer_name": "Acme",
            "full_description": "Lead technology teams. " * 20,
        }
        second_new_job = {
            "title": "Technology Director",
            "location": "Barcelona, Spain",
            "external_path": "/job/second-new",
            "employer_key": "acme",
            "employer_name": "Acme",
            "full_description": "Lead platform teams. " * 20,
        }

        assert workday.store_results(conn, [existing_job, new_job, second_new_job], employers, limit=1) == (1, 1)
        urls = {row["url"] for row in conn.execute("SELECT url FROM jobs").fetchall()}
        assert "https://acme.wd1.myworkdayjobs.com/careers/job/existing" in urls
        assert "https://acme.wd1.myworkdayjobs.com/careers/job/new" in urls
        assert "https://acme.wd1.myworkdayjobs.com/careers/job/second-new" not in urls
    finally:
        close_connection(db_path)


def test_jobspy_learns_posting_owner_source_from_direct_ats_url(tmp_path):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        direct_url = "https://boards.greenhouse.io/acme/jobs/123456"
        frame = _jobspy_frame(
            [
                {
                    "job_url": "https://www.linkedin.com/jobs/view/4416248661",
                    "job_url_direct": direct_url,
                    "title": "Staff Platform Engineer",
                    "company": "Acme",
                    "location": "Barcelona, Spain",
                    "site": "linkedin",
                }
            ]
        )

        assert jobspy.store_jobspy_results(conn, frame, "Platform", limit=10) == (1, 0)

        observation = conn.execute(
            """
            SELECT source_id, observed_url, run_id
            FROM job_source_observations
            WHERE job_id = ?
            """,
            (_stable_job_id(conn, "https://www.linkedin.com/jobs/view/4416248661"),),
        ).fetchone()
        assert observation["source_id"] == "jobspy:linkedin"
        assert observation["observed_url"] == "https://www.linkedin.com/jobs/view/4416248661"
        assert observation["run_id"] == "jobspy"

        identity = conn.execute(
            """
            SELECT canonical_url, ats_kind, source_native_id, confidence
            FROM job_canonical_identities
            WHERE job_id = ?
            """,
            (_stable_job_id(conn, "https://www.linkedin.com/jobs/view/4416248661"),),
        ).fetchone()
        assert identity["canonical_url"] == direct_url
        assert identity["ats_kind"] == "greenhouse"
        assert identity["source_native_id"] == "123456"
        assert identity["confidence"] == 0.82

        source = conn.execute(
            """
            SELECT source_id, kind, priority, state, seed_url
            FROM source_registry_entries
            WHERE source_id = 'greenhouse:acme'
            """
        ).fetchone()
        assert dict(source) == {
            "source_id": "greenhouse:acme",
            "kind": "ats_api",
            "priority": "canonical",
            "state": "active",
            "seed_url": direct_url,
        }

        events = {
            row["event_type"]
            for row in conn.execute("SELECT event_type FROM job_events").fetchall()
        }
        assert {
            "JobSourceObserved",
            "SourceRegistryEntryCreated",
            "SourceLocationCandidatePromoted",
            "CanonicalJobIdentityResolved",
        }.issubset(events)
    finally:
        close_connection(db_path)


def test_jobspy_persists_posted_compensation_fact_from_bounded_salary_text(tmp_path):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        frame = _jobspy_frame(
            [
                {
                    "job_url": "https://www.linkedin.com/jobs/view/posted-comp",
                    "title": "Staff Platform Engineer",
                    "company": "Acme",
                    "location": "Barcelona, Spain",
                    "site": "linkedin",
                    "min_amount": 80_000,
                    "max_amount": 95_000,
                    "currency": "EUR",
                    "interval": "year",
                }
            ]
        )

        assert jobspy.store_jobspy_results(conn, frame, "Platform", limit=10) == (1, 0)

        fact = SqlitePostedCompensationRepository(conn).get_fact(
            "local",
            _stable_job_id(conn, "https://www.linkedin.com/jobs/view/posted-comp"),
        )
        assert fact is not None
        assert fact.parse_state == "parsed_range"
        assert fact.source_text == "EUR80,000-EUR95,000/year"
        assert fact.legacy_raw_salary == "EUR80,000-EUR95,000/year"
        assert fact.currency == "EUR"
        assert fact.minimum_amount == 80_000
        assert fact.maximum_amount == 95_000
    finally:
        close_connection(db_path)


def test_jobspy_projects_posted_compensation_from_full_description_when_salary_is_blank(
    tmp_path,
):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        description = (
            "Competitive compensation and benefits. "
            "In addition to base salary, the annual learning stipend is €2,000 per year. "
            + ("Lead platform engineering and delivery teams. " * 16)
            + "Base pay range per year:\n**€80,000 - €95,000**"
        )
        frame = _jobspy_frame(
            [
                {
                    "job_url": "https://www.linkedin.com/jobs/view/description-comp",
                    "title": "Staff Platform Engineer",
                    "company": "Acme",
                    "location": "Barcelona, Spain",
                    "site": "linkedin",
                    "description": description,
                }
            ]
        )

        assert jobspy.store_jobspy_results(conn, frame, "Platform", limit=10) == (1, 0)
        job_id = _stable_job_id(
            conn,
            "https://www.linkedin.com/jobs/view/description-comp",
        )
        fact = SqlitePostedCompensationRepository(conn).get_fact("local", job_id)
        salary = conn.execute(
            "SELECT salary FROM jobs WHERE tenant_id = ? AND job_id = ?",
            ("local", job_id),
        ).fetchone()["salary"]

        assert salary in (None, "")
        assert fact is not None
        assert fact.source_field == "jobs.full_description"
        assert fact.parse_state == "parsed_range"
        assert fact.annualized_minimum_amount == 80_000
        assert fact.annualized_maximum_amount == 95_000

        ProjectionBuilder(conn_factory=lambda: conn).refresh()
        projection = conn.execute(
            "SELECT compensation_summary_json FROM job_list_projections WHERE job_id = ?",
            (job_id,),
        ).fetchone()
        assert projection is not None
        summary = json.loads(projection["compensation_summary_json"])
        assert summary["posted"]["parseState"] == "parsed_range"
        assert summary["posted"]["range"]["annualizedMinimumAmount"] == 80_000
        assert summary["posted"]["range"]["annualizedMaximumAmount"] == 95_000
    finally:
        close_connection(db_path)


def test_jobspy_deduplicates_learned_sources_for_same_owner(tmp_path):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        frame = _jobspy_frame(
            [
                {
                    "job_url": "https://www.linkedin.com/jobs/view/1",
                    "job_url_direct": "https://boards.greenhouse.io/acme/jobs/111",
                    "title": "Staff Engineer",
                    "company": "Acme",
                    "location": "Barcelona, Spain",
                    "site": "linkedin",
                },
                {
                    "job_url": "https://www.indeed.com/viewjob?jk=2",
                    "job_url_direct": "https://boards.greenhouse.io/acme/jobs/222",
                    "title": "Principal Engineer",
                    "company": "Acme",
                    "location": "Barcelona, Spain",
                    "site": "indeed",
                },
            ]
        )

        assert jobspy.store_jobspy_results(conn, frame, "Platform", limit=10) == (2, 0)

        source_count = conn.execute(
            "SELECT COUNT(*) FROM source_registry_entries WHERE source_id = 'greenhouse:acme'"
        ).fetchone()[0]
        assert source_count == 1
        identities = conn.execute(
            "SELECT COUNT(*) FROM job_canonical_identities WHERE ats_kind = 'greenhouse'"
        ).fetchone()[0]
        assert identities == 2
    finally:
        close_connection(db_path)


def test_jobspy_surfaces_ambiguous_direct_urls_for_source_review(tmp_path):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        direct_url = "https://careers.example.com/platform-engineer"
        frame = _jobspy_frame(
            [
                {
                    "job_url": "https://www.linkedin.com/jobs/view/9",
                    "job_url_direct": direct_url,
                    "title": "Platform Engineer",
                    "company": "Example",
                    "location": "Barcelona, Spain",
                    "site": "linkedin",
                }
            ]
        )

        assert jobspy.store_jobspy_results(conn, frame, "Platform", limit=10) == (1, 0)

        candidate = conn.execute(
            """
            SELECT candidate_url, source_kind, confidence, manual_action_reason
            FROM source_locator_candidates
            WHERE candidate_url = ?
            """,
            (direct_url,),
        ).fetchone()
        assert candidate["source_kind"] == "employer_careers_page"
        assert candidate["confidence"] == 0.55
        assert candidate["manual_action_reason"] == "ambiguous_career_system"

        manual = conn.execute(
            """
            SELECT originating_url, reason, status
            FROM manual_capture_queue
            WHERE originating_url = ?
            """,
            (direct_url,),
        ).fetchone()
        assert manual["reason"] == "ambiguous_career_system"
        assert manual["status"] == "pending"
    finally:
        close_connection(db_path)


def test_jobspy_keeps_learned_workday_sources_in_review_until_runnable(tmp_path):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        direct_url = "https://acme.wd1.myworkdayjobs.com/en-US/acme/job/Platform-Engineer_JR-123"
        frame = _jobspy_frame(
            [
                {
                    "job_url": "https://www.linkedin.com/jobs/view/12",
                    "job_url_direct": direct_url,
                    "title": "Platform Engineer",
                    "company": "Acme",
                    "location": "Barcelona, Spain",
                    "site": "linkedin",
                }
            ]
        )

        assert jobspy.store_jobspy_results(conn, frame, "Platform", limit=10) == (1, 0)

        identity = conn.execute(
            """
            SELECT canonical_url, ats_kind, source_native_id
            FROM job_canonical_identities
            WHERE job_id = ?
            """,
            (_stable_job_id(conn, "https://www.linkedin.com/jobs/view/12"),),
        ).fetchone()
        assert identity["canonical_url"] == direct_url
        assert identity["ats_kind"] == "workday"
        assert identity["source_native_id"] == "Platform-Engineer_JR-123"

        assert (
            conn.execute(
                "SELECT COUNT(*) FROM source_registry_entries WHERE source_id LIKE 'workday:%'"
            ).fetchone()[0]
            == 0
        )

        candidate = conn.execute(
            """
            SELECT candidate_url, source_kind, detected_ats_kind, manual_action_reason
            FROM source_locator_candidates
            WHERE candidate_url = ?
            """,
            (direct_url,),
        ).fetchone()
        assert candidate["source_kind"] == "ats_api"
        assert candidate["detected_ats_kind"] == "workday"
        assert candidate["manual_action_reason"] == "ambiguous_career_system"

        manual = conn.execute(
            """
            SELECT originating_url, reason, status
            FROM manual_capture_queue
            WHERE originating_url = ?
            """,
            (direct_url,),
        ).fetchone()
        assert manual["reason"] == "ambiguous_career_system"
        assert manual["status"] == "pending"
    finally:
        close_connection(db_path)


def test_jobspy_ignores_missing_direct_url_for_source_learning(tmp_path):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        frame = _jobspy_frame(
            [
                {
                    "job_url": "https://www.linkedin.com/jobs/view/10",
                    "job_url_direct": None,
                    "title": "Platform Engineer",
                    "company": "Example",
                    "location": "Barcelona, Spain",
                    "site": "linkedin",
                }
            ]
        )

        assert jobspy.store_jobspy_results(conn, frame, "Platform", limit=10) == (1, 0)

        job = conn.execute(
            "SELECT application_url FROM jobs WHERE url = ?",
            ("https://www.linkedin.com/jobs/view/10",),
        ).fetchone()
        assert job["application_url"] is None
        assert conn.execute("SELECT COUNT(*) FROM job_canonical_identities").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM source_locator_candidates").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM manual_capture_queue").fetchone()[0] == 0
    finally:
        close_connection(db_path)


def test_jobspy_rejects_same_content_location_variants(tmp_path):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    description = "Lead security engineering, compliance, identity, and platform risk. " * 8
    try:
        first = _jobspy_frame(
            [
                {
                    "job_url": "https://www.linkedin.com/jobs/view/4416248661",
                    "title": "Director, Security Engineering - Remote in Spain",
                    "company": "Auctane",
                    "location": "Madrid, Spain",
                    "site": "linkedin",
                    "description": description,
                }
            ]
        )
        assert jobspy.store_jobspy_results(conn, first, "Security Engineering", limit=10) == (1, 0)

        duplicate = _jobspy_frame(
            [
                {
                    "job_url": "https://www.linkedin.com/jobs/view/4416235850",
                    "title": "Director, Security Engineering - Remote in Spain",
                    "company": "Auctane",
                    "location": "Seville, Spain",
                    "site": "linkedin",
                    "description": description,
                }
            ]
        )
        assert jobspy.store_jobspy_results(conn, duplicate, "Security Engineering", limit=10) == (0, 1)

        job_count = conn.execute(
            "SELECT COUNT(*) FROM jobs WHERE company = 'Auctane'"
        ).fetchone()[0]
        assert job_count == 1
        link = conn.execute(
            "SELECT surviving_job_id, superseded_job_or_observation_id, reason "
            "FROM job_duplicate_links"
        ).fetchone()
        assert link["surviving_job_id"] == _stable_job_id(
            conn, "https://www.linkedin.com/jobs/view/4416248661"
        )
        assert link["superseded_job_or_observation_id"] == "https://www.linkedin.com/jobs/view/4416235850"
        assert link["reason"] == "content_fingerprint_match"
        observation = conn.execute(
            "SELECT source_id FROM job_source_observations WHERE job_id = ?",
            (_stable_job_id(conn, "https://www.linkedin.com/jobs/view/4416248661"),),
        ).fetchone()
        assert observation["source_id"] == "jobspy:linkedin"
    finally:
        close_connection(db_path)


def test_jobspy_content_dedupe_normalizes_typographic_punctuation(tmp_path):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    curly_description = "Own Vonage\u2019s platform services and partner APIs. " * 8
    straight_description = "Own Vonage's platform services and partner APIs. " * 8
    try:
        first = _jobspy_frame(
            [
                {
                    "job_url": "https://es.indeed.com/viewjob?jk=curly",
                    "title": "Director, Product Management (BSS/Platform Services)",
                    "company": "Vonage",
                    "location": "Spain",
                    "site": "indeed",
                    "description": curly_description,
                }
            ]
        )
        assert jobspy.store_jobspy_results(conn, first, "Product", limit=10) == (1, 0)

        duplicate = _jobspy_frame(
            [
                {
                    "job_url": "https://es.indeed.com/viewjob?jk=straight",
                    "title": "Director, Product Management (BSS/Platform Services)",
                    "company": "Vonage",
                    "location": "Madrid, Spain",
                    "site": "indeed",
                    "description": straight_description,
                }
            ]
        )
        assert jobspy.store_jobspy_results(conn, duplicate, "Product", limit=10) == (0, 1)
        assert conn.execute("SELECT COUNT(*) FROM jobs WHERE company = 'Vonage'").fetchone()[0] == 1
    finally:
        close_connection(db_path)


def test_jobspy_rejects_cross_board_markdown_description_variants(tmp_path):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    shared_body = (
        "G\\+D makes the lives of billions of people around the world more secure. "
        "We shape trust in the digital age with built-in security technology. "
        "The Head of Technology owns platform delivery, engineering standards, "
        "vendor coordination, security governance, architecture roadmaps, "
        "cloud reliability, compliance, and stakeholder communication. "
    ) * 5
    indeed_description = f"**{shared_body}**\n\nEqual opportunity footer and Indeed metadata."
    linkedin_description = f"{shared_body}\n\nLinkedIn workplace summary."
    try:
        first = _jobspy_frame(
            [
                {
                    "job_url": "https://es.indeed.com/viewjob?jk=6b34cd5504dac130",
                    "job_url_direct": "https://www.gi-de.com/en/careers/jobs/jobs-detail-view/27069-en-US",
                    "title": "Head of Technology",
                    "company": "Giesecke+Devrient",
                    "location": "Catalonia, Spain (Remote)",
                    "site": "indeed",
                    "description": indeed_description,
                }
            ]
        )
        assert jobspy.store_jobspy_results(conn, first, "Head of Technology", limit=10) == (1, 0)

        duplicate = _jobspy_frame(
            [
                {
                    "job_url": "https://www.linkedin.com/jobs/view/4409381449",
                    "title": "Head of Technology",
                    "company": "Giesecke+Devrient",
                    "location": "Sant Joan Despí, Catalonia, Spain (Remote)",
                    "site": "linkedin",
                    "description": linkedin_description,
                }
            ]
        )
        assert jobspy.store_jobspy_results(conn, duplicate, "Head of Technology", limit=10) == (0, 1)

        assert conn.execute("SELECT COUNT(*) FROM jobs WHERE company = 'Giesecke+Devrient'").fetchone()[0] == 1
        link = conn.execute(
            "SELECT surviving_job_id, superseded_job_or_observation_id, reason FROM job_duplicate_links"
        ).fetchone()
        assert link["surviving_job_id"] == _stable_job_id(
            conn, "https://es.indeed.com/viewjob?jk=6b34cd5504dac130"
        )
        assert link["superseded_job_or_observation_id"] == "https://www.linkedin.com/jobs/view/4409381449"
        assert link["reason"] == "content_fingerprint_match"
        observations = conn.execute(
            "SELECT source_id FROM job_source_observations WHERE job_id = ? ORDER BY source_id",
            (_stable_job_id(conn, "https://es.indeed.com/viewjob?jk=6b34cd5504dac130"),),
        ).fetchall()
        assert [row["source_id"] for row in observations] == ["jobspy:indeed", "jobspy:linkedin"]
    finally:
        close_connection(db_path)


def test_jobspy_keeps_same_title_company_when_descriptions_diverge(tmp_path):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    shared_intro = (
        "G\\+D makes the lives of billions of people around the world more secure. "
        "We shape trust in the digital age with built-in security technology. "
    ) * 2
    platform_description = shared_intro + (
        "This Head of Technology role owns platform reliability, incident response, "
        "cloud architecture, developer tooling, service ownership, and infrastructure roadmaps. "
    ) * 6
    payments_description = shared_intro + (
        "This Head of Technology role owns card personalization, payment terminals, "
        "manufacturing systems, embedded firmware, supply-chain delivery, and factory operations. "
    ) * 6
    try:
        first = _jobspy_frame(
            [
                {
                    "job_url": "https://example.test/jobs/platform",
                    "title": "Head of Technology",
                    "company": "Giesecke+Devrient",
                    "location": "Catalonia, Spain",
                    "site": "indeed",
                    "description": platform_description,
                }
            ]
        )
        assert jobspy.store_jobspy_results(conn, first, "Head of Technology", limit=10) == (1, 0)

        second = _jobspy_frame(
            [
                {
                    "job_url": "https://example.test/jobs/payments",
                    "title": "Head of Technology",
                    "company": "Giesecke+Devrient",
                    "location": "Madrid, Spain",
                    "site": "linkedin",
                    "description": payments_description,
                }
            ]
        )
        assert jobspy.store_jobspy_results(conn, second, "Head of Technology", limit=10) == (1, 0)
        assert conn.execute("SELECT COUNT(*) FROM jobs WHERE company = 'Giesecke+Devrient'").fetchone()[0] == 2
        assert conn.execute("SELECT COUNT(*) FROM job_duplicate_links").fetchone()[0] == 0
    finally:
        close_connection(db_path)


def test_jobspy_exact_rediscovery_keeps_deleted_content_duplicate_suppressed(tmp_path):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    description = "Own product platforms, billing, service delivery, and API lifecycle. " * 8
    survivor_url = "https://es.indeed.com/viewjob?jk=canonical"
    duplicate_url = "https://es.indeed.com/viewjob?jk=duplicate"
    try:
        first = _jobspy_frame(
            [
                {
                    "job_url": survivor_url,
                    "title": "Director, Product Management (BSS/Platform Services)",
                    "company": "Vonage",
                    "location": "Barcelona, Spain",
                    "site": "indeed",
                    "description": description,
                }
            ]
        )
        assert jobspy.store_jobspy_results(conn, first, "Product", limit=10) == (1, 0)
        conn.execute(
            """
            INSERT INTO jobs (
                tenant_id, job_id, url, title, company, location, site, strategy, discovered_at,
                description, full_description, detail_scraped_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(LOCAL_TENANT),
                str(generate_job_id()),
                duplicate_url,
                "Director, Product Management (BSS/Platform Services)",
                "Vonage",
                "Madrid, Spain",
                "indeed",
                "jobspy",
                "2026-05-21T10:00:00+00:00",
                description,
                description,
                "2026-05-21T10:00:00+00:00",
            ),
        )
        conn.execute(
            """
            INSERT INTO jobctrl_deleted_jobs (
                tenant_id, job_id, deleted_at, reason, restored_at
            ) VALUES (?, ?, ?, ?, NULL)
            """,
            (
                str(LOCAL_TENANT),
                _stable_job_id(conn, duplicate_url),
                "2026-05-21T11:00:00+00:00",
                "content duplicate",
            ),
        )
        conn.commit()

        rediscovered = _jobspy_frame(
            [
                {
                    "job_url": duplicate_url,
                    "title": "Director, Product Management (BSS/Platform Services)",
                    "company": "Vonage",
                    "location": "Madrid, Spain",
                    "site": "indeed",
                }
            ]
        )
        assert jobspy.store_jobspy_results(conn, rediscovered, "Product", limit=10) == (0, 1)

        tombstone = conn.execute(
            "SELECT restored_at FROM jobctrl_deleted_jobs WHERE tenant_id = ? AND job_id = ?",
            (str(LOCAL_TENANT), _stable_job_id(conn, duplicate_url)),
        ).fetchone()
        assert tombstone["restored_at"] is None
        link = conn.execute(
            "SELECT surviving_job_id, superseded_job_or_observation_id, reason FROM job_duplicate_links"
        ).fetchone()
        assert link["surviving_job_id"] == _stable_job_id(conn, survivor_url)
        assert link["superseded_job_or_observation_id"] == duplicate_url
        assert link["reason"] == "content_fingerprint_match"
    finally:
        close_connection(db_path)


def test_jobspy_normalizes_source_locations_before_storage(tmp_path):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        results = _jobspy_frame(
            [
                {
                    "job_url": "https://es.indeed.com/viewjob?jk=remote-spain",
                    "title": "Director, Product Management",
                    "company": "Vonage",
                    "location": "En remoto, ES",
                    "is_remote": True,
                    "site": "indeed",
                }
            ]
        )

        assert jobspy.store_jobspy_results(conn, results, "Director", limit=10) == (1, 0)
        row = conn.execute(
            "SELECT location FROM jobs WHERE url = ?",
            ("https://es.indeed.com/viewjob?jk=remote-spain",),
        ).fetchone()

        assert row["location"] == "Spain (Remote)"
    finally:
        close_connection(db_path)


def test_jobspy_missing_dependency_is_not_reported_as_empty_success(monkeypatch):
    def missing_jobspy(_kwargs: dict, max_retries: int = 2, backoff: float = 5.0):
        raise ImportError("The pinned jobstreaming dependency is not installed")

    monkeypatch.setattr(jobspy, "_scrape_with_retry", missing_jobspy)

    with pytest.raises(ImportError, match="pinned jobstreaming dependency"):
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
