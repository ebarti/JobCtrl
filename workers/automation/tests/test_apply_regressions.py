"""PR 4 regressions for ``jobhunter.apply.launcher``.

The bespoke ``apply_runs`` table is gone; the canonical lock now lives
on ``job_stage_states.apply.state`` and the lifecycle is observable via
the ``apply_run_projections`` table (sourced from ``job_events``).
These tests cover the launcher contract that downstream callers
(``cli.py``, ``actions.py``, ``pipeline.py``) still rely on.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from unittest.mock import patch

from jobhunter.apply.launcher import (
    _rescue_orphaned_running_apply,
    acquire_job,
    mark_result,
    release_lock,
    worker_loop,
)
from jobhunter.database import close_connection, get_connection, init_db
from jobhunter.infrastructure.projections.projection_builder import ProjectionBuilder
from jobhunter.state import ensure_job_stage_rows, record_job_event, set_stage_state, utc_now


def _insert_ready_job(
    conn,
    *,
    url: str = "https://example.com/job",
    application_url: str | None = "https://example.com/apply",
) -> None:
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
            application_url,
            9,
            "/tmp/resume.txt",
            "/tmp/cover.txt",
        ),
    )
    conn.commit()


def _insert_single_job_tailor_candidate(
    conn, *, url: str = "https://example.com/job"
) -> None:
    conn.execute(
        """
        INSERT INTO jobs (
            url, title, site, full_description, application_url, fit_score
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            url,
            "Platform Engineer",
            "ExampleCo",
            "Build distributed systems.",
            "https://example.com/apply",
            9,
        ),
    )
    conn.commit()


def _insert_blocked_score(conn, url: str, *, fit_score: int = 9) -> None:
    conn.execute(
        """
        INSERT INTO job_scores (
            job_url, version, tenant_id, fit_score, breakdown_json,
            keywords_json, scored_at, correction_json, criteria_json, trace_json
        ) VALUES (?, 1, 'local', ?, ?, '["python"]', ?, NULL, '{}', '{}')
        """,
        (
            url,
            fit_score,
            json.dumps(
                {
                    "reasoning": "Strong match with a hard blocker.",
                    "eligibility": {
                        "status": "blocked",
                        "hard_blockers": ["No sponsorship."],
                        "warnings": [],
                    },
                },
                sort_keys=True,
            ),
            "2026-05-14T00:00:00+00:00",
        ),
    )
    conn.commit()


