"""PR 4 regressions for ``jobhunter.apply.launcher``.

The bespoke ``apply_runs`` table is gone; the canonical lock now lives
on ``job_stage_states.apply.state`` and the lifecycle is observable via
the ``apply_run_projections`` table (sourced from ``job_events``).
These tests cover the launcher contract that downstream callers
(``cli.py``, ``actions.py``, ``pipeline.py``) still rely on.
"""

from __future__ import annotations

from pathlib import Path

from jobhunter.apply.launcher import acquire_job, mark_result
from jobhunter.database import close_connection, get_connection, init_db
from jobhunter.infrastructure.projections.projection_builder import ProjectionBuilder
from jobhunter.state import ensure_job_stage_rows, record_job_event, set_stage_state


def _insert_ready_job(conn, *, url: str = "https://example.com/job") -> None:
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
    conn.commit()


def test_targeted_apply_takes_canonical_stage_lock(tmp_path, monkeypatch):
    """The lock now lives on ``job_stage_states.apply.state == 'running'``.
    Legacy ``jobs.apply_status`` stays NULL."""
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)

    try:
        monkeypatch.setattr(
            "jobhunter.apply.launcher.get_connection", lambda: get_connection(db_path)
        )
        job = acquire_job(target_url="https://example.com/job", worker_id=1)
        assert job is not None
        assert job["url"] == "https://example.com/job"
        # Legacy column stays NULL on the new path.
        legacy = conn.execute(
            "SELECT apply_status FROM jobs WHERE url = ?", (job["url"],)
        ).fetchone()
        assert legacy["apply_status"] is None
        # Canonical lock: stage row in 'running'.
        stage = conn.execute(
            "SELECT state FROM job_stage_states "
            "WHERE job_url = ? AND stage = 'apply'",
            (job["url"],),
        ).fetchone()
        assert stage is not None
        assert stage["state"] == "running"
        # ApplyRunStarted event recorded with the same run_id.
        evt = conn.execute(
            "SELECT payload_json FROM job_events "
            "WHERE job_url = ? AND event_type = 'ApplyRunStarted' "
            "ORDER BY event_id DESC LIMIT 1",
            (job["url"],),
        ).fetchone()
        assert evt is not None
        import json

        payload = json.loads(evt["payload_json"])
        assert payload["run_id"] == job["apply_run_id"]
    finally:
        close_connection(db_path)


def test_acquire_job_promotes_prior_apply_run_into_row_dict(tmp_path, monkeypatch):
    """When a prior failed apply run exists in ``apply_run_projections``,
    ``acquire_job`` promotes its status into the legacy
    ``apply_status`` slot."""
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)
    # Seed prior failed apply via the canonical writer + projector.
    ensure_job_stage_rows(conn, "https://example.com/job")
    set_stage_state(
        conn,
        "https://example.com/job",
        "apply",
        "failed",
        finished_at="2026-01-01T00:01:00+00:00",
        attempt_count=1,
        validate_transition=False,
    )
    record_job_event(
        conn,
        "https://example.com/job",
        "apply",
        "ApplyRunStarted",
        payload={
            "run_id": "run-prior",
            "started_at": "2026-01-01T00:00:00+00:00",
        },
    )
    record_job_event(
        conn,
        "https://example.com/job",
        "apply",
        "ApplicationFailed",
        payload={
            "run_id": "run-prior",
            "finished_at": "2026-01-01T00:01:00+00:00",
            "result": "failed",
        },
    )
    conn.commit()
    ProjectionBuilder(conn).refresh()
    try:
        monkeypatch.setattr(
            "jobhunter.apply.launcher.get_connection", lambda: get_connection(db_path)
        )
        job = acquire_job(target_url="https://example.com/job", worker_id=1)
        assert job is not None
        assert job["apply_status"] == "failed"
        assert job["apply_attempts"] == 1
        assert job["applied_at"] is None
    finally:
        close_connection(db_path)


def test_acquire_job_finds_new_path_enriched_job(tmp_path, monkeypatch):
    """``acquire_job`` must find jobs whose ``application_url`` lives
    only in ``job_enrichments`` (the new write path leaves
    ``jobs.application_url`` NULL)."""
    from jobhunter.domain.enrichment import (
        ApplicationUrl,
        ExtractionTier,
        FullDescription,
        JobEnrichment,
    )
    from jobhunter.domain.identifiers import JobId
    from jobhunter.domain.tenant import LOCAL_TENANT
    from jobhunter.infrastructure.enrichment import SqliteEnrichmentRepository

    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    url = "https://example.com/new-path-job"
    conn.execute(
        "INSERT INTO jobs (url, title, site, fit_score, tailored_resume_path) "
        "VALUES (?, ?, ?, ?, ?)",
        (url, "New Path Engineer", "ExampleCo", 9, "/tmp/resume.txt"),
    )
    conn.commit()

    repo = SqliteEnrichmentRepository(conn)
    repo.save(
        JobEnrichment.empty(
            tenant_id=LOCAL_TENANT, job_id=JobId(url), updated_at="t0"
        )
        .start_attempt(extraction_tier=ExtractionTier.JSON_LD, started_at="t0")
        .succeed_attempt(
            full_description=FullDescription(text="Build distributed systems."),
            application_url=ApplicationUrl(value="https://example.com/apply-new"),
            extraction_tier=ExtractionTier.JSON_LD,
            finished_at="t1",
        )
    )
    legacy = conn.execute(
        "SELECT application_url FROM jobs WHERE url = ?", (url,)
    ).fetchone()
    assert legacy["application_url"] is None

    try:
        monkeypatch.setattr(
            "jobhunter.apply.launcher.get_connection", lambda: get_connection(db_path)
        )
        job = acquire_job(target_url=url, worker_id=1)
        assert job is not None
        assert job["url"] == url
        assert job["application_url"] == "https://example.com/apply-new"
        assert job["full_description"] == "Build distributed systems."
    finally:
        close_connection(db_path)


def test_dry_run_result_does_not_mark_job_applied(tmp_path, monkeypatch):
    """A dry-run result writes a ``DryRunCompleted`` event whose
    projection has ``status='dry_run_complete'`` and ``dry_run=1``.
    The legacy ``jobs.apply_*`` columns stay NULL.
    """
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)

    try:
        monkeypatch.setattr(
            "jobhunter.apply.launcher.get_connection", lambda: get_connection(db_path)
        )
        mark_result(
            "https://example.com/job",
            "dry_run",
            duration_ms=123,
            task_id="run-test",
        )
        ProjectionBuilder(get_connection(db_path)).refresh()

        row = conn.execute(
            "SELECT apply_status, applied_at, apply_task_id FROM jobs WHERE url = ?",
            ("https://example.com/job",),
        ).fetchone()
        state = conn.execute(
            "SELECT state, error_code FROM job_stage_states "
            "WHERE job_url = ? AND stage = 'apply'",
            ("https://example.com/job",),
        ).fetchone()
        # Legacy columns stay NULL on the new write path.
        assert row["apply_status"] is None
        assert row["applied_at"] is None
        assert row["apply_task_id"] is None
        assert state["state"] == "skipped"
        assert state["error_code"] == "DRY_RUN"
        # Canonical: an apply_run_projections row in dry_run_complete.
        ar = conn.execute(
            "SELECT run_id, status, dry_run FROM apply_run_projections "
            "WHERE job_id = ?",
            ("https://example.com/job",),
        ).fetchone()
        assert ar is not None
        assert ar["status"] == "dry_run_complete"
        assert ar["dry_run"] == 1
        assert ar["run_id"] == "run-test"
    finally:
        close_connection(db_path)
