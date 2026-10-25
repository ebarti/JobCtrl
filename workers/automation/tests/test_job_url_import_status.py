"""Only exact acknowledged import histories may supply completion results."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from temporalio.client import WorkflowExecutionStatus

from jobctrl.discovery.job_url_import_workflow import JobUrlImportWorkflowResult, job_url_import_workflow_id
from jobctrl.infrastructure.rpc import job_url_import_status as module
from jobctrl.infrastructure.rpc.server import _RpcParamError

EXECUTION = "11111111-1111-4111-8111-111111111111"
WORKFLOW = job_url_import_workflow_id("local", "https://example.test/jobs/42")


@pytest.fixture
def setup(monkeypatch, tmp_path):
    guard = Mock()
    monkeypatch.setattr(module, "assert_expected_runtime", guard)
    params = {
        "tenantId": "local",
        "workflowId": WORKFLOW,
        "executionId": EXECUTION,
        "expectedAppDir": str(tmp_path),
        "expectedDbPath": str(tmp_path / "jobctrl.db"),
    }
    description = SimpleNamespace(
        id=WORKFLOW, run_id=EXECUTION, workflow_type="JobUrlImportWorkflow", status=WorkflowExecutionStatus.RUNNING
    )
    handle = SimpleNamespace(describe=AsyncMock(return_value=description), result=AsyncMock())
    client = SimpleNamespace(get_workflow_handle=Mock(return_value=handle))
    factory = AsyncMock(return_value=client)
    return params, description, handle, client, factory, guard


def test_running_import_returns_without_waiting_for_completion(setup):
    params, _, handle, client, factory, guard = setup
    handle.result.side_effect = AssertionError("Running results must never be awaited")
    result = module.job_url_import_status(params, client_factory=factory)
    assert result == {"workflowId": WORKFLOW, "executionId": EXECUTION, "status": "pending"}
    client.get_workflow_handle.assert_called_once_with(WORKFLOW, run_id=EXECUTION)
    handle.result.assert_not_awaited()
    guard.assert_called_once_with(expected_app_dir=params["expectedAppDir"], expected_db_path=params["expectedDbPath"])


def test_completed_result_is_read_only_from_the_exact_run(setup):
    params, description, handle, _, factory, _ = setup
    description.status = WorkflowExecutionStatus.COMPLETED
    handle.result.return_value = JobUrlImportWorkflowResult(
        status="succeeded",
        outcome="imported",
        job_id="22222222-2222-4222-8222-222222222222",
        imported_at="2026-10-24T12:00:00Z",
    )
    result = module.job_url_import_status(params, client_factory=factory)
    assert result["status"] == "succeeded"
    assert result["result"]["job_id"] == "22222222-2222-4222-8222-222222222222"
    handle.result.assert_awaited_once_with(follow_runs=False)


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (WorkflowExecutionStatus.FAILED, "failed"),
        (WorkflowExecutionStatus.CANCELED, "canceled"),
        (WorkflowExecutionStatus.TIMED_OUT, "timed_out"),
        (WorkflowExecutionStatus.TERMINATED, "terminated"),
    ],
)
def test_terminal_history_does_not_wait_or_read_exception_text(setup, status, expected):
    params, description, handle, _, factory, _ = setup
    description.status = status
    assert module.job_url_import_status(params, client_factory=factory)["status"] == expected
    handle.result.assert_not_awaited()


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("tenantId", "foreign"),
        ("workflowId", "unrelated-workflow"),
        ("executionId", "not-a-run-id"),
        ("unexpected", True),
    ],
)
def test_foreign_or_malformed_request_is_rejected_before_temporal(setup, field, value):
    params, _, _, _, factory, _ = setup
    with pytest.raises(_RpcParamError):
        module.job_url_import_status({**params, field: value}, client_factory=factory)
    factory.assert_not_awaited()


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("id", "foreign"),
        ("run_id", "22222222-2222-4222-8222-222222222222"),
        ("workflow_type", "ApplyWorkflow"),
    ],
)
def test_description_identity_must_match_before_result_read(setup, field, value):
    params, description, handle, _, factory, _ = setup
    description.status = WorkflowExecutionStatus.COMPLETED
    setattr(description, field, value)
    with pytest.raises(_RpcParamError):
        module.job_url_import_status(params, client_factory=factory)
    handle.result.assert_not_awaited()


def test_wrong_runtime_fails_before_temporal(setup):
    params, _, _, _, factory, guard = setup
    guard.side_effect = ValueError("Runtime identity mismatch")
    with pytest.raises(ValueError, match="Runtime identity mismatch"):
        module.job_url_import_status(params, client_factory=factory)
    factory.assert_not_awaited()
