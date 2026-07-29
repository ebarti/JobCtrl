from __future__ import annotations

from pathlib import Path

import pytest

from jobctrl import config
from jobctrl.database import close_connection, init_db
from jobctrl.discovery import smartextract
from jobctrl.domain.discovery import (
    AtsKind,
    DuplicateJobLink,
    Employer,
    Job,
    JobMetadata,
    PostingUrl,
    SearchStrategy,
    Source,
)
from jobctrl.domain.discovery.use_cases import DiscoverJobsUseCase
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.ports.discovery import ScrapedJobPosting
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.discovery import SqliteJobRepository
from jobctrl.infrastructure.discovery.production_wiring import DurableJobEventPublisher


def test_short_headless_html_never_retries_headful_in_the_bundled_core(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, object]] = []

    def collect(_url: str, **kwargs: object) -> dict[str, object]:
        calls.append(kwargs)
        return {
            "full_html": "<html>short</html>",
            "json_ld": [],
            "api_responses": [],
            "data_testids": [],
            "card_candidates": [],
        }

    monkeypatch.setattr(smartextract, "collect_page_intelligence", collect)
    monkeypatch.setattr(smartextract, "is_bundled_runtime", lambda: True)
    monkeypatch.setattr(smartextract, "clean_page_html", lambda _html: "short")
    monkeypatch.setattr(smartextract, "format_strategy_briefing", lambda _intel: "fixture")
    monkeypatch.setattr(smartextract, "ask_llm", lambda _prompt: ("fixture", 0.0, {"response_chars": 7}))
    monkeypatch.setattr(smartextract, "extract_json", lambda _raw: {"strategy": "unknown", "reasoning": "fixture"})

    result = smartextract._run_one_site("Fixture", "https://example.test/jobs")

    assert result["status"] == "FAIL"
    assert calls == [{}]


def test_short_headless_html_retries_headful_in_source_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, object]] = []

    def collect(_url: str, **kwargs: object) -> dict[str, object]:
        calls.append(kwargs)
        return {
            "full_html": "<html>short</html>",
            "json_ld": [],
            "api_responses": [],
            "data_testids": [],
            "card_candidates": [],
        }

    monkeypatch.setattr(smartextract, "collect_page_intelligence", collect)
    monkeypatch.setattr(smartextract, "is_bundled_runtime", lambda: False)
    monkeypatch.setattr(smartextract, "clean_page_html", lambda _html: "short")
    monkeypatch.setattr(smartextract, "format_strategy_briefing", lambda _intel: "fixture")
    monkeypatch.setattr(smartextract, "ask_llm", lambda _prompt: ("fixture", 0.0, {"response_chars": 7}))
    monkeypatch.setattr(smartextract, "extract_json", lambda _raw: {"strategy": "unknown", "reasoning": "fixture"})

    result = smartextract._run_one_site("Fixture", "https://example.test/jobs")

    assert result["status"] == "FAIL"
    assert calls == [{}, {"headless": False}]


def test_source_mode_propagates_a_failed_headful_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, object]] = []

    def collect(_url: str, **kwargs: object) -> dict[str, object]:
        calls.append(kwargs)
        if kwargs == {"headless": False}:
            raise RuntimeError("headed retry failed")
        return {
            "full_html": "<html>short</html>",
            "json_ld": [],
            "api_responses": [],
            "data_testids": [],
            "card_candidates": [],
        }

    monkeypatch.setattr(smartextract, "collect_page_intelligence", collect)
    monkeypatch.setattr(smartextract, "is_bundled_runtime", lambda: False)
    monkeypatch.setattr(smartextract, "clean_page_html", lambda _html: "short")

    with pytest.raises(RuntimeError, match="headed retry failed"):
        smartextract._run_one_site("Fixture", "https://example.test/jobs")

    assert calls == [{}, {"headless": False}]


