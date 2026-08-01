"""DashboardProjection — aggregate counts after every event type."""

from __future__ import annotations

import json
import sqlite3
import uuid
from pathlib import Path
from typing import Iterator

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.infrastructure.projections.projection_builder import (
    ProjectionBuilder,
    _template_conversion_sort_key,
)
from jobctrl.state import record_job_event, set_stage_state, utc_now


LOCAL_TENANT = "local"


def _job_id_for(url: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"dashboard-projection:{url}"))


@pytest.fixture
def conn(tmp_path: Path) -> Iterator[sqlite3.Connection]:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    yield conn
    close_connection(db_path)


def _seed_job(conn: sqlite3.Connection, url: str, *, site: str = "ExampleCo") -> str:
    job_id = _job_id_for(url)
    now = "2026-05-04T12:00:00+00:00"
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, site, strategy, location, salary,
            discovered_at, application_url, description
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            LOCAL_TENANT,
            job_id,
            url,
            "Engineer",
            site,
            "jobspy",
            "Remote",
            "",
            now,
            url,
            "desc",
        ),
    )
    conn.execute(
        """
        INSERT INTO job_locators (
            tenant_id, job_id, locator_kind, locator_value,
            is_current, first_seen_at, last_seen_at
        ) VALUES (?, ?, 'posting_url', ?, 1, ?, ?)
        """,
        (LOCAL_TENANT, job_id, url, now, now),
    )
    conn.commit()
    return job_id


def _mark_closed(conn: sqlite3.Connection, url: str, state: str = "removed") -> None:
    job_id = _job_id_for(url)
    conn.execute(
        """
        INSERT INTO posting_snapshot_sets (
            tenant_id, job_id, snapshot_set_json, latest_snapshot_version,
            latest_active_state, updated_at
        ) VALUES (?, ?, '{}', 0, ?, ?)
        ON CONFLICT(tenant_id, job_id) DO UPDATE SET
            latest_active_state = excluded.latest_active_state,
            updated_at = excluded.updated_at
        """,
        (LOCAL_TENANT, job_id, state, utc_now()),
    )
    conn.commit()


def _row_value(row, key, default=None):
    if row is None:
        return default
    if isinstance(row, dict):
        return row.get(key, default)
    try:
        value = row[key]
    except (KeyError, IndexError, TypeError):
        return default
    return value if value is not None else default


def _dashboard(conn: sqlite3.Connection) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM dashboard_projections WHERE tenant_id = 'local'"
    ).fetchone()


def test_dashboard_starts_empty(conn: sqlite3.Connection) -> None:
    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    row = _dashboard(conn)
    assert row is not None
    assert _row_value(row, "total_jobs", 0) == 0


def test_total_jobs_reflects_active_jobs(conn: sqlite3.Connection) -> None:
    _seed_job(conn, "https://example.com/a")
    _seed_job(conn, "https://example.com/b")
    record_job_event(conn, _job_id_for("https://example.com/a"), "discover", "JobDiscovered")
    record_job_event(conn, _job_id_for("https://example.com/b"), "discover", "JobDiscovered")
    conn.commit()
    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    row = _dashboard(conn)
    assert _row_value(row, "total_jobs") == 2


def test_dashboard_excludes_closed_jobs_from_active_counts(conn: sqlite3.Connection) -> None:
    active_url = "https://example.com/active"
    closed_url = "https://example.com/closed"
    _seed_job(conn, active_url)
    _seed_job(conn, closed_url)
    active_job_id = _job_id_for(active_url)
    closed_job_id = _job_id_for(closed_url)
    set_stage_state(conn, active_job_id, "discover", "succeeded", finished_at=utc_now())
    set_stage_state(conn, active_job_id, "enrich", "succeeded", finished_at=utc_now())
    set_stage_state(conn, active_job_id, "score", "succeeded", finished_at=utc_now())
    set_stage_state(conn, active_job_id, "tailor", "blocked", validate_transition=False)
    set_stage_state(conn, closed_job_id, "discover", "succeeded", finished_at=utc_now())
    set_stage_state(conn, closed_job_id, "enrich", "succeeded", finished_at=utc_now())
    set_stage_state(conn, closed_job_id, "score", "failed", validate_transition=False)
    record_job_event(conn, active_job_id, "tailor", "StageBlocked")
    record_job_event(conn, closed_job_id, "score", "StageFailed")
    _mark_closed(conn, closed_url)
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    row = _dashboard(conn)

    assert _row_value(row, "total_jobs") == 1
    assert _row_value(row, "blocked") == 1
    assert _row_value(row, "failures") == 0


