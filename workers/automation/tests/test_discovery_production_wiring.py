from __future__ import annotations

import json
import sqlite3
import sys
from io import StringIO
from pathlib import Path
from typing import Any, Iterator

import pytest

from jobhunter import config
from jobhunter.discovery import manual_capture_import as manual_capture_import_cli
from jobhunter.database import close_connection, init_db
from jobhunter.domain.discovery.scheduler import DiscoveryScheduler
from jobhunter.domain.discovery.source_registry import SourceKind
from jobhunter.infrastructure.discovery.production_wiring import (
    ManualCaptureImport,
    build_discovery_acceptance_report,
    import_manual_capture_item,
    run_scheduled_ats_sources,
    seed_discovery_control_queues,
)
from jobhunter.infrastructure.projections.projection_builder import ProjectionBuilder


@pytest.fixture
def conn(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[sqlite3.Connection]:
    db_path = tmp_path / "jobhunter.db"
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
                }
            ]
        }
    return {}


def _fake_ats_http_with_lever_failure(url: str, **kwargs: Any) -> Any:
    if "lever" in url:
        raise TimeoutError("lever unavailable")
    return _fake_ats_http(url, **kwargs)


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
        SET status = 'dismissed', dismissed_at = ?
        WHERE item_id = ?
        """,
        ("2026-05-12T10:00:00+00:00", item_id),
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
        WHERE url = ?
        """,
        (outcome.job_id,),
    ).fetchone()["strategy"] == "manual"
    enrichment_row = conn.execute(
        """
        SELECT current_status, extraction_tier
        FROM job_enrichments
        WHERE job_url = ?
        """,
        (outcome.job_id,),
    ).fetchone()
    assert tuple(enrichment_row) == ("enriched", "json_ld")
    snapshot_row = conn.execute(
        """
        SELECT latest_snapshot_version, latest_active_state
        FROM posting_snapshot_sets
        WHERE job_url = ?
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


def test_manual_capture_import_cli_routes_api_bridge_through_worker_pipeline(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    db_path = tmp_path / "jobhunter.db"
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
    assert result["jobId"] == "https://login.protected.example/jobs/vp-engineering"
    assert result["promotedToJobEnrichment"] is True
    assert result["retryContext"]["manual_capture_provenance"]["source_kind"] == (
        "user_mediated_capture"
    )
    verify_conn = sqlite3.connect(db_path)
    verify_conn.row_factory = sqlite3.Row
    try:
        assert (
            verify_conn.execute(
                "SELECT strategy FROM jobs WHERE url = ?",
                ("https://login.protected.example/jobs/vp-engineering",),
            ).fetchone()["strategy"]
            == "manual"
        )
        assert (
            verify_conn.execute(
                "SELECT current_status FROM job_enrichments WHERE job_url = ?",
                ("https://login.protected.example/jobs/vp-engineering",),
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
    assert report["details"]["locator_candidates"] >= 4