def test_page_intelligence_rejects_headed_playwright_in_bundled_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(smartextract, "is_bundled_runtime", lambda: True)

    with pytest.raises(ValueError, match="headless Playwright only"):
        smartextract.collect_page_intelligence("https://example.test/jobs", headless=False)


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
    db_path = tmp_path / "jobctrl.db"
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
    db_path = tmp_path / "jobctrl.db"
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
    db_path = tmp_path / "jobctrl.db"
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
    db_path = tmp_path / "jobctrl.db"
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
    db_path = tmp_path / "jobctrl.db"
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
            CREATE TABLE IF NOT EXISTS jobctrl_deleted_jobs (
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
            INSERT INTO jobctrl_deleted_jobs (job_url, deleted_at, reason, restored_at)
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
            JOIN jobctrl_deleted_jobs d ON d.job_url = j.url
            WHERE j.url = ?
            """,
            (url,),
        ).fetchone()
        assert stored["description"] == "Lead engineering teams and own platform delivery."
        assert stored["restored_at"] is not None
    finally:
        close_connection(db_path)


def test_smart_extract_current_alias_refreshes_and_restores_storage_owner(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    monkeypatch.setattr(config, "DB_PATH", db_path)
    conn = init_db(db_path)
    try:
        repository = SqliteJobRepository(conn)
        stable_job_id = JobId("e02fc922-8320-4455-9f6b-ad839b9f7a8d")
        storage_url = "https://example.com/jobs/original"
        current_url = "https://example.com/jobs/current"
        original = Job.discover(
            tenant_id=LOCAL_TENANT,
            job_id=stable_job_id,
            posting_url=PostingUrl(value=storage_url),
            source=Source(board="Acme Careers"),
            employer=Employer(name="Acme"),
            search_strategy=SearchStrategy.MANUAL,
            metadata=JobMetadata(
                title="Engineering Director",
                description="Lead the engineering organization.",
                location="Remote",
            ),
            discovered_at="2026-05-20T00:00:00+00:00",
        )
        assert repository.save(original) == stable_job_id
        moved = Job.discover(
            tenant_id=LOCAL_TENANT,
            job_id=stable_job_id,
            posting_url=PostingUrl(value=current_url),
            source=original.source,
            employer=original.employer,
            search_strategy=original.search_strategy,
            metadata=original.metadata,
            discovered_at=original.discovered_at,
        )
        assert repository.save(moved) == stable_job_id
        repository.soft_delete(
            LOCAL_TENANT,
            stable_job_id,
            reason="temporarily hidden",
            deleted_at="2026-05-21T00:00:00+00:00",
        )

        assert smartextract._store_jobs_filtered(
            conn,
            [
                {
                    "url": current_url,
                    "title": "Head of Engineering",
                    "company": "Acme",
                    "location": "Barcelona, Spain",
                    "description": "Lead the engineering organization.",
                }
            ],
            "Acme Careers",
            "static",
            ["Barcelona, Spain", "Spain", "Europe", "EMEA"],
            ["United States", "Canada"],
            query="Head of Engineering",
            run_id="run-current-alias",
        ) == (0, 1)

        loaded = repository.load(LOCAL_TENANT, stable_job_id)
        assert loaded is not None
        assert loaded.posting_url == PostingUrl(value=current_url)
        assert loaded.metadata.title == "Head of Engineering"
        assert loaded.metadata.location == "Barcelona, Spain"
        assert loaded.is_deleted is False
        physical = conn.execute(
            "SELECT url FROM jobs WHERE job_id = ?",
            (str(stable_job_id),),
        ).fetchone()
        assert physical["url"] == storage_url
        tombstones = conn.execute("SELECT job_url, restored_at FROM jobctrl_deleted_jobs").fetchall()
        assert [(row["job_url"], row["restored_at"] is not None) for row in tombstones] == [(storage_url, True)]
        event_urls = {
            row["job_url"]
            for row in conn.execute(
                """
                SELECT job_url
                FROM job_events
                WHERE event_type IN ('JobMetadataUpdated', 'JobRestored')
                """
            ).fetchall()
        }
        assert event_urls == {storage_url}
        observation_urls = {
            row["job_url"]
            for row in conn.execute(
                """
                SELECT job_url
                FROM job_source_observations
                WHERE source_id = 'smartextract:Acme Careers'
                """
            ).fetchall()
        }
        assert observation_urls == {storage_url}
    finally:
        close_connection(db_path)


def test_smart_extract_refreshes_existing_title_location_before_restore(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobctrl.db"
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
            CREATE TABLE IF NOT EXISTS jobctrl_deleted_jobs (
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
            INSERT INTO jobctrl_deleted_jobs (job_url, deleted_at, reason, restored_at)
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
            JOIN jobctrl_deleted_jobs d ON d.job_url = j.url
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
    db_path = tmp_path / "jobctrl.db"
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
    db_path = tmp_path / "jobctrl.db"
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

        same_url_result = smartextract._store_jobs_filtered(
            conn,
            [
                {
                    "url": owner_url,
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
        assert same_url_result == (0, 1)
        assert conn.execute("SELECT COUNT(*) FROM job_duplicate_links").fetchone()[0] == 0

        owner_identity = repository.resolve_by_posting_url(
            LOCAL_TENANT,
            PostingUrl(value=owner_url),
        )
        assert owner_identity is not None
        domain_links: list[DuplicateJobLink] = []
        record_duplicate_link = SqliteJobRepository.record_duplicate_link

        def capture_duplicate_link(
            self: SqliteJobRepository,
            tenant_id: TenantId,
            link: DuplicateJobLink,
        ) -> None:
            domain_links.append(link)
            record_duplicate_link(self, tenant_id, link)

        monkeypatch.setattr(
            SqliteJobRepository,
            "record_duplicate_link",
            capture_duplicate_link,
        )
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
        assert len(domain_links) == 1
        assert domain_links[0].surviving_job_id == str(owner_identity.job_id)
        assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1
        link = conn.execute("SELECT surviving_job_id, reason, confidence FROM job_duplicate_links").fetchone()
        assert link["surviving_job_id"] == owner_url
        assert link["reason"] == "content_fingerprint_match"
        assert link["confidence"] == 0.95
        linked_events = conn.execute(
            "SELECT job_url FROM job_events WHERE event_type = 'DuplicateJobLinked'"
        ).fetchall()
        assert len(linked_events) == 1
        assert linked_events[0]["job_url"] == owner_url
        observations = repository.list_observations(LOCAL_TENANT, owner_url)
        assert "smartextract:Acme Careers" in {obs.source_id for obs in observations}
    finally:
        close_connection(db_path)


def test_ats_dedups_against_smart_extract_first_content_owner(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The reverse direction: a later ATS scrape must merge onto a Smart Extract owner."""
    db_path = tmp_path / "jobctrl.db"
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
        link = conn.execute("SELECT surviving_job_id, reason FROM job_duplicate_links").fetchone()
        assert link["surviving_job_id"] == smart_url
        assert link["reason"] == "content_fingerprint_match"
    finally:
        close_connection(db_path)


def test_smart_extract_keeps_distinct_roles_at_same_employer_separate(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Distinct roles at one employer must not merge through the Smart Extract route.

    The content-owner lookup gates on normalized title AND employer, so two
    genuinely different roles stay separate even when their descriptions are
    near-identical (well above the 0.83 shingle threshold): the title gate must
    short-circuit before any description match. If it did not, the shared
    description would fingerprint- or shingle-match and wrongly collapse the two
    roles into one aggregate. Regression guard for the direct-SQL skip-insert path.
    """
    db_path = tmp_path / "jobctrl.db"
    monkeypatch.setattr(config, "DB_PATH", db_path)
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
                _ats_posting(
                    canonical_url=owner_url,
                    description=shared_description,
                    title="Staff Platform Engineer",
                )
            ],
            run_id="run-ats",
        )
        assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1

        result = smartextract._store_jobs_filtered(
            conn,
            [
                {
                    "url": "https://careers.acme.com/staff-data-scientist",
                    "title": "Staff Data Scientist",
                    "company": "Acme",
                    "location": "Barcelona, Spain",
                    "description": shared_description,
                }
            ],
            "Acme Careers",
            "static",
            ["Barcelona, Spain", "Spain", "Europe", "EMEA"],
            ["United States", "Canada"],
            query="Staff Data Scientist",
        )

        assert result == (1, 0)
        assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 2
        assert conn.execute("SELECT COUNT(*) FROM job_duplicate_links").fetchone()[0] == 0
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
