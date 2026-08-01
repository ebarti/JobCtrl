from __future__ import annotations

import json
import sqlite3
import sys
from io import StringIO
from pathlib import Path
from typing import Any, Iterator

import pytest

from jobctrl import config
from jobctrl.discovery import manual_capture_import as manual_capture_import_cli
from jobctrl.database import close_connection, get_jobs_by_stage, init_db
from jobctrl.domain.discovery import (
    AtsKind,
    JobMetadata,
    PostingUrl,
    SearchStrategy,
    Source,
)
from jobctrl.domain.discovery.scheduler import DiscoveryScheduler
from jobctrl.domain.discovery.source_registry import (
    SourceKind,
    SourcePriority,
    SourceRegistryEntry,
    SourceState,
    WORKDAY_API_POLICY,
)
from jobctrl.domain.identifiers import generate_job_id
from jobctrl.domain.ports.discovery import ScrapedJobPosting
from jobctrl.enrichment.detail import _record_posting_snapshot_from_cascade
from jobctrl.infrastructure.discovery.production_wiring import (
    ManualCaptureImport,
    _posting_acceptance_policy,
    build_discovery_acceptance_report,
    import_manual_capture_item,
    retire_invalid_canonical_ats_jobs,
    retire_invalid_source_jobs,
    run_deterministic_source_locator,
    run_scheduled_ats_sources,
    seed_discovery_control_queues,
    seed_source_registry_controls,
)
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
from jobctrl.pipeline import runner
from jobctrl.state import record_job_event


def _insert_v7_job(
    conn: sqlite3.Connection,
    *,
    url: str,
    title: str,
    company: str,
    description: str,
    location: str,
    site: str,
    strategy: str,
    discovered_at: str,
) -> str:
    job_id = str(generate_job_id())
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, company, description, location,
            site, strategy, discovered_at
        ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (job_id, url, title, company, description, location, site, strategy, discovered_at),
    )
    conn.execute(
        """
        INSERT INTO job_locators (
            tenant_id, job_id, locator_kind, locator_value, is_current,
            first_seen_at, last_seen_at, retired_at
        ) VALUES ('local', ?, 'posting_url', ?, 1, ?, ?, NULL)
        """,
        (job_id, url, discovered_at, discovered_at),
    )
    return job_id


def _insert_source_observation(
    conn: sqlite3.Connection,
    *,
    observation_id: str,
    job_id: str,
    source_id: str,
    source_native_id: str,
    url: str,
    observed_at: str,
) -> None:
    conn.execute(
        """
        INSERT INTO job_source_observations (
            tenant_id, source_observation_id, job_id, source_id,
            source_native_id, observed_url, normalized_observed_url,
            run_id, observed_at
        ) VALUES ('local', ?, ?, ?, ?, ?, ?, 'test', ?)
        """,
        (observation_id, job_id, source_id, source_native_id, url, url, observed_at),
    )


def _deleted_reasons_by_url(conn: sqlite3.Connection) -> dict[str, str]:
    return {
        str(row["url"]): str(row["reason"])
        for row in conn.execute(
            """
            SELECT jobs.url, jobctrl_deleted_jobs.reason
            FROM jobctrl_deleted_jobs
            JOIN jobs
              ON jobs.tenant_id = jobctrl_deleted_jobs.tenant_id
             AND jobs.job_id = jobctrl_deleted_jobs.job_id
            """
        ).fetchall()
    }


