"""PR 7 of the Temporal stack — apply logs as ``job_artifacts`` rows.

The launcher now registers each apply run's per-worker log file
(``LOG_DIR/worker-{worker_id}.log`` — written by
``ClaudeCodeCliAdapter``) as a ``job_artifacts`` row of kind
``apply_log`` so the artifacts list reflects what the agent produced
on disk. The legacy ``apply_runs.log_path`` string column was dropped
in PR 4; this PR replaces it with a real artifact row that the
existing ``artifact_list_projections`` projector picks up.
"""

from __future__ import annotations

import json
from pathlib import Path

from jobctrl import config
from jobctrl.apply.launcher import SqliteApplyRunRepository, mark_result
from jobctrl.database import close_connection, get_connection, init_db
from jobctrl.domain.apply import ApplyRun, ApplyRunId, DryRunComplete
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
from jobctrl.state import ensure_job_stage_rows, set_stage_state


def _insert_running_apply_job(
    conn, *, url: str = "https://example.com/job"
) -> None:
    """Seed a job whose apply stage is already ``running`` — the only
    state from which ``mark_result`` can validly transition to
    succeeded / failed per the §8.5 state machine table."""
    conn.execute(
        """
        INSERT INTO jobs (
            url, title, site, full_description, application_url,
            fit_score, tailored_resume_path, cover_letter_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            url,
            "Platform Engineer",
            "ExampleCo",
            "Build distributed systems.",
            "https://example.com/apply",
            9,
            "/tmp/resume.txt",
            "/tmp/cover.txt",
        ),
    )
    ensure_job_stage_rows(conn, url)
    set_stage_state(conn, url, "apply", "running", attempt_count=1)
    conn.commit()


def test_mark_result_applied_registers_apply_log_artifact(
    tmp_path, monkeypatch
):
    """A successful apply run records its per-worker log file as a
    ``job_artifacts`` row of kind ``apply_log``, with the worker_id
    surfaced in metadata, and the artifact appears in
    ``artifact_list_projections`` after the projection refresh fires.
    """
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_running_apply_job(conn)

    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    monkeypatch.setattr(config, "LOG_DIR", log_dir)
    # Simulate the on-disk log file that ``ClaudeCodeCliAdapter`` would
    # have appended during the run.
    (log_dir / "worker-3.log").write_text("agent ran here\n", encoding="utf-8")

    try:
        monkeypatch.setattr(
            "jobctrl.apply.launcher.get_connection",
            lambda: get_connection(db_path),
        )
        mark_result(
            "https://example.com/job",
            "applied",
            duration_ms=1234,
            task_id="run-applied",
            run_ctx={"run_id": "run-applied", "worker_id": 3, "model": "haiku"},
        )

        artifact_row = conn.execute(
            "SELECT job_id, stage, artifact_type, status, path, size_bytes "
            "FROM job_artifacts WHERE tenant_id = 'local' "
            "AND job_id = (SELECT job_id FROM jobs WHERE url = ?) "
            "AND artifact_type = 'apply_log'",
            ("https://example.com/job",),
        ).fetchone()
        assert artifact_row is not None
        assert artifact_row["stage"] == "apply"
        assert artifact_row["status"] == "active"
        assert artifact_row["path"] == str(log_dir / "worker-3.log")
        assert artifact_row["size_bytes"] == len("agent ran here\n")

        ProjectionBuilder(conn_factory=lambda: get_connection(db_path)).refresh()
        proj_rows = conn.execute(
            "SELECT artifact_type, local_path, size_bytes "
            "FROM artifact_list_projections "
            "WHERE job_id = ? AND artifact_type = 'apply_log'",
            ("https://example.com/job",),
        ).fetchall()
        assert len(proj_rows) == 1
        assert proj_rows[0]["local_path"] == str(log_dir / "worker-3.log")
        assert proj_rows[0]["size_bytes"] == len("agent ran here\n")
    finally:
        close_connection(db_path)


def test_mark_result_failed_registers_apply_log_artifact(tmp_path, monkeypatch):
    """A failed apply run also registers its per-worker log file —
    failure logs are exactly when an operator most wants the artifact
    surfaced in the UI.
    """
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_running_apply_job(conn)

    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    monkeypatch.setattr(config, "LOG_DIR", log_dir)
    (log_dir / "worker-7.log").write_text("agent crashed\n", encoding="utf-8")

    try:
        monkeypatch.setattr(
            "jobctrl.apply.launcher.get_connection",
            lambda: get_connection(db_path),
        )
        mark_result(
            "https://example.com/job",
            "failed",
            error="captcha",
            permanent=True,
            duration_ms=5678,
            task_id="run-failed",
            run_ctx={"run_id": "run-failed", "worker_id": 7},
        )

        row = conn.execute(
            "SELECT path, size_bytes FROM job_artifacts "
            "WHERE tenant_id = 'local' "
            "AND job_id = (SELECT job_id FROM jobs WHERE url = ?) "
            "AND artifact_type = 'apply_log'",
            ("https://example.com/job",),
        ).fetchone()
        assert row is not None
        assert row["path"] == str(log_dir / "worker-7.log")
        assert row["size_bytes"] == len("agent crashed\n")
    finally:
        close_connection(db_path)


def test_mark_result_dry_run_registers_apply_log_artifact(
    tmp_path, monkeypatch
):
    """Dry-run completions also surface the worker log so the operator
    can inspect what the agent did without applying.
    """
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_running_apply_job(conn)

    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    monkeypatch.setattr(config, "LOG_DIR", log_dir)
    (log_dir / "worker-0.log").write_text("dry run\n", encoding="utf-8")

    try:
        monkeypatch.setattr(
            "jobctrl.apply.launcher.get_connection",
            lambda: get_connection(db_path),
        )
        mark_result(
            "https://example.com/job",
            "dry_run",
            duration_ms=42,
            task_id="run-dry",
            run_ctx={"run_id": "run-dry", "worker_id": 0, "dry_run": True},
        )

        row = conn.execute(
            "SELECT path FROM job_artifacts "
            "WHERE tenant_id = 'local' "
            "AND job_id = (SELECT job_id FROM jobs WHERE url = ?) "
            "AND artifact_type = 'apply_log'",
            ("https://example.com/job",),
        ).fetchone()
        assert row is not None
        assert row["path"] == str(log_dir / "worker-0.log")
    finally:
        close_connection(db_path)


def test_repository_persists_dry_run_blocked_channel_artifact(
    tmp_path, monkeypatch
):
    """Blocked browser channels are durable local evidence for the dry-run gate."""
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_running_apply_job(conn)

    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    monkeypatch.setattr(config, "LOG_DIR", log_dir)

    try:
        monkeypatch.setattr(
            "jobctrl.apply.launcher.get_connection",
            lambda: get_connection(db_path),
        )
        run = ApplyRun.start(
            tenant_id=LOCAL_TENANT,
            run_id=ApplyRunId("run-dry-blocked"),
            job_id=JobId("https://example.com/job"),
            started_at="2026-07-06T10:00:00+00:00",
            worker_id=1,
            model="haiku",
            dry_run=True,
        )
        run = run.record_event(
            event_type="DryRunBlockedChannels",
            occurred_at="2026-07-06T10:00:01+00:00",
            level="warn",
            payload={
                "coverage": "partial",
                "blocked_channels": ["network:POST"],
                "blocked_requests": [
                    {
                        "channel": "network",
                        "method": "POST",
                        "url": "https://example.com/apply",
                        "resource_type": "Fetch",
                    }
                ],
            },
        )
        run = run.complete(
            result=DryRunComplete(
                navigated_to="https://example.com/job",
                coverage="partial",
                blocked_channels=("network:POST",),
            ),
            finished_at="2026-07-06T10:00:02+00:00",
        )

        SqliteApplyRunRepository().save(run)

        row = conn.execute(
            "SELECT path, metadata_json FROM job_artifacts "
            "WHERE tenant_id = 'local' "
            "AND job_id = (SELECT job_id FROM jobs WHERE url = ?) "
            "AND artifact_type = 'apply_dryrun_blocked'",
            ("https://example.com/job",),
        ).fetchone()
        assert row is not None
        artifact_path = Path(row["path"])
        assert artifact_path.exists()
        assert json.loads(row["metadata_json"]) == {
            "run_id": "run-dry-blocked",
            "coverage": "partial",
            "blocked_count": 1,
        }
        assert json.loads(artifact_path.read_text(encoding="utf-8")) == {
            "run_id": "run-dry-blocked",
            "coverage": "partial",
            "blocked_channels": ["network:POST"],
            "blocked_requests": [
                {
                    "channel": "network",
                    "method": "POST",
                    "url": "https://example.com/apply",
                    "resource_type": "Fetch",
                }
            ],
        }
    finally:
        close_connection(db_path)


def test_mark_result_without_worker_id_skips_artifact_registration(
    tmp_path, monkeypatch
):
    """Manual ``mark_result`` calls (``actions.py``, ``mark_job``) do
    not carry a ``worker_id`` and therefore have no derivable on-disk
    log path. The launcher must NOT fabricate a fake artifact row in
    that case — leave ``job_artifacts`` empty.
    """
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_running_apply_job(conn)

    try:
        monkeypatch.setattr(
            "jobctrl.apply.launcher.get_connection",
            lambda: get_connection(db_path),
        )
        # No run_ctx -> worker_id is None.
        mark_result(
            "https://example.com/job",
            "applied",
            duration_ms=0,
            task_id="run-manual",
        )

        rows = conn.execute(
            "SELECT 1 FROM job_artifacts WHERE tenant_id = 'local' "
            "AND job_id = (SELECT job_id FROM jobs WHERE url = ?) "
            "AND artifact_type = 'apply_log'",
            ("https://example.com/job",),
        ).fetchall()
        assert rows == []
    finally:
        close_connection(db_path)


def test_mark_result_apply_log_registration_is_idempotent(
    tmp_path, monkeypatch
):
    """Two apply runs from the same worker share one log file (the
    adapter appends to ``worker-{id}.log``). The artifact row must
    UPSERT — exactly one ``apply_log`` artifact per (job, path) survives,
    with the latest size_bytes reflected.
    """
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_running_apply_job(conn)

    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    monkeypatch.setattr(config, "LOG_DIR", log_dir)
    log_path = log_dir / "worker-1.log"
    log_path.write_text("first run\n", encoding="utf-8")

    try:
        monkeypatch.setattr(
            "jobctrl.apply.launcher.get_connection",
            lambda: get_connection(db_path),
        )
        mark_result(
            "https://example.com/job",
            "failed",
            error="captcha",
            duration_ms=10,
            task_id="run-1",
            run_ctx={"run_id": "run-1", "worker_id": 1},
        )

        # Reset back to running so the second mark_result is a valid
        # state-machine transition (the canonical lifecycle is
        # acquire_job -> mark_result -> reset -> acquire_job -> mark_result;
        # this test compresses those steps).
        set_stage_state(
            conn,
            "https://example.com/job",
            "apply",
            "pending",
            validate_transition=False,
        )
        set_stage_state(
            conn,
            "https://example.com/job",
            "apply",
            "running",
            attempt_count=2,
        )
        conn.commit()

        # Append more bytes to the same log (mimicking a second apply
        # run on the same worker).
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write("second run\n")

        mark_result(
            "https://example.com/job",
            "applied",
            duration_ms=20,
            task_id="run-2",
            run_ctx={"run_id": "run-2", "worker_id": 1},
        )

        rows = conn.execute(
            "SELECT path, size_bytes FROM job_artifacts "
            "WHERE tenant_id = 'local' "
            "AND job_id = (SELECT job_id FROM jobs WHERE url = ?) "
            "AND artifact_type = 'apply_log'",
            ("https://example.com/job",),
        ).fetchall()
        assert len(rows) == 1
        # Reflects the appended file size.
        assert rows[0]["size_bytes"] == log_path.stat().st_size
    finally:
        close_connection(db_path)