def _mark_closed(conn: sqlite3.Connection, url: str, state: str = "removed") -> None:
    conn.execute(
        """
        INSERT INTO posting_snapshot_sets (
            tenant_id, job_url, snapshot_set_json, latest_snapshot_version,
            latest_active_state, updated_at
        ) VALUES ('local', ?, '{}', 0, ?, ?)
        ON CONFLICT(tenant_id, job_url) DO UPDATE SET
            latest_active_state = excluded.latest_active_state,
            updated_at = excluded.updated_at
        """,
        (url, state, utc_now()),
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


def test_acquire_job_accepts_posting_url_when_direct_apply_url_missing(tmp_path, monkeypatch):
    """The agent can start from the posting URL and click through to Apply."""
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(
        conn,
        url="https://example.com/posting-only",
        application_url=None,
    )

    try:
        monkeypatch.setattr(
            "jobhunter.apply.launcher.get_connection", lambda: get_connection(db_path)
        )
        job = acquire_job(worker_id=1)
        assert job is not None
        assert job["url"] == "https://example.com/posting-only"
        assert job["application_url"] is None
    finally:
        close_connection(db_path)


def test_worker_loop_delegates_browser_lifecycle_to_apply_saga(monkeypatch):
    """The worker loop should not launch Chrome before ``run_job``.

    ``run_job`` now drives ``SubmitApplicationUseCase`` and ``ApplySaga``,
    whose browser port owns launch/cleanup. Keeping the legacy outer launch
    path would boot Chrome twice on the same CDP port.
    """

    job = {
        "url": "https://example.com/job",
        "title": "Platform Engineer",
        "site": "ExampleCo",
        "application_url": None,
        "tailored_resume_path": "/tmp/resume.txt",
        "fit_score": 9,
    }
    acquired = {"used": False}
    marked = {}

    def fake_acquire_job(**_kwargs):
        if acquired["used"]:
            return None
        acquired["used"] = True
        return job

    def forbidden_outer_launch(*_args, **_kwargs):
        raise AssertionError("worker_loop must not launch Chrome directly")

    def fake_run_job(*_args, **_kwargs):
        return "dry_run", 10

    def fake_mark_result(url, status, **kwargs):
        marked["url"] = url
        marked["status"] = status
        marked["duration_ms"] = kwargs.get("duration_ms")

    monkeypatch.setattr("jobhunter.apply.launcher.acquire_job", fake_acquire_job)
    monkeypatch.setattr(
        "jobhunter.apply.launcher.launch_chrome",
        forbidden_outer_launch,
        raising=False,
    )
    monkeypatch.setattr("jobhunter.apply.launcher.run_job", fake_run_job)
    monkeypatch.setattr("jobhunter.apply.launcher.mark_result", fake_mark_result)

    applied, failed = worker_loop(worker_id=0, limit=1, dry_run=True, snapshot=object())

    assert (applied, failed) == (0, 0)
    assert marked == {
        "url": "https://example.com/job",
        "status": "dry_run",
        "duration_ms": 10,
    }


def test_acquire_job_excludes_high_score_blocked_candidates(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn, url="https://example.com/allowed")
    _insert_ready_job(conn, url="https://example.com/blocked")
    _insert_blocked_score(conn, "https://example.com/blocked", fit_score=10)

    try:
        monkeypatch.setattr(
            "jobhunter.apply.launcher.get_connection", lambda: get_connection(db_path)
        )
        job = acquire_job(min_score=7, worker_id=1)
        assert job is not None
        assert job["url"] == "https://example.com/allowed"
    finally:
        close_connection(db_path)


def test_acquire_job_excludes_closed_candidates(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn, url="https://example.com/closed")
    _mark_closed(conn, "https://example.com/closed")

    try:
        monkeypatch.setattr(
            "jobhunter.apply.launcher.get_connection", lambda: get_connection(db_path)
        )
        assert acquire_job(min_score=7, worker_id=1) is None
        assert acquire_job(target_url="https://example.com/closed", worker_id=1) is None
    finally:
        close_connection(db_path)


def test_targeted_apply_rejects_blocked_candidate(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn, url="https://example.com/blocked")
    _insert_blocked_score(conn, "https://example.com/blocked", fit_score=10)

    try:
        monkeypatch.setattr(
            "jobhunter.apply.launcher.get_connection", lambda: get_connection(db_path)
        )
        assert acquire_job(target_url="https://example.com/blocked", worker_id=1) is None
    finally:
        close_connection(db_path)


def test_single_job_tailor_rejects_blocked_candidate(tmp_path, monkeypatch):
    import jobhunter.config as config_module
    import jobhunter.database as database_module
    import jobhunter.pipeline.runner as runner_module

    app_dir = Path(tmp_path) / "app"
    resume_path = app_dir / "resume.txt"
    db_path = Path(tmp_path) / "jobs.db"
    app_dir.mkdir()
    resume_path.write_text("Resume baseline.", encoding="utf-8")

    monkeypatch.setattr(config_module, "APP_DIR", app_dir)
    monkeypatch.setattr(config_module, "DB_PATH", db_path)
    monkeypatch.setattr(config_module, "PROFILE_PATH", app_dir / "profile.json")
    monkeypatch.setattr(config_module, "RESUME_PATH", resume_path)
    monkeypatch.setattr(config_module, "TAILORED_DIR", app_dir / "tailored_resumes")
    monkeypatch.setattr(config_module, "COVER_LETTER_DIR", app_dir / "cover_letters")
    monkeypatch.setattr(config_module, "LOG_DIR", app_dir / "logs")
    monkeypatch.setattr(config_module, "ENV_PATH", app_dir / ".env")
    monkeypatch.setattr(database_module, "DB_PATH", db_path)

    conn = init_db(db_path)
    url = "https://example.com/blocked"
    _insert_single_job_tailor_candidate(conn, url=url)
    _insert_blocked_score(conn, url, fit_score=10)

    class FakeProfileRepository:
        def load_snapshot(self, tenant_id):
            return object()

    def fail_tailor(*args, **kwargs):
        raise AssertionError("blocked score must not tailor")

    def fail_cover_use_case(*args, **kwargs):
        raise AssertionError("blocked score must not generate cover letters")

    try:
        monkeypatch.setattr(
            "jobhunter.infrastructure.profile.get_profile_repository",
            lambda: FakeProfileRepository(),
        )
        monkeypatch.setattr("jobhunter.scoring.tailor._tailor_one_job", fail_tailor)
        monkeypatch.setattr(
            "jobhunter.scoring.cover_letter._build_use_case",
            fail_cover_use_case,
        )

        result = runner_module.run_single_job(url, do_tailor=True, do_apply=False)

        assert result["tailor_status"] == "blocked_score_eligibility"
        assert result["cover_status"] == "blocked_score_eligibility"
        assert result["errors"] == [
            "Score eligibility blocks tailoring: No sponsorship."
        ]
        row = conn.execute(
            "SELECT tailored_resume_path, cover_letter_path FROM jobs WHERE url = ?",
            (url,),
        ).fetchone()
        assert row["tailored_resume_path"] is None
        assert row["cover_letter_path"] is None
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
    ProjectionBuilder(conn_factory=lambda: conn).refresh()
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
        ProjectionBuilder(conn_factory=lambda: get_connection(db_path)).refresh()

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


def test_acquire_job_then_mark_result_dry_run_completes_end_to_end(
    tmp_path, monkeypatch
):
    """Reviewer-reported regression (PR 37 High #1): the production
    sequence ``acquire_job`` (Pending -> Running) then
    ``mark_result("dry_run", ...)`` (Running -> Skipped) used to raise
    ``ValueError`` because Running -> Skipped is not in the §8.5
    state-machine table.  The launcher now bypasses validation for the
    dry-run convention.
    """
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)

    try:
        monkeypatch.setattr(
            "jobhunter.apply.launcher.get_connection", lambda: get_connection(db_path)
        )
        run_ctx: dict = {}
        job = acquire_job(
            target_url="https://example.com/job", worker_id=2, run_ctx=run_ctx
        )
        assert job is not None
        # Sanity: the lock acquired -> Running.
        before = conn.execute(
            "SELECT state FROM job_stage_states "
            "WHERE job_url = ? AND stage = 'apply'",
            (job["url"],),
        ).fetchone()
        assert before["state"] == "running"

        # Production sequence -- this used to raise ValueError.
        mark_result(
            job["url"],
            "dry_run",
            duration_ms=42,
            run_ctx=run_ctx,
        )

        # (a) No exception (we got here).
        # (b) Stage row landed on Skipped.
        after = conn.execute(
            "SELECT state, error_code FROM job_stage_states "
            "WHERE job_url = ? AND stage = 'apply'",
            (job["url"],),
        ).fetchone()
        assert after["state"] == "skipped"
        assert after["error_code"] == "DRY_RUN"

        # (c) apply_run_projections has a row for the run_id with dry_run=1
        # and a sensible terminal status, after refresh.
        ProjectionBuilder(conn_factory=lambda: get_connection(db_path)).refresh()
        ar = conn.execute(
            "SELECT run_id, status, dry_run FROM apply_run_projections "
            "WHERE job_id = ?",
            (job["url"],),
        ).fetchone()
        assert ar is not None
        assert ar["run_id"] == run_ctx["run_id"]
        assert ar["dry_run"] == 1
        assert ar["status"] == "dry_run_complete"
    finally:
        close_connection(db_path)