@pytest.fixture
def conn(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[sqlite3.Connection]:
    db_path = tmp_path / "jobctrl.db"
    monkeypatch.setattr(config, "DB_PATH", db_path)
    connection = init_db(db_path)
    yield connection
    close_connection(db_path)


def _barcelona_registry():
    return config.load_source_registry(
        search_cfg={"boards": []},
        employers_cfg={"employers": {}},
        sites_cfg={
            "sources": [
                {
                    "id": "greenhouse:barcelona-tech",
                    "kind": "ats_api",
                    "display_name": "Barcelona Tech Greenhouse",
                    "priority": "canonical",
                    "seed_url": (
                        "https://boards-api.greenhouse.io/v1/boards/"
                        "barcelonatech/jobs"
                    ),
                    "board_token": "barcelonatech",
                    "ats_kind": "greenhouse",
                    "company": "Barcelona Tech",
                },
                {
                    "id": "lever:leadershipco",
                    "kind": "ats_api",
                    "display_name": "LeadershipCo Lever",
                    "priority": "canonical",
                    "seed_url": "https://api.lever.co/v0/postings/leadershipco",
                    "site": "leadershipco",
                    "ats_kind": "lever",
                    "company": "LeadershipCo",
                },
                {
                    "id": "ashby:platformops",
                    "kind": "ats_api",
                    "display_name": "PlatformOps Ashby",
                    "priority": "canonical",
                    "seed_url": (
                        "https://api.ashbyhq.com/posting-api/job-board/"
                        "platformops"
                    ),
                    "board_name": "platformops",
                    "ats_kind": "ashby",
                    "company": "PlatformOps",
                },
                {
                    "id": "manual:protected-board",
                    "kind": "employer_careers_page",
                    "display_name": "Protected Careers",
                    "priority": "standard",
                    "seed_url": "https://login.protected.example/jobs",
                },
            ],
            "sites": [],
        },
    )


def _search_cfg() -> dict[str, Any]:
    return {
        "queries": [
            {"query": "Engineering", "tier": 1},
            {"query": "Head", "tier": 1},
        ],
        "locations": [{"location": "Spain"}],
    }


def test_workday_locator_candidate_uses_packaged_source_id(conn: sqlite3.Connection) -> None:
    canonical = SourceRegistryEntry(
        tenant_id=config.LOCAL_TENANT,
        source_id="workday:acme",
        kind=SourceKind.ATS_API,
        display_name="Acme",
        owner="system",
        priority=SourcePriority.CANONICAL,
        state=SourceState.ACTIVE,
        policy=WORKDAY_API_POLICY,
        adapter_config={
            "employer_key": "acme",
            "tenant": "acme",
            "site_id": "External",
            "base_url": "https://acme.wd3.myworkdayjobs.com",
        },
    )
    host_alias = SourceRegistryEntry(
        tenant_id=config.LOCAL_TENANT,
        source_id="workday:acme-wd3-myworkdayjobs-com",
        kind=SourceKind.ATS_API,
        display_name="acme.wd3.myworkdayjobs.com",
        owner="user",
        priority=SourcePriority.CANONICAL,
        state=SourceState.ACTIVE,
        policy=WORKDAY_API_POLICY,
        adapter_config={"base_url": "https://acme.wd3.myworkdayjobs.com"},
    )

    seed_source_registry_controls(conn, (canonical,))
    run_deterministic_source_locator(conn, (host_alias,))

    rows = conn.execute(
        """
        SELECT source_id
        FROM source_registry_entries
        WHERE source_id LIKE 'workday:acme%'
        ORDER BY source_id
        """
    ).fetchall()
    assert [str(row["source_id"]) for row in rows] == ["workday:acme"]


def _fake_ats_http(url: str, **_kwargs: Any) -> Any:
    if "greenhouse" in url:
        return {
            "jobs": [
                {
                    "id": 101,
                    "title": "Director of Engineering",
                    "absolute_url": (
                        "https://boards.greenhouse.io/barcelonatech/jobs/101"
                    ),
                    "location": {"name": "Barcelona, Spain"},
                    "company_name": "Barcelona Tech",
                    "content": "<p>Lead engineering delivery for Barcelona teams.</p>",
                }
            ]
        }
    if "lever" in url:
        return [
            {
                "id": "lever-202",
                "text": "Head of Platform",
                "hostedUrl": "https://jobs.lever.co/leadershipco/202",
                "categories": {"location": "Spain"},
                "description": "<p>Own platform strategy for Spain.</p>",
            }
        ]
    if "ashby" in url:
        return {
            "jobs": [
                {
                    "id": "ashby-303",
                    "title": "Engineering Manager",
                    "jobUrl": "https://jobs.ashbyhq.com/platformops/303",
                    "location": "Barcelona, Spain",
                    "descriptionHtml": "<p>Manage engineering teams in Barcelona.</p>",
                }
            ]
        }
    return {}


def _fake_ats_http_with_lever_failure(url: str, **kwargs: Any) -> Any:
    if "lever" in url:
        raise TimeoutError("lever unavailable")
    return _fake_ats_http(url, **kwargs)


def test_posting_acceptance_policy_uses_title_location_evidence_for_remote_roles() -> None:
    policy = _posting_acceptance_policy(
        {
            "queries": [{"query": "Software Engineer", "tier": 1}],
            "locations": [{"location": "Remote"}],
            "location_accept": ["Remote", "Spain", "European Union", "EU", "EMEA"],
            "location_reject_non_remote": ["India", "Poland", "United States"],
            "ats_max_tier": 1,
        }
    )

    rejected = policy(
        ScrapedJobPosting(
            posting_url=PostingUrl(value="https://jobs.ashbyhq.com/acai/india"),
            source=Source(board="ashby"),
            metadata=JobMetadata(
                title="Senior Software Engineer (India)",
                description="Build distributed systems.",
                location="Remote",
            ),
            strategy=SearchStrategy.WORKDAY_API,
            source_id="ashby:acai",
            source_native_id="india",
            canonical_url="https://jobs.ashbyhq.com/acai/india",
            ats_kind=AtsKind.ASHBY,
        )
    )
    accepted = policy(
        ScrapedJobPosting(
            posting_url=PostingUrl(value="https://jobs.ashbyhq.com/acai/spain"),
            source=Source(board="ashby"),
            metadata=JobMetadata(
                title="Senior Software Engineer",
                description="Build distributed systems.",
                location="Spain (Remote)",
            ),
            strategy=SearchStrategy.WORKDAY_API,
            source_id="ashby:acai",
            source_native_id="spain",
            canonical_url="https://jobs.ashbyhq.com/acai/spain",
            ats_kind=AtsKind.ASHBY,
        )
    )

    assert rejected.accepted is False
    assert "location_mismatch" in rejected.rejection_reasons
    assert accepted.accepted is True


def _manual_capture_html() -> str:
    description = (
        "Lead engineering teams building job search infrastructure with Python, "
        "TypeScript, observability, product strategy, hiring systems, and "
        "local-first automation. " * 5
    )
    return f"""
    <html>
      <head>
        <script type="application/ld+json">
        {{
          "@type": "JobPosting",
          "title": "VP Engineering",
          "description": "{description}",
          "directApply": true,
          "url": "https://login.protected.example/jobs/vp-engineering",
          "validThrough": "2999-01-01T00:00:00+00:00",
          "jobLocation": {{
            "address": {{
              "addressLocality": "Barcelona",
              "addressCountry": "Spain"
            }}
          }}
        }}
        </script>
      </head>
      <body><main>{description}</main></body>
    </html>
    """


def test_worker_seeds_api_visible_locator_and_manual_queues(
    conn: sqlite3.Connection,
) -> None:
    summary = seed_discovery_control_queues(conn, _barcelona_registry())

    assert summary.registry_rows >= 4
    assert summary.locator_candidates >= 4
    assert summary.manual_action_count == 1
    parseable_candidate_count = conn.execute(
        """
        SELECT COUNT(*)
        FROM source_locator_candidates
        WHERE detected_ats_kind IS NOT NULL
        """
    ).fetchone()[0]
    assert parseable_candidate_count == 0
    active_source_count = conn.execute(
        """
        SELECT COUNT(*)
        FROM source_registry_entries
        WHERE source_id IN (
          'greenhouse:barcelona-tech',
          'lever:leadershipco',
          'ashby:platformops'
        )
          AND state = 'active'
        """
    ).fetchone()[0]
    assert active_source_count == 3
    manual_row = conn.execute(
        """
        SELECT originating_url, source_id, reason, retry_context_json
        FROM manual_capture_queue
        WHERE source_id = ?
        """,
        ("manual:protected-board",),
    ).fetchone()
    assert manual_row is not None
    assert manual_row["reason"] == "protected_internal_site"
    assert "configured_seed" in manual_row["retry_context_json"]


def test_worker_auto_approves_parseable_sources_from_broad_board_observations(
    conn: sqlite3.Connection,
) -> None:
    url = "https://boards.greenhouse.io/acme/jobs/123"
    job_id = _insert_v7_job(
        conn,
        url=url,
        title="Engineering Manager",
        company="Acme",
        description="Lead engineering teams.",
        location="Barcelona, Spain",
        site="linkedin",
        strategy="jobspy",
        discovered_at="2026-05-12T10:00:00+00:00",
    )
    _insert_source_observation(
        conn,
        observation_id="obs-1",
        job_id=job_id,
        source_id="jobspy:linkedin",
        source_native_id="123",
        url=url,
        observed_at="2026-05-12T10:00:00+00:00",
    )
    conn.commit()

    summary = seed_discovery_control_queues(conn, ())

    assert summary.locator_candidates == 1
    source_row = conn.execute(
        """
        SELECT source_id, kind, state, priority, policy_id, seed_url
        FROM source_registry_entries
        WHERE source_id = ?
        """,
        ("greenhouse:acme",),
    ).fetchone()
    assert dict(source_row) == {
        "source_id": "greenhouse:acme",
        "kind": "ats_api",
        "state": "active",
        "priority": "canonical",
        "policy_id": "ats_api_canonical",
        "seed_url": "https://boards.greenhouse.io/acme/jobs/123",
    }
    pending_candidates = conn.execute(
        "SELECT COUNT(*) FROM source_locator_candidates"
    ).fetchone()[0]
    assert pending_candidates == 0


def test_worker_queue_seeding_preserves_dismissed_manual_actions(
    conn: sqlite3.Connection,
) -> None:
    registry = _barcelona_registry()
    seed_discovery_control_queues(conn, registry)
    item_id = conn.execute(
        """
        SELECT item_id FROM manual_capture_queue
        WHERE source_id = ?
        """,
        ("manual:protected-board",),
    ).fetchone()["item_id"]
    conn.execute(
        """
        UPDATE manual_capture_queue
        SET status = 'dismissed',
            dismissed_at = ?,
            retry_context_json = ?
        WHERE item_id = ?
        """,
        (
            "2026-05-12T10:00:00+00:00",
            json.dumps(
                {
                    "dismissal_source": "api",
                    "manual_capture_provenance": {
                        "source_kind": "user_mediated_capture",
                        "captured_at": "2026-05-12T09:30:00+00:00",
                    },
                },
                sort_keys=True,
            ),
            item_id,
        ),
    )
    conn.commit()

    seed_discovery_control_queues(conn, registry)

    manual_row = conn.execute(
        """
        SELECT status, dismissed_at
        FROM manual_capture_queue
        WHERE item_id = ?
        """,
        (item_id,),
    ).fetchone()
    assert tuple(manual_row) == ("dismissed", "2026-05-12T10:00:00+00:00")
    retry_context = json.loads(
        conn.execute(
            """
            SELECT retry_context_json
            FROM manual_capture_queue
            WHERE item_id = ?
            """,
            (item_id,),
        ).fetchone()["retry_context_json"]
    )
    assert retry_context["manual_capture_provenance"]["source_kind"] == (
        "user_mediated_capture"
    )


def test_canonical_ats_scheduler_routes_postings_through_discovery_use_case(
    conn: sqlite3.Connection,
) -> None:
    registry = _barcelona_registry()
    schedule = DiscoveryScheduler().plan(registry=registry)
    ats_sources = schedule.for_kinds(SourceKind.ATS_API)

    result = run_scheduled_ats_sources(
        conn,
        ats_sources,
        search_cfg=_search_cfg(),
        run_id="acceptance:ats",
        http=_fake_ats_http,
    )

    assert result["new_jobs"] == 3
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 3
    assert (
        conn.execute("SELECT COUNT(*) FROM job_source_observations").fetchone()[0]
        == 3
    )
    ats_kinds = {
        row["ats_kind"]
        for row in conn.execute(
            "SELECT ats_kind FROM job_canonical_identities"
        ).fetchall()
    }
    assert ats_kinds == {"greenhouse", "lever", "ashby"}
    expected_urls = {
        "https://boards.greenhouse.io/barcelonatech/jobs/101",
        "https://jobs.lever.co/leadershipco/202",
        "https://jobs.ashbyhq.com/platformops/303",
    }
    enrichments = conn.execute(
        """
        SELECT jobs.url, job_enrichments.current_status,
               job_enrichments.full_description, job_enrichments.extraction_tier
        FROM job_enrichments
        JOIN jobs
          ON jobs.tenant_id = job_enrichments.tenant_id
         AND jobs.job_id = job_enrichments.job_id
        """
    ).fetchall()
    assert {row["url"] for row in enrichments} == expected_urls
    assert {row["current_status"] for row in enrichments} == {"enriched"}
    assert {row["extraction_tier"] for row in enrichments} == {"css_selectors"}
    assert all(str(row["full_description"] or "").strip() for row in enrichments)
    stage_rows = conn.execute(
        """
        SELECT jobs.url, job_stage_states.state
        FROM job_stage_states
        JOIN jobs
          ON jobs.tenant_id = job_stage_states.tenant_id
         AND jobs.job_id = job_stage_states.job_id
        WHERE job_stage_states.stage = 'enrich'
        """
    ).fetchall()
    assert {row["url"] for row in stage_rows} == expected_urls
    assert {row["state"] for row in stage_rows} == {"succeeded"}
    assert {
        row["url"] for row in get_jobs_by_stage(conn, "pending_score", limit=0)
    } == expected_urls


def test_canonical_ats_scheduler_fetches_each_source_once_then_filters_queries(
    conn: sqlite3.Connection,
) -> None:
    registry = _barcelona_registry()
    schedule = DiscoveryScheduler().plan(registry=registry)
    ats_sources = schedule.for_kinds(SourceKind.ATS_API)
    calls: list[str] = []

    def http(url: str, **kwargs: Any) -> Any:
        calls.append(url)
        return _fake_ats_http(url, **kwargs)

    result = run_scheduled_ats_sources(
        conn,
        ats_sources,
        search_cfg={
            "queries": [
                {"query": "Engineering", "tier": 1},
                {
                    "query": "platform director",
                    "tier": 1,
                    "match_mode": "recall",
                    "generated_from": "target_roles",
                },
            ],
            "locations": [{"location": "Spain"}],
            "ats_max_tier": 1,
        },
        run_id="acceptance:ats",
        http=http,
    )

    assert result["new_jobs"] == 3
    assert len(calls) == 3
    assert "https://boards-api.greenhouse.io/v1/boards/barcelonatech/jobs?content=true" in calls


def test_canonical_ats_scheduler_rejects_empty_descriptions(
    conn: sqlite3.Connection,
) -> None:
    registry = _barcelona_registry()
    schedule = DiscoveryScheduler().plan(registry=registry)
    ats_sources = schedule.for_kinds(SourceKind.ATS_API)

    def http(url: str, **_kwargs: Any) -> Any:
        if "greenhouse" in url:
            return {
                "jobs": [
                    {
                        "id": 101,
                        "title": "Director of Engineering",
                        "absolute_url": "https://boards.greenhouse.io/barcelonatech/jobs/101",
                        "location": {"name": "Barcelona, Spain"},
                        "company_name": "Barcelona Tech",
                    }
                ]
            }
        return _fake_ats_http(url)

    result = run_scheduled_ats_sources(
        conn,
        ats_sources,
        search_cfg=_search_cfg(),
        run_id="acceptance:ats",
        http=http,
    )

    assert result["new_jobs"] == 2
    row = conn.execute(
        "SELECT 1 FROM jobs WHERE url = ?",
        ("https://boards.greenhouse.io/barcelonatech/jobs/101",),
    ).fetchone()
    assert row is None


def test_discovery_hygiene_retires_existing_invalid_canonical_ats_rows(
    conn: sqlite3.Connection,
) -> None:
    rows = [
        (
            "https://boards.greenhouse.io/acme/jobs/valid",
            "Director of Engineering",
            "Barcelona, Spain",
            "Lead engineering teams in Barcelona.",
        ),
        (
            "https://boards.greenhouse.io/acme/jobs/empty-description",
            "Director of Engineering",
            "Barcelona, Spain",
            "",
        ),
        (
            "https://boards.greenhouse.io/acme/jobs/sales",
            "Sales Director",
            "Work from Home - Spain",
            "Lead enterprise sales teams.",
        ),
        (
            "https://boards.greenhouse.io/acme/jobs/india",
            "Engineering Manager",
            "India, Remote",
            "Lead engineering teams.",
        ),
    ]
    for index, (url, title, location, description) in enumerate(rows):
        job_id = _insert_v7_job(
            conn,
            url=url,
            title=title,
            company="Acme",
            description=description,
            location=location,
            site="Acme",
            strategy="workday_api",
            discovered_at="2026-05-20T00:00:00+00:00",
        )
        conn.execute(
            """
            INSERT INTO job_canonical_identities (
                tenant_id, job_id, canonical_url, ats_kind, source_native_id, confidence, resolved_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            ("local", job_id, url, "greenhouse", f"gh-{index}", 1.0, "2026-05-20T00:00:00+00:00"),
        )
        _insert_source_observation(
            conn,
            observation_id=f"obs-{index}",
            job_id=job_id,
            source_id="greenhouse:acme",
            source_native_id=f"gh-{index}",
            url=url,
            observed_at="2026-05-20T00:00:00+00:00",
        )
    conn.commit()

    result = retire_invalid_canonical_ats_jobs(
        conn,
        search_cfg=_search_cfg(),
        run_id="hygiene:test",
    )

    assert result["retired_jobs"] == 3
    deleted = _deleted_reasons_by_url(conn)
    assert "https://boards.greenhouse.io/acme/jobs/valid" not in deleted
    assert "missing_description" in deleted["https://boards.greenhouse.io/acme/jobs/empty-description"]
    assert "title_mismatch" in deleted["https://boards.greenhouse.io/acme/jobs/sales"]
    assert "location_mismatch" in deleted["https://boards.greenhouse.io/acme/jobs/india"]
    event_count = conn.execute(
        "SELECT COUNT(*) FROM job_events WHERE event_type = 'JobDeleted'"
    ).fetchone()[0]
    assert event_count == 3


def test_discovery_hygiene_retires_ashby_business_travel_portugal_rows(
    conn: sqlite3.Connection,
) -> None:
    bad_url = "https://jobs.ashbyhq.com/Perk/ad419744-c6e3-4cb6-94bf-8c6eb5e645c0"
    good_url = "https://jobs.ashbyhq.com/PlatformOps/engineering-manager"
    rows = [
        (
            bad_url,
            "Senior Business Travel Consultant - Spanish speaking - Remote",
            "Portugal (Remote)",
            "Deliver VIP business travel service for executives.",
            "perk-travel",
        ),
        (
            good_url,
            "Engineering Manager",
            "Barcelona, Spain (Remote)",
            "Lead engineering teams in Barcelona.",
            "platform-eng",
        ),
    ]
    for url, title, location, description, native_id in rows:
        job_id = _insert_v7_job(
            conn,
            url=url,
            title=title,
            company="Perk",
            description=description,
            location=location,
            site="jobs.ashbyhq.com",
            strategy="workday_api",
            discovered_at="2026-05-25T21:35:55+00:00",
        )
        conn.execute(
            """
            INSERT INTO job_canonical_identities (
                tenant_id, job_id, canonical_url, ats_kind, source_native_id, confidence, resolved_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            ("local", job_id, url, "ashby", native_id, 0.9, "2026-05-25T21:35:55+00:00"),
        )
        _insert_source_observation(
            conn,
            observation_id=f"obs-{native_id}",
            job_id=job_id,
            source_id="ashby:perk",
            source_native_id=native_id,
            url=url,
            observed_at="2026-05-25T21:35:55+00:00",
        )
    conn.commit()

    result = retire_invalid_source_jobs(
        conn,
        search_cfg={
            "queries": [
                {
                    "query": "Engineering Manager",
                    "tier": 1,
                    "match_mode": "recall",
                    "generated_from": "target_roles",
                }
            ],
            "locations": [{"location": "Spain"}, {"location": "European Union"}],
            "location_accept": ["Spain", "European Union", "EU", "EMEA"],
            "location_reject_non_remote": ["United States", "USA", "US only"],
            "ats_max_tier": 1,
        },
        run_id="hygiene:ashby-perk",
    )

    assert result["retired_jobs"] == 1
    deleted = _deleted_reasons_by_url(conn)
    assert good_url not in deleted
    assert "title_mismatch" in deleted[bad_url]
    assert "location_mismatch" in deleted[bad_url]


def test_discovery_hygiene_retires_invalid_jobspy_rows(
    conn: sqlite3.Connection,
) -> None:
    rows = [
        (
            "https://www.linkedin.com/jobs/view/valid-head-engineering",
            "Head of Engineering",
            "Barcelona, Spain",
            "Lead engineering teams in Barcelona.",
            "jobspy:linkedin",
        ),
        (
            "https://www.linkedin.com/jobs/view/head-school-biomedical",
            "Head of School - School of Biomedical Engineering",
            "Barcelona, Spain",
            "Lead an academic biomedical engineering school.",
            "jobspy:linkedin",
        ),
        (
            "https://www.linkedin.com/jobs/view/us-engineering-manager",
            "Engineering Manager",
            "United States (Remote)",
            "Lead engineering teams.",
            "jobspy:linkedin",
        ),
    ]
    for index, (url, title, location, description, source_id) in enumerate(rows):
        job_id = _insert_v7_job(
            conn,
            url=url,
            title=title,
            company="LinkedInCo",
            description=description,
            location=location,
            site="linkedin",
            strategy="jobspy",
            discovered_at="2026-05-20T00:00:00+00:00",
        )
        _insert_source_observation(
            conn,
            observation_id=f"jobspy-obs-{index}",
            job_id=job_id,
            source_id=source_id,
            source_native_id=f"li-{index}",
            url=url,
            observed_at="2026-05-20T00:00:00+00:00",
        )
    conn.commit()

    result = retire_invalid_source_jobs(
        conn,
        search_cfg={
            "queries": [
                {"query": "Head of Engineering", "tier": 1},
                {
                    "query": "engineering manager",
                    "tier": 1,
                    "match_mode": "recall",
                    "generated_from": "target_roles",
                },
            ],
            "locations": [{"location": "Spain"}],
            "location_accept": ["Spain", "Barcelona, Spain"],
            "location_reject_non_remote": ["United States", "USA", "US only"],
        },
        run_id="hygiene:jobspy",
    )

    assert result["retired_jobs"] == 2
    deleted = _deleted_reasons_by_url(conn)
    assert "https://www.linkedin.com/jobs/view/valid-head-engineering" not in deleted
    assert "title_mismatch" in deleted["https://www.linkedin.com/jobs/view/head-school-biomedical"]
    assert "location_mismatch" in deleted["https://www.linkedin.com/jobs/view/us-engineering-manager"]


def test_discovery_hygiene_treats_serialized_null_descriptions_as_missing(
    conn: sqlite3.Connection,
) -> None:
    rows = [
        (
            "https://www.linkedin.com/jobs/view/valid-head-engineering",
            "Head of Engineering",
            "Barcelona, Spain",
            "Lead engineering teams in Barcelona.",
        ),
        (
            "https://www.linkedin.com/jobs/view/none-description",
            "Head of Engineering",
            "Barcelona, Spain",
            "None",
        ),
        (
            "https://www.linkedin.com/jobs/view/pandas-na-description",
            "Head of Engineering",
            "Barcelona, Spain",
            "<NA>",
        ),
        (
            "https://www.linkedin.com/jobs/view/nan-description",
            "Head of Engineering",
            "Barcelona, Spain",
            "nan",
        ),
        (
            "https://www.linkedin.com/jobs/view/enrichment-sentinel-with-fallback",
            "Head of Engineering",
            "Barcelona, Spain",
            "Lead engineering teams in Barcelona.",
        ),
    ]
    job_ids_by_url: dict[str, str] = {}
    for index, (url, title, location, description) in enumerate(rows):
        job_id = _insert_v7_job(
            conn,
            url=url,
            title=title,
            company="LinkedInCo",
            description=description,
            location=location,
            site="linkedin",
            strategy="jobspy",
            discovered_at="2026-05-20T00:00:00+00:00",
        )
        job_ids_by_url[url] = job_id
        _insert_source_observation(
            conn,
            observation_id=f"jobspy-sentinel-obs-{index}",
            job_id=job_id,
            source_id="jobspy:linkedin",
            source_native_id=f"li-sentinel-{index}",
            url=url,
            observed_at="2026-05-20T00:00:00+00:00",
        )
    conn.execute(
        """
        INSERT INTO job_enrichments (
            job_id, tenant_id, current_status, full_description, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        """,
        (
            job_ids_by_url[
                "https://www.linkedin.com/jobs/view/enrichment-sentinel-with-fallback"
            ],
            "local",
            "success",
            "<NA>",
            "2026-05-20T00:00:00+00:00",
        ),
    )
    conn.commit()

    result = retire_invalid_source_jobs(
        conn,
        search_cfg={
            "queries": [{"query": "Head of Engineering", "tier": 1}],
            "locations": [{"location": "Spain"}],
            "location_accept": ["Spain", "Barcelona, Spain"],
        },
        run_id="hygiene:serialized-null",
    )

    assert result["retired_jobs"] == 3
    deleted = _deleted_reasons_by_url(conn)
    assert "https://www.linkedin.com/jobs/view/valid-head-engineering" not in deleted
    assert (
        "https://www.linkedin.com/jobs/view/enrichment-sentinel-with-fallback"
        not in deleted
    )
    assert "missing_description" in deleted[
        "https://www.linkedin.com/jobs/view/none-description"
    ]
    assert "missing_description" in deleted[
        "https://www.linkedin.com/jobs/view/pandas-na-description"
    ]
    assert "missing_description" in deleted[
        "https://www.linkedin.com/jobs/view/nan-description"
    ]


def test_discovery_hygiene_applies_to_workday_and_smart_extract_rows(
    conn: sqlite3.Connection,
) -> None:
    rows = [
        (
            "https://acme.wd1.myworkdayjobs.com/jobs/valid-engineering-manager",
            "Engineering Manager",
            "Madrid, Spain",
            "Lead engineering teams in Spain.",
            "Acme",
            "workday_api",
            "workday:acme",
        ),
        (
            "https://acme.wd1.myworkdayjobs.com/jobs/customer-success",
            "Customer Success Manager",
            "Madrid, Spain",
            "Lead customer success teams.",
            "Acme",
            "workday_api",
            "workday:acme",
        ),
        (
            "https://wellfound.com/jobs/valid-head-engineering",
            "Head of Engineering",
            "Spain",
            "Lead engineering teams at a startup.",
            "Wellfound",
            "api_response",
            "smart_extract:wellfound",
        ),
        (
            "https://wellfound.com/jobs/us-head-engineering",
            "Head of Engineering",
            "United States (Remote)",
            "Lead engineering teams at a startup.",
            "Wellfound",
            "smart_extract",
            "smart_extract:wellfound",
        ),
        (
            "https://wellfound.com/jobs/missing-description",
            "Head of Engineering",
            "Spain",
            "",
            "Wellfound",
            "static",
            "smart_extract:wellfound",
        ),
    ]
    for index, (url, title, location, description, site, strategy, source_id) in enumerate(rows):
        job_id = _insert_v7_job(
            conn,
            url=url,
            title=title,
            company=site,
            description=description,
            location=location,
            site=site,
            strategy=strategy,
            discovered_at="2026-05-20T00:00:00+00:00",
        )
        _insert_source_observation(
            conn,
            observation_id=f"source-family-obs-{index}",
            job_id=job_id,
            source_id=source_id,
            source_native_id=f"native-{index}",
            url=url,
            observed_at="2026-05-20T00:00:00+00:00",
        )
    conn.commit()

    result = retire_invalid_source_jobs(
        conn,
        search_cfg={
            "queries": [
                {"query": "Head of Engineering", "tier": 1},
                {"query": "Engineering Manager", "tier": 1},
            ],
            "locations": [{"location": "Spain"}],
            "location_accept": ["Spain", "Madrid, Spain"],
            "location_reject_non_remote": ["United States", "USA", "US only"],
        },
        run_id="hygiene:families",
    )

    assert result["retired_jobs"] == 3
    deleted = _deleted_reasons_by_url(conn)
    assert "https://acme.wd1.myworkdayjobs.com/jobs/valid-engineering-manager" not in deleted
    assert "https://wellfound.com/jobs/valid-head-engineering" not in deleted
    assert "title_mismatch" in deleted["https://acme.wd1.myworkdayjobs.com/jobs/customer-success"]
    assert "location_mismatch" in deleted["https://wellfound.com/jobs/us-head-engineering"]
    assert "missing_description" in deleted["https://wellfound.com/jobs/missing-description"]


def test_canonical_ats_limit_counts_new_jobs_not_existing_observations(
    conn: sqlite3.Connection,
) -> None:
    registry = _barcelona_registry()
    schedule = DiscoveryScheduler().plan(registry=registry)
    ats_sources = schedule.for_kinds(SourceKind.ATS_API)
    first_source = ats_sources[:1]

    initial = run_scheduled_ats_sources(
        conn,
        first_source,
        search_cfg=_search_cfg(),
        run_id="acceptance:ats:initial",
        http=_fake_ats_http,
        limit=1,
    )
    assert initial["new_jobs"] == 1

    limited = run_scheduled_ats_sources(
        conn,
        ats_sources,
        search_cfg=_search_cfg(),
        run_id="acceptance:ats:limited",
        http=_fake_ats_http,
        limit=1,
    )

    assert limited["new_jobs"] == 1
    assert limited["observed_jobs"] >= 1
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 2


def test_canonical_ats_scheduler_preserves_successes_when_one_source_fails(
    conn: sqlite3.Connection,
) -> None:
    registry = _barcelona_registry()
    schedule = DiscoveryScheduler().plan(registry=registry)
    ats_sources = schedule.for_kinds(SourceKind.ATS_API)

    result = run_scheduled_ats_sources(
        conn,
        ats_sources,
        search_cfg=_search_cfg(),
        run_id="acceptance:ats",
        http=_fake_ats_http_with_lever_failure,
    )

    assert result["new_jobs"] == 2
    assert result["failed_sources"] == ["lever:leadershipco"]
    assert result["failed_source_ids"] == ["lever:leadershipco"]
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 2
    assert (
        conn.execute("SELECT COUNT(*) FROM job_source_observations").fetchone()[0]
        == 2
    )
    failed_event = conn.execute(
        """
        SELECT payload_json
        FROM job_events
        WHERE event_type = 'DiscoveryRunFailed'
        ORDER BY event_id DESC
        LIMIT 1
        """
    ).fetchone()
    assert json.loads(failed_event["payload_json"])["source_id"] == "lever:leadershipco"


def test_runner_records_partial_ats_source_without_losing_successes(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(runner, "get_connection", lambda: conn)
    registry = _barcelona_registry()
    schedule = DiscoveryScheduler().plan(registry=registry)
    ats_sources = tuple(
        source
        for source in schedule.for_kinds(SourceKind.ATS_API)
        if not source.source_id.startswith("workday:")
    )

    def run_ats(run_id: str | None = None) -> dict[str, Any]:
        return run_scheduled_ats_sources(
            conn,
            ats_sources,
            search_cfg=_search_cfg(),
            run_id=run_id or "runner:ats",
            http=_fake_ats_http_with_lever_failure,
        )

    status = runner._run_discovery_source(
        "ats_api",
        "Canonical ATS APIs",
        ats_sources,
        run_ats,
    )

    assert status == "ok"
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 2
    completed_event = conn.execute(
        """
        SELECT payload_json
        FROM job_events
        WHERE event_type = 'DiscoveryRunCompleted'
        ORDER BY event_id DESC
        LIMIT 1
        """
    ).fetchone()
    completed_payload = json.loads(completed_event["payload_json"])
    assert completed_payload["error_classes"] == ["partial_source_failure"]
    assert completed_payload["failed_source_ids"] == ["lever:leadershipco"]
    failed_event = conn.execute(
        """
        SELECT payload_json
        FROM job_events
        WHERE event_type = 'DiscoveryRunFailed'
        ORDER BY event_id DESC
        LIMIT 1
        """
    ).fetchone()
    assert json.loads(failed_event["payload_json"])["source_id"] == "lever:leadershipco"


def test_repeated_partial_ats_failures_keep_failed_source_quarantined(
    conn: sqlite3.Connection,
) -> None:
    registry = _barcelona_registry()
    schedule = DiscoveryScheduler().plan(registry=registry)
    ats_sources = schedule.for_kinds(SourceKind.ATS_API)
    source_ids = [source.source_id for source in ats_sources]

    for run_number in range(3):
        run_id = f"acceptance:ats:{run_number}"
        record_job_event(
            conn,
            None,
            "discover",
            "DiscoveryRunStarted",
            payload={
                "tenantId": "local",
                "run_id": run_id,
                "runId": run_id,
                "source_ids": source_ids,
                "sourceIds": source_ids,
                "started_at": f"2026-05-14T00:0{run_number}:00+00:00",
                "startedAt": f"2026-05-14T00:0{run_number}:00+00:00",
            },
        )
        result = run_scheduled_ats_sources(
            conn,
            ats_sources,
            search_cfg=_search_cfg(),
            run_id=run_id,
            http=_fake_ats_http_with_lever_failure,
        )
        failed_source_ids = result["failed_source_ids"]
        record_job_event(
            conn,
            None,
            "discover",
            "DiscoveryRunCompleted",
            payload={
                "tenantId": "local",
                "run_id": run_id,
                "runId": run_id,
                "counts": {
                    "total": result["total"],
                    "new_jobs": result["new_jobs"],
                    "newJobs": result["new_jobs"],
                    "observed_jobs": result["observed_jobs"],
                    "observedJobs": result["observed_jobs"],
                    "duplicate_jobs": result["duplicate_jobs"],
                    "duplicateJobs": result["duplicate_jobs"],
                    "rejected_duplicates": result["rejected_duplicates"],
                    "rejectedDuplicates": result["rejected_duplicates"],
                },
                "error_classes": ["partial_source_failure"],
                "errorClasses": ["partial_source_failure"],
                "failed_source_ids": failed_source_ids,
                "failedSourceIds": failed_source_ids,
                "completed_at": f"2026-05-14T00:0{run_number}:30+00:00",
                "completedAt": f"2026-05-14T00:0{run_number}:30+00:00",
            },
        )

    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    lever_stats = conn.execute(
        """
        SELECT failed_run_count, consecutive_failures, recommended_state
        FROM source_quality_stats
        WHERE source_id = ?
        """,
        ("lever:leadershipco",),
    ).fetchone()
    greenhouse_stats = conn.execute(
        """
        SELECT run_count, consecutive_failures, recommended_state
        FROM source_quality_stats
        WHERE source_id = ?
        """,
        ("greenhouse:barcelona-tech",),
    ).fetchone()

    assert tuple(lever_stats) == (3, 3, "quarantined")
    assert tuple(greenhouse_stats) == (3, 0, "normal")


def test_enrichment_snapshot_success_uses_observed_source_id(
    conn: sqlite3.Connection,
) -> None:
    registry = _barcelona_registry()
    schedule = DiscoveryScheduler().plan(registry=registry)
    run_scheduled_ats_sources(
        conn,
        schedule.for_kinds(SourceKind.ATS_API),
        search_cfg=_search_cfg(),
        run_id="acceptance:ats",
        http=_fake_ats_http,
    )
    row = conn.execute(
        """
        SELECT jobs.job_id, jobs.url, jobs.title, jobs.site,
               job_source_observations.source_id
        FROM jobs
        JOIN job_source_observations
          ON job_source_observations.tenant_id = jobs.tenant_id
         AND job_source_observations.job_id = jobs.job_id
        WHERE job_source_observations.source_id = ?
        LIMIT 1
        """,
        ("greenhouse:barcelona-tech",),
    ).fetchone()

    assert row["site"] != row["source_id"]
    _record_posting_snapshot_from_cascade(
        conn,
        url=row["url"],
        job_id=row["job_id"],
        source_id=row["site"],
        title=row["title"],
        cascade_result={
            "status": "ok",
            "tier_used": 1,
            "full_description": _manual_capture_html(),
            "application_url": f"{row['url']}/apply",
        },
        captured_at="2026-05-14T00:00:00+00:00",
    )

    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    observed_source_stats = conn.execute(
        """
        SELECT detail_success_count
        FROM source_quality_stats
        WHERE source_id = ?
        """,
        ("greenhouse:barcelona-tech",),
    ).fetchone()
    display_site_stats = conn.execute(
        """
        SELECT detail_success_count
        FROM source_quality_stats
        WHERE source_id = ?
        """,
        (row["site"],),
    ).fetchone()
    snapshot_event = conn.execute(
        """
        SELECT payload_json
        FROM job_events
        WHERE event_type = 'PostingContentSnapshotCaptured'
        ORDER BY event_id DESC
        LIMIT 1
        """
    ).fetchone()

    assert observed_source_stats["detail_success_count"] == 1
    assert display_site_stats is None
    assert json.loads(snapshot_event["payload_json"])["source_id"] == (
        "greenhouse:barcelona-tech"
    )


def test_manual_capture_import_runs_discovery_enrichment_and_snapshot_pipeline(
    conn: sqlite3.Connection,
) -> None:
    seed_discovery_control_queues(conn, _barcelona_registry())
    item_id = conn.execute(
        """
        SELECT item_id FROM manual_capture_queue
        WHERE source_id = ?
        """,
        ("manual:protected-board",),
    ).fetchone()["item_id"]

    outcome = import_manual_capture_item(
        conn,
        ManualCaptureImport(
            item_id=item_id,
            capture_mode="saved_html",
            captured_url="https://login.protected.example/jobs/vp-engineering",
            content_text=_manual_capture_html(),
            future_manual_action_required=True,
        ),
    )

    assert outcome.promoted_to_job_enrichment is True
    assert outcome.quarantine_reason == "none"
    assert conn.execute(
        """
        SELECT strategy FROM jobs
        WHERE job_id = ?
        """,
        (outcome.job_id,),
    ).fetchone()["strategy"] == "manual"
    enrichment_row = conn.execute(
        """
        SELECT current_status, extraction_tier
        FROM job_enrichments
        WHERE job_id = ?
        """,
        (outcome.job_id,),
    ).fetchone()
    assert tuple(enrichment_row) == ("enriched", "json_ld")
    snapshot_row = conn.execute(
        """
        SELECT latest_snapshot_version, latest_active_state
        FROM posting_snapshot_sets
        WHERE job_id = ?
        """,
        (outcome.job_id,),
    ).fetchone()
    assert tuple(snapshot_row) == (1, "active")
    manual_row = conn.execute(
        """
        SELECT status, future_manual_action_required, retry_context_json
        FROM manual_capture_queue
        WHERE item_id = ?
        """,
        (item_id,),
    ).fetchone()
    assert tuple(manual_row)[0:2] == ("imported", 1)
    provenance = json.loads(manual_row["retry_context_json"])[
        "manual_capture_provenance"
    ]
    assert provenance["source_kind"] == "user_mediated_capture"


def test_manual_capture_import_preserves_extension_capture_provenance(
    conn: sqlite3.Connection,
) -> None:
    seed_discovery_control_queues(conn, _barcelona_registry())
    item_id = conn.execute(
        """
        SELECT item_id FROM manual_capture_queue
        WHERE source_id = ?
        """,
        ("manual:protected-board",),
    ).fetchone()["item_id"]
    conn.execute(
        """
        UPDATE manual_capture_queue
        SET source_id = ?, reason = ?, retry_context_json = ?
        WHERE item_id = ?
        """,
        (
            "manual_capture:extension",
            "browser_extension_capture",
            json.dumps(
                {
                    "source": "browser_extension",
                    "capture_client": "browser_extension",
                    "extension_version": "0.3.0",
                }
            ),
            item_id,
        ),
    )

    import_manual_capture_item(
        conn,
        ManualCaptureImport(
            item_id=item_id,
            capture_mode="current_page",
            captured_url="https://login.protected.example/jobs/vp-engineering",
            content_text=_manual_capture_html(),
            future_manual_action_required=False,
        ),
    )

    manual_row = conn.execute(
        """
        SELECT retry_context_json
        FROM manual_capture_queue
        WHERE item_id = ?
        """,
        (item_id,),
    ).fetchone()
    provenance = json.loads(manual_row["retry_context_json"])[
        "manual_capture_provenance"
    ]
    assert provenance["source_kind"] == "user_mediated_capture"
    assert provenance["source_id"] == "manual_capture:extension"
    assert provenance["capture_mode"] == "current_page"
    assert provenance["capture_client"] == "browser_extension"
    assert provenance["extension_version"] == "0.3.0"


def test_manual_capture_import_cli_routes_api_bridge_through_worker_pipeline(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    seed_discovery_control_queues(conn, _barcelona_registry())
    item_id = conn.execute(
        """
        SELECT item_id FROM manual_capture_queue
        WHERE source_id = ?
        """,
        ("manual:protected-board",),
    ).fetchone()["item_id"]
    close_connection(db_path)
    monkeypatch.setattr(
        sys,
        "stdin",
        StringIO(
            json.dumps(
                {
                    "itemId": item_id,
                    "captureMode": "saved_html",
                    "capturedUrl": "https://login.protected.example/jobs/vp-engineering",
                    "contentText": _manual_capture_html(),
                    "futureManualActionRequired": True,
                }
            )
        ),
    )

    exit_code = manual_capture_import_cli.main(["--db-path", str(db_path)])

    captured = capsys.readouterr()
    assert captured.err == ""
    assert exit_code == 0
    result = json.loads(captured.out)
    assert result["jobId"]
    assert result["promotedToJobEnrichment"] is True
    assert result["retryContext"]["manual_capture_provenance"]["source_kind"] == (
        "user_mediated_capture"
    )
    verify_conn = sqlite3.connect(db_path)
    verify_conn.row_factory = sqlite3.Row
    try:
        assert result["jobId"] == verify_conn.execute(
            "SELECT job_id FROM jobs WHERE url = ?",
            ("https://login.protected.example/jobs/vp-engineering",),
        ).fetchone()["job_id"]
        assert (
            verify_conn.execute(
                "SELECT strategy FROM jobs WHERE url = ?",
                ("https://login.protected.example/jobs/vp-engineering",),
            ).fetchone()["strategy"]
            == "manual"
        )
        assert (
            verify_conn.execute(
                "SELECT current_status FROM job_enrichments WHERE job_id = ?",
                (result["jobId"],),
            ).fetchone()["current_status"]
            == "enriched"
        )
        assert (
            verify_conn.execute(
                "SELECT status FROM manual_capture_queue WHERE item_id = ?",
                (item_id,),
            ).fetchone()["status"]
            == "imported"
        )
    finally:
        verify_conn.close()


def test_worker_queue_reseeding_preserves_imported_manual_capture_provenance(
    conn: sqlite3.Connection,
) -> None:
    registry = _barcelona_registry()
    seed_discovery_control_queues(conn, registry)
    item_id = conn.execute(
        """
        SELECT item_id FROM manual_capture_queue
        WHERE source_id = ?
        """,
        ("manual:protected-board",),
    ).fetchone()["item_id"]

    import_manual_capture_item(
        conn,
        ManualCaptureImport(
            item_id=item_id,
            capture_mode="saved_html",
            captured_url="https://login.protected.example/jobs/vp-engineering",
            content_text=_manual_capture_html(),
            future_manual_action_required=True,
        ),
    )
    imported_context = json.loads(
        conn.execute(
            """
            SELECT retry_context_json
            FROM manual_capture_queue
            WHERE item_id = ?
            """,
            (item_id,),
        ).fetchone()["retry_context_json"]
    )
    assert "manual_capture_provenance" in imported_context

    seed_discovery_control_queues(conn, registry)

    manual_row = conn.execute(
        """
        SELECT status, retry_context_json
        FROM manual_capture_queue
        WHERE item_id = ?
        """,
        (item_id,),
    ).fetchone()
    reseeded_context = json.loads(manual_row["retry_context_json"])
    assert manual_row["status"] == "imported"
    assert reseeded_context["manual_capture_provenance"] == (
        imported_context["manual_capture_provenance"]
    )


def test_barcelona_spain_tech_leadership_acceptance_report_is_end_to_end(
    conn: sqlite3.Connection,
) -> None:
    registry = _barcelona_registry()
    seed_discovery_control_queues(conn, registry)
    schedule = DiscoveryScheduler().plan(registry=registry)
    run_scheduled_ats_sources(
        conn,
        schedule.for_kinds(SourceKind.ATS_API),
        search_cfg=_search_cfg(),
        run_id="acceptance:ats",
        http=_fake_ats_http,
    )
    item_id = conn.execute(
        "SELECT item_id FROM manual_capture_queue WHERE status = 'pending'"
    ).fetchone()["item_id"]
    import_manual_capture_item(
        conn,
        ManualCaptureImport(
            item_id=item_id,
            capture_mode="saved_html",
            captured_url="https://login.protected.example/jobs/vp-engineering",
            content_text=_manual_capture_html(),
            future_manual_action_required=True,
        ),
    )

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    fixture = json.loads(
        (
            Path(__file__).parent
            / "fixtures"
            / "discovery_barcelona_acceptance.json"
        ).read_text(encoding="utf-8")
    )
    report = build_discovery_acceptance_report(conn).to_dict()
    assert report["scenario"] == fixture["scenario"]
    assert report["lead_yield"] == fixture["minimums"]["lead_yield"]
    assert set(report["candidate_sources"]) >= set(fixture["expected_sources"])
    assert report["manual_action_count"] == fixture["minimums"]["manual_action_count"]
    assert (
        report["canonical_verification_rate"]
        == fixture["minimums"]["canonical_verification_rate"]
    )
    assert report["duplicate_count"] == 0
    assert report["quarantine_count"] == 0
    assert report["source_quality_updates"] >= fixture["minimums"]["source_quality_updates"]
    assert report["scoring_handoff_count"] == fixture["minimums"]["scoring_handoff_count"]
    assert report["details"]["locator_candidates"] == 1
