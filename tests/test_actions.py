from pathlib import Path

from typer.testing import CliRunner

from jobhunter import actions
from jobhunter.actions import LocalActionRequest, run_local_action
from jobhunter.cli import app
from jobhunter.database import close_connection, get_connection, init_db


def test_local_stage_action_records_events(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    calls = []

    def fake_pipeline(**kwargs):
        calls.append(kwargs)
        return {"stages": [{"stage": "score", "status": "ok", "elapsed": 0.01}], "errors": {}, "elapsed": 0.01}

    monkeypatch.setattr(actions, "_bootstrap_runtime", lambda: None)
    monkeypatch.setattr(actions, "get_connection", lambda: get_connection(db_path))
    monkeypatch.setattr(actions, "run_pipeline", fake_pipeline)

    try:
        result = run_local_action(LocalActionRequest(stage="score", limit=3, workers=2))
        rows = conn.execute("SELECT event_type, stage, level FROM job_events ORDER BY event_id").fetchall()

        assert result.ok is True
        assert result.stage == "score"
        assert calls[0]["stages"] == ["score"]
        assert calls[0]["limit"] == 3
        assert calls[0]["workers"] == 2
        assert [(row["event_type"], row["stage"], row["level"]) for row in rows] == [
            ("action_started", "score", "info"),
            ("action_succeeded", "score", "info"),
        ]
    finally:
        close_connection(db_path)


def test_local_action_returns_structured_failure(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    def broken_pipeline(**_kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(actions, "_bootstrap_runtime", lambda: None)
    monkeypatch.setattr(actions, "get_connection", lambda: get_connection(db_path))
    monkeypatch.setattr(actions, "run_pipeline", broken_pipeline)

    try:
        result = run_local_action(LocalActionRequest(stage="tailor"))
        failure = conn.execute("SELECT event_type, level, message FROM job_events ORDER BY event_id DESC LIMIT 1").fetchone()

        assert result.ok is False
        assert result.status == "failed"
        assert result.error == "boom"
        assert "RuntimeError" in (result.traceback or "")
        assert failure["event_type"] == "action_failed"
        assert failure["level"] == "error"
    finally:
        close_connection(db_path)


def test_local_action_dry_run_does_not_execute(monkeypatch, tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    init_db(db_path)

    def should_not_run(**_kwargs):  # pragma: no cover - assertion guard
        raise AssertionError("pipeline should not run")

    monkeypatch.setattr(actions, "_bootstrap_runtime", lambda: None)
    monkeypatch.setattr(actions, "get_connection", lambda: get_connection(db_path))
    monkeypatch.setattr(actions, "run_pipeline", should_not_run)

    try:
        result = run_local_action(LocalActionRequest(stage="enrich", dry_run=True))
        assert result.ok is True
        assert result.status == "dry_run"
        assert result.result["planned"]["stage"] == "enrich"
    finally:
        close_connection(db_path)


def test_action_cli_prints_json(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    init_db(db_path)

    def fake_pipeline(**_kwargs):
        return {"stages": [{"stage": "pdf", "status": "ok", "elapsed": 0.01}], "errors": {}, "elapsed": 0.01}

    monkeypatch.setattr(actions, "_bootstrap_runtime", lambda: None)
    monkeypatch.setattr(actions, "get_connection", lambda: get_connection(db_path))
    monkeypatch.setattr(actions, "run_pipeline", fake_pipeline)

    try:
        result = CliRunner().invoke(app, ["action", "pdf", "--limit", "1"])
        assert result.exit_code == 0
        assert '"stage": "pdf"' in result.stdout
        assert '"ok": true' in result.stdout
    finally:
        close_connection(db_path)

