"""Owned synthetic model ports around the real registered RPC transport.

Used by API publication regressions. No production flags, sends, source-output
replay or user workspace access. The caller owns the database and barrier files.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import time
from types import SimpleNamespace

from tests.determination_fakes import VerificationModel
from tests.test_outreach_draft_gates import _profile


class PublicationModel(VerificationModel):
    provider_id = "synthetic"
    model = "synthetic"

    def chat_json(self, messages, *, response_schema, **kwargs):
        data = json.loads(messages[1].content)
        if response_schema["title"] == "GeneratedProseDraft":
            with (Path(os.environ["OUTREACH_QA_BARRIERS"]) / "generation-calls").open("a") as calls:
                calls.write("synthesis entered after base capture\n")
            return {"lines": [{
                "line_id": "outreach:body", "text": "Could we discuss the team?",
                "evidence_ids": [data["sources"][0]["source_id"]], "requirement_ids": [],
                "transform_type": "rephrase", "reason": "Explicit synthetic proposal",
            }]}
        if response_schema["title"] != "ArtifactQuality":
            text = next(row["text"] for row in data["sources"] if row["source_id"].startswith("line:"))
            barrier = Path(os.environ["OUTREACH_QA_BARRIERS"]) / hashlib.sha256(text.encode()).hexdigest()
            if barrier.exists():
                barrier.with_suffix(".ready").write_text("inside production verification model port\n")
                deadline = time.monotonic() + 20
                while not barrier.with_suffix(".release").exists():
                    if time.monotonic() > deadline:
                        raise RuntimeError("Owned Outreach gate barrier timed out")
                    time.sleep(0.01)
        result = super().chat_json(messages, response_schema=response_schema, **kwargs)
        if response_schema["title"] != "ArtifactQuality":
            sources = {row["source_id"]: row["text"] for row in data["sources"]}
            for line, reviewed in zip(data["context"]["lines"], result["lines"], strict=True):
                evidence_id = line["allowed_evidence_ids"][0]
                reviewed["claims"] = [{
                    "kind": "advice", "support": "not_factual",
                    "text": {"source_id": "line:" + line["line_id"], "quote": sources["line:" + line["line_id"]], "exact_values": []},
                    "evidence": [{"source_id": evidence_id, "quote": sources[evidence_id], "exact_values": []}],
                    "rationale": "Explicit synthetic source-bound claim",
                }]
        return result


def main():
    import jobctrl.infrastructure.profile.factory as profile_factory
    import jobctrl.infrastructure.llm.llm_client as llm_client
    import jobctrl.infrastructure.determinations as determinations
    from jobctrl.infrastructure.rpc.handlers import register_default_handlers
    from jobctrl.infrastructure.rpc.server import JsonRpcServer

    profile_factory.get_profile_repository = lambda: SimpleNamespace(
        load_snapshot=lambda tenant: SimpleNamespace(as_dict=_profile)
    )
    llm_client.get_llm_adapter = PublicationModel

    def dependencies(connection, *, tenant_id, lane, adapter):
        return dict(
            llm=adapter, repository=determinations.SqliteDeterminationRepository(connection),
            tenant_id=str(tenant_id), provider="synthetic", model="synthetic", lane=lane,
            preflight=lambda: None,
        )

    determinations.determination_dependencies = dependencies
    server = JsonRpcServer()
    register_default_handlers(server, canceler=lambda *args, **kwargs: None)
    server.serve()


if __name__ == "__main__":
    main()