def test_failures_count_includes_failed_and_exhausted(conn: sqlite3.Connection) -> None:
    url = "https://example.com/c"
    _seed_job(conn, url)
    job_id = _job_id_for(url)
    set_stage_state(conn, job_id, "discover", "succeeded", finished_at=utc_now())
    set_stage_state(conn, job_id, "enrich", "succeeded", finished_at=utc_now())
    set_stage_state(conn, job_id, "score", "failed", validate_transition=False)
    record_job_event(conn, job_id, "score", "StageFailed")
    conn.commit()
    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    row = _dashboard(conn)
    assert _row_value(row, "failures") == 1


def test_blocked_count(conn: sqlite3.Connection) -> None:
    url = "https://example.com/d"
    _seed_job(conn, url)
    job_id = _job_id_for(url)
    set_stage_state(conn, job_id, "discover", "succeeded", finished_at=utc_now())
    set_stage_state(conn, job_id, "enrich", "succeeded", finished_at=utc_now())
    set_stage_state(conn, job_id, "score", "succeeded", finished_at=utc_now())
    set_stage_state(conn, job_id, "tailor", "blocked", validate_transition=False)
    record_job_event(conn, job_id, "tailor", "StageBlocked")
    conn.commit()
    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    row = _dashboard(conn)
    assert _row_value(row, "blocked") == 1


def test_applied_count_via_apply_status(conn: sqlite3.Connection) -> None:
    _seed_job(conn, "https://example.com/e")
    started = utc_now()
    finished = utc_now()
    record_job_event(
        conn,
        _job_id_for("https://example.com/e"),
        "apply",
        "ApplyRunStarted",
        payload={"run_id": "run-e", "started_at": started},
    )
    record_job_event(
        conn,
        _job_id_for("https://example.com/e"),
        "apply",
        "ApplicationSubmitted",
        payload={"run_id": "run-e", "finished_at": finished, "result": "applied"},
    )
    conn.commit()
    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    row = _dashboard(conn)
    assert _row_value(row, "applied") == 1


def test_score_distribution_groups_by_score(conn: sqlite3.Connection) -> None:
    for url, score in [
        ("https://example.com/s8", 8),
        ("https://example.com/s8b", 8),
        ("https://example.com/s5", 5),
    ]:
        _seed_job(conn, url)
        conn.execute(
            """
            INSERT INTO job_scores (tenant_id, job_id, version, fit_score,
                                    breakdown_json, keywords_json, scored_at)
            VALUES (?, ?, 1, ?, ?, ?, ?)
            """,
            (LOCAL_TENANT, _job_id_for(url), score, json.dumps({}), json.dumps([]), utc_now()),
        )
        record_job_event(conn, _job_id_for(url), "score", "JobScored")
    conn.commit()
    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    row = _dashboard(conn)
    distribution = json.loads(_row_value(row, "score_distribution_json", "[]"))
    distribution_by_score = {entry[0]: entry[1] for entry in distribution}
    assert distribution_by_score[8] == 2
    assert distribution_by_score[5] == 1


def test_artifact_projection_preserves_material_metadata(conn: sqlite3.Connection) -> None:
    url = "https://example.com/materials-metadata"
    _seed_job(conn, url)
    metadata = {"quality_plan": {"target_seniority": "executive"}}
    conn.execute(
        """
        INSERT INTO job_materials (
            tenant_id, job_id, generation, status, created_at, updated_at, metadata_json
        ) VALUES (?, ?, 1, 'resume_approved', ?, ?, '{}')
        """,
        (LOCAL_TENANT, _job_id_for(url), utc_now(), utc_now()),
    )
    conn.execute(
        """
        INSERT INTO job_materials_artifacts (
            tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
            render_format, size_bytes, metadata_json, created_at
        ) VALUES (?, ?, 1, 'tailored_resume', 'artifact-1', 'approved', ?, 'text', 12, ?, ?)
        """,
        (LOCAL_TENANT, _job_id_for(url), "/tmp/resume.txt", json.dumps(metadata), utc_now()),
    )
    conn.execute(
        """
        INSERT INTO job_materials_artifacts (
            tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
            render_format, size_bytes, metadata_json, created_at
        ) VALUES (?, ?, 1, 'resume_pdf', 'artifact-pdf', 'approved', ?, 'pdf', 120, '{}', ?)
        """,
        (LOCAL_TENANT, _job_id_for(url), "/tmp/resume.pdf", utc_now()),
    )
    record_job_event(conn, _job_id_for(url), "tailor", "MaterialsGenerated")
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    row = conn.execute(
        """
        SELECT metadata_json
        FROM artifact_list_projections
        WHERE tenant_id = 'local' AND artifact_id = 'artifact-1'
        """
    ).fetchone()

    assert json.loads(_row_value(row, "metadata_json", "{}")) == metadata
    registered_pdf = conn.execute(
        """
        SELECT metadata_json
        FROM artifact_list_projections
        WHERE tenant_id = 'local' AND artifact_id = 'artifact-pdf'
        """
    ).fetchone()

    assert json.loads(_row_value(registered_pdf, "metadata_json", "{}")) == {}