def test_release_lock_releases_running_row_back_to_pending(tmp_path, monkeypatch):
    """Reviewer-reported regression (PR 37 High #2): ``release_lock``
    used to raise ``ValueError: Invalid state transition for apply:
    running -> pending`` because Running -> Pending is not in §8.5.
    """
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)

    try:
        monkeypatch.setattr(
            "jobhunter.apply.launcher.get_connection", lambda: get_connection(db_path)
        )
        run_ctx: dict = {}
        job = acquire_job(
            target_url="https://example.com/job", worker_id=3, run_ctx=run_ctx
        )
        assert job is not None
        before = conn.execute(
            "SELECT state FROM job_stage_states "
            "WHERE job_url = ? AND stage = 'apply'",
            (job["url"],),
        ).fetchone()
        assert before["state"] == "running"

        # Used to raise ValueError; now bypasses validation.
        release_lock(job["url"], run_ctx=run_ctx)

        after = conn.execute(
            "SELECT state FROM job_stage_states "
            "WHERE job_url = ? AND stage = 'apply'",
            (job["url"],),
        ).fetchone()
        assert after["state"] == "pending"
    finally:
        close_connection(db_path)


def test_orphan_rescue_keeps_original_run_id(tmp_path, monkeypatch):
    """Reviewer-reported regression (PR 37 Medium #1): the orphan
    rescue path used to mint a fresh ``run_id`` via ``new_apply_run_id()``
    and write the terminal ``ApplicationFailed`` event under it,
    leaving the ORIGINAL ``ApplyRunStarted`` row stuck in
    ``status='starting'`` forever.  ``release_lock`` now looks up the
    prior ``ApplyRunStarted`` event for the URL and reuses its
    ``run_id`` when no ``run_ctx`` is provided.
    """
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)

    try:
        monkeypatch.setattr(
            "jobhunter.apply.launcher.get_connection", lambda: get_connection(db_path)
        )
        # 1. Acquire (writes ApplyRunStarted with the canonical run_id +
        #    flips stage to running).
        run_ctx: dict = {}
        job = acquire_job(
            target_url="https://example.com/job", worker_id=5, run_ctx=run_ctx
        )
        assert job is not None
        original_run_id = run_ctx["run_id"]
        assert original_run_id

        # 2. Simulate orphan rescue (no run_ctx — same shape the
        #    sweep in ``_rescue_orphaned_running_apply`` uses).
        release_lock(job["url"])

        # 3. Refresh the projection.
        ProjectionBuilder(conn_factory=lambda: get_connection(db_path)).refresh()

        # 4. The projection row uses the ORIGINAL run_id and is failed.
        rows = conn.execute(
            "SELECT run_id, status FROM apply_run_projections WHERE job_id = ?",
            (job["url"],),
        ).fetchall()
        assert len(rows) == 1
        row = rows[0]
        assert row["run_id"] == original_run_id
        assert row["status"] == "failed"
    finally:
        close_connection(db_path)


