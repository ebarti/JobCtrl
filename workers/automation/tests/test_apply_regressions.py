import sys
import time
from pathlib import Path

from jobhunter.apply import launcher
from jobhunter.apply.launcher import acquire_job, mark_result
from jobhunter.database import close_connection, get_connection, init_db


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


def test_targeted_apply_acquires_job_with_null_apply_status(tmp_path, monkeypatch):
    """Phase 8 (S-30): the lock now lives on ``apply_runs.status``, not
    on ``jobs.apply_status``. New code never writes the legacy column —
    the aggregate is the source of truth.

    Round-1 review M1 also locked in: the row dict's ``applied_at`` /
    ``apply_status`` / ``apply_attempts`` columns are populated through
    the new apply_runs join, NOT from the legacy jobs columns.
    """
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)

    try:
        monkeypatch.setattr("jobhunter.apply.launcher.get_connection", lambda: get_connection(db_path))

        job = acquire_job(target_url="https://example.com/job", worker_id=1)

        assert job is not None
        assert job["url"] == "https://example.com/job"
        # Legacy column stays NULL on the new path.
        row = conn.execute(
            "SELECT apply_status FROM jobs WHERE url = ?", (job["url"],)
        ).fetchone()
        assert row["apply_status"] is None
        # New canonical lock: the apply_runs row is in 'starting'.
        ar = conn.execute(
            "SELECT status, run_id FROM apply_runs WHERE job_url = ?",
            (job["url"],),
        ).fetchone()
        assert ar is not None
        assert ar["status"] == "starting"
        assert job["apply_run_id"] == ar["run_id"]
        # Round-1 M1: the row dict's ``applied_at`` / ``apply_status``
        # / ``apply_attempts`` come from the new apply_runs join. At
        # SELECT time (before the INSERT inside this same transaction)
        # there are no prior apply_runs rows for this URL, so the
        # COALESCE falls back to NULL / 0. The eligibility checker
        # would now see canonical state if any prior runs existed —
        # the dedicated test that proves this lives in
        # test_apply_eligibility_checker.py.
        assert job["apply_status"] is None
        assert job["applied_at"] is None
        assert job["apply_attempts"] == 0
    finally:
        close_connection(db_path)


def test_acquire_job_promotes_prior_apply_runs_into_row_dict(tmp_path, monkeypatch):
    """Round-1 review M1: when prior apply_runs rows exist for a job,
    the row dict acquire_job returns must surface the canonical
    ``applied_at`` / ``apply_status`` / ``apply_attempts`` via the
    new apply_runs join — not the always-NULL legacy jobs columns."""
    from jobhunter.domain.apply import (
        ApplyRun,
        Failed,
        new_apply_run_id,
    )
    from jobhunter.domain.identifiers import JobId
    from jobhunter.domain.tenant import LOCAL_TENANT
    from jobhunter.infrastructure.apply import SqliteApplyRunRepository

    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)
    # Seed a prior failed apply_runs row (same URL).
    repo = SqliteApplyRunRepository(conn)
    repo.save(
        ApplyRun.start(
            tenant_id=LOCAL_TENANT,
            run_id=new_apply_run_id(),
            job_id=JobId("https://example.com/job"),
            started_at="2026-01-01T00:00:00+00:00",
        ).complete(
            result=Failed(error="boom", retryable=True),
            finished_at="2026-01-01T00:01:00+00:00",
        )
    )
    try:
        monkeypatch.setattr(
            "jobhunter.apply.launcher.get_connection", lambda: get_connection(db_path)
        )
        job = acquire_job(target_url="https://example.com/job", worker_id=1)
        assert job is not None
        # Canonical apply_status promoted from the apply_runs join
        # (the prior row was Failed → status='failed').
        assert job["apply_status"] == "failed"
        # Prior failed run counts toward apply_attempts.
        assert job["apply_attempts"] == 1
        # No succeeded run exists, so applied_at stays NULL.
        assert job["applied_at"] is None
    finally:
        close_connection(db_path)


