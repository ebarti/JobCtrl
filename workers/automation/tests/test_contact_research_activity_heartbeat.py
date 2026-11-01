"""Contact research heartbeats use the Temporal activity context."""

from dataclasses import replace
import sqlite3
import threading

import pytest
from temporalio.testing import ActivityEnvironment


@pytest.mark.asyncio
@pytest.mark.parametrize("is_local", [False, True])
async def test_contact_research_heartbeat_respects_activity_context(tmp_path, monkeypatch, is_local):
    from jobctrl import config, database
    from jobctrl.contact.activities import (
        ResearchSourceInput, RunContactResearchActivityInput, run_contact_research_activity,
    )
    from jobctrl.infrastructure import determinations, events
    from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
    from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
    from jobctrl.infrastructure.temporal import run_in_activity

    path = tmp_path / "synthetic.db"
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", path)
    monkeypatch.setattr(database, "DB_PATH", path)
    monkeypatch.setattr(config, "load_saved_search_settings", lambda: {})
    job_id = "00000000-0000-4000-8000-000000000023"
    conn = database.init_db(path)
    conn.execute(
        "INSERT INTO jobs (tenant_id, job_id, url, title) VALUES (?, ?, ?, ?)",
        ("local", job_id, "https://example.test/synthetic", "Synthetic job"),
    )
    conn.commit()
    conn.close()
    monkeypatch.setattr(events, "get_default_publisher", lambda: InProcessEventBus())

    def forbidden(*_args, **_kwargs):
        raise AssertionError("user-entered research must not call a provider")

    class NoProvider:
        chat_json = forbidden

    def dependencies(conn, *, tenant_id, lane, model_spec=None):
        return {
            "llm": NoProvider(), "repository": SqliteDeterminationRepository(conn),
            "preflight": forbidden, "provider": "synthetic", "model": "synthetic",
        }

    monkeypatch.setattr(determinations, "determination_dependencies", dependencies)
    env = ActivityEnvironment()
    env.info = replace(env.info, is_local=is_local)
    heartbeats = []
    activity_thread = threading.get_ident()
    env.on_heartbeat = lambda *details: heartbeats.append((threading.get_ident(), details))
    run_in_activity.set_activity_executor(run_in_activity.ActivityThreadPoolExecutor(max_workers=1))
    try:
        result = await env.run(
            run_contact_research_activity,
            RunContactResearchActivityInput(
                tenant_id="local", task_id="synthetic", employer="Synthetic", job_id=job_id,
                sources=(ResearchSourceInput(category="user_entered", label="synthetic"),),
                expected_app_dir=str(tmp_path), expected_db_path=str(path),
            ),
        )
        assert result.status == "needs_review"
        with sqlite3.connect(path) as conn:
            assert conn.execute(
                "SELECT status FROM contact_research_tasks WHERE task_id='synthetic'"
            ).fetchone() == ("needs_review",)
        assert all(ident == activity_thread for ident, _details in heartbeats)
        if is_local:
            assert heartbeats == []
        else:
            assert heartbeats[0][1] == ("contact research starting",)
            assert heartbeats[-1][1] == ({"status": "needs_review", "jobId": job_id},)
    finally:
        await run_in_activity.drain_activity_executors()
        run_in_activity.set_activity_executor(None)
        database.close_thread_connections()
