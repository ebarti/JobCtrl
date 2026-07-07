"""``cancel_run`` JSON-RPC handler — cooperative workflow cancellation."""

from __future__ import annotations

from jobctl.domain.rpc.messages import INVALID_PARAMS, JsonRpcRequest
from jobctl.infrastructure.rpc.handlers import register_default_handlers
from jobctl.infrastructure.rpc.server import JsonRpcServer


async def _stub_starter(_spec):  # pragma: no cover — not invoked in cancel tests
    raise AssertionError("starter must not be called")


def test_cancel_run_calls_canceler_with_run_id() -> None:
    cancelled: list[str] = []

    async def canceler(run_id: str) -> None:
        cancelled.append(run_id)

    server = JsonRpcServer(workflow_starter=_stub_starter)
    register_default_handlers(server, canceler=canceler)

    response = server.dispatch(
        JsonRpcRequest(
            method="cancel_run",
            params={"tenantId": "local", "runId": "wf-123"},
            id=1,
        )
    )

    assert response is not None
    body = response.to_dict()
    assert body["result"] == {"runId": "wf-123", "status": "canceling"}
    assert cancelled == ["wf-123"]


def test_cancel_run_missing_run_id_returns_invalid_params() -> None:
    async def canceler(_run_id: str) -> None:  # pragma: no cover — not reached
        return None

    server = JsonRpcServer(workflow_starter=_stub_starter)
    register_default_handlers(server, canceler=canceler)

    response = server.dispatch(
        JsonRpcRequest(method="cancel_run", params={"tenantId": "local"}, id=1)
    )
    assert response is not None
    body = response.to_dict()
    assert body["error"]["code"] == INVALID_PARAMS