def test_acquire_job_finds_new_path_enriched_job(tmp_path, monkeypatch):
    """Phase 7 (S-26 round-1 review B5) regression: ``acquire_job`` must
    find jobs whose ``application_url`` lives only in ``job_enrichments``
    (the new write path leaves ``jobs.application_url`` NULL).

    Without the LEFT JOIN + COALESCE in ``apply.launcher.acquire_job``,
    this test would assert ``job is None`` — the apply queue would skip
    every post-Phase-7 enriched job.
    """
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

    # Insert a discovered job WITHOUT touching jobs.application_url /
    # jobs.full_description (mirrors the new write path exactly).
    url = "https://example.com/new-path-job"
    conn.execute(
        """
        INSERT INTO jobs (url, title, site, fit_score, tailored_resume_path)
        VALUES (?, ?, ?, ?, ?)
        """,
        (url, "New Path Engineer", "ExampleCo", 9, "/tmp/resume.txt"),
    )
    conn.commit()

    # Enrich via the new repository — application_url + full_description
    # land in job_enrichments only.
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

    # Confirm the legacy column really is NULL (proves the test exercises
    # the new path, not a fluke).
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
        # The COALESCE'd application_url surfaces from job_enrichments.
        assert job["application_url"] == "https://example.com/apply-new"
        # And the COALESCE'd description follows along.
        assert job["full_description"] == "Build distributed systems."
    finally:
        close_connection(db_path)


def test_acquire_job_queue_picks_new_path_enriched_job(tmp_path, monkeypatch):
    """Same as above but exercises the queue-mode WHERE clause (no
    target_url) — distinct code path inside ``claim_one``."""
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
    url = "https://example.com/queue-mode-job"
    conn.execute(
        "INSERT INTO jobs (url, title, site, fit_score, tailored_resume_path) "
        "VALUES (?, ?, ?, ?, ?)",
        (url, "QueueModeRole", "ExampleCo", 9, "/tmp/resume.txt"),
    )
    conn.commit()

    repo = SqliteEnrichmentRepository(conn)
    repo.save(
        JobEnrichment.empty(
            tenant_id=LOCAL_TENANT, job_id=JobId(url), updated_at="t0"
        )
        .start_attempt(extraction_tier=ExtractionTier.JSON_LD, started_at="t0")
        .succeed_attempt(
            full_description=FullDescription(text="Queue-mode description."),
            application_url=ApplicationUrl(value="https://example.com/q-apply"),
            extraction_tier=ExtractionTier.JSON_LD,
            finished_at="t1",
        )
    )

    try:
        monkeypatch.setattr(
            "jobhunter.apply.launcher.get_connection", lambda: get_connection(db_path)
        )
        # No target_url ⇒ exercises the queue-mode WHERE clause
        job = acquire_job(worker_id=1, min_score=7)
        assert job is not None
        assert job["url"] == url
        assert job["application_url"] == "https://example.com/q-apply"
    finally:
        close_connection(db_path)


def test_dry_run_result_does_not_mark_job_applied(tmp_path, monkeypatch):
    """Phase 8 (S-30): a dry-run result writes a ``DryRunComplete``
    aggregate variant — not the legacy ``jobs.applied_at`` column.
    The §4.6 invariant "dry runs never mark applied" is enforced
    inside the aggregate's __post_init__."""
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)

    try:
        monkeypatch.setattr("jobhunter.apply.launcher.get_connection", lambda: get_connection(db_path))

        mark_result("https://example.com/job", "dry_run", duration_ms=123, task_id="run-test")

        row = conn.execute(
            "SELECT apply_status, applied_at, apply_task_id FROM jobs WHERE url = ?",
            ("https://example.com/job",),
        ).fetchone()
        state = conn.execute(
            "SELECT state, error_code FROM job_stage_states WHERE job_url = ? AND stage = 'apply'",
            ("https://example.com/job",),
        ).fetchone()

        # Legacy columns stay NULL on the new write path (no-strangler).
        assert row["apply_status"] is None
        assert row["applied_at"] is None
        assert row["apply_task_id"] is None
        assert state["state"] == "skipped"
        assert state["error_code"] == "DRY_RUN"
        # Canonical: an apply_runs row in dry_run_complete state.
        ar = conn.execute(
            "SELECT run_id, status, dry_run FROM apply_runs WHERE job_url = ?",
            ("https://example.com/job",),
        ).fetchone()
        assert ar is not None
        assert ar["status"] == "dry_run_complete"
        assert ar["dry_run"] == 1
        assert ar["run_id"] == "run-test"
    finally:
        close_connection(db_path)


