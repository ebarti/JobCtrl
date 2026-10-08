"""TS API test probe: real registered RPC + saved repository, model double only."""

from __future__ import annotations

import json
import os
from dataclasses import asdict
from pathlib import Path
import sys

# Refuse any workspace except the API test's explicitly marked synthetic root.
root = Path(os.environ["JOBCTRL_DIR"]).resolve()
if not (root / ".required-coaching-test").is_file():
    raise RuntimeError("Required coaching probe needs an owned synthetic workspace")

from jobctrl.domain.rpc.messages import JsonRpcRequest  # noqa: E402
from jobctrl.infrastructure.rpc.handlers import register_default_handlers  # noqa: E402
from jobctrl.infrastructure.rpc.server import JsonRpcServer  # noqa: E402
from jobctrl import llm  # noqa: E402

observed = []


class Model:
    def chat_json(self, messages, **kwargs):
        sources = json.loads(messages[1].content)["sources"]
        observed.append([json.loads(row["text"]) for row in sources])
        return {
            "suggestions": [],
            "citations": [{"source_id": row["source_id"], "quote": row["text"]} for row in sources],
            "rationale": "Explicit synthetic no-findings decision",
        }


from jobctrl.infrastructure import determinations  # noqa: E402
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository  # noqa: E402

determinations.determination_dependencies = lambda connection, **kwargs: dict(
    llm=Model(),
    repository=SqliteDeterminationRepository(connection),
    tenant_id=kwargs["tenant_id"],
    provider="synthetic",
    model="synthetic",
    lane=kwargs["lane"],
    preflight=lambda: None,
)
llm.enforce_spend_budget = lambda **kwargs: None
request = JsonRpcRequest.from_dict(json.load(sys.stdin))
if request.method != "profile_required_bullet_suggestions":
    raise RuntimeError("Probe supports only Required coaching")
server = JsonRpcServer()
register_default_handlers(server, canceler=lambda *_args, **_kwargs: None)
response = server.dispatch(request)
print(json.dumps({"response": asdict(response), "modelSources": observed}))
