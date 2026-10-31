"""Discover preview must stop before any workflow or workspace effects."""

from __future__ import annotations

from io import StringIO
from types import SimpleNamespace

import pytest
from rich.console import Console
from typer.testing import CliRunner

from jobctrl import actions, cli, workflow_specs
from jobctrl.actions import LocalActionRequest, run_local_action
from jobctrl.discovery.workflow import DiscoverWorkflow
from jobctrl.domain.rpc.messages import INVALID_PARAMS, JsonRpcRequest
from jobctrl.infrastructure.rpc.handlers import register_default_handlers
from jobctrl.infrastructure.rpc.server import JsonRpcServer
from jobctrl.pipeline.workflow import JobPipelineWorkflow


@pytest.mark.parametrize(
    "selection",
    [
        {"stage": "discover"},
        {"stage": "discover", "stages": ["discover", "score"]},
        {"stage": "discover", "stages": ["score"]},
        {"stage": "all", "stages": ["score"]},
        {"stage": "score", "stages": ["score", "discover", "tailor"]},
        {"stage": "discover", "stages": ["discover", "apply"]},
        {"stages": ["all"]},
    ],
)
def test_registered_rpc_rejects_preview_before_selection_or_start(monkeypatch, selection):
    def unexpected(*_args, **_kwargs):
        raise AssertionError("preview crossed an effects boundary")

    monkeypatch.setattr(workflow_specs, "_scope_global_material_batch", unexpected)
    monkeypatch.setattr(workflow_specs, "_require_auto_apply_browser_capability", unexpected)
    starts = []

    async def starter(spec):
        starts.append(spec)
        raise AssertionError("preview must not start Temporal")

    server = JsonRpcServer(workflow_starter=starter)
    register_default_handlers(server, canceler=lambda *_args, **_kwargs: None)
    response = server.dispatch(JsonRpcRequest(
        method="run_stage", params={"tenantId": "local", "dryRun": True, **selection}, id=1,
    ))
    assert response is not None
    assert response.error is not None
    assert response.error.code == INVALID_PARAMS
    assert "Discover does not support dry runs" in response.error.message
    assert starts == []


@pytest.mark.parametrize("stages, workflow", [
    (["discover"], DiscoverWorkflow),
    (["score", "discover"], JobPipelineWorkflow),
])
def test_registered_rpc_starts_ordinary_search_with_its_requested_sources(stages, workflow):
    starts = []

    async def starter(spec):
        starts.append(spec)
        return SimpleNamespace(id="synthetic-workflow", first_execution_run_id="synthetic-run")

    server = JsonRpcServer(workflow_starter=starter)
    register_default_handlers(server, canceler=lambda *_args, **_kwargs: None)
    response = server.dispatch(JsonRpcRequest(
        method="run_stage",
        params={"tenantId": "local", "stage": stages[0], "stages": stages,
                "dryRun": False, "sourceIds": ["jobspy:indeed"]},
        id=1,
    ))
    assert response is not None and response.error is None
    assert response.result["workflowId"] == "synthetic-workflow"
    assert len(starts) == 1 and starts[0].workflow is workflow
    assert starts[0].args[0].source_ids == ("jobspy:indeed",)
    if workflow is JobPipelineWorkflow:
        assert starts[0].args[0].dry_run is False


def test_other_stage_preview_keeps_its_mode():
    spec = workflow_specs.build_run_stage_workflow_spec(
        {"tenantId": "local", "stage": "score", "dryRun": True},
    )
    assert spec.workflow is JobPipelineWorkflow
    assert spec.args[0].dry_run is True


def test_conflicting_selection_without_preview_preserves_effective_stages():
    spec = workflow_specs.build_run_stage_workflow_spec(
        {"tenantId": "local", "stage": "discover", "stages": ["score"], "dryRun": False},
    )
    assert spec.workflow is JobPipelineWorkflow
    assert spec.args[0].stages == ["score"]
    assert spec.args[0].dry_run is False


def test_general_pipeline_builder_rejects_nested_discover_preview():
    with pytest.raises(ValueError, match="Discover does not support dry runs"):
        workflow_specs.build_pipeline_workflow_spec(
            {"tenantId": "local", "dryRun": True}, stages=["score", "discover"], limit=1,
        )
    with pytest.raises(ValueError, match="Discover does not support dry runs"):
        workflow_specs.build_pipeline_workflow_spec(
            {"tenantId": "local", "stage": "discover", "dryRun": True}, stages=["score"], limit=1,
        )
    with pytest.raises(ValueError, match="Discover does not support dry runs"):
        workflow_specs.build_pipeline_workflow_spec(
            {"tenantId": "local", "stage": "score", "stages": ["discover"], "dryRun": True},
            stages=["score"], limit=1,
        )


@pytest.mark.parametrize("command", [
    ["discover", "--dry-run"],
    ["run", "discover", "--dry-run"],
    ["run", "score", "discover", "--dry-run"],
    ["run", "all", "--dry-run"],
    ["run", "--dry-run"],
    ["action", "discover", "--dry-run"],
])
def test_cli_rejects_preview_before_bootstrap_and_dispatch(monkeypatch, command):
    output = StringIO()
    monkeypatch.setattr(cli, "console", Console(file=output, force_terminal=False, color_system=None))

    def unexpected(*_args, **_kwargs):
        raise AssertionError("preview must not bootstrap, write, or dispatch")

    monkeypatch.setattr(cli, "_bootstrap", unexpected)
    monkeypatch.setattr(cli, "_run_workflow_spec_from_cli", unexpected)
    monkeypatch.setattr(actions, "_bootstrap_runtime", unexpected)
    monkeypatch.setattr(actions, "_record_action_event", unexpected)
    result = CliRunner().invoke(cli.app, command)
    assert result.exit_code != 0
    assert "Discover does not support dry runs" in output.getvalue()


def test_structured_action_rejects_preview_without_events(monkeypatch):
    def unexpected(*_args, **_kwargs):
        raise AssertionError("preview must not initialize or write the workspace")

    monkeypatch.setattr(actions, "_bootstrap_runtime", unexpected)
    monkeypatch.setattr(actions, "_record_action_event", unexpected)
    result = run_local_action(LocalActionRequest(stage="discover", dry_run=True))
    assert result.ok is False and result.status == "failed" and result.dry_run is True
    assert "Discover does not support dry runs" in (result.error or "")
