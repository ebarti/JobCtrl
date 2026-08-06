"""``cancel_run`` JSON-RPC handler — cooperative workflow cancellation."""

from __future__ import annotations

import json
import uuid

from jobctrl.database import get_connection
from jobctrl.domain.rpc.messages import INVALID_PARAMS, JsonRpcRequest
from jobctrl.infrastructure.rpc.handlers import register_default_handlers
from jobctrl.infrastructure.rpc.server import JsonRpcServer


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
            params={
                "tenantId": "local",
                "runId": "wf-123",
                "requestedBy": "local_operator",
                "source": "jobctrl_api",
                "reason": "Canceled from JobCtrl.",
            },
            id=1,
        )
    )

    assert response is not None
    body = response.to_dict()
    assert body["result"] == {"runId": "wf-123", "status": "canceling"}
    assert cancelled == ["wf-123"]
    row = get_connection().execute(
        "SELECT payload_json FROM job_events "
        "WHERE event_type = 'WorkflowCancellationRequested' "
        "AND entity_ref = 'wf-123' ORDER BY event_id DESC LIMIT 1"
    ).fetchone()
    assert row is not None
    payload = json.loads(row[0])
    assert payload["requestedBy"] == "local_operator"
    assert payload["source"] == "jobctrl_api"
    assert payload["evidenceKind"] == "request_intent"
    assert payload["reason"] == "Canceled from JobCtrl."


def test_cancel_run_delivery_failure_does_not_record_request_intent() -> None:
    run_id = f"wf-{uuid.uuid4().hex}"

    async def canceler(_run_id: str) -> None:
        raise RuntimeError("Temporal unavailable")

    server = JsonRpcServer(workflow_starter=_stub_starter)
    register_default_handlers(server, canceler=canceler)
    response = server.dispatch(
        JsonRpcRequest(
            method="cancel_run",
            params={
                "tenantId": "local",
                "runId": run_id,
                "requestedBy": "local_operator",
                "source": "jobctrl_api",
            },
            id=1,
        )
    )

    assert response is not None
    assert "error" in response.to_dict()
    count = get_connection().execute(
        "SELECT COUNT(*) FROM job_events "
        "WHERE event_type = 'WorkflowCancellationRequested' AND entity_ref = ?",
        (run_id,),
    ).fetchone()[0]
    assert count == 0


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
