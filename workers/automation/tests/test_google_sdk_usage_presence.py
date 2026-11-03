"""Installed SDK step presence must govern synthetic spend accounting."""

from __future__ import annotations

import asyncio
import json
import sqlite3
from types import SimpleNamespace

import pytest
from google.antigravity import types
from google.antigravity.conversation.conversation import Conversation

import jobctrl.database as database
import jobctrl.infrastructure.setup_probes as setup_probes
import jobctrl.llm as accounting
from jobctrl.infrastructure.llm.llm_client import GoogleSdkBackend
from jobctrl.infrastructure.llm.spend_observation import SpendAccountingUnresolved
from jobctrl.llm_lanes import bind_llm_lane


def _backend_with_sdk_steps(counts, *, error=None, conversation_type=Conversation, after_steps=None):
    conversations = []

    class Connection:
        is_idle = True
        conversation_id = "synthetic"

        async def send(self, prompt, **kwargs):
            pass

        async def receive_steps(self):
            for index, (prompt, candidates) in enumerate(counts):
                yield types.Step(
                    id=f"synthetic-step-{index}", step_index=index, type=types.StepType.TEXT_RESPONSE,
                    source=types.StepSource.MODEL, target=types.StepTarget.USER,
                    content_delta="synthetic", usage_metadata=types.UsageMetadata(
                        prompt_token_count=prompt, candidates_token_count=candidates,
                    ),
                )
            if after_steps is not None:
                after_steps(self.conversation)
            if error is not None:
                raise error

    class Agent:
        def __init__(self, config):
            connection = Connection()
            self.conversation = conversation_type(connection, max_history_size=0)
            connection.conversation = self.conversation
            self.conversation_id = "synthetic"
            conversations.append(self.conversation)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def chat(self, prompt):
            return await self.conversation.chat(prompt)

    return (GoogleSdkBackend(agent_factory=Agent, config_factory=lambda **kwargs: SimpleNamespace(**kwargs),
                             types_module=types, model="gemini-synthetic"), conversations)


def _isolated_ledger(monkeypatch, tmp_path):
    db_path = tmp_path / "jobctrl.db"
    monkeypatch.setattr(database, "DB_PATH", db_path)
    database.init_db(db_path)
    monkeypatch.setattr(accounting, "enforce_spend_budget", lambda _lane=None: accounting.read_llm_spend())
    monkeypatch.setattr(setup_probes, "antigravity_auth_kwargs", lambda env=None: {"api_key": "synthetic"})
    return db_path


def _receipt_report(tmp_path):
    receipt = next((tmp_path / ".jobctrl.db.llm-spend-pending").glob("*.jsonl"))
    _, observed = [json.loads(line) for line in receipt.read_text().splitlines()]
    return next(report for report in observed["ambiguous_reports"] if report.get("source") == "provider_step_subtotals")


@pytest.mark.asyncio
@pytest.mark.parametrize("termination", ["success", "failure", "cancel"])
@pytest.mark.parametrize("candidates", [None, 0])
async def test_real_sdk_distinguishes_missing_usage_from_observed_zero(monkeypatch, tmp_path, termination, candidates):
    db_path = _isolated_ledger(monkeypatch, tmp_path)
    error = asyncio.CancelledError("synthetic-cancel") if termination == "cancel" else OSError("synthetic stream")
    backend, conversations = _backend_with_sdk_steps([(11, candidates)], error=error if termination != "success" else None)
    with bind_llm_lane("scoring"):
        if termination == "success" and candidates == 0:
            assert await backend._call([{"role": "user", "content": "synthetic"}], response_schema=None,
                                       temperature=None, max_tokens=None, thinking_budget=None) == "synthetic"
        else:
            expected = SpendAccountingUnresolved if termination == "success" else type(error)
            with pytest.raises(expected) as raised:
                await backend._call([{"role": "user", "content": "synthetic"}], response_schema=None,
                                    temperature=None, max_tokens=None, thinking_budget=None)
            if termination != "success":
                assert raised.value is error

    # This is the lossy SDK behavior; source Step fields retain presence.
    assert conversations[0].last_turn_usage.candidates_token_count == 0
    assert conversations[0].history[0].usage_metadata.candidates_token_count == candidates
    assert conversations[0].receive_steps.__func__ is Conversation.receive_steps
    with sqlite3.connect(db_path) as raw:
        row = raw.execute("SELECT input_tokens, output_tokens FROM llm_spend WHERE lane = 'scoring'").fetchone()
    if candidates is None:
        assert row is None
        with pytest.raises(SpendAccountingUnresolved):
            accounting.read_llm_spend()
        source = _receipt_report(tmp_path)
        assert source["input_tokens"] == 11 and source["output_tokens"] is None
        assert source["input_incomplete"] is False and source["output_incomplete"] is True
    else:
        assert row == (11, 0)
        assert accounting.read_llm_spend()["input_tokens"] == 11
    database.close_connection(db_path)


