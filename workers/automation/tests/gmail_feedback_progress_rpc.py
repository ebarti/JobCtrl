"""Synthetic Gmail/model ports around the real scan and registered RPC handler."""
from __future__ import annotations

import os
import sys
from pathlib import Path

import httpx

from tests.test_gmail_feedback import (
    FakeGmailClient,
    _linked_message_body,
    _linked_message_metadata,
    seed_feedback_db,
)

PRIVATE_CANARY = "owned private message and note canary"


def main() -> None:
    workspace = Path(os.environ["JOBCTRL_DIR"])
    if sys.argv[1:] == ["seed"]:
        seed_feedback_db(workspace)
        return

    import jobctrl.infrastructure.determinations as determinations
    import jobctrl.infrastructure.gmail.feedback as feedback
    from jobctrl.infrastructure.rpc.handlers import register_default_handlers
    from jobctrl.infrastructure.rpc.server import JsonRpcServer

    class FailingRead(FakeGmailClient):
        fail = True

        def read_email(self, *, message_id: str):
            if message_id == "second" and self.fail:
                self.fail = False
                raise httpx.ConnectError(PRIVATE_CANARY)
            return super().read_email(message_id=message_id)

    metadata = [_linked_message_metadata("first"), _linked_message_metadata("second")]
    metadata[0]["subject"] = PRIVATE_CANARY
    client = FailingRead(
        metadata,
        {ident: _linked_message_body(ident, PRIVATE_CANARY) for ident in ("first", "second")},
    )
    feedback.GmailClient = lambda: client

    def dependencies(connection, *, tenant_id, lane):
        return {
            "llm": client.model,
            "repository": determinations.SqliteDeterminationRepository(connection),
            "tenant_id": tenant_id,
            "provider": "synthetic",
            "model": "synthetic",
            "lane": lane,
            "preflight": lambda: None,
        }

    determinations.determination_dependencies = dependencies
    server = JsonRpcServer()
    register_default_handlers(server, canceler=lambda *args, **kwargs: None)
    server.serve()


if __name__ == "__main__":
    main()