def test_orphan_rescue_continues_past_failing_row(tmp_path, monkeypatch):
    """Reviewer-reported regression (PR 37 High #2): one bad row used
    to abort the entire orphan sweep via the outer ``try/except`` in
    ``_rescue_orphaned_running_apply``.  The sweep now catches per-row
    exceptions and continues so all healthy orphans are rescued.
    """
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    # Two ready jobs, both put into running state directly so the rescue
    # finds them as orphans on a fresh worker boot.
    for url in (
        "https://example.com/job-a",
        "https://example.com/job-b",
    ):
        conn.execute(
            "INSERT INTO jobs (url, title, site, fit_score, tailored_resume_path, "
            "application_url) VALUES (?, ?, ?, ?, ?, ?)",
            (url, "Engineer", "ExampleCo", 9, "/tmp/r.txt", url),
        )
        ensure_job_stage_rows(conn, url)
        set_stage_state(
            conn,
            url,
            "apply",
            "running",
            attempt_count=1,
            started_at="2026-01-01T00:00:00+00:00",
            validate_transition=False,
        )
    conn.commit()

    try:
        monkeypatch.setattr(
            "jobhunter.apply.launcher.get_connection", lambda: get_connection(db_path)
        )

        # Inject a failure for the FIRST URL while letting the second
        # succeed: patch ``release_lock`` so it raises only for job-a.
        original_release_lock = release_lock

        def flaky_release_lock(url, run_ctx=None):
            if url == "https://example.com/job-a":
                raise RuntimeError("simulated per-row failure")
            return original_release_lock(url, run_ctx=run_ctx)

        with patch(
            "jobhunter.apply.launcher.release_lock", side_effect=flaky_release_lock
        ):
            from rich.console import Console

            rescued = _rescue_orphaned_running_apply(Console(quiet=True))

        # Exactly the healthy row was rescued; the failing row's
        # exception didn't poison the loop.
        assert rescued == 1
        states = {
            row["job_url"]: row["state"]
            for row in conn.execute(
                "SELECT job_url, state FROM job_stage_states WHERE stage = 'apply'"
            ).fetchall()
        }
        assert states["https://example.com/job-a"] == "running"
        assert states["https://example.com/job-b"] == "pending"
    finally:
        close_connection(db_path)