@pytest.mark.asyncio
@pytest.mark.parametrize("second_output", [None, 5])
async def test_real_sdk_one_missing_step_stays_unresolved_after_later_report(monkeypatch, tmp_path, second_output):
    db_path = _isolated_ledger(monkeypatch, tmp_path)
    backend, conversations = _backend_with_sdk_steps([(11, None), (4, second_output)])
    with bind_llm_lane("scoring"), pytest.raises(SpendAccountingUnresolved):
        await backend._call([{"role": "user", "content": "synthetic"}], response_schema=None,
                            temperature=None, max_tokens=None, thinking_budget=None)
    assert conversations[0].last_turn_usage.prompt_token_count == 15
    assert conversations[0].last_turn_usage.candidates_token_count == (second_output or 0)
    with sqlite3.connect(db_path) as raw:
        assert raw.execute("SELECT COUNT(*) FROM llm_spend").fetchone() == (0,)
    source = _receipt_report(tmp_path)
    assert source["input_tokens"] == 15 and source["output_tokens"] == second_output
    assert source["output_incomplete"] is True
    database.close_connection(db_path)


@pytest.mark.asyncio
async def test_real_sdk_complete_multiple_steps_are_recorded_once(monkeypatch, tmp_path):
    db_path = _isolated_ledger(monkeypatch, tmp_path)
    backend, conversations = _backend_with_sdk_steps([(11, 0), (4, 5)])
    with bind_llm_lane("scoring"):
        assert await backend._call([{"role": "user", "content": "synthetic"}], response_schema=None,
                                   temperature=None, max_tokens=None, thinking_budget=None) == "syntheticsynthetic"
    assert conversations[0].last_turn_usage.candidates_token_count == 5
    lane = accounting.read_llm_spend_by_lane()["scoring"]
    assert (lane["input_tokens"], lane["output_tokens"]) == (15, 5)
    assert not list((tmp_path / ".jobctrl.db.llm-spend-pending").glob("*.jsonl"))
    database.close_connection(db_path)


@pytest.mark.asyncio
async def test_aggregate_without_step_authority_is_unresolved(monkeypatch, tmp_path):
    db_path = _isolated_ledger(monkeypatch, tmp_path)

    class Response:
        usage_metadata = types.UsageMetadata(prompt_token_count=11, candidates_token_count=0)

        @property
        async def chunks(self):
            yield types.Text(step_index=0, text="synthetic")

        async def text(self):
            return "synthetic"

    class Agent:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def chat(self, prompt):
            return Response()

    backend = GoogleSdkBackend(agent_factory=lambda config: Agent(),
                               config_factory=lambda **kwargs: SimpleNamespace(**kwargs),
                               types_module=types, model="gemini-synthetic")
    with bind_llm_lane("scoring"), pytest.raises(SpendAccountingUnresolved):
        await backend._call([{"role": "user", "content": "synthetic"}], response_schema=None,
                            temperature=None, max_tokens=None, thinking_budget=None)
    with sqlite3.connect(db_path) as raw:
        assert raw.execute("SELECT COUNT(*) FROM llm_spend").fetchone() == (0,)
    receipt = next((tmp_path / ".jobctrl.db.llm-spend-pending").glob("*.jsonl"))
    _, observed = [json.loads(line) for line in receipt.read_text().splitlines()]
    source = next(report for report in observed["ambiguous_reports"] if report.get("source") == "unverified_sdk_aggregate")
    assert (source["input_tokens"], source["output_tokens"]) == (11, 0)
    with pytest.raises(SpendAccountingUnresolved):
        accounting.read_llm_spend()
    database.close_connection(db_path)


@pytest.mark.asyncio
async def test_inconsistent_sdk_aggregate_preserves_both_observations(monkeypatch, tmp_path):
    db_path = _isolated_ledger(monkeypatch, tmp_path)

    class DisagreeingConversation(Conversation):
        @property
        def last_turn_usage(self):
            usage = super().last_turn_usage
            if usage is not None:
                usage.prompt_token_count += 1
            return usage

    backend, _ = _backend_with_sdk_steps([(11, 7)], conversation_type=DisagreeingConversation)
    with bind_llm_lane("scoring"), pytest.raises(SpendAccountingUnresolved):
        await backend._call([{"role": "user", "content": "synthetic"}], response_schema=None,
                            temperature=None, max_tokens=None, thinking_budget=None)
    with sqlite3.connect(db_path) as raw:
        assert raw.execute("SELECT COUNT(*) FROM llm_spend").fetchone() == (0,)
    receipt = next((tmp_path / ".jobctrl.db.llm-spend-pending").glob("*.jsonl"))
    _, observed = [json.loads(line) for line in receipt.read_text().splitlines()]
    reports = {report.get("source"): report for report in observed["ambiguous_reports"] if report.get("source")}
    assert reports["provider_step_subtotals"]["input_tokens"] == 11
    assert reports["unverified_sdk_aggregate"]["input_tokens"] == 12
    database.close_connection(db_path)