def test_run_job_timeout_stops_silent_stdout_hang(tmp_path, monkeypatch):
    """Phase 8 (S-30): the timeout enforcement now lives inside the
    ``ClaudeCodeCliAdapter``, but the legacy contract — ``run_job``
    returns ``("failed:timeout", duration_ms)`` and kills the spawned
    subprocess — is preserved end-to-end.
    """
    from jobhunter.infrastructure.apply import claude_code_cli as adapter_mod
    from jobhunter.apply import chrome as chrome_mod
    from jobhunter.apply import launcher as launcher_mod
    from jobhunter.apply import prompt as prompt_mod_local

    app_dir = tmp_path / "app"
    log_dir = tmp_path / "logs"
    worker_dir = tmp_path / "workers"
    app_dir.mkdir()
    log_dir.mkdir()
    worker_dir.mkdir()
    db_path = tmp_path / "jobs.db"
    init_db(db_path)
    monkeypatch.setattr(launcher.config, "APP_DIR", app_dir)
    monkeypatch.setattr(launcher.config, "LOG_DIR", log_dir)
    monkeypatch.setattr(launcher.config, "APPLY_WORKER_DIR", worker_dir)
    monkeypatch.setitem(launcher.config.DEFAULTS, "apply_timeout", 1)
    monkeypatch.setattr(prompt_mod_local, "build_prompt", lambda **_kwargs: "apply prompt")
    monkeypatch.setattr(launcher_mod, "get_connection", lambda: get_connection(db_path))
    monkeypatch.setattr(launcher_mod, "_load_profile_snapshot", lambda: object())
    # Skip Chrome reset — the adapter only needs a worker dir under
    # APPLY_WORKER_DIR. We point reset_worker_dir at our tmp tree.
    def _reset_worker_dir(wid):
        wdir = worker_dir / f"worker-{wid}"
        wdir.mkdir(parents=True, exist_ok=True)
        return wdir

    monkeypatch.setattr(launcher_mod, "reset_worker_dir", _reset_worker_dir)

    original_popen = adapter_mod.subprocess.Popen
    spawned = []

    def fake_popen(_cmd, *args, **kwargs):
        script = (
            "import sys, time\n"
            "sys.stdout.write('{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"started\"}]}}\\n')\n"
            "sys.stdout.flush()\n"
            "time.sleep(60)\n"
        )
        proc = original_popen([sys.executable, "-c", script], *args, **kwargs)
        spawned.append(proc)
        return proc

    def safe_kill_process_tree(pid):
        for proc in spawned:
            if proc.pid == pid and proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)

    monkeypatch.setattr(adapter_mod.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(chrome_mod, "_kill_process_tree", safe_kill_process_tree)

    # Bypass the saga's browser launch — pass a fake BrowserPort that
    # returns a dummy session and a no-op cleanup.
    from jobhunter.domain.ports.apply import BrowserSession

    class FakeBrowser:
        def launch(self, config):
            return BrowserSession(config=config, pid=1, worker_dir=str(worker_dir / f"worker-{config.worker_id}"))

        def cleanup(self, session):
            pass

    real_build = launcher_mod._build_use_case

    def fake_build_use_case():
        from jobhunter.domain.apply.process_manager import ApplySaga
        from jobhunter.domain.apply.services import (
            ApplyEligibilityChecker,
            ApplyPromptBuilder,
        )
        from jobhunter.domain.apply.use_cases import SubmitApplicationUseCase
        from jobhunter.infrastructure.apply import (
            ClaudeCodeCliAdapter,
            SqliteApplyRunRepository,
        )

        repo = SqliteApplyRunRepository(get_connection(db_path))
        browser = FakeBrowser()
        agent = ClaudeCodeCliAdapter()
        saga = ApplySaga(browser_port=browser, agent_port=agent, repository=repo, timeout_seconds=1)
        return SubmitApplicationUseCase(
            repository=repo,
            browser_port=browser,
            agent_port=agent,
            eligibility_checker=ApplyEligibilityChecker(max_attempts=99),
            prompt_builder=ApplyPromptBuilder(mcp_config_factory=lambda port: {"port": port}),
            saga=saga,
            timeout_seconds=1,
        )

    monkeypatch.setattr(launcher_mod, "_build_use_case", fake_build_use_case)

    started = time.monotonic()
    result, duration_ms = launcher.run_job(
        {
            "url": "https://example.com/job",
            "application_url": "https://example.com/apply",
            "title": "Platform Engineer",
            "site": "ExampleCo",
            "fit_score": 9,
            "location": "Remote",
            "full_description": "Build reliable systems.",
            "cover_letter_path": None,
            "tailored_resume_path": "/tmp/resume.txt",
            "apply_attempts": 0,
        },
        port=9222,
        worker_id=77,
        run_ctx={"run_id": "timeout-test"},
    )
    _ = real_build  # silence unused-var warning

    assert result == "failed:timeout"
    assert duration_ms >= 900
    assert time.monotonic() - started < 5
    assert spawned
    assert all(proc.poll() is not None for proc in spawned)
