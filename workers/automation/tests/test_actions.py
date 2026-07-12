from io import StringIO
from pathlib import Path

import pytest
import typer
from rich.console import Console
from typer.testing import CliRunner

from jobctrl import actions, browser_capabilities, cli
from jobctrl.actions import LocalActionRequest, run_local_action
from jobctrl.cli import app
from jobctrl.database import close_connection, get_connection, init_db
from jobctrl.workflow_specs import StartedWorkflowResult, build_run_stage_workflow_spec


@pytest.fixture(autouse=True)
def permit_browser_for_existing_apply_action_tests(monkeypatch: pytest.MonkeyPatch) -> None:
    """Action result tests run after the browser capability preflight."""

    monkeypatch.setattr(
        browser_capabilities,
        "require_system_browser_capability",
        lambda _capability: Path("/test/Chromium"),
    )


def _started(result: dict | None = None) -> StartedWorkflowResult:
    return StartedWorkflowResult(
        run_id="run-test",
        workflow_id="workflow-test",
        first_execution_run_id="first-test",
        result=result or {"status": "succeeded"},
    )


def test_local_stage_action_records_events(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    specs = []

    monkeypatch.setattr(actions, "_bootstrap_runtime", lambda: None)
    monkeypatch.setattr(actions, "get_connection", lambda: get_connection(db_path))
    monkeypatch.setattr(
        actions,
        "start_workflow_spec_and_wait_sync",
        lambda spec: specs.append(spec) or _started({"status": "succeeded", "stages_completed": ["score"]}),
    )

    try:
        result = run_local_action(LocalActionRequest(stage="score", limit=3, workers=2))
        rows = conn.execute("SELECT event_type, stage, level FROM job_events ORDER BY event_id").fetchall()

        assert result.ok is True
        assert result.stage == "score"
        payload = specs[0].args[0]
        assert payload.stages == ["score"]
        assert payload.limit == 3
        assert payload.workers == 2
        assert [(row["event_type"], row["stage"], row["level"]) for row in rows] == [
            ("ActionStarted", "score", "info"),
            ("ActionSucceeded", "score", "info"),
        ]
    finally:
        close_connection(db_path)


def test_tailor_action_passes_tailoring_model_controls(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    init_db(db_path)
    specs = []

    monkeypatch.setattr(actions, "_bootstrap_runtime", lambda: None)
    monkeypatch.setattr(actions, "get_connection", lambda: get_connection(db_path))
    monkeypatch.setattr(
        actions,
        "start_workflow_spec_and_wait_sync",
        lambda spec: specs.append(spec) or _started(),
    )

    try:
        result = run_local_action(
            LocalActionRequest(
                stage="tailor",
                tailor_models=("codex:draft-a", "claude:draft-b"),
                tailor_judge_model="gemini:judge-c",
                tailor_judge_min_score=0.9,
            )
        )

        assert result.ok is True
        payload = specs[0].args[0]
        assert payload.tailor_models == ("codex:draft-a", "claude:draft-b")
        assert payload.tailor_judge_model == "gemini:judge-c"
        assert payload.tailor_judge_min_score == 0.9
    finally:
        close_connection(db_path)


def test_tailor_action_fails_when_pipeline_reports_quality_gate_failure(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    init_db(db_path)

    monkeypatch.setattr(actions, "_bootstrap_runtime", lambda: None)
    monkeypatch.setattr(actions, "get_connection", lambda: get_connection(db_path))
    monkeypatch.setattr(
        actions,
        "start_workflow_spec_and_wait_sync",
        lambda _spec: _started({"status": "failed", "errors": {"tailor": "failed"}}),
    )

    try:
        result = run_local_action(LocalActionRequest(stage="tailor"))
        conn = get_connection(db_path)
        failure = conn.execute(
            "SELECT event_type, level FROM job_events ORDER BY event_id DESC LIMIT 1"
        ).fetchone()

        assert result.ok is False
        assert result.status == "failed"
        assert result.result["errors"] == {"tailor": "failed"}
        assert failure["event_type"] == "ActionFailed"
        assert failure["level"] == "error"
    finally:
        close_connection(db_path)


def test_local_action_returns_structured_failure(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    def broken_start(_spec):
        raise RuntimeError("boom")

    monkeypatch.setattr(actions, "_bootstrap_runtime", lambda: None)
    monkeypatch.setattr(actions, "get_connection", lambda: get_connection(db_path))
    monkeypatch.setattr(actions, "start_workflow_spec_and_wait_sync", broken_start)

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


def test_pipeline_action_dry_run_starts_workflow_with_dry_run_flag(monkeypatch, tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    init_db(db_path)
    specs = []

    monkeypatch.setattr(actions, "_bootstrap_runtime", lambda: None)
    monkeypatch.setattr(actions, "get_connection", lambda: get_connection(db_path))
    monkeypatch.setattr(
        actions,
        "start_workflow_spec_and_wait_sync",
        lambda spec: specs.append(spec) or _started({"status": "succeeded", "dryRun": True}),
    )

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
        assert result.status == "succeeded"
        payload = specs[0].args[0]
        assert payload.stages == ["enrich"]
        assert payload.dry_run is True
        assert payload.rescore is True
        assert payload.retailor is True
    finally:
        close_connection(db_path)


def test_profile_import_dry_run_returns_plan_without_starting_workflow(monkeypatch, tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    init_db(db_path)
    specs = []

    monkeypatch.setattr(actions, "_bootstrap_runtime", lambda: None)
    monkeypatch.setattr(actions, "get_connection", lambda: get_connection(db_path))
    monkeypatch.setattr(
        actions,
        "start_workflow_spec_and_wait_sync",
        lambda spec: specs.append(spec) or _started({"status": "succeeded"}),
    )

    try:
        result = run_local_action(
            LocalActionRequest(
                stage="profile_import",
                pdf_path="/tmp/resume.pdf",
                dry_run=True,
                import_profile=False,
                import_style=True,
            )
        )
        assert result.ok is True
        assert result.status == "dry_run"
        assert specs == []
        assert result.result["planned"]["stage"] == "profile_import"
        assert result.result["planned"]["pdf_path"] == "/tmp/resume.pdf"
        assert result.result["planned"]["dry_run"] is True
    finally:
        close_connection(db_path)


def test_apply_action_propagates_failed_count(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    init_db(db_path)

    monkeypatch.setattr(actions, "_bootstrap_runtime", lambda: None)
    monkeypatch.setattr(actions, "get_connection", lambda: get_connection(db_path))
    monkeypatch.setattr(
        actions,
        "start_workflow_spec_and_wait_sync",
        lambda _spec: _started({"status": "failed", "failed": 1}),
    )

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
    specs = []

    monkeypatch.setattr(actions, "_bootstrap_runtime", lambda: None)
    monkeypatch.setattr(actions, "get_connection", lambda: get_connection(db_path))
    monkeypatch.setattr(
        actions,
        "start_workflow_spec_and_wait_sync",
        lambda spec: specs.append(spec) or _started(),
    )

    try:
        result = run_local_action(LocalActionRequest(stage="apply", job_url="https://example.com/job"))

        assert result.ok is True
        payload = specs[0].args[0]
        assert payload.limit == 1
        assert payload.continuous is False
    finally:
        close_connection(db_path)


def test_action_cli_passes_apply_model_and_headless_options(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    init_db(db_path)
    specs = []

    monkeypatch.setattr(actions, "_bootstrap_runtime", lambda: None)
    monkeypatch.setattr(actions, "get_connection", lambda: get_connection(db_path))
    monkeypatch.setattr(
        actions,
        "start_workflow_spec_and_wait_sync",
        lambda spec: specs.append(spec) or _started(),
    )

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
        payload = specs[0].args[0]
        assert payload.model == "sonnet"
        assert payload.headless is True
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
    specs = []

    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(actions, "_bootstrap_runtime", lambda: None)
    monkeypatch.setattr(actions, "get_connection", lambda: get_connection(db_path))
    monkeypatch.setattr(
        actions,
        "start_workflow_spec_and_wait_sync",
        lambda spec: specs.append(spec) or _started({"status": "succeeded", "draft": {"source": "pdf"}}),
    )

    try:
        result = run_local_action(LocalActionRequest(stage="profile_import", pdf_path="~/resume.pdf"))

        assert result.ok is True
        payload = specs[0].args[0]
        assert payload.pdf_path == str(pdf_path)
        assert result.result["draft"] == {"source": "pdf"}
    finally:
        close_connection(db_path)


def test_action_cli_prints_json(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    init_db(db_path)

    monkeypatch.setattr(actions, "_bootstrap_runtime", lambda: None)
    monkeypatch.setattr(actions, "get_connection", lambda: get_connection(db_path))
    monkeypatch.setattr(
        actions,
        "start_workflow_spec_and_wait_sync",
        lambda _spec: _started({"status": "succeeded", "stages_completed": ["cover"]}),
    )

    try:
        result = CliRunner().invoke(app, ["action", "cover", "--limit", "1"])
        assert result.exit_code == 0
        assert '"stage": "cover"' in result.stdout
        assert '"ok": true' in result.stdout
    finally:
        close_connection(db_path)


def test_stage_cli_commands_accept_limits(monkeypatch):
    specs = []

    monkeypatch.setattr(cli, "_bootstrap", lambda: None)
    monkeypatch.setattr("jobctrl.config.check_tier", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        cli,
        "start_workflow_spec_and_wait_sync",
        lambda spec: specs.append(spec) or _started({"status": "succeeded"}),
    )

    runner = CliRunner()
    for command in (["discover", "--limit", "1"], ["enrich", "--limit", "1"], ["run", "discover", "--limit", "1"]):
        result = runner.invoke(app, command)
        assert result.exit_code == 0

    assert [spec.workflow.__name__ for spec in specs] == [
        "DiscoverWorkflow",
        "JobPipelineWorkflow",
        "DiscoverWorkflow",
    ]
    assert [spec.args[0].limit for spec in specs] == [1, 1, 1]


def test_cli_workflow_runtime_failure_exits_with_doctor_hint(monkeypatch):
    output = StringIO()

    monkeypatch.setattr(
        cli,
        "console",
        Console(file=output, force_terminal=False, color_system=None, width=120),
    )
    monkeypatch.setattr(
        cli,
        "start_workflow_spec_and_wait_sync",
        lambda _spec: (_ for _ in ()).throw(RuntimeError("connection refused")),
    )

    with pytest.raises(typer.Exit) as exc_info:
        cli._run_workflow_spec_from_cli(
            build_run_stage_workflow_spec({"tenantId": "local", "stages": ["score"]}),
            label="score",
        )

    assert exc_info.value.exit_code == 1
    text = output.getvalue()
    assert "Temporal workflow runtime is unavailable." in text
    assert "connection refused" in text
    assert "jobctrl doctor" in text


def test_discover_cli_requires_tier2_guard(monkeypatch):
    guard_calls = []

    def fake_check_tier(required, feature):
        guard_calls.append((required, feature))
        raise SystemExit(1)

    def should_not_start_workflow(*_args, **_kwargs):
        raise AssertionError("discover should be tier-gated before workflow start")

    monkeypatch.setattr(cli, "_bootstrap", lambda: None)
    monkeypatch.setattr("jobctrl.config.check_tier", fake_check_tier)
    monkeypatch.setattr(cli, "_run_workflow_spec_from_cli", should_not_start_workflow)

    result = CliRunner().invoke(app, ["discover", "--limit", "1"])

    assert result.exit_code == 1
    assert guard_calls == [(2, "AI discovery preparation")]


def test_run_discover_requires_tier2_guard(monkeypatch):
    guard_calls = []

    def fake_check_tier(required, feature):
        guard_calls.append((required, feature))
        raise SystemExit(1)

    def should_not_start_workflow(*_args, **_kwargs):
        raise AssertionError("run discover should be tier-gated before workflow start")

    monkeypatch.setattr(cli, "_bootstrap", lambda: None)
    monkeypatch.setattr("jobctrl.config.check_tier", fake_check_tier)
    monkeypatch.setattr(cli, "_run_workflow_spec_from_cli", should_not_start_workflow)

    result = CliRunner().invoke(app, ["run", "discover", "--limit", "1"])

    assert result.exit_code == 1
    assert guard_calls == [(2, "AI discovery preparation")]


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
