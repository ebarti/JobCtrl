"""``mode='workflow'`` dispatch in ``JsonRpcServer``."""

from __future__ import annotations

import pytest

from jobhunter.domain.rpc.messages import (
    INTERNAL_ERROR,
    JsonRpcRequest,
    WorkflowStartSpec,
)
from jobhunter.infrastructure.rpc.server import JsonRpcServer


class _FakeWorkflow:
    pass


class _FakeHandle:
    def __init__(self, workflow_id: str, run_id: str) -> None:
        self.id = workflow_id
        self.first_execution_run_id = run_id


def _request(method: str, params=None, rid: int | str | None = 1) -> JsonRpcRequest:
    return JsonRpcRequest(method=method, params=params or {}, id=rid)


def test_register_rejects_legacy_fire_and_forget_mode() -> None:
    """The deleted ``fire_and_forget`` mode must no longer register."""
    server = JsonRpcServer()
    with pytest.raises(ValueError):
        server.register("legacy", lambda _p: None, mode="fire_and_forget")


def test_workflow_mode_calls_starter_and_returns_run_id() -> None:
    seen: list[WorkflowStartSpec] = []

    async def starter(spec: WorkflowStartSpec) -> _FakeHandle:
        seen.append(spec)
        return _FakeHandle("wf-id", "first-run-id")

    server = JsonRpcServer(workflow_starter=starter)
    spec = WorkflowStartSpec(workflow=_FakeWorkflow, args=("payload",))
    server.register("start", lambda _params: spec, mode="workflow")

    response = server.dispatch(_request("start"))

    assert response is not None
    body = response.to_dict()
    assert body["result"] == {
        "runId": "wf-id",
        "workflowId": "wf-id",
        "firstExecutionRunId": "first-run-id",
    }
    assert seen == [spec]


def test_workflow_mode_starter_failure_surfaces_internal_error() -> None:
    async def starter(_spec: WorkflowStartSpec) -> _FakeHandle:
        raise RuntimeError("temporal-down")

    server = JsonRpcServer(workflow_starter=starter)
    server.register(
        "start",
        lambda _params: WorkflowStartSpec(workflow=_FakeWorkflow, args=()),
        mode="workflow",
    )

    response = server.dispatch(_request("start"))

    assert response is not None
    body = response.to_dict()
    assert body["error"]["code"] == INTERNAL_ERROR
    assert body["error"]["data"] == "temporal-down"


def test_workflow_mode_handler_returning_non_spec_is_internal_error() -> None:
    async def starter(_spec: WorkflowStartSpec) -> _FakeHandle:  # pragma: no cover
        raise AssertionError("starter must not be called")

    server = JsonRpcServer(workflow_starter=starter)
    server.register("start", lambda _params: {"not": "a spec"}, mode="workflow")

    response = server.dispatch(_request("start"))

    assert response is not None
    body = response.to_dict()
    assert body["error"]["code"] == INTERNAL_ERROR


def test_workflow_mode_without_starter_is_internal_error() -> None:
    server = JsonRpcServer()  # no workflow_starter wired
    server.register(
        "start",
        lambda _p: WorkflowStartSpec(workflow=_FakeWorkflow, args=()),
        mode="workflow",
    )

    response = server.dispatch(_request("start"))
    assert response is not None
    body = response.to_dict()
    assert body["error"]["code"] == INTERNAL_ERROR
    assert "workflow_starter" in body["error"]["data"]