def test_artifact_projection_includes_resume_layout_boxes(conn: sqlite3.Connection) -> None:
    url = "https://example.com/materials-layout"
    _seed_job(conn, url)
    now = utc_now()
    conn.execute(
        """
        INSERT INTO job_materials (
            tenant_id, job_id, generation, status, created_at, updated_at, metadata_json
        ) VALUES (?, ?, 1, 'resume_approved', ?, ?, '{}')
        """,
        (LOCAL_TENANT, _job_id_for(url), now, now),
    )
    conn.execute(
        """
        INSERT INTO job_materials_artifacts (
            tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
            render_format, size_bytes, metadata_json, created_at
        ) VALUES (?, ?, 1, 'resume_pdf', 'artifact-pdf', 'approved', ?, 'html_pdf', 120, '{}', ?)
        """,
        (LOCAL_TENANT, _job_id_for(url), "/tmp/resume.pdf", now),
    )
    conn.execute(
        """
        INSERT INTO job_material_layout_boxes (
            tenant_id, job_id, generation, artifact_id, box_index,
            semantic_id, page_number, line_number, text_excerpt,
            left_pct, top_pct, width_pct, height_pct, audit_target_json,
            created_at
        ) VALUES (?, ?, 1, 'artifact-pdf', 0, ?, 1, 6, ?, 12.5, 24.0, 62.0, 2.4, '{}', ?)
        """,
        (LOCAL_TENANT, _job_id_for(url), "experience:acme:bullet:1", "Cut latency.", now),
    )
    record_job_event(conn, _job_id_for(url), "tailor", "PdfRendered")
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    row = conn.execute(
        """
        SELECT layout_boxes_json
        FROM artifact_list_projections
        WHERE tenant_id = 'local' AND artifact_id = 'artifact-pdf'
        """
    ).fetchone()

    layout_boxes = json.loads(_row_value(row, "layout_boxes_json", "[]"))
    assert layout_boxes == [
        {
            "semanticId": "experience:acme:bullet:1",
            "pageNumber": 1,
            "lineNumber": 6,
            "textExcerpt": "Cut latency.",
            "leftPct": 12.5,
            "topPct": 24.0,
            "widthPct": 62.0,
            "heightPct": 2.4,
        }
    ]


def test_funnel_counts_per_stage(conn: sqlite3.Connection) -> None:
    url = "https://example.com/funnel"
    _seed_job(conn, url)
    job_id = _job_id_for(url)
    set_stage_state(conn, job_id, "discover", "succeeded", finished_at=utc_now())
    set_stage_state(conn, job_id, "enrich", "succeeded", finished_at=utc_now())
    set_stage_state(conn, job_id, "score", "succeeded", finished_at=utc_now())
    set_stage_state(conn, job_id, "tailor", "running")
    record_job_event(conn, job_id, "tailor", "StageStarted")
    conn.commit()
    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = _dashboard(conn)
    funnel = json.loads(_row_value(row, "funnel_json", "[]"))
    by_stage = {entry["stage"]: entry for entry in funnel}
    assert by_stage["discover"]["succeeded"] == 1
    assert by_stage["enrich"]["succeeded"] == 1
    assert by_stage["score"]["succeeded"] == 1
    assert by_stage["tailor"]["running"] == 1
    assert by_stage["cover"]["pending"] == 1