@pytest.mark.asyncio
async def test_replaced_step_source_stays_unresolved_and_is_not_overwritten(monkeypatch, tmp_path):
    db_path = _isolated_ledger(monkeypatch, tmp_path)

    async def successor():
        if False:
            yield None

    def replace_source(conversation):
        conversation.receive_steps = successor

    backend, conversations = _backend_with_sdk_steps([(11, 7)], after_steps=replace_source)
    with bind_llm_lane("scoring"), pytest.raises(SpendAccountingUnresolved):
        await backend._call([{"role": "user", "content": "synthetic"}], response_schema=None,
                            temperature=None, max_tokens=None, thinking_budget=None)
    assert conversations[0].receive_steps is successor
    with sqlite3.connect(db_path) as raw:
        assert raw.execute("SELECT COUNT(*) FROM llm_spend").fetchone() == (0,)
    source = _receipt_report(tmp_path)
    assert (source["input_tokens"], source["output_tokens"]) == (11, 7)
    assert source["input_incomplete"] is True and source["output_incomplete"] is True
    database.close_connection(db_path)


@pytest.mark.asyncio
async def test_replaced_step_source_with_unavailable_aggregate_preserves_failure(monkeypatch, tmp_path):
    db_path = _isolated_ledger(monkeypatch, tmp_path)
    error = OSError("synthetic aggregate unavailable")

    class UnavailableConversation(Conversation):
        @property
        def last_turn_usage(self):
            if getattr(self, "source_replaced", False):
                raise error
            return super().last_turn_usage

    async def successor():
        if False:
            yield None

    def replace_source(conversation):
        conversation.source_replaced = True
        conversation.receive_steps = successor

    backend, conversations = _backend_with_sdk_steps(
        [(11, 7)], conversation_type=UnavailableConversation, after_steps=replace_source,
    )
    with bind_llm_lane("scoring"), pytest.raises(OSError) as raised:
        await backend._call([{"role": "user", "content": "synthetic"}], response_schema=None,
                            temperature=None, max_tokens=None, thinking_budget=None)
    assert raised.value is error
    assert conversations[0].receive_steps is successor
    with sqlite3.connect(db_path) as raw:
        assert raw.execute("SELECT COUNT(*) FROM llm_spend").fetchone() == (0,)
    source = _receipt_report(tmp_path)
    assert (source["input_tokens"], source["output_tokens"]) == (11, 7)
    assert source["input_incomplete"] is True and source["output_incomplete"] is True
    database.close_connection(db_path)


