from pathlib import Path

from typer.testing import CliRunner

from jobhunter import actions, cli
from jobhunter.actions import LocalActionRequest, run_local_action
from jobhunter.apply import launcher
from jobhunter.cli import app
from jobhunter.database import close_connection, get_connection, init_db
from jobhunter.domain.profile.ports import ProfileImportResult


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
            ("ActionStarted", "score", "info"),
            ("ActionSucceeded", "score", "info"),
        ]
    finally:
        close_connection(db_path)


def test_tailor_action_passes_tailoring_model_controls(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    init_db(db_path)
    calls = []

    def fake_pipeline(**kwargs):
        calls.append(kwargs)
        return {"stages": [{"stage": "tailor", "status": "ok", "elapsed": 0.01}], "errors": {}, "elapsed": 0.01}

    monkeypatch.setattr(actions, "_bootstrap_runtime", lambda: None)
    monkeypatch.setattr(actions, "get_connection", lambda: get_connection(db_path))
    monkeypatch.setattr(actions, "run_pipeline", fake_pipeline)

    try:
        result = run_local_action(
            LocalActionRequest(
                stage="tailor",
                tailor_models=("local:draft-a", "openai:draft-b"),
                tailor_judge_model="gemini:judge-c",
                tailor_judge_min_score=0.9,
            )
        )

        assert result.ok is True
        assert calls[0]["tailor_models"] == ("local:draft-a", "openai:draft-b")
        assert calls[0]["tailor_judge_model"] == "gemini:judge-c"
        assert calls[0]["tailor_judge_min_score"] == 0.9
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
        assert failure["event_type"] == "ActionFailed"
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
        result = run_local_action(
            LocalActionRequest(
                stage="enrich",
                dry_run=True,
                rescore=True,
                retailor=True,
                import_profile=False,
                import_style=True,
            )
        )
        assert result.ok is True
        assert result.status == "dry_run"
        assert result.result["planned"]["stage"] == "enrich"
        assert result.result["planned"]["rescore"] is True
        assert result.result["planned"]["retailor"] is True
        assert result.result["planned"]["import_profile"] is False
    finally:
        close_connection(db_path)


def test_apply_action_propagates_failed_count(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    init_db(db_path)

    monkeypatch.setattr(actions, "_bootstrap_runtime", lambda: None)
    monkeypatch.setattr(actions, "get_connection", lambda: get_connection(db_path))
    monkeypatch.setattr(launcher, "main", lambda **_kwargs: (0, 1))

    try:
        result = run_local_action(LocalActionRequest(stage="apply", job_url="https://example.com/job", limit=1))

        assert result.ok is False
        assert result.status == "failed"
        assert result.result["failed"] == 1
    finally:
        close_connection(db_path)


def test_apply_action_uses_single_job_default_limit(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    init_db(db_path)
    calls = []

    def fake_apply(**kwargs):
        calls.append(kwargs)
        return (1, 0)

    monkeypatch.setattr(actions, "_bootstrap_runtime", lambda: None)
    monkeypatch.setattr(actions, "get_connection", lambda: get_connection(db_path))
    monkeypatch.setattr(launcher, "main", fake_apply)

    try:
        result = run_local_action(LocalActionRequest(stage="apply", job_url="https://example.com/job"))

        assert result.ok is True
        assert calls[0]["limit"] == 1
        assert calls[0]["continuous"] is False
    finally:
        close_connection(db_path)


def test_action_cli_passes_apply_model_and_headless_options(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    init_db(db_path)
    calls = []

    def fake_apply(**kwargs):
        calls.append(kwargs)
        return (1, 0)

    monkeypatch.setattr(actions, "_bootstrap_runtime", lambda: None)
    monkeypatch.setattr(actions, "get_connection", lambda: get_connection(db_path))
    monkeypatch.setattr(launcher, "main", fake_apply)

    try:
        result = CliRunner().invoke(
            app,
            [
                "action",
                "apply",
                "--url",
                "https://example.com/job",
                "--model",
                "sonnet",
                "--headless",
            ],
        )

        assert result.exit_code == 0
        assert calls[0]["model"] == "sonnet"
        assert calls[0]["headless"] is True
    finally:
        close_connection(db_path)


def test_local_action_returns_structured_bootstrap_failure(monkeypatch):
    monkeypatch.setattr(actions, "_bootstrap_runtime", lambda: (_ for _ in ()).throw(RuntimeError("db unavailable")))

    result = run_local_action(LocalActionRequest(stage="score"))

    assert result.ok is False
    assert result.status == "failed"
    assert result.error == "db unavailable"
    assert "RuntimeError" in (result.traceback or "")


def test_profile_import_action_expands_user_paths(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    init_db(db_path)
    pdf_path = tmp_path / "resume.pdf"
    pdf_path.write_bytes(b"%PDF")

    captured: dict[str, object] = {}

    class FakeRepository:
        def import_from_pdf(self, tenant_id, pdf_bytes, *, filename):
            captured["tenant_id"] = tenant_id
            captured["filename"] = filename
            captured["bytes"] = len(pdf_bytes)
            return ProfileImportResult(
                profile={"filename": filename, "bytes": len(pdf_bytes)},
                style={"font": "moderncv"},
                source={"filename": filename, "pages": 1},
            )

    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(actions, "_bootstrap_runtime", lambda: None)
    monkeypatch.setattr(actions, "get_connection", lambda: get_connection(db_path))
    monkeypatch.setattr(actions, "get_profile_repository", lambda: FakeRepository())

    try:
        result = run_local_action(LocalActionRequest(stage="profile_import", pdf_path="~/resume.pdf"))

        assert result.ok is True
        assert captured["filename"] == "resume.pdf"
        assert captured["bytes"] == 4
        assert result.result["draft"]["profile"] == {"filename": "resume.pdf", "bytes": 4}
        assert result.result["draft"]["style"] == {"font": "moderncv"}
        assert result.result["draft"]["source"] == {"filename": "resume.pdf", "pages": 1}
    finally:
        close_connection(db_path)


def test_action_cli_prints_json(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    init_db(db_path)

    def fake_pipeline(**_kwargs):
        return {"stages": [{"stage": "cover", "status": "ok", "elapsed": 0.01}], "errors": {}, "elapsed": 0.01}

    monkeypatch.setattr(actions, "_bootstrap_runtime", lambda: None)
    monkeypatch.setattr(actions, "get_connection", lambda: get_connection(db_path))
    monkeypatch.setattr(actions, "run_pipeline", fake_pipeline)

    try:
        result = CliRunner().invoke(app, ["action", "cover", "--limit", "1"])
        assert result.exit_code == 0
        assert '"stage": "cover"' in result.stdout
        assert '"ok": true' in result.stdout
    finally:
        close_connection(db_path)


def test_stage_cli_commands_accept_limits(monkeypatch):
    calls = []

    def fake_pipeline(**kwargs):
        calls.append(kwargs)
        stage = kwargs["stages"][0]
        return {"stages": [{"stage": stage, "status": "ok", "elapsed": 0.01}], "errors": {}, "elapsed": 0.01}

    monkeypatch.setattr(cli, "_bootstrap", lambda: None)
    monkeypatch.setattr(cli, "run_pipeline", fake_pipeline)

    runner = CliRunner()
    for command in (["discover", "--limit", "1"], ["enrich", "--limit", "1"], ["run", "discover", "--limit", "1"]):
        result = runner.invoke(app, command)
        assert result.exit_code == 0

    assert [call["stages"] for call in calls] == [["discover"], ["enrich"], ["discover"]]
    assert [call["limit"] for call in calls] == [1, 1, 1]


def test_action_cli_reports_validation_errors_without_traceback(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    init_db(db_path)

    monkeypatch.setattr(actions, "_bootstrap_runtime", lambda: None)
    monkeypatch.setattr(actions, "get_connection", lambda: get_connection(db_path))

    try:
        result = CliRunner().invoke(app, ["action", "not-a-stage"])

        assert result.exit_code == 1
        assert "Unknown action stage: not-a-stage" in result.stdout
        assert "Traceback" not in result.stdout
    finally:
        close_connection(db_path)
