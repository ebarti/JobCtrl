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
