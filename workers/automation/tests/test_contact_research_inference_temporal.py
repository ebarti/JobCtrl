"""Real Temporal dispatch and replay with synthetic contact model and fetch ports."""

from __future__ import annotations

import asyncio
import json
import sqlite3
import uuid
from unittest.mock import patch

import pytest
from temporalio import activity, workflow
from temporalio.converter import DataConverter
from temporalio.worker import Replayer, UnsandboxedWorkflowRunner

from jobctrl.contact.activities import (
    ResearchSourceInput, RunContactResearchActivityInput, RunContactResearchActivityOutput,
    run_contact_research_activity,
)
from jobctrl.contact.workflow import ContactResearchWorkflow, ContactResearchWorkflowInput, _output_to_result
from jobctrl.domain.contact import ResearchSourceOutcome
from jobctrl.domain.ports.contact import ResearchPageFetch
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
from jobctrl.infrastructure.temporal.finalize import record_workflow_outcome, record_workflow_started
from jobctrl.infrastructure.temporal.run_in_activity import shutdown_activity_executors
from jobctrl.infrastructure.temporal.worker import build_worker
from jobctrl.llm import SpendBudgetStatus, check_spend_budget
from tests.temporal_env import local_env


@pytest.mark.asyncio
async def test_parent_activity_output_deserializes_without_new_failure_field():
    payloads = await DataConverter.default.encode([{
        "task_id": "legacy-task", "status": "needs_review", "candidate_count": 0, "attempt_count": 1,
    }])
    (output,) = await DataConverter.default.decode(payloads, [RunContactResearchActivityOutput])
    assert output.error_code is None
    result = _output_to_result(output)
    assert result.task_id == "legacy-task" and result.status == "needs_review" and result.error_code is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("old_history", "budget_denied", "overlap"),
    [(False, False, False), (False, True, False), (True, False, False), (False, False, True)],
)
async def test_contact_inference_temporal_dispatch_and_replay(monkeypatch, tmp_path, old_history, budget_denied, overlap):
    from jobctrl import database, llm
    from jobctrl.infrastructure import contact, determinations, events
    from jobctrl.infrastructure.temporal import runtime_guard

    path = tmp_path / "research.db"
    database.init_db(path).close()
    monkeypatch.setattr(database, "DB_PATH", path)
    monkeypatch.setattr(runtime_guard, "assert_activity_runtime", lambda **_kwargs: None)
    monkeypatch.setattr(events, "get_default_publisher", lambda: InProcessEventBus())
    calls = []

    class Fetcher:
        def __init__(self, **_kwargs):
            pass

        def fetch(self, _url):
            return ResearchPageFetch(outcome="allowed", text="Synthetic public team page")

    class Model:
        def chat_json(self, messages, **_kwargs):
            calls.append("model")
            if overlap:
                from jobctrl.domain.contact import ContactLink, ContactResearchService, ContactResearchSourcePolicy
                from jobctrl.domain.contact import ResearchSourceSpec, RunContactResearchUseCase
                from jobctrl.domain.ports.llm import LlmFailure
                from jobctrl.domain.tenant import LOCAL_TENANT
                from jobctrl.infrastructure.contact import SqliteContactResearchTaskRepository

                peer = sqlite3.connect(path, timeout=1)
                peer.row_factory = sqlite3.Row
                try:
                    class PeerFetcher:
                        def fetch(self, _url):
                            return ResearchPageFetch(outcome="allowed", text="Synthetic Person")

                    class PeerModel:
                        def chat_json(self, peer_messages, **_kwargs):
                            source = json.loads(peer_messages[1].content)["sources"][0]
                            return {"source_id": source["source_id"], "candidates": [{
                                "name": {"source_id": source["source_id"], "start": 0, "end": 16},
                                "role": "recruiter", "confidence": 0.5,
                            }]}

                    repository = SqliteContactResearchTaskRepository(peer, publisher=InProcessEventBus())
                    service = ContactResearchService(
                        policy=ContactResearchSourcePolicy(domain_allowlist=("acme.example",)),
                        determination_repository=SqliteDeterminationRepository(peer), preflight=lambda: None,
                        provider="synthetic", selected_model="synthetic",
                    )
                    accepted = RunContactResearchUseCase(
                        repository=repository, service=service, fetcher=PeerFetcher(), llm=PeerModel(),
                    ).execute(
                        LOCAL_TENANT, task_id="synthetic-task", link=ContactLink(employer="Acme"),
                        sources=(ResearchSourceSpec(category="public_web_page", url="https://acme.example/team"),),
                    )
                    assert accepted.candidates
                finally:
                    peer.close()
                raise LlmFailure("provider_unavailable")
            return {"source_id": json.loads(messages[1].content)["sources"][0]["source_id"], "candidates": []}

    def preflight():
        calls.append("source_preflight")
        if budget_denied:
            raise RuntimeError("synthetic budget refusal")

    def dependencies(conn, *, tenant_id, lane, model_spec=None):
        return {
            "llm": Model(), "repository": SqliteDeterminationRepository(conn),
            "tenant_id": str(tenant_id), "provider": "synthetic", "model": "synthetic",
            "lane": lane, "preflight": preflight,
        }

    monkeypatch.setattr(contact, "GatewayContactResearchFetcher", Fetcher)
    monkeypatch.setattr(determinations, "determination_dependencies", dependencies)
    def legacy_preflight(lane):
        calls.append("old_preflight")
        return SpendBudgetStatus(
            day="2026-01-01", input_tokens=0, output_tokens=0, estimated_usd=0,
            daily_budget_usd=1, lane=lane, lane_input_tokens=0, lane_output_tokens=0,
            lane_token_limit=100, lane_exceeded=False, global_exceeded=False, exceeded=False,
        )

    monkeypatch.setattr(llm, "enforce_spend_budget", legacy_preflight)
    original_patched = workflow.patched

    def legacy_marker(marker):
        if marker in {"contact-research-source-spend-preflight-v1", "contact-research-attempt-failure-outcome-v1"}:
            return False
        return original_patched(marker)

    queue = f"contact-inference-{uuid.uuid4()}"

    @activity.defn(name="run_contact_research")
    async def legacy_activity(payload: RunContactResearchActivityInput) -> dict:
        output = await run_contact_research_activity(payload)
        return {
            "task_id": output.task_id, "status": output.status,
            "candidate_count": output.candidate_count, "attempt_count": output.attempt_count,
        }

    async with local_env() as env:
        worker = build_worker(
            env.client, task_queue=queue, workflows=[ContactResearchWorkflow],
            activities=[legacy_activity if old_history else run_contact_research_activity, check_spend_budget,
                        record_workflow_started, record_workflow_outcome],
        )
        try:
            with patch("temporalio.workflow.patched", side_effect=legacy_marker if old_history else original_patched):
                async with worker:
                    handle = await env.client.start_workflow(
                        ContactResearchWorkflow.run,
                        ContactResearchWorkflowInput(
                            tenant_id="local", task_id="synthetic-task", employer="Acme",
                            sources=(ResearchSourceInput(category="public_web_page", url="https://acme.example/team"),),
                        ),
                        id=f"contact-inference-{uuid.uuid4()}", task_queue=queue,
                    )
                    result = await asyncio.wait_for(handle.result(), timeout=20)
                    history = await handle.fetch_history()
            await Replayer(workflows=[ContactResearchWorkflow], workflow_runner=UnsandboxedWorkflowRunner()).replay_workflow(history)
        finally:
            shutdown_activity_executors()

    conn = database.get_connection(path)
    row = conn.execute("SELECT status, error_class, source_attempts_json FROM contact_research_tasks").fetchone()
    attempts = json.loads(row["source_attempts_json"])
    outcome = conn.execute(
        "SELECT event_type, payload_json FROM job_events WHERE event_type IN ('WorkflowCompleted', 'WorkflowFailed')"
    ).fetchone()
    if overlap:
        assert result.status == "failed" and result.error_code == "provider_unavailable"
        assert row["status"] == "needs_review" and result.candidate_count == 1
        assert [attempt["outcome"] for attempt in attempts] == ["allowed", "provider_unavailable"]
        assert calls == ["source_preflight", "model"] and outcome["event_type"] == "WorkflowFailed"
        assert conn.execute(
            "SELECT COUNT(*) FROM job_events WHERE event_type = 'ContactResearchSourceAttemptFailed'"
        ).fetchone()[0] == 1
    elif budget_denied:
        assert result.status == row["status"] == "failed"
        assert result.error_code == row["error_class"] == attempts[0]["outcome"] == "spend_denied"
        assert calls == ["source_preflight"] and outcome["event_type"] == "WorkflowFailed"
    else:
        assert result.status == row["status"] == "needs_review"
        assert attempts[0]["outcome"] == ResearchSourceOutcome.NO_CANDIDATES.value and attempts[0]["determinationId"]
        assert calls == (["old_preflight", "source_preflight", "model"] if old_history else ["source_preflight", "model"])
        assert outcome["event_type"] == "WorkflowCompleted"
    database.close_connection(path)
