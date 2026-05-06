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
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)

    try:
        monkeypatch.setattr("jobhunter.apply.launcher.get_connection", lambda: get_connection(db_path))

        job = acquire_job(target_url="https://example.com/job", worker_id=1)

        assert job is not None
        assert job["url"] == "https://example.com/job"
        row = conn.execute("SELECT apply_status FROM jobs WHERE url = ?", (job["url"],)).fetchone()
        assert row["apply_status"] == "in_progress"
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

        assert row["apply_status"] == "dry_run"
        assert row["applied_at"] is None
        assert row["apply_task_id"] == "run-test"
        assert state["state"] == "skipped"
        assert state["error_code"] == "DRY_RUN"
    finally:
        close_connection(db_path)


def test_run_job_timeout_stops_silent_stdout_hang(tmp_path, monkeypatch):
    app_dir = tmp_path / "app"
    log_dir = tmp_path / "logs"
    worker_dir = tmp_path / "workers"
    app_dir.mkdir()
    log_dir.mkdir()
    worker_dir.mkdir()
    monkeypatch.setattr(launcher.config, "APP_DIR", app_dir)
    monkeypatch.setattr(launcher.config, "LOG_DIR", log_dir)
    monkeypatch.setattr(launcher.config, "APPLY_WORKER_DIR", worker_dir)
    monkeypatch.setitem(launcher.config.DEFAULTS, "apply_timeout", 1)
    monkeypatch.setattr(launcher.prompt_mod, "build_prompt", lambda **_kwargs: "apply prompt")

    original_popen = launcher.subprocess.Popen
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

    monkeypatch.setattr(launcher.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(launcher, "_kill_process_tree", safe_kill_process_tree)

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
            "tailored_resume_path": None,
        },
        port=9222,
        worker_id=77,
        run_ctx={"run_id": "timeout-test"},
    )

    assert result == "failed:timeout"
    assert duration_ms >= 900
    assert time.monotonic() - started < 5
    assert spawned
    assert all(proc.poll() is not None for proc in spawned)