@pytest.mark.asyncio
@pytest.mark.parametrize("source_case", ["missing", "successor"])
@pytest.mark.parametrize("aggregate_case", ["none", "error"])
@pytest.mark.parametrize("termination", ["success", "failure", "cancel"])
async def test_lost_source_before_first_step_never_becomes_free(
    monkeypatch, tmp_path, source_case, aggregate_case, termination,
):
    db_path = _isolated_ledger(monkeypatch, tmp_path)
    stream_error = (asyncio.CancelledError("synthetic cancellation") if termination == "cancel"
                    else OSError("synthetic stream failure"))
    aggregate_error = OSError("synthetic aggregate failure")
    conversations = []

    class Connection:
        is_idle = True
        conversation_id = "synthetic"

        async def send(self, prompt, **kwargs):
            pass

        async def receive_steps(self):
            yield types.Step(
                id="synthetic-step", step_index=0, type=types.StepType.TEXT_RESPONSE,
                source=types.StepSource.MODEL, target=types.StepTarget.USER,
                content_delta="private-response-sentinel",
                usage_metadata=types.UsageMetadata(prompt_token_count=11, candidates_token_count=7),
            )
            if termination != "success":
                raise stream_error

    class UnavailableConversation(Conversation):
        @property
        def last_turn_usage(self):
            if aggregate_case == "error":
                raise aggregate_error
            return None

        async def receive_chunks(self):
            if source_case == "successor":
                # Replace the interceptor before the lazy SDK stream reads a step.
                async def successor():
                    async for step in Conversation.receive_steps(self):
                        yield step

                self.successor = successor
                self.receive_steps = successor
            async for chunk in super().receive_chunks():
                yield chunk

    class Agent:
        def __init__(self, config):
            self.actual_conversation = UnavailableConversation(Connection(), max_history_size=0)
            if source_case == "successor":
                self.conversation = self.actual_conversation
            self.conversation_id = "synthetic"
            conversations.append(self.actual_conversation)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def chat(self, prompt):
            return await self.actual_conversation.chat(prompt)

    backend = GoogleSdkBackend(agent_factory=Agent, config_factory=lambda **kwargs: SimpleNamespace(**kwargs),
                               types_module=types, model="gemini-synthetic")
    expected = (type(stream_error) if termination != "success" else
                OSError if aggregate_case == "error" else SpendAccountingUnresolved)
    with bind_llm_lane("scoring"), pytest.raises(expected) as raised:
        await backend._call([{"role": "user", "content": "private-prompt-sentinel"}], response_schema=None,
                            temperature=None, max_tokens=None, thinking_budget=None)
    if termination != "success":
        assert raised.value is stream_error
    elif aggregate_case == "error":
        assert raised.value is aggregate_error

    conversation = conversations[0]
    assert isinstance(conversation.history[0], types.Step)
    assert (conversation.history[0].usage_metadata.prompt_token_count,
            conversation.history[0].usage_metadata.candidates_token_count) == (11, 7)
    if source_case == "successor":
        assert conversation.receive_steps is conversation.successor
    with sqlite3.connect(db_path) as raw:
        assert raw.execute("SELECT COUNT(*) FROM llm_spend").fetchone() == (0,)
    receipt = next((tmp_path / ".jobctrl.db.llm-spend-pending").glob("*.jsonl"))
    receipt_text = receipt.read_text()
    assert "private-prompt-sentinel" not in receipt_text and "private-response-sentinel" not in receipt_text
    _, observed = [json.loads(line) for line in receipt_text.splitlines()]
    source = next(report for report in observed["ambiguous_reports"] if report.get("source") == "step_source_unavailable")
    assert source["input_tokens"] is None and source["output_tokens"] is None
    with pytest.raises(SpendAccountingUnresolved):
        accounting.read_llm_spend()
    database.close_connection(db_path)


@pytest.mark.asyncio
async def test_overlapping_real_sdk_calls_keep_step_evidence_on_their_own_lanes(monkeypatch, tmp_path):
    db_path = _isolated_ledger(monkeypatch, tmp_path)
    emitted = {"partial": asyncio.Event(), "complete": asyncio.Event()}

    class Connection:
        is_idle = True
        conversation_id = "synthetic"

        async def send(self, prompt, **kwargs):
            self.case = "partial" if "partial" in prompt else "complete"

        async def receive_steps(self):
            prompt_count, candidates_count = (11, None) if self.case == "partial" else (22, 0)
            yield types.Step(
                id=f"synthetic-{self.case}", type=types.StepType.TEXT_RESPONSE,
                source=types.StepSource.MODEL, target=types.StepTarget.USER, content_delta="synthetic",
                usage_metadata=types.UsageMetadata(prompt_token_count=prompt_count, candidates_token_count=candidates_count),
            )
            emitted[self.case].set()
            await emitted["complete" if self.case == "partial" else "partial"].wait()

    class Agent:
        def __init__(self, config):
            self.conversation = Conversation(Connection(), max_history_size=0)
            self.conversation_id = "synthetic"

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def chat(self, prompt):
            return await self.conversation.chat(prompt)

    backend = GoogleSdkBackend(agent_factory=Agent, config_factory=lambda **kwargs: SimpleNamespace(**kwargs),
                               types_module=types, model="gemini-synthetic")

    async def call(lane, content):
        with bind_llm_lane(lane):
            return await backend._call([{"role": "user", "content": content}], response_schema=None,
                                       temperature=None, max_tokens=None, thinking_budget=None)

    partial, complete = await asyncio.wait_for(
        asyncio.gather(call("scoring", "partial"), call("tailoring", "complete"), return_exceptions=True), 5,
    )
    assert isinstance(partial, SpendAccountingUnresolved)
    assert complete == "synthetic"
    with sqlite3.connect(db_path) as raw:
        assert raw.execute("SELECT lane, input_tokens, output_tokens FROM llm_spend").fetchall() == [("tailoring", 22, 0)]
    receipt = next((tmp_path / ".jobctrl.db.llm-spend-pending").glob("*.jsonl"))
    header, observed = [json.loads(line) for line in receipt.read_text().splitlines()]
    assert header["lane"] == "scoring"
    report = next(row for row in observed["ambiguous_reports"] if row.get("source") == "provider_step_subtotals")
    assert report["input_tokens"] == 11 and report["output_tokens"] is None
    with pytest.raises(SpendAccountingUnresolved):
        accounting.read_llm_spend()
    database.close_connection(db_path)