def test_by_source_counts(conn: sqlite3.Connection) -> None:
    _seed_job(conn, "https://example.com/x", site="OneCo")
    _seed_job(conn, "https://example.com/y", site="OneCo")
    _seed_job(conn, "https://example.com/z", site="TwoCo")
    for url in ("https://example.com/x", "https://example.com/y", "https://example.com/z"):
        record_job_event(conn, _job_id_for(url), "discover", "JobDiscovered")
    conn.commit()
    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = _dashboard(conn)
    by_source = json.loads(_row_value(row, "by_source_json", "[]"))
    counts = {entry[0]: entry[1] for entry in by_source}
    assert counts["OneCo"] == 2
    assert counts["TwoCo"] == 1


def test_by_source_orders_ties_by_source_name(conn: sqlite3.Connection) -> None:
    # Netflix leads on count; Acme and Wayfair tie at 2. The builder seeds
    # source_counts from fetch_job_list, which returns rows ORDER BY job_id —
    # so the URL prefixes below deliberately put Wayfair FIRST in job_id order
    # (a-wayfair < m-netflix < z-acme) while the tie must render Acme first
    # A->Z. A count-only sort would leak insertion order ([..., Wayfair, Acme])
    # and fail; only the count-desc-then-source-asc tiebreak passes,
    # byte-identical to the TS builder.
    seeded = [
        ("https://example.com/a-wayfair-1", "Wayfair"),
        ("https://example.com/a-wayfair-2", "Wayfair"),
        ("https://example.com/m-netflix-1", "Netflix"),
        ("https://example.com/m-netflix-2", "Netflix"),
        ("https://example.com/m-netflix-3", "Netflix"),
        ("https://example.com/z-acme-1", "Acme"),
        ("https://example.com/z-acme-2", "Acme"),
    ]
    for url, site in seeded:
        _seed_job(conn, url, site=site)
        record_job_event(conn, _job_id_for(url), "discover", "JobDiscovered")
    conn.commit()
    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = _dashboard(conn)
    by_source = json.loads(_row_value(row, "by_source_json", "[]"))
    assert by_source == [["Netflix", 3], ["Acme", 2], ["Wayfair", 2]]


def _apply_job(
    conn: sqlite3.Connection,
    url: str,
    *,
    site: str,
    fit_score: int,
    applied_at: str | None = None,
) -> None:
    _seed_job(conn, url, site=site)
    at = applied_at or utc_now()
    job_id = _job_id_for(url)
    conn.execute(
        """
        INSERT INTO job_scores (tenant_id, job_id, version, fit_score,
                                breakdown_json, keywords_json, scored_at)
        VALUES (?, ?, 1, ?, '{}', '[]', ?)
        """,
        (LOCAL_TENANT, job_id, fit_score, utc_now()),
    )
    run_id = f"run-{url}"
    record_job_event(
        conn, job_id, "apply", "ApplyRunStarted",
        payload={"run_id": run_id, "started_at": at},
    )
    record_job_event(
        conn, job_id, "apply", "ApplicationSubmitted",
        payload={"run_id": run_id, "finished_at": at, "result": "applied"},
    )


def _mark_manual_applied(
    conn: sqlite3.Connection,
    url: str,
    *,
    site: str,
    fit_score: int,
    applied_at: str | None = None,
) -> None:
    _seed_job(conn, url, site=site)
    at = applied_at or utc_now()
    job_id = _job_id_for(url)
    conn.execute(
        """
        INSERT INTO job_scores (tenant_id, job_id, version, fit_score,
                                breakdown_json, keywords_json, scored_at)
        VALUES (?, ?, 1, ?, '{}', '[]', ?)
        """,
        (LOCAL_TENANT, job_id, fit_score, utc_now()),
    )
    record_job_event(
        conn,
        job_id,
        "apply",
        "ApplicationManuallyMarked",
        occurred_at=at,
    )


def _mark_external_confirmed(
    conn: sqlite3.Connection,
    url: str,
    *,
    site: str,
    fit_score: int,
    applied_at: str | None = None,
) -> None:
    _seed_job(conn, url, site=site)
    at = applied_at or utc_now()
    job_id = _job_id_for(url)
    conn.execute(
        """
        INSERT INTO job_scores (tenant_id, job_id, version, fit_score,
                                breakdown_json, keywords_json, scored_at)
        VALUES (?, ?, 1, ?, '{}', '[]', ?)
        """,
        (LOCAL_TENANT, job_id, fit_score, utc_now()),
    )
    _record_outcome(conn, url, "applied_confirmation", occurred_at=at)


