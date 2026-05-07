"""``apply`` JSON-RPC handler returns a :class:`WorkflowStartSpec`."""

from __future__ import annotations

from jobhunter.apply.workflow import ApplyWorkflow, ApplyWorkflowInput
from jobhunter.domain.rpc.messages import JsonRpcRequest, WorkflowStartSpec
from jobhunter.infrastructure.rpc.handlers import apply_action, register_default_handlers
from jobhunter.infrastructure.rpc.server import JsonRpcServer


class _FakeHandle:
    def __init__(self, workflow_id: str = "apply-wf", run_id: str = "first-run") -> None:
        self.id = workflow_id
        self.first_execution_run_id = run_id


async def _stub_canceler(_run_id: str) -> None:  # pragma: no cover — not invoked
    return None


def test_apply_handler_returns_workflow_start_spec() -> None:
    spec = apply_action(
        {
            "tenantId": "local",
            "jobUrl": "https://example.com/job/1",
            "limit": 2,
            "model": "sonnet",
            "dryRun": True,
            "headless": True,
            "minScore": 8,
            "workers": 3,
        }
    )

    assert isinstance(spec, WorkflowStartSpec)
    assert spec.workflow is ApplyWorkflow
    (payload,) = spec.args
    assert isinstance(payload, ApplyWorkflowInput)
    assert payload == ApplyWorkflowInput(
        tenant_id="local",
        job_url="https://example.com/job/1",
        dry_run=True,
        headless=True,
        model="sonnet",
        min_score=8,
        workers=3,
        limit=2,
    )


def test_apply_via_jsonrpc_starts_workflow() -> None:
    seen: list[WorkflowStartSpec] = []

    async def starter(spec: WorkflowStartSpec) -> _FakeHandle:
        seen.append(spec)
        return _FakeHandle("apply-wf-123", "first-exec-run-id")

    server = JsonRpcServer(workflow_starter=starter)
    register_default_handlers(server, canceler=_stub_canceler)

    response = server.dispatch(
        JsonRpcRequest(
            method="apply",
            params={
                "tenantId": "local",
                "jobUrl": "https://example.com/job/1",
                "limit": 1,
                "model": "haiku",
                "dryRun": False,
                "headless": False,
            },
            id=42,
        )
    )

    assert response is not None
    body = response.to_dict()
    assert body["result"] == {
        "runId": "apply-wf-123",
        "workflowId": "apply-wf-123",
        "firstExecutionRunId": "first-exec-run-id",
    }
    assert len(seen) == 1
    assert seen[0].workflow is ApplyWorkflow
    (payload,) = seen[0].args
    assert payload.tenant_id == "local"
    assert payload.job_url == "https://example.com/job/1"
    assert payload.limit == 1
    assert payload.model == "haiku"
