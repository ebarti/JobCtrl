from __future__ import annotations

from typer.testing import CliRunner

from jobctl import cli
from jobctl.cli import app
from jobctl.workflow_specs import StartedWorkflowResult


def _started(result: dict | None = None) -> StartedWorkflowResult:
    return StartedWorkflowResult(
        run_id="run-comp",
        workflow_id="workflow-comp",
        first_execution_run_id="first-comp",
        result=result or {"status": "succeeded", "postedFactsRefreshed": 1},
    )


def test_compensation_refresh_cli_starts_workflow_for_one_job(monkeypatch, tmp_path) -> None:
    specs = []
    observations_path = tmp_path / "reported-comp.json"
    observations_path.write_text("[]", encoding="utf-8")
    job_url = "https://example.com/jobs/platform"

    monkeypatch.setattr(cli, "_bootstrap", lambda: None)
    monkeypatch.setattr(
        cli,
        "start_workflow_spec_and_wait_sync",
        lambda spec: specs.append(spec) or _started(),
    )

    result = CliRunner().invoke(
        app,
        ["compensation-refresh", "--observations-json", str(observations_path), "--no-eurotoptech", "--url", job_url],
    )

    assert result.exit_code == 0, result.output
    assert '"postedFactsRefreshed": 1' in result.output
    payload = specs[0].args[0]
    assert specs[0].workflow.__name__ == "CompensationRefreshWorkflow"
    assert payload.job_url == job_url
    assert payload.observations_json_path == str(observations_path)
    assert payload.include_euro_top_tech is False


def test_compensation_refresh_cli_defaults_to_all_jobs(monkeypatch) -> None:
    specs = []

    monkeypatch.setattr(cli, "_bootstrap", lambda: None)
    monkeypatch.setattr(
        cli,
        "start_workflow_spec_and_wait_sync",
        lambda spec: specs.append(spec) or _started({"status": "succeeded", "allJobs": True}),
    )

    result = CliRunner().invoke(app, ["compensation-refresh", "--limit", "5"])

    assert result.exit_code == 0, result.output
    payload = specs[0].args[0]
    assert payload.job_url is None
    assert payload.limit == 5
    assert payload.include_euro_top_tech is True
