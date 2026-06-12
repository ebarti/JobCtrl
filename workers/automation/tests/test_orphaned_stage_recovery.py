from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from jobhunter.database import close_connection, init_db
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.materials import (
    Artifact,
    ArtifactType,
    JudgeVerdict,
    MaterialsSetFactory,
    RenderFormat,
    ValidationResult,
)
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.materials import SqliteMaterialsRepository
from jobhunter.state import (
    ensure_job_stage_rows,
    recover_orphaned_discovery_runs,
    recover_orphaned_running_stages,
    set_stage_state,
)


def _insert_job(conn: sqlite3.Connection, url: str) -> None:
    conn.execute(
        """
        INSERT INTO jobs (url, title, site, full_description, discovered_at)
        VALUES (?, 'Engineer', 'ExampleCo', 'Build reliable systems.', ?)
        """,
        (url, "2026-05-21T20:00:00+00:00"),
    )
    ensure_job_stage_rows(conn, url)
    conn.commit()


def _mark_running_at(conn: sqlite3.Connection, url: str, stage: str, timestamp: str) -> None:
    set_stage_state(
        conn,
        url,
        stage,
        "running",
        started_at=timestamp,
        validate_transition=False,
    )
    conn.execute(
        """
        UPDATE job_stage_states
        SET updated_at = ?
        WHERE job_url = ? AND stage = ?
        """,
        (timestamp, url, stage),
    )
    conn.commit()


def _artifact(artifact_type: ArtifactType, path: str, render_format: RenderFormat) -> Artifact:
    return Artifact.create(
        type=artifact_type,
        path=path,
        created_at="2026-05-21T20:00:30+00:00",
        render_format=render_format,
    )


def test_recover_orphaned_running_stages_marks_only_stale_non_apply_runs_failed(tmp_path: Path) -> None:
    db_path = tmp_path / "jobhunter.db"
    conn = init_db(db_path)
    old_score_url = "https://example.com/jobs/orphaned-score"
    fresh_score_url = "https://example.com/jobs/fresh-score"
    current_worker_score_url = "https://example.com/jobs/current-worker-score"
    apply_url = "https://example.com/jobs/apply-run"
    missing_job_url = "https://example.com/jobs/missing-parent"

    try:
        _insert_job(conn, old_score_url)
        _insert_job(conn, fresh_score_url)
        _insert_job(conn, current_worker_score_url)
        _insert_job(conn, apply_url)
        _mark_running_at(conn, old_score_url, "score", "2026-05-21T20:00:00+00:00")
        _mark_running_at(conn, fresh_score_url, "score", "2026-05-21T20:09:00+00:00")
        _mark_running_at(conn, current_worker_score_url, "score", "2026-05-21T20:03:00+00:00")
        _mark_running_at(conn, apply_url, "apply", "2026-05-21T20:00:00+00:00")
        conn.execute(
            """
            INSERT INTO job_stage_states (job_url, stage, state, updated_at)
            VALUES (?, 'tailor', 'running', ?)
            """,
            (missing_job_url, "2026-05-21T20:00:00+00:00"),
        )
        conn.commit()

        recovered = recover_orphaned_running_stages(
            conn,
            now=datetime(2026, 5, 21, 20, 10, 0, tzinfo=timezone.utc),
            stale_after_seconds=150,
            started_before=datetime(2026, 5, 21, 20, 2, 0, tzinfo=timezone.utc),
        )

        assert recovered == 1
        recovered_row = conn.execute(
            """
            SELECT state, attempt_count, error_code, error_message, retryable, next_action
            FROM job_stage_states
            WHERE job_url = ? AND stage = 'score'
            """,
            (old_score_url,),
        ).fetchone()
        assert recovered_row["state"] == "failed"
        assert recovered_row["attempt_count"] == 1
        assert recovered_row["error_code"] == "ORPHANED_STAGE_RUN"
        assert recovered_row["retryable"] == 1
        assert old_score_url in recovered_row["next_action"]
        assert "left running by a prior worker" in recovered_row["error_message"]

        fresh_row = conn.execute(
            "SELECT state FROM job_stage_states WHERE job_url = ? AND stage = 'score'",
            (fresh_score_url,),
        ).fetchone()
        assert fresh_row["state"] == "running"

        current_worker_row = conn.execute(
            "SELECT state FROM job_stage_states WHERE job_url = ? AND stage = 'score'",
            (current_worker_score_url,),
        ).fetchone()
        assert current_worker_row["state"] == "running"

        apply_row = conn.execute(
            "SELECT state FROM job_stage_states WHERE job_url = ? AND stage = 'apply'",
            (apply_url,),
        ).fetchone()
        assert apply_row["state"] == "running"

        missing_job_event_count = conn.execute(
            "SELECT COUNT(*) AS count FROM job_events WHERE job_url = ?",
            (missing_job_url,),
        ).fetchone()
        assert missing_job_event_count["count"] == 0

        event = conn.execute(
            """
            SELECT event_type, level, message, payload_json
            FROM job_events
            WHERE job_url = ? AND stage = 'score'
            ORDER BY event_id DESC LIMIT 1
            """,
            (old_score_url,),
        ).fetchone()
        assert event["event_type"] == "StageFailed"
        assert event["level"] == "error"
        assert "marked failed for retry" in event["message"]
        assert "ORPHANED_STAGE_RUN" in event["payload_json"]

        metric = conn.execute(
            """
            SELECT stage, attempt_kind, outcome, failure_category,
                   is_operational_failure, is_scrape_failure, is_retryable,
                   job_url, error_class
            FROM operational_attempt_metrics
            WHERE job_url = ? AND stage = 'score'
            ORDER BY metric_id DESC LIMIT 1
            """,
            (old_score_url,),
        ).fetchone()
        assert metric["attempt_kind"] == "orphan_recovery"
        assert metric["outcome"] == "failed"
        assert metric["failure_category"] == "orphaned_stage_run"
        assert metric["is_operational_failure"] == 1
        assert metric["is_scrape_failure"] == 0
        assert metric["is_retryable"] == 1
        assert metric["error_class"] == "ORPHANED_STAGE_RUN"
    finally:
        close_connection(db_path)