def test_acquire_job_concurrent_workers_only_one_succeeds(tmp_path, monkeypatch):
    """Reviewer-reported brief item (PR 37 Medium #2): the lock moved
    from per-run ``apply_runs`` rows to per-job-stage
    ``job_stage_states.apply.state == 'running'`` UPSERTed inside
    ``BEGIN IMMEDIATE``.  Two concurrent workers MUST NOT both succeed.
    """
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)
    close_connection(db_path)  # workers create thread-local connections

    try:
        # Each worker thread MUST hold its own thread-local SQLite
        # connection (SQLite forbids sharing across threads).  The
        # ``get_connection`` helper is already thread-local, so the
        # monkeypatch points each thread to the same DB path.
        monkeypatch.setattr(
            "jobhunter.apply.launcher.get_connection", lambda: get_connection(db_path)
        )

        results: list[dict | None] = []
        results_lock = threading.Lock()
        ready = threading.Event()

        def _worker(worker_id: int) -> None:
            ready.wait()
            try:
                outcome = acquire_job(
                    target_url="https://example.com/job", worker_id=worker_id
                )
            except sqlite3.OperationalError:
                outcome = None
            finally:
                # Don't hold a connection in the worker thread we're
                # about to exit; the cache is per-thread anyway but
                # close keeps state clean for the asserts below.
                close_connection(db_path)
            with results_lock:
                results.append(outcome)

        t1 = threading.Thread(target=_worker, args=(1,))
        t2 = threading.Thread(target=_worker, args=(2,))
        t1.start()
        t2.start()
        ready.set()
        t1.join(timeout=10)
        t2.join(timeout=10)
        assert not t1.is_alive() and not t2.is_alive(), "worker thread hung"

        successes = [r for r in results if r is not None]
        assert len(successes) == 1, (
            f"expected exactly one acquire to succeed, got {len(successes)} "
            f"(results={results!r})"
        )

        # Exactly one ``running`` row in ``job_stage_states.apply``.
        check_conn = get_connection(db_path)
        running_count = check_conn.execute(
            "SELECT COUNT(*) FROM job_stage_states "
            "WHERE job_url = ? AND stage = 'apply' AND state = 'running'",
            ("https://example.com/job",),
        ).fetchone()[0]
        assert running_count == 1
    finally:
        close_connection(db_path)


def test_record_job_event_default_publisher_refreshes_apply_run_projections(
    tmp_path, monkeypatch
):
    """Reviewer-reported regression (PR 37 High #4): ``record_job_event``
    used to require the caller to thread a publisher through to fan out
    via the ``InProcessEventBus``; the projection's wildcard subscriber
    therefore never fired in the launcher's apply path.

    Now ``record_job_event`` defaults to the process-wide publisher,
    so a wildcard subscriber (the projection builder, in production)
    fires on every event.  After ``record_job_event`` returns + the
    projection refresh fires once, the ``apply_run_projections`` row is
    fresh.
    """
    from jobhunter.infrastructure.events import (
        get_default_publisher,
        reset_default_publisher,
    )

    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)
    reset_default_publisher()
    publisher = get_default_publisher()

    fired: list = []

    def _capture(event):
        fired.append(event.event_type)

    publisher.subscribe(None, _capture)

    try:
        record_job_event(
            conn,
            "https://example.com/job",
            "apply",
            "ApplyRunStarted",
            payload={
                "run_id": "run-fresh",
                "started_at": "2026-05-04T13:00:00+00:00",
                "model": "haiku",
                "worker_id": 0,
            },
        )
        conn.commit()
        # The wildcard subscriber fired (default publisher was used).
        assert "ApplyRunStarted" in fired

        record_job_event(
            conn,
            "https://example.com/job",
            "apply",
            "ApplicationSubmitted",
            payload={
                "run_id": "run-fresh",
                "result": "applied",
                "finished_at": "2026-05-04T13:01:00+00:00",
            },
        )
        conn.commit()
        ProjectionBuilder(conn_factory=lambda: conn).refresh()

        ar = conn.execute(
            "SELECT run_id, status FROM apply_run_projections WHERE job_id = ?",
            ("https://example.com/job",),
        ).fetchone()
        assert ar is not None
        assert ar["run_id"] == "run-fresh"
        assert ar["status"] == "succeeded"
    finally:
        reset_default_publisher()
        close_connection(db_path)


