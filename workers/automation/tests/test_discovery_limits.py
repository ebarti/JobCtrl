from __future__ import annotations

from types import SimpleNamespace

import pandas as pd
import pytest

from jobhunter.database import close_connection, init_db
from jobhunter.discovery import jobspy


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
        return pd.DataFrame(
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
            "SELECT event_type FROM job_events WHERE job_url = ? AND event_type = 'JobMetadataUpdated' LIMIT 1",
            ("https://www.linkedin.com/jobs/view/1",),
        ).fetchone()
        assert event["event_type"] == "JobMetadataUpdated"
    finally:
        close_connection(db_path)


def test_jobspy_store_limit_counts_new_jobs_not_existing_observations(tmp_path):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        existing = pd.DataFrame(
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

        mixed = pd.DataFrame(
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


def test_jobspy_learns_posting_owner_source_from_direct_ats_url(tmp_path):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        direct_url = "https://boards.greenhouse.io/acme/jobs/123456"
        frame = pd.DataFrame(
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
            WHERE job_url = ?
            """,
            ("https://www.linkedin.com/jobs/view/4416248661",),
        ).fetchone()
        assert observation["source_id"] == "jobspy:linkedin"
        assert observation["observed_url"] == "https://www.linkedin.com/jobs/view/4416248661"
        assert observation["run_id"] == "jobspy"

        identity = conn.execute(
            """
            SELECT canonical_url, ats_kind, source_native_id, confidence
            FROM job_canonical_identities
            WHERE job_url = ?
            """,
            ("https://www.linkedin.com/jobs/view/4416248661",),
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


def test_jobspy_deduplicates_learned_sources_for_same_owner(tmp_path):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        frame = pd.DataFrame(
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
        frame = pd.DataFrame(
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
        frame = pd.DataFrame(
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
            WHERE job_url = ?
            """,
            ("https://www.linkedin.com/jobs/view/12",),
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
        frame = pd.DataFrame(
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
        assert conn.execute("SELECT COUNT(*) FROM job_canonical_identities").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM source_locator_candidates").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM manual_capture_queue").fetchone()[0] == 0
    finally:
        close_connection(db_path)


def test_jobspy_rejects_same_content_location_variants(tmp_path):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    description = "Lead security engineering, compliance, identity, and platform risk. " * 8
    try:
        first = pd.DataFrame(
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

        duplicate = pd.DataFrame(
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
        assert link["surviving_job_id"] == "https://www.linkedin.com/jobs/view/4416248661"
        assert link["superseded_job_or_observation_id"] == "https://www.linkedin.com/jobs/view/4416235850"
        assert link["reason"] == "content_fingerprint_match"
        observation = conn.execute(
            "SELECT source_id FROM job_source_observations WHERE job_url = ?",
            ("https://www.linkedin.com/jobs/view/4416248661",),
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
        first = pd.DataFrame(
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

        duplicate = pd.DataFrame(
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


def test_jobspy_exact_rediscovery_keeps_deleted_content_duplicate_suppressed(tmp_path):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    description = "Own product platforms, billing, service delivery, and API lifecycle. " * 8
    survivor_url = "https://es.indeed.com/viewjob?jk=canonical"
    duplicate_url = "https://es.indeed.com/viewjob?jk=duplicate"
    try:
        first = pd.DataFrame(
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
                url, title, company, location, site, strategy, discovered_at,
                description, full_description, detail_scraped_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
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
            INSERT INTO jobhunter_deleted_jobs (job_url, deleted_at, reason, restored_at)
            VALUES (?, ?, ?, NULL)
            """,
            (duplicate_url, "2026-05-21T11:00:00+00:00", "content duplicate"),
        )
        conn.commit()

        rediscovered = pd.DataFrame(
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
            "SELECT restored_at FROM jobhunter_deleted_jobs WHERE job_url = ?",
            (duplicate_url,),
        ).fetchone()
        assert tombstone["restored_at"] is None
        link = conn.execute(
            "SELECT surviving_job_id, superseded_job_or_observation_id, reason FROM job_duplicate_links"
        ).fetchone()
        assert link["surviving_job_id"] == survivor_url
        assert link["superseded_job_or_observation_id"] == duplicate_url
        assert link["reason"] == "content_fingerprint_match"
    finally:
        close_connection(db_path)


def test_jobspy_normalizes_source_locations_before_storage(tmp_path):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        results = pd.DataFrame(
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
