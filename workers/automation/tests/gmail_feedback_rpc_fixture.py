"""Owned synthetic transports for the real Gmail HTTP-to-RPC integration test."""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path

import httpx

from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.infrastructure import determinations
from jobctrl.infrastructure.gmail import client as client_module
from jobctrl.infrastructure.gmail import feedback as feedback_module
from jobctrl.infrastructure.gmail.client import GmailClient
from jobctrl.infrastructure.rpc.handlers import register_default_handlers
from jobctrl.infrastructure.rpc.server import JsonRpcServer

ROOT = Path(os.environ["JOBCTRL_DIR"]).resolve()
assert (ROOT / ".gmail-feedback-synthetic").read_text() == "owned synthetic Gmail fixture"
assert (ROOT / "jobctrl.db").is_file()
BODY = "Synthetic private body: the project is proceeding."


def mode() -> str:
    return (ROOT / "gmail-mode.txt").read_text(encoding="utf-8").strip()


def transport(request: httpx.Request) -> httpx.Response:
    assert request.url.host == "gmail.googleapis.com"
    assert request.method == "GET"
    if request.url.path.endswith("/messages"):
        with (ROOT / "gmail-searches.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(dict(request.url.params)) + "\n")
        if mode() == "provider_failure":
            return httpx.Response(503, text=BODY)
        return httpx.Response(200, json={"messages": [{"id": "synthetic-message"}]})
    assert request.url.path.endswith("/messages/synthetic-message")
    headers = [
        {"name": "From", "value": "person@unrelated.example"},
        {"name": "To", "value": "candidate@example.com"},
        {"name": "Subject", "value": "A neutral note"},
        {"name": "Date", "value": "Mon, 01 Jun 2026 12:00:00 +0000"},
    ]
    payload = {"id": "synthetic-message", "threadId": "synthetic-thread", "payload": {"headers": headers}}
    if request.url.params.get("format") == "metadata":
        payload["internalDate"] = "1780315200000"
    else:
        payload["payload"].update(
            mimeType="text/plain", body={"data": base64.urlsafe_b64encode(BODY.encode()).decode()}
        )
    return httpx.Response(200, json=payload)


class SyntheticModel:
    def chat_json(self, messages, *, response_schema, **_kwargs):
        if mode() == "model_unavailable":
            raise DeterminationFailure("provider_unavailable")
        data = json.loads(messages[1].content)
        sources = {row["source_id"]: row["text"] for row in data["sources"]}

        def citation(ident: str):
            return {"source_id": ident, "quote": sources[ident][:4000], "exact_values": []}

        if response_schema["title"] == "ApplicationMessageLink":
            linked = mode() == "linked"
            ident = data["context"]["application_ids"][0] if linked else None
            return {
                "decision": "linked" if linked else "unrelated",
                "application_id": ident,
                "confidence": 0.63,
                "citations": [citation("message_headers"), citation("application:" + ident)]
                if ident else [citation("message_headers")],
                "rationale": "Explicit synthetic linking verdict",
            }
        return {
            "kind": "applied_confirmation",
            "confidence": 0.64,
            "citations": [{"source_id": "message", "quote": BODY, "exact_values": []}],
            "rationale": "Explicit synthetic outcome verdict",
        }


def dependencies(conn, **_kwargs):
    return dict(
        llm=SyntheticModel(), repository=determinations.SqliteDeterminationRepository(conn),
        tenant_id="local", provider="synthetic", model="synthetic", lane="enrichment", preflight=lambda: None,
    )


client_module.get_access_token = lambda: "synthetic-token"
http = httpx.Client(transport=httpx.MockTransport(transport))
feedback_module.GmailClient = lambda: GmailClient(http=http)
determinations.determination_dependencies = dependencies
server = JsonRpcServer()
register_default_handlers(server, canceler=lambda *_args, **_kwargs: None)
try:
    server.serve()
finally:
    http.close()