def test_record_job_event_from_worker_thread_refreshes_projection(
    tmp_path,
):
    """Reviewer-reported regression (PR 37 High, second iteration):
    when a worker thread calls ``record_job_event`` (now defaulted to
    publish through the bus), the wildcard subscriber
    ``ProjectionBuilder._on_event`` must refresh the projection — even
    though the bootstrap thread that wired the subscriber owns a
    different SQLite connection.

    Without the thread-local connection-factory fix, the subscriber
    blows up with ``sqlite3.ProgrammingError`` (SQLite objects can only
    be used in the thread that created them) and the broad ``except``
    in ``_on_event`` swallows it — the projection never updates.
    """
    import time as _time

    from jobhunter.infrastructure.events import (
        get_default_publisher,
        reset_default_publisher,
    )

    db_path = Path(tmp_path) / "jobs.db"
    bootstrap_conn = init_db(db_path)
    _insert_ready_job(bootstrap_conn)
    reset_default_publisher()

    # Wire the projection builder on the bootstrap thread the same way
    # ``cli._bootstrap`` does in production: pass a thread-local
    # connection factory so the wildcard subscriber can refresh from
    # any worker thread.
    builder = ProjectionBuilder(conn_factory=lambda: get_connection(db_path))
    subscription = builder.subscribe_to(get_default_publisher())

    worker_errors: list[BaseException] = []

    def _worker() -> None:
        try:
            worker_conn = get_connection(db_path)
            # Two events keyed by the same run_id so the projection
            # builder has a complete starting + terminal pair to fold.
            record_job_event(
                worker_conn,
                "https://example.com/job",
                "apply",
                "ApplyRunStarted",
                payload={
                    "run_id": "from-worker",
                    "started_at": "2026-05-04T13:00:00+00:00",
                    "model": "haiku",
                    "worker_id": 7,
                },
            )
            record_job_event(
                worker_conn,
                "https://example.com/job",
                "apply",
                "ApplicationSubmitted",
                payload={
                    "run_id": "from-worker",
                    "result": "applied",
                    "finished_at": "2026-05-04T13:01:00+00:00",
                    "duration_ms": 60000,
                },
            )
            worker_conn.commit()
        except BaseException as exc:  # noqa: BLE001 — propagate to assertions
            worker_errors.append(exc)

    t = threading.Thread(target=_worker, name="apply-worker-1")
    t.start()
    t.join(timeout=5.0)
    assert not t.is_alive(), "worker thread did not finish"
    assert not worker_errors, worker_errors

    try:
        # Poll briefly — the wildcard subscriber commits inline on the
        # worker thread so the projection should land within a tick or
        # two.  1s is plenty.
        deadline = _time.monotonic() + 1.0
        ar = None
        while _time.monotonic() < deadline:
            ar = bootstrap_conn.execute(
                "SELECT run_id, status FROM apply_run_projections "
                "WHERE job_id = ?",
                ("https://example.com/job",),
            ).fetchone()
            if ar is not None:
                break
            _time.sleep(0.05)

        assert ar is not None, (
            "apply_run_projections row never appeared — "
            "the wildcard subscriber did not refresh on the worker thread"
        )
        assert ar["run_id"] == "from-worker"
        assert ar["status"] == "succeeded"
    finally:
        try:
            subscription.unsubscribe()
        except Exception:  # noqa: BLE001
            pass
        reset_default_publisher()
        close_connection(db_path)