def _record_fit_band(conn: sqlite3.Connection, url: str, fit_score: int, fit_band: str) -> None:
    conn.execute(
        """
        INSERT INTO job_requirement_fit_reports (
            tenant_id, job_id, score_version, employer_analysis_generation,
            profile_snapshot_version, scoring_policy_version, formula_version,
            resolved_fit_score, fit_band, confidence, summary_json, created_at
        ) VALUES (?, ?, 1, 1, 1, 1, 'test', ?, ?, 'medium', '{}', ?)
        """,
        (LOCAL_TENANT, _job_id_for(url), fit_score, fit_band, utc_now()),
    )


def _record_outcome(
    conn: sqlite3.Connection,
    url: str,
    kind: str,
    *,
    occurred_at: str | None = None,
) -> None:
    at = occurred_at or utc_now()
    conn.execute(
        """
        INSERT INTO application_outcomes (
            tenant_id, outcome_id, job_id, kind, source, occurred_at, recorded_at
        ) VALUES (?, ?, ?, ?, 'manual', ?, ?)
        """,
        (LOCAL_TENANT, f"outcome-{url}-{kind}", _job_id_for(url), kind, at, at),
    )


def _record_material_metadata(
    conn: sqlite3.Connection,
    url: str,
    *,
    template_id: str | None = None,
    template_name: str | None = None,
    policy_version: int | None = None,
) -> None:
    metadata: dict[str, object | None] = {"tailoring_policy_version": policy_version}
    if template_id is not None:
        metadata["resume_template"] = {
            "templateId": template_id,
            "templateVersionId": f"{template_id}:v1",
            "templateVersionNumber": 1,
            "templateName": template_name,
            "templateHash": f"hash:{template_id}",
            "assignmentSource": "test",
        }
    conn.execute(
        """
        INSERT INTO job_materials (
            tenant_id, job_id, generation, status, created_at, updated_at, metadata_json
        ) VALUES (?, ?, 1, 'resume_approved', ?, ?, '{}')
        """,
        (LOCAL_TENANT, _job_id_for(url), utc_now(), utc_now()),
    )
    conn.execute(
        """
        INSERT INTO job_materials_artifacts (
            tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
            render_format, size_bytes, metadata_json, created_at
        ) VALUES (?, ?, 1, 'tailored_resume', ?, 'approved', ?, 'text', 12, ?, ?)
        """,
        (
            LOCAL_TENANT,
            _job_id_for(url),
            f"resume-{url}",
            f"/tmp/{url.rsplit('/', 1)[-1]}.txt",
            json.dumps(metadata),
            utc_now(),
        ),
    )


def _record_replacement_material_metadata(conn: sqlite3.Connection, url: str) -> None:
    conn.execute(
        """
        INSERT INTO job_materials (
            tenant_id, job_id, generation, status, created_at, updated_at, metadata_json
        ) VALUES (?, ?, 2, 'resume_approved', ?, ?, ?)
        """,
        (
            LOCAL_TENANT,
            _job_id_for(url),
            utc_now(),
            utc_now(),
            json.dumps({"source": "resume_review_draft", "base_generation": 1}),
        ),
    )
    conn.execute(
        """
        INSERT INTO job_materials_artifacts (
            tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
            render_format, size_bytes, metadata_json, created_at
        ) VALUES (?, ?, 2, 'tailored_resume', ?, 'approved', ?, 'text', 12, ?, ?)
        """,
        (
            LOCAL_TENANT,
            _job_id_for(url),
            f"replacement-{url}",
            f"/tmp/{url.rsplit('/', 1)[-1]}-replacement.txt",
            json.dumps(
                {
                    "source": "resume_review_draft",
                    "base_generation": 1,
                    "base_resume_text_artifact_id": f"resume-{url}",
                }
            ),
            utc_now(),
        ),
    )


def _record_suggestion(conn: sqlite3.Connection, index: int, status: str) -> None:
    conn.execute(
        """
        INSERT INTO application_outcome_suggestions (
            tenant_id, suggestion_id, job_id, suggested_kind, confidence, rationale,
            status, created_at, decided_at, decision
        ) VALUES (?, ?, ?, 'recruiter_reply', 0.9, '', ?, ?, ?, ?)
        """,
        (
            LOCAL_TENANT,
            f"suggestion-{index}",
            _job_id_for("https://example.com/live-1"),
            status,
            utc_now(),
            utc_now(),
            status,
        ),
    )