def test_recover_orphaned_tailor_with_approved_artifacts_marks_succeeded(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobhunter.db"
    conn = init_db(db_path)
    url = "https://example.com/jobs/orphaned-tailor-approved"

    try:
        _insert_job(conn, url)
        repo = SqliteMaterialsRepository(conn)
        materials = MaterialsSetFactory.initial(
            tenant_id=LOCAL_TENANT,
            job_id=JobId(url),
            created_at="2026-05-21T20:00:00+00:00",
        ).with_resume_attempt(
            _artifact(ArtifactType.TAILORED_RESUME, "/tmp/resume.txt", RenderFormat.TEXT),
            validation=ValidationResult.success(),
            verdict=JudgeVerdict.passed(),
            updated_at="2026-05-21T20:00:30+00:00",
        ).with_resume_pdf(
            _artifact(ArtifactType.RESUME_PDF, "/tmp/resume.pdf", RenderFormat.LATEX_PDF),
            updated_at="2026-05-21T20:00:40+00:00",
        )
        repo.save(materials)
        _mark_running_at(conn, url, "tailor", "2026-05-21T20:00:00+00:00")

        recovered = recover_orphaned_running_stages(
            conn,
            now=datetime(2026, 5, 21, 20, 10, 0, tzinfo=timezone.utc),
            stale_after_seconds=150,
            started_before=datetime(2026, 5, 21, 20, 2, 0, tzinfo=timezone.utc),
        )

        assert recovered == 1
        recovered_row = conn.execute(
            """
            SELECT state, error_code, error_message, retryable, next_action, metadata_json
            FROM job_stage_states
            WHERE job_url = ? AND stage = 'tailor'
            """,
            (url,),
        ).fetchone()
        assert recovered_row["state"] == "succeeded"
        assert recovered_row["error_code"] is None
        assert recovered_row["error_message"] is None
        assert recovered_row["retryable"] == 0
        assert recovered_row["next_action"] is None
        assert '"materials_generation": 1' in recovered_row["metadata_json"]

        event = conn.execute(
            """
            SELECT event_type, level, message, payload_json
            FROM job_events
            WHERE job_url = ? AND stage = 'tailor'
            ORDER BY event_id DESC LIMIT 1
            """,
            (url,),
        ).fetchone()
        assert event["event_type"] == "StageCompleted"
        assert event["level"] == "info"
        assert "approved artifacts were found" in event["message"]
        assert "approved_material_artifacts" in event["payload_json"]

        metric = conn.execute(
            """
            SELECT attempt_kind, outcome, failure_category,
                   is_operational_failure, is_retryable
            FROM operational_attempt_metrics
            WHERE job_url = ? AND stage = 'tailor'
            ORDER BY metric_id DESC LIMIT 1
            """,
            (url,),
        ).fetchone()
        assert metric["attempt_kind"] == "orphan_recovery"
        assert metric["outcome"] == "succeeded"
        assert metric["failure_category"] is None
        assert metric["is_operational_failure"] == 0
        assert metric["is_retryable"] == 0
    finally:
        close_connection(db_path)


def test_recover_failed_orphaned_tailor_with_approved_artifacts_marks_succeeded(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobhunter.db"
    conn = init_db(db_path)
    url = "https://example.com/jobs/failed-orphaned-tailor-approved"

    try:
        _insert_job(conn, url)
        repo = SqliteMaterialsRepository(conn)
        materials = MaterialsSetFactory.initial(
            tenant_id=LOCAL_TENANT,
            job_id=JobId(url),
            created_at="2026-05-21T20:00:00+00:00",
        ).with_resume_attempt(
            _artifact(ArtifactType.TAILORED_RESUME, "/tmp/resume.txt", RenderFormat.TEXT),
            validation=ValidationResult.success(),
            verdict=JudgeVerdict.passed(),
            updated_at="2026-05-21T20:00:30+00:00",
        ).with_resume_pdf(
            _artifact(ArtifactType.RESUME_PDF, "/tmp/resume.pdf", RenderFormat.LATEX_PDF),
            updated_at="2026-05-21T20:00:40+00:00",
        )
        repo.save(materials)
        set_stage_state(
            conn,
            url,
            "tailor",
            "failed",
            attempt_count=1,
            error_code="ORPHANED_STAGE_RUN",
            error_message="tailor stage was left running by a prior worker.",
            retryable=True,
            validate_transition=False,
        )
        conn.commit()

        recovered = recover_orphaned_running_stages(
            conn,
            now=datetime(2026, 5, 21, 20, 10, 0, tzinfo=timezone.utc),
            stale_after_seconds=150,
            started_before=datetime(2026, 5, 21, 20, 2, 0, tzinfo=timezone.utc),
        )

        assert recovered == 1
        recovered_row = conn.execute(
            """
            SELECT state, error_code, error_message, retryable
            FROM job_stage_states
            WHERE job_url = ? AND stage = 'tailor'
            """,
            (url,),
        ).fetchone()
        assert recovered_row["state"] == "succeeded"
        assert recovered_row["error_code"] is None
        assert recovered_row["error_message"] is None
        assert recovered_row["retryable"] == 0
    finally:
        close_connection(db_path)


def test_recover_orphaned_discovery_runs_marks_stale_pipeline_progress_failed(tmp_path: Path) -> None:
    db_path = tmp_path / "jobhunter.db"
    conn = init_db(db_path)
    old_run_id = "discovery:smartextract:old"
    current_worker_run_id = "discovery:workday:current-worker"
    fresh_run_id = "discovery:jobspy:fresh"

    try:
        conn.execute(
            """
            INSERT INTO discovery_runs (
                tenant_id, run_id, source_ids_json, profile_snapshot_id,
                status, counts_json, error_classes_json, started_at,
                completed_at, failed_at
            ) VALUES
              ('local', ?, ?, NULL, 'running', ?, '[]', ?, NULL, NULL),
              ('local', ?, ?, NULL, 'running', '{}', '[]', ?, NULL, NULL),
              ('local', ?, ?, NULL, 'running', '{}', '[]', ?, NULL, NULL)
            """,
            (
                old_run_id,
                json.dumps(["smart_extract:talent-com", "smart_extract:simplyhired"]),
                json.dumps({"total": 0, "new_jobs": 0}),
                "2026-05-21T20:00:00+00:00",
                current_worker_run_id,
                json.dumps(["workday:acme"]),
                "2026-05-21T20:03:00+00:00",
                fresh_run_id,
                json.dumps(["jobspy:linkedin"]),
                "2026-05-21T20:09:00+00:00",
            ),
        )
        conn.commit()

        recovered = recover_orphaned_discovery_runs(
            conn,
            now=datetime(2026, 5, 21, 20, 10, 0, tzinfo=timezone.utc),
            stale_after_seconds=150,
            started_before=datetime(2026, 5, 21, 20, 2, 0, tzinfo=timezone.utc),
        )

        assert recovered == 1
        old_row = conn.execute(
            """
            SELECT status, failed_at, updated_at, error_classes_json
            FROM discovery_runs
            WHERE run_id = ?
            """,
            (old_run_id,),
        ).fetchone()
        assert old_row["status"] == "failed"
        assert old_row["failed_at"] == "2026-05-21T20:10:00+00:00"
        assert old_row["updated_at"] == "2026-05-21T20:10:00+00:00"
        assert json.loads(old_row["error_classes_json"]) == ["ORPHANED_DISCOVERY_RUN"]

        fresh_row = conn.execute(
            "SELECT status FROM discovery_runs WHERE run_id = ?",
            (fresh_run_id,),
        ).fetchone()
        assert fresh_row["status"] == "running"

        current_worker_row = conn.execute(
            "SELECT status FROM discovery_runs WHERE run_id = ?",
            (current_worker_run_id,),
        ).fetchone()
        assert current_worker_row["status"] == "running"

        events = conn.execute(
            """
            SELECT event_type, level, message, payload_json
            FROM job_events
            WHERE stage = 'discover'
            ORDER BY event_id
            """
        ).fetchall()
        assert [event["event_type"] for event in events] == [
            "DiscoveryRunFailed",
            "StageFailed",
        ]
        assert all(event["level"] == "error" for event in events)
        assert events[1]["message"] == (
            "Smart extract is not running. Smart extract is ready to run again."
        )
        payload = json.loads(events[1]["payload_json"])
        assert payload["errorCode"] == "ORPHANED_DISCOVERY_RUN"
        assert payload["progress"] == {
            "completed": 3,
            "total": 5,
            "percent": 60,
            "currentStep": "Smart extract",
            "status": "failed",
            "message": "Smart extract is ready to run again.",
        }

        metric = conn.execute(
            """
            SELECT stage, attempt_kind, outcome, failure_category,
                   is_operational_failure, is_scrape_failure, is_retryable,
                   run_id, adapter, error_class
            FROM operational_attempt_metrics
            WHERE run_id = ?
            ORDER BY metric_id DESC LIMIT 1
            """,
            (old_run_id,),
        ).fetchone()
        assert metric["attempt_kind"] == "orphan_recovery"
        assert metric["outcome"] == "failed"
        assert metric["failure_category"] == "orphaned_discovery_run"
        assert metric["is_operational_failure"] == 1
        assert metric["is_scrape_failure"] == 1
        assert metric["is_retryable"] == 1
        assert metric["adapter"] == "smartextract"
        assert metric["error_class"] == "ORPHANED_DISCOVERY_RUN"
    finally:
        close_connection(db_path)
