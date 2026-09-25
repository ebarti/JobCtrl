"""Execute shared boundary cases through the registered Python JSON-RPC server.

This is test support, not a second production method registry. The Python test
pins its live observation; the TypeScript test checks that snapshot against
RpcMethods and validates returned shapes.
"""

from __future__ import annotations

import io
import json
from pathlib import Path
from unittest.mock import patch

from jobctrl import database
from jobctrl.domain.rpc.messages import JsonRpcRequest, WorkflowStartSpec
from jobctrl.infrastructure.llm import model_catalog
from jobctrl.infrastructure.rpc.handlers import register_default_handlers
from jobctrl.infrastructure.rpc.server import JsonRpcServer

FIXTURE = Path(__file__).parent / "fixtures" / "rpc_boundary.json"


class _Handle:
    id = "synthetic-workflow"
    first_execution_run_id = "synthetic-first-run"

    async def result(self) -> dict[str, str]:
        return {"status": "succeeded"}


async def _canceler(_run_id: str) -> None:
    raise AssertionError("the contract probe must not cancel a workflow")


def build_server(*, started_specs: list[WorkflowStartSpec] | None = None) -> JsonRpcServer:
    async def starter(spec: WorkflowStartSpec) -> _Handle:
        if started_specs is not None:
            started_specs.append(spec)
        return _Handle()

    server = JsonRpcServer(workflow_starter=starter)
    register_default_handlers(server, canceler=_canceler)
    return server


def run_probe() -> dict[str, object]:
    cases = json.loads(FIXTURE.read_text())["cases"]
    started_specs: list[WorkflowStartSpec] = []
    server = build_server(started_specs=started_specs)
    inventory = [
        {"method": method, "mode": spec.mode}
        for method, spec in sorted(server._handlers.items())
    ]
    catalog = {
        "providers": [
            {"provider": provider, "configured": False, "ready": False, "source": "live", "models": []}
            for provider in ("codex", "claude", "google")
        ]
    }
    observations: dict[str, dict[str, object]] = {}
    with (
        patch.object(model_catalog, "provider_model_catalog", return_value=catalog),
        patch.object(database, "get_connection", return_value=object()),
        patch.object(database, "get_jobs_by_stage", return_value=[]),
    ):
        for case in cases:
            payload = case.get("request")
            line = case.get("raw", json.dumps(payload))
            parsed: bool
            normalized_params: object = None
            try:
                if not isinstance(payload, dict):
                    raise ValueError("not an object")
                request = JsonRpcRequest.from_dict(payload)
                parsed = True
                normalized_params = request.params
            except ValueError:
                parsed = False
            output = io.StringIO()
            starts_before = len(started_specs)
            server.serve(stdin=io.StringIO(line + "\n"), stdout=output)
            responses = [json.loads(value) for value in output.getvalue().splitlines()]
            observation: dict[str, object] = {
                "pythonParsed": parsed,
                "normalizedParams": normalized_params,
                "responses": responses,
            }
            if len(started_specs) > starts_before:
                spec = started_specs[-1]
                observation["workflowSpec"] = {
                    "workflow": spec.workflow.__name__,
                    "workflowId": spec.workflow_id,
                    "sourceIds": list(getattr(spec.args[0], "source_ids", ())),
                }
            observations[case["name"]] = observation
    return {"inventory": inventory, "observations": observations}


if __name__ == "__main__":
    print(json.dumps(run_probe()))