def test_outcome_conversion_counts_by_source_and_band(conn: sqlite3.Connection) -> None:
    from jobctrl.infrastructure.gmail.feedback import ensure_application_feedback_tables

    ensure_application_feedback_tables(conn)
    _apply_job(conn, "https://example.com/li-a", site="linkedin", fit_score=8)
    _apply_job(conn, "https://example.com/li-b", site="linkedin", fit_score=8)
    _apply_job(conn, "https://example.com/li-c", site="linkedin", fit_score=8)
    _apply_job(conn, "https://example.com/gh-a", site="greenhouse", fit_score=5)
    _apply_job(conn, "https://example.com/gh-b", site="greenhouse", fit_score=5)
    _record_outcome(conn, "https://example.com/li-a", "interview")
    _record_outcome(conn, "https://example.com/li-b", "recruiter_reply")
    _record_outcome(conn, "https://example.com/gh-a", "offer")
    _record_outcome(conn, "https://example.com/gh-b", "rejection")
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    row = _dashboard(conn)
    conversion = json.loads(_row_value(row, "outcome_conversion_json", "{}"))

    assert conversion["version"] == 2
    assert conversion["totals"] == {
        "applied": 5, "reply": 4, "interview": 2, "offer": 1, "rejection": 1,
    }
    by_source = {entry["source"]: entry for entry in conversion["bySource"]}
    assert by_source["linkedin"] == {
        "source": "linkedin", "applied": 3, "reply": 2, "interview": 1, "offer": 0, "rejection": 0,
    }
    assert by_source["greenhouse"] == {
        "source": "greenhouse", "applied": 2, "reply": 2, "interview": 1, "offer": 1, "rejection": 1,
    }
    by_band = {entry["band"]: entry for entry in conversion["byBand"]}
    assert by_band["strong"] == {
        "band": "strong", "applied": 3, "reply": 2, "interview": 1, "offer": 0, "rejection": 0,
    }
    assert by_band["moderate"] == {
        "band": "moderate", "applied": 2, "reply": 2, "interview": 1, "offer": 1, "rejection": 1,
    }
    by_apply_mode = {entry["applyMode"]: entry for entry in conversion["byApplyMode"]}
    assert by_apply_mode["automated_live"] == {
        "applyMode": "automated_live", "applied": 5, "reply": 4, "interview": 2, "offer": 1, "rejection": 1,
    }
    by_fit_band = {entry["fitBand"]: entry for entry in conversion["byFitBand"]}
    assert by_fit_band["unreported"] == {
        "fitBand": "unreported", "applied": 5, "reply": 4, "interview": 2, "offer": 1, "rejection": 1,
    }


def test_outcome_conversion_counts_by_fit_band_and_apply_mode(conn: sqlite3.Connection) -> None:
    from jobctrl.infrastructure.gmail.feedback import ensure_application_feedback_tables

    ensure_application_feedback_tables(conn)
    for idx in range(1, 6):
        url = f"https://example.com/live-{idx}"
        _apply_job(conn, url, site="greenhouse", fit_score=9)
        _record_fit_band(conn, url, 9, "excellent")
        if idx <= 2:
            _record_outcome(conn, url, "interview")
    for idx in range(1, 6):
        url = f"https://example.com/manual-{idx}"
        _mark_manual_applied(conn, url, site="linkedin", fit_score=8)
        _record_fit_band(conn, url, 8, "strong")
        if idx <= 3:
            _record_outcome(conn, url, "recruiter_reply")
    _mark_external_confirmed(conn, "https://example.com/external", site="lever", fit_score=4)
    _record_fit_band(conn, "https://example.com/external", 4, "stretch")
    _record_outcome(conn, "https://example.com/external", "recruiter_reply")
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    row = _dashboard(conn)
    conversion = json.loads(_row_value(row, "outcome_conversion_json", "{}"))

    by_fit_band = {entry["fitBand"]: entry for entry in conversion["byFitBand"]}
    assert by_fit_band["excellent"] == {
        "fitBand": "excellent", "applied": 5, "reply": 2, "interview": 2, "offer": 0, "rejection": 0,
    }
    assert by_fit_band["strong"] == {
        "fitBand": "strong", "applied": 5, "reply": 3, "interview": 0, "offer": 0, "rejection": 0,
    }
    assert by_fit_band["stretch"] == {
        "fitBand": "stretch", "applied": 1, "reply": 1, "interview": 0, "offer": 0, "rejection": 0,
    }

    by_apply_mode = {entry["applyMode"]: entry for entry in conversion["byApplyMode"]}
    assert by_apply_mode["automated_live"] == {
        "applyMode": "automated_live", "applied": 5, "reply": 2, "interview": 2, "offer": 0, "rejection": 0,
    }
    assert by_apply_mode["manual_marked"] == {
        "applyMode": "manual_marked", "applied": 5, "reply": 3, "interview": 0, "offer": 0, "rejection": 0,
    }
    assert by_apply_mode["external_confirmed"] == {
        "applyMode": "external_confirmed", "applied": 1, "reply": 1, "interview": 0, "offer": 0, "rejection": 0,
    }