def test_apply_saga_writes_full_event_timeline_to_job_events(
    tmp_path, monkeypatch
):
    """Reviewer-reported regression (PR 37 High #3): saga events
    (``SagaStarted`` / ``BrowserLaunched`` / ``AgentStarted`` /
    ``AgentResult`` / per-``AgentEvent``) used to be lost because
    ``_NoopApplyRunRepository.save`` is a no-op AND the use case had
    no publisher.  The launcher now persists the saga's intermediate
    timeline into ``job_events`` after the use case returns, so
    ``apply_run_projections.events_json`` reflects the complete
    timeline.
    """
    from jobhunter.apply.launcher import _persist_saga_event_timeline
    from jobhunter.domain.apply.aggregate import ApplyRun
    from jobhunter.domain.apply.value_objects import (
        Applied,
        ApplyRunId,
        TokenUsage,
    )
    from jobhunter.domain.identifiers import JobId
    from jobhunter.domain.tenant import LOCAL_TENANT

    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)

    try:
        monkeypatch.setattr(
            "jobhunter.apply.launcher.get_connection", lambda: get_connection(db_path)
        )

        # Seed the launcher-emitted ApplyRunStarted (acquire_job's job).
        run_ctx: dict = {}
        job = acquire_job(
            target_url="https://example.com/job", worker_id=1, run_ctx=run_ctx
        )
        assert job is not None
        run_id = run_ctx["run_id"]

        # Build an ApplyRun aggregate that records the saga's
        # intermediate event timeline (mimicking what the saga would
        # produce in production, without the heavyweight Chrome /
        # Claude Code adapters).
        run = ApplyRun.start(
            tenant_id=LOCAL_TENANT,
            run_id=ApplyRunId(run_id),
            job_id=JobId(job["url"]),
            started_at="2026-05-04T13:00:00+00:00",
            worker_id=1,
            model="haiku",
            dry_run=False,
            headless=False,
            attempts=1,
        )
        for event_type, payload in (
            ("SagaStarted", {"job_id": job["url"], "model": "haiku"}),
            ("BrowserLaunched", {"cdp_port": 9222, "pid": 1234}),
            ("AgentStarted", {"model": "haiku"}),
            # Agent-stream events forwarded by the Claude CLI adapter
            # (claude_code_cli.py emits ClaudeLaunched / AssistantText /
            # ToolUse).  Round-2 review (Medium): these used to be
            # dropped by the safelist; now they must land in
            # job_events too.
            ("ClaudeLaunched", {"pid": 4567}),
            ("AssistantText", {"text": "Filling in form"}),
            ("ToolUse", {"name": "browser_action", "input": {"action": "click"}}),
            ("AgentResult", {"kind": "applied", "duration_ms": 1500}),
        ):
            run = run.record_event(
                event_type=event_type,
                occurred_at="2026-05-04T13:00:01+00:00",
                level="info",
                payload=payload,
            )
        run = run.complete(
            result=Applied(applied_at="2026-05-04T13:01:00+00:00", verification_confidence=1.0),
            finished_at="2026-05-04T13:01:00+00:00",
            token_usage=TokenUsage(input=1, output=2, cost_usd=0.01),
            duration_ms=60000,
        )

        # The launcher's helper persists saga events to job_events
        # keyed by run_id.
        _persist_saga_event_timeline(run, run_id=run_id)

        # Mark the terminal applied result via the launcher.
        mark_result(
            job["url"],
            "applied",
            duration_ms=60000,
            run_ctx=run_ctx,
        )

        # The saga's intermediate timeline lands in job_events keyed by run_id.
        events = conn.execute(
            "SELECT event_type, payload_json FROM job_events "
            "WHERE job_url = ? AND stage = 'apply' ORDER BY event_id ASC",
            (job["url"],),
        ).fetchall()
        recorded: dict[str, dict] = {}
        for evt in events:
            payload = json.loads(evt["payload_json"]) if evt["payload_json"] else {}
            recorded.setdefault(evt["event_type"], payload)

        assert "SagaStarted" in recorded, recorded
        assert "BrowserLaunched" in recorded, recorded
        assert "AgentStarted" in recorded, recorded
        assert "AgentResult" in recorded, recorded
        assert "ApplicationSubmitted" in recorded, recorded
        # Round-2 review (Medium): agent-stream events from the CLI
        # adapter must land too.
        assert "ClaudeLaunched" in recorded, recorded
        assert "AssistantText" in recorded, recorded
        assert "ToolUse" in recorded, recorded
        # Each saga event is keyed by the same run_id as the lifecycle.
        for evt_type in (
            "SagaStarted",
            "BrowserLaunched",
            "AgentStarted",
            "AgentResult",
            "ClaudeLaunched",
            "AssistantText",
            "ToolUse",
        ):
            assert recorded[evt_type].get("run_id") == run_id, (evt_type, recorded[evt_type])

        # apply_run_projections.events_json carries the full timeline.
        ProjectionBuilder(conn_factory=lambda: get_connection(db_path)).refresh()
        ar = conn.execute(
            "SELECT events_json, status FROM apply_run_projections WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        assert ar is not None
        assert ar["status"] == "succeeded"
        events_json = json.loads(ar["events_json"]) if ar["events_json"] else []
        event_types = [e.get("event_type") for e in events_json]
        for required in (
            "SagaStarted",
            "BrowserLaunched",
            "AgentStarted",
            "AgentResult",
            "ClaudeLaunched",
            "AssistantText",
            "ToolUse",
        ):
            assert required in event_types, (required, event_types)
        # The ToolUse payload survives the round-trip into events_json.
        tool_use_entry = next(
            (e for e in events_json if e.get("event_type") == "ToolUse"),
            None,
        )
        assert tool_use_entry is not None
        assert tool_use_entry["payload"]["name"] == "browser_action"
        assert tool_use_entry["payload"]["input"] == {"action": "click"}
    finally:
        close_connection(db_path)


def test_dashboard_dry_runs_excludes_soft_deleted_jobs(tmp_path):
    """Reviewer-reported regression (PR 37 Low): the Python dashboard
    counter used to count soft-deleted jobs' dry-run rows; the TS
    counter excludes them.  Both writers update the same row so the
    user-visible value depended on which ran last.  Aligned now.
    """
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    # ``jobhunter_deleted_jobs`` is created on demand by the discovery
    # repository.  Create it here so the test seeds a tombstone.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS jobhunter_deleted_jobs (
            job_url TEXT PRIMARY KEY,
            deleted_at TEXT NOT NULL,
            reason TEXT,
            restored_at TEXT,
            FOREIGN KEY(job_url) REFERENCES jobs(url)
        )
        """
    )
    conn.commit()

    try:
        # Two jobs, both with a dry-run apply lifecycle.
        for url in (
            "https://example.com/job-live",
            "https://example.com/job-deleted",
        ):
            conn.execute(
                "INSERT INTO jobs (url, title, site, fit_score, "
                "tailored_resume_path, application_url) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (url, "Eng", "ExampleCo", 9, "/tmp/r.txt", url),
            )
            record_job_event(
                conn,
                url,
                "apply",
                "ApplyRunStarted",
                payload={
                    "run_id": f"run-{url[-8:]}",
                    "started_at": "2026-05-04T13:00:00+00:00",
                    "dry_run": True,
                    "worker_id": 0,
                },
            )
            record_job_event(
                conn,
                url,
                "apply",
                "DryRunCompleted",
                payload={
                    "run_id": f"run-{url[-8:]}",
                    "result": "dry_run_complete",
                    "finished_at": "2026-05-04T13:01:00+00:00",
                    "dry_run": True,
                },
            )

        # Soft-delete the second job.
        conn.execute(
            "INSERT INTO jobhunter_deleted_jobs (job_url, deleted_at) "
            "VALUES (?, ?)",
            ("https://example.com/job-deleted", "2026-05-04T13:05:00+00:00"),
        )
        conn.commit()
        ProjectionBuilder(conn_factory=lambda: conn).refresh()

        dash = conn.execute(
            "SELECT dry_runs FROM dashboard_projections LIMIT 1"
        ).fetchone()
        assert dash is not None
        # Only the live job's dry run is counted.
        assert dash["dry_runs"] == 1
    finally:
        close_connection(db_path)