def test_outcome_conversion_counts_by_material_and_feedback_rows(conn: sqlite3.Connection) -> None:
    from jobctrl.infrastructure.gmail.feedback import ensure_application_feedback_tables

    ensure_application_feedback_tables(conn)
    applied_at = "2026-06-01T12:00:00+00:00"
    response_at = "2026-06-05T12:00:00+00:00"

    for idx in range(1, 6):
        url = f"https://example.com/live-{idx}"
        _apply_job(conn, url, site="greenhouse", fit_score=9, applied_at=applied_at)
        _record_fit_band(conn, url, 9, "excellent")
        _record_material_metadata(
            conn,
            url,
            template_id="template-modern",
            template_name="Modern compact",
            policy_version=3,
        )
        _record_replacement_material_metadata(conn, url)
        if idx <= 2:
            _record_outcome(conn, url, "interview", occurred_at=response_at)
    for idx in range(1, 6):
        url = f"https://example.com/manual-{idx}"
        _mark_manual_applied(conn, url, site="linkedin", fit_score=8, applied_at=applied_at)
        _record_fit_band(conn, url, 8, "strong")
        _record_material_metadata(
            conn,
            url,
            template_id="template-plain",
            template_name="Plain ATS",
            policy_version=4,
        )
        if idx <= 3:
            _record_outcome(conn, url, "recruiter_reply", occurred_at=response_at)
    _mark_external_confirmed(
        conn,
        "https://example.com/external",
        site="lever",
        fit_score=4,
        applied_at=applied_at,
    )
    _record_fit_band(conn, "https://example.com/external", 4, "stretch")
    _record_outcome(conn, "https://example.com/external", "recruiter_reply", occurred_at=response_at)
    for index, status in enumerate(["accepted", "accepted", "accepted", "corrected", "ignored"]):
        _record_suggestion(conn, index, status)
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    row = _dashboard(conn)
    conversion = json.loads(_row_value(row, "outcome_conversion_json", "{}"))

    by_template = {entry["templateId"]: entry for entry in conversion["byTemplate"]}
    assert by_template["template-modern"] == {
        "templateId": "template-modern",
        "templateName": "Modern compact",
        "applied": 5,
        "reply": 2,
        "interview": 2,
        "offer": 0,
        "rejection": 0,
    }
    assert by_template["template-plain"] == {
        "templateId": "template-plain",
        "templateName": "Plain ATS",
        "applied": 5,
        "reply": 3,
        "interview": 0,
        "offer": 0,
        "rejection": 0,
    }
    assert by_template["unreported"] == {
        "templateId": "unreported",
        "templateName": None,
        "applied": 1,
        "reply": 1,
        "interview": 0,
        "offer": 0,
        "rejection": 0,
    }

    by_policy = {entry["policyLabel"]: entry for entry in conversion["byPolicy"]}
    assert by_policy["Policy v3"]["tailoringPolicyVersion"] == 3
    assert by_policy["Policy v3"]["applied"] == 5
    assert by_policy["Policy v3"]["reply"] == 2
    assert by_policy["Policy v4"]["tailoringPolicyVersion"] == 4
    assert by_policy["Policy v4"]["applied"] == 5
    assert by_policy["Policy v4"]["reply"] == 3
    assert by_policy["Unreported"]["tailoringPolicyVersion"] is None
    assert by_policy["Unreported"]["applied"] == 1
    assert by_policy["Unreported"]["reply"] == 1

    assert conversion["timeToResponseMinutes"] == [5760, 5760, 5760, 5760, 5760, 5760]
    assert conversion["suggestionAccuracy"] == {
        "decided": 5,
        "accepted": 3,
        "corrected": 1,
        "ignored": 1,
    }


def test_outcome_conversion_breaks_template_name_ties_by_id() -> None:
    fixture = json.loads(
        (
            Path(__file__).parents[3]
            / "packages/domain-types/test/fixtures/dashboard_template_order.json"
        ).read_text()
    )
    buckets = [
        (
            entry["templateId"],
            {
                "templateName": entry["templateName"],
                "counts": {"applied": entry["applied"]},
            },
        )
        for entry in fixture["entries"]
    ]

    assert [
        template_id
        for template_id, _ in sorted(
            buckets, key=_template_conversion_sort_key
        )
    ] == fixture["expectedTemplateIds"]


def test_outcome_conversion_does_not_fallback_without_material_registry(
    conn: sqlite3.Connection,
) -> None:
    from jobctrl.infrastructure.gmail.feedback import ensure_application_feedback_tables

    ensure_application_feedback_tables(conn)
    for idx in range(1, 6):
        url = f"https://example.com/compat-{idx}"
        _apply_job(conn, url, site="greenhouse", fit_score=9)
        _record_material_metadata(
            conn,
            url,
            template_id="template-compat",
            template_name="Compatibility resume",
            policy_version=7,
        )
    conn.execute("DROP TABLE job_materials")
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    row = _dashboard(conn)
    conversion = json.loads(_row_value(row, "outcome_conversion_json", "{}"))

    by_template = {entry["templateId"]: entry for entry in conversion["byTemplate"]}
    assert "template-compat" not in by_template
    assert by_template["unreported"] == {
        "templateId": "unreported",
        "templateName": None,
        "applied": 5,
        "reply": 0,
        "interview": 0,
        "offer": 0,
        "rejection": 0,
    }
    by_policy = {entry["policyLabel"]: entry for entry in conversion["byPolicy"]}
    assert "Policy v7" not in by_policy
    assert by_policy["Unreported"]["tailoringPolicyVersion"] is None
    assert by_policy["Unreported"]["applied"] == 5


def test_outcome_conversion_empty_when_no_applied_jobs(conn: sqlite3.Connection) -> None:
    _seed_job(conn, "https://example.com/discovered-only")
    record_job_event(
        conn,
        _job_id_for("https://example.com/discovered-only"),
        "discover",
        "JobDiscovered",
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    row = _dashboard(conn)
    conversion = json.loads(_row_value(row, "outcome_conversion_json", "{}"))

    assert conversion == {
        "version": 2,
        "totals": {"applied": 0, "reply": 0, "interview": 0, "offer": 0, "rejection": 0},
        "bySource": [],
        "byBand": [],
        "byFitBand": [],
        "byApplyMode": [],
        "byTemplate": [],
        "byPolicy": [],
        "timeToResponseMinutes": [],
        "suggestionAccuracy": {"decided": 0, "accepted": 0, "corrected": 0, "ignored": 0},
    }


def test_outcome_conversion_keeps_raw_counts_for_small_sample(
    conn: sqlite3.Connection,
) -> None:
    """Dual-writer parity: the Python builder never drops a bucket for a small
    sample. The minimum-sample rate suppression is a read-time concern in
    ``read-model.ts`` (``MIN_CONVERSION_SAMPLE``); the projection keeps the raw
    counts so a single application with a single reply stays inspectable and the
    counts match the TypeScript builder byte-for-byte.
    """
    from jobctrl.infrastructure.gmail.feedback import ensure_application_feedback_tables

    ensure_application_feedback_tables(conn)
    _apply_job(conn, "https://example.com/solo", site="linkedin", fit_score=8)
    _record_outcome(conn, "https://example.com/solo", "recruiter_reply")
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    row = _dashboard(conn)
    conversion = json.loads(_row_value(row, "outcome_conversion_json", "{}"))

    # n = 1 keeps its raw counts (rates are never materialised in the projection).
    assert conversion["totals"] == {
        "applied": 1, "reply": 1, "interview": 0, "offer": 0, "rejection": 0,
    }
    by_source = {entry["source"]: entry for entry in conversion["bySource"]}
    assert by_source["linkedin"] == {
        "source": "linkedin", "applied": 1, "reply": 1, "interview": 0, "offer": 0, "rejection": 0,
    }
