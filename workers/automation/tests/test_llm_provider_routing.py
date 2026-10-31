"""No-network provider routing for plain and schema-constrained LlmPort calls."""

from __future__ import annotations

import asyncio
import json
import sqlite3
from types import SimpleNamespace
from typing import Any

import pytest

import jobctrl.infrastructure.setup_probes as setup_probes
import jobctrl.llm as legacy_llm
from jobctrl.domain.ports.llm import LlmMessage
from jobctrl.infrastructure.llm.llm_client import (
    ClaudeSdkBackend,
    CodexSdkBackend,
    GoogleSdkBackend,
    SdkControlNormalizationWarning,
)
from jobctrl.infrastructure.llm.provider_errors import ProviderCallError
from jobctrl.llm_lanes import bind_llm_lane

_REAL_RECORD_LLM_SPEND = legacy_llm.record_llm_spend


@pytest.fixture(autouse=True)
def _llm_accounting_context(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr("jobctrl.llm.enforce_spend_budget", lambda _lane=None: None)
    monkeypatch.setattr("jobctrl.llm.record_llm_spend", lambda **_kwargs: None)
    with bind_llm_lane("tailoring"):
        yield


class ResultMessage:
    def __init__(self, *, result: str = "", structured_output: dict | None = None) -> None:
        self.result = result
        self.structured_output = structured_output
        self.subtype = "success"
        self.usage = {"input_tokens": 4, "output_tokens": 2}


class _Options:
    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        self.__dict__.update(kwargs)


def _claude_query(*, prompt: str, options: _Options):
    async def stream():
        if "output_format" in options.kwargs:
            yield ResultMessage(structured_output={"answer": 42})
        else:
            yield ResultMessage(result="plain claude")

    return stream()


class _CodexThread:
    def __init__(self, calls: dict[str, Any] | None = None) -> None:
        self.calls = calls

    async def run(self, prompt: str, **kwargs: Any) -> Any:
        if self.calls is not None:
            self.calls["run"] = {"prompt": prompt, **kwargs}
        response = json.dumps({"answer": 42}) if "output_schema" in kwargs else "plain codex"
        total = SimpleNamespace(input_tokens=5, output_tokens=3)
        return SimpleNamespace(
            status=SimpleNamespace(value="completed"),
            final_response=response,
            usage=SimpleNamespace(total=total),
        )


class _FailedCodexTurnHandle:
    id = "turn-builder-error"

    async def stream(self):
        # This mirrors the public SDK stream shape closely enough to prove we
        # retain TurnError fields that AsyncThread.run() otherwise discards.
        yield SimpleNamespace(
            payload=SimpleNamespace(
                turn_id=self.id,
                token_usage=SimpleNamespace(
                    total=SimpleNamespace(input_tokens=11, output_tokens=7)
                ),
            )
        )
        yield SimpleNamespace(
            payload=SimpleNamespace(
                turn=SimpleNamespace(
                    id=self.id,
                    status=SimpleNamespace(value="failed"),
                    error=SimpleNamespace(
                        message="builder error",
                        additional_details="schema validation failed",
                        codex_error_info=SimpleNamespace(
                            root=SimpleNamespace(value="serverOverloaded")
                        ),
                    ),
                )
            )
        )


class _FailedCodexThread:
    async def turn(self, prompt: str, **kwargs: Any) -> _FailedCodexTurnHandle:
        return _FailedCodexTurnHandle()


class _Codex:
    def __init__(self, calls: dict[str, Any] | None = None) -> None:
        self.calls = calls

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    async def thread_start(self, **kwargs: Any) -> _CodexThread:
        if self.calls is not None:
            self.calls["thread_start"] = kwargs
        return _CodexThread(self.calls)


class _FailedCodex(_Codex):
    async def thread_start(self, **kwargs: Any) -> _FailedCodexThread:
        return _FailedCodexThread()


class _UsageThenIteratorFailureStream:
    def __init__(self, turn_id: str) -> None:
        self._turn_id = turn_id
        self._usage = iter(((2, 1), (13, 5)))

    def __aiter__(self) -> _UsageThenIteratorFailureStream:
        return self

    async def __anext__(self) -> Any:
        try:
            input_tokens, output_tokens = next(self._usage)
        except StopIteration as exc:
            raise RuntimeError("synthetic stream failure") from exc
        return SimpleNamespace(
            payload=SimpleNamespace(
                turn_id=self._turn_id,
                token_usage=SimpleNamespace(
                    total=SimpleNamespace(
                        input_tokens=input_tokens,
                        output_tokens=output_tokens,
                    )
                ),
            )
        )

    async def aclose(self) -> None:
        return None


class _UsageThenIteratorFailureHandle:
    id = "turn-stream-failure"

    def stream(self) -> _UsageThenIteratorFailureStream:
        return _UsageThenIteratorFailureStream(self.id)


class _UsageThenIteratorFailureThread:
    async def turn(self, prompt: str, **kwargs: Any) -> _UsageThenIteratorFailureHandle:
        return _UsageThenIteratorFailureHandle()


class _UsageThenIteratorFailureCodex(_Codex):
    async def thread_start(self, **kwargs: Any) -> _UsageThenIteratorFailureThread:
        return _UsageThenIteratorFailureThread()


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel", [False, True])
async def test_codex_partial_later_usage_preserves_observed_counts_and_original_failure(monkeypatch, tmp_path, cancel):
    import jobctrl.database as database
    from jobctrl.infrastructure.llm.spend_observation import SpendAccountingUnresolved

    db_path = tmp_path / "jobctrl.db"
    monkeypatch.setattr(database, "DB_PATH", db_path)
    database.init_db(db_path)
    monkeypatch.setattr(legacy_llm, "enforce_spend_budget", lambda _lane=None: legacy_llm.read_llm_spend())
    monkeypatch.setattr(legacy_llm, "record_llm_spend", _REAL_RECORD_LLM_SPEND)
    error = asyncio.CancelledError("synthetic-cancel") if cancel else OSError("synthetic stream failure")

    class Stream:
        def __init__(self):
            self.values = iter(((11, 7), (20, None)))

        def __aiter__(self):
            return self

        async def __anext__(self):
            try:
                input_tokens, output_tokens = next(self.values)
            except StopIteration:
                raise error
            return SimpleNamespace(payload=SimpleNamespace(
                turn_id="synthetic-turn",
                token_usage=SimpleNamespace(total=SimpleNamespace(input_tokens=input_tokens, output_tokens=output_tokens)),
            ))

        async def aclose(self):
            pass

    class Handle:
        id = "synthetic-turn"

        def stream(self):
            return Stream()

    class Thread:
        async def turn(self, prompt, **kwargs):
            return Handle()

    class Codex(_Codex):
        async def thread_start(self, **kwargs):
            return Thread()

    backend = CodexSdkBackend(model="codex-test-model", async_codex_factory=Codex, approval_mode_factory=lambda: "deny")
    with pytest.raises(asyncio.CancelledError if cancel else ProviderCallError) as raised:
        await backend._call([{"role": "user", "content": "synthetic"}], response_schema=None,
                            temperature=None, max_tokens=None, thinking_budget=None)
    if cancel:
        assert raised.value is error
    else:
        assert raised.value.__cause__ is error
    with sqlite3.connect(db_path) as raw:
        assert raw.execute("SELECT COUNT(*) FROM llm_spend").fetchone() == (0,)
    receipt = next((tmp_path / ".jobctrl.db.llm-spend-pending").glob("*.jsonl"))
    header, observed = [json.loads(line) for line in receipt.read_text().splitlines()]
    assert header["provider"] == "openai" and header["lane"] == "tailoring"
    assert {(row["input_tokens"], row["output_tokens"]) for row in observed["ambiguous_reports"]} == {
        (11, 7), (20, None),
    }
    with pytest.raises(SpendAccountingUnresolved):
        legacy_llm.read_llm_spend()
    database.close_connection(db_path)


@pytest.mark.asyncio
async def test_codex_empty_usage_object_is_unresolved(monkeypatch, tmp_path):
    import jobctrl.database as database
    from jobctrl.infrastructure.llm.spend_observation import SpendAccountingUnresolved

    db_path = tmp_path / "jobctrl.db"
    monkeypatch.setattr(database, "DB_PATH", db_path)
    database.init_db(db_path)
    monkeypatch.setattr(legacy_llm, "enforce_spend_budget", lambda _lane=None: legacy_llm.read_llm_spend())
    monkeypatch.setattr(legacy_llm, "record_llm_spend", _REAL_RECORD_LLM_SPEND)

    class Thread:
        async def run(self, *args, **kwargs):
            return SimpleNamespace(status="completed", final_response="synthetic", usage=SimpleNamespace(total=None))

    class Codex(_Codex):
        async def thread_start(self, **kwargs):
            return Thread()

    backend = CodexSdkBackend(model="codex-test-model", async_codex_factory=Codex, approval_mode_factory=lambda: "deny")
    with pytest.raises(SpendAccountingUnresolved):
        await backend._call([{"role": "user", "content": "synthetic"}], response_schema=None,
                            temperature=None, max_tokens=None, thinking_budget=None)
    with sqlite3.connect(db_path) as raw:
        assert raw.execute("SELECT COUNT(*) FROM llm_spend").fetchone() == (0,)
    with pytest.raises(SpendAccountingUnresolved):
        legacy_llm.read_llm_spend()
    database.close_connection(db_path)


_DEFAULT_GOOGLE_USAGE = object()


class _GoogleConversation:
    def __init__(self, response):
        self.response = response

    async def receive_steps(self, usage=_DEFAULT_GOOGLE_USAGE):
        if usage is _DEFAULT_GOOGLE_USAGE:
            usage = self.response.usage_metadata
        yield SimpleNamespace(usage_metadata=usage)


class _GoogleResponse:
    usage_metadata = SimpleNamespace(
        prompt_token_count=6,
        candidates_token_count=2,
        thoughts_token_count=1,
    )

    def __init__(self) -> None:
        self.consumed = False
        self._conversation = _GoogleConversation(self)

    @property
    def chunks(self):
        async def stream():
            async for _ in self._conversation.receive_steps():
                yield "chunk"
            self.consumed = True

        return stream()

    async def text(self) -> str:
        assert self.consumed
        return "plain google"

    async def structured_output(self) -> dict:
        assert self.consumed
        return {"answer": 42}


class _GoogleAgent:
    def __init__(self, config: Any) -> None:
        self.config = config

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    async def chat(self, prompt: str) -> _GoogleResponse:
        self.response = _GoogleResponse()
        self.conversation = self.response._conversation
        return self.response


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel", [False, True])
@pytest.mark.parametrize("unavailable_after_close", [False, True])
async def test_google_usage_survives_stream_failure_and_cancellation(monkeypatch, cancel, unavailable_after_close):
    error = asyncio.CancelledError("synthetic-cancel") if cancel else OSError("synthetic stream failure")
    spend = []
    monkeypatch.setattr(legacy_llm, "record_llm_spend", lambda **values: spend.append(values))
    monkeypatch.setattr(setup_probes, "antigravity_auth_kwargs", lambda env=None: {"api_key": "synthetic"})

    class Response(_GoogleResponse):
        closed = False

        @property
        def usage_metadata(self):
            if self.closed and unavailable_after_close:
                raise RuntimeError("synthetic closed response")
            return _GoogleResponse.usage_metadata

        @property
        def chunks(self):
            async def stream():
                async for _ in self._conversation.receive_steps():
                    yield "synthetic chunk"
                raise error
            return stream()

    class Agent(_GoogleAgent):
        async def chat(self, prompt):
            self.response = Response()
            self.conversation = self.response._conversation
            return self.response

        async def __aexit__(self, *exc):
            self.response.closed = True

    backend = GoogleSdkBackend(agent_factory=Agent, config_factory=lambda **kwargs: SimpleNamespace(**kwargs),
                               types_module=_GoogleTypes)
    with pytest.raises(asyncio.CancelledError if cancel else OSError) as raised:
        await backend._call([{"role": "user", "content": "synthetic"}], response_schema=None,
                            temperature=None, max_tokens=None, thinking_budget=None)
    assert raised.value is error
    assert len(spend) == 1
    assert (spend[0]["input_tokens"], spend[0]["output_tokens"], spend[0]["lane"]) == (6, 2, "tailoring")


@pytest.mark.asyncio
async def test_google_usage_snapshot_does_not_read_a_reused_agents_next_turn():
    from jobctrl.infrastructure.llm.agent_runtime_antigravity import (
        AntigravityGeneration, _Call, _Response, _bind_step_source, _record_available_usage,
    )

    counts = []
    state = _Call(None, None, False, AntigravityGeneration(), lambda *values: counts.append(values))
    response = _GoogleResponse()
    state.native_response = response
    _bind_step_source(state, response, SimpleNamespace(conversation=response._conversation))
    async for _ in _Response(response, state).chunks:
        pass
    response.usage_metadata = SimpleNamespace(prompt_token_count=99, candidates_token_count=33)
    _record_available_usage(state)
    assert counts == [(6, 2)]


@pytest.mark.asyncio
async def test_google_usage_discovered_during_cancel_cleanup_is_retained(monkeypatch):
    cancellation = asyncio.CancelledError("synthetic-cancel")
    spend = []
    monkeypatch.setattr(legacy_llm, "record_llm_spend", lambda **values: spend.append(values))
    monkeypatch.setattr(setup_probes, "antigravity_auth_kwargs", lambda env=None: {"api_key": "synthetic"})

    class Response(_GoogleResponse):
        usage_metadata = None

        @property
        def chunks(self):
            async def stream():
                async for _ in self._conversation.receive_steps(None):
                    yield "synthetic chunk"
                raise cancellation
            return stream()

    class Agent(_GoogleAgent):
        async def chat(self, prompt):
            self.response = Response()
            self.conversation = self.response._conversation
            return self.response

        async def __aexit__(self, *exc):
            self.response.usage_metadata = SimpleNamespace(prompt_token_count=6, candidates_token_count=2)
            async for _ in self.conversation.receive_steps():
                pass

    backend = GoogleSdkBackend(agent_factory=Agent, config_factory=lambda **kwargs: SimpleNamespace(**kwargs),
                               types_module=_GoogleTypes)
    with pytest.raises(asyncio.CancelledError) as raised:
        await backend._call([{"role": "user", "content": "synthetic"}], response_schema=None,
                            temperature=None, max_tokens=None, thinking_budget=None)
    assert raised.value is cancellation
    assert [(row["input_tokens"], row["output_tokens"], row["lane"]) for row in spend] == [(6, 2, "tailoring")]


@pytest.mark.asyncio
@pytest.mark.parametrize("termination", ["success", "failure", "cancel"])
@pytest.mark.parametrize("latest", [(20, None), (None, None)])
async def test_google_partial_latest_snapshot_preserves_prior_counts_without_fabricating_total(
    monkeypatch, tmp_path, termination, latest,
):
    import jobctrl.database as database
    from jobctrl.infrastructure.llm.spend_observation import SpendAccountingUnresolved

    db_path = tmp_path / "jobctrl.db"
    monkeypatch.setattr(database, "DB_PATH", db_path)
    database.init_db(db_path)
    monkeypatch.setattr(legacy_llm, "enforce_spend_budget", lambda _lane=None: legacy_llm.read_llm_spend())
    monkeypatch.setattr(legacy_llm, "record_llm_spend", _REAL_RECORD_LLM_SPEND)
    monkeypatch.setattr(setup_probes, "antigravity_auth_kwargs", lambda env=None: {"api_key": "synthetic"})
    error = asyncio.CancelledError("synthetic-cancel") if termination == "cancel" else OSError("synthetic-stream")

    class Response(_GoogleResponse):
        @property
        def chunks(self):
            async def stream():
                self.usage_metadata = SimpleNamespace(prompt_token_count=11, candidates_token_count=7)
                async for _ in self._conversation.receive_steps():
                    yield "first"
                self.usage_metadata = SimpleNamespace(prompt_token_count=latest[0], candidates_token_count=latest[1])
                step = SimpleNamespace(prompt_token_count=9 if latest[0] is not None else None,
                                       candidates_token_count=None)
                async for _ in self._conversation.receive_steps(step):
                    yield "second"
                if termination != "success":
                    raise error
                self.consumed = True
            return stream()

    class Agent(_GoogleAgent):
        async def chat(self, prompt):
            self.response = Response()
            self.conversation = self.response._conversation
            return self.response

    backend = GoogleSdkBackend(agent_factory=Agent, config_factory=lambda **kwargs: SimpleNamespace(**kwargs),
                               types_module=_GoogleTypes)
    exception_type = SpendAccountingUnresolved if termination == "success" else type(error)
    with pytest.raises(exception_type) as raised:
        await backend._call([{"role": "user", "content": "synthetic"}], response_schema=None,
                            temperature=None, max_tokens=None, thinking_budget=None)
    if termination != "success":
        assert raised.value is error
    with sqlite3.connect(db_path) as raw:
        assert raw.execute("SELECT COUNT(*) FROM llm_spend").fetchone() == (0,)
    receipts = list((tmp_path / ".jobctrl.db.llm-spend-pending").glob("*.jsonl"))
    assert len(receipts) == 1
    header, observed = [json.loads(line) for line in receipts[0].read_text().splitlines()]
    assert header["provider"] == "google" and header["lane"] == "tailoring"
    assert {(row["input_tokens"], row["output_tokens"]) for row in observed["ambiguous_reports"]} >= {
        (11, 7), latest,
    }
    with pytest.raises(SpendAccountingUnresolved):
        legacy_llm.read_llm_spend()
    database.close_connection(db_path)


@pytest.mark.asyncio
@pytest.mark.parametrize("final_output", [0, 9])
async def test_google_complete_terminal_usage_after_step_without_usage(monkeypatch, tmp_path, final_output):
    import jobctrl.database as database

    db_path = tmp_path / "jobctrl.db"
    monkeypatch.setattr(database, "DB_PATH", db_path)
    database.init_db(db_path)
    monkeypatch.setattr(legacy_llm, "enforce_spend_budget", lambda _lane=None: legacy_llm.read_llm_spend())
    monkeypatch.setattr(legacy_llm, "record_llm_spend", _REAL_RECORD_LLM_SPEND)
    monkeypatch.setattr(setup_probes, "antigravity_auth_kwargs", lambda env=None: {"api_key": "synthetic"})

    class Response(_GoogleResponse):
        @property
        def chunks(self):
            async def stream():
                self.usage_metadata = None
                async for _ in self._conversation.receive_steps(None):
                    yield "first"
                self.usage_metadata = SimpleNamespace(prompt_token_count=21, candidates_token_count=final_output)
                async for _ in self._conversation.receive_steps():
                    yield "second"
                self.consumed = True
            return stream()

    class Agent(_GoogleAgent):
        async def chat(self, prompt):
            self.response = Response()
            self.conversation = self.response._conversation
            return self.response

    backend = GoogleSdkBackend(agent_factory=Agent, config_factory=lambda **kwargs: SimpleNamespace(**kwargs),
                               types_module=_GoogleTypes)
    assert await backend._call([{"role": "user", "content": "synthetic"}], response_schema=None,
                               temperature=None, max_tokens=None, thinking_budget=None) == "plain google"
    totals = legacy_llm.read_llm_spend_by_lane()["tailoring"]
    assert (totals["input_tokens"], totals["output_tokens"]) == (21, final_output)
    assert not list((tmp_path / ".jobctrl.db.llm-spend-pending").glob("*.jsonl"))
    database.close_connection(db_path)


class _GoogleTypes:
    class BuiltinTools:
        FINISH = "finish"

        @classmethod
        def read_only(cls):
            return [cls.FINISH]

    Text = type("Text", (), {})
    Thought = type("Thought", (), {})
    ToolCall = type("ToolCall", (), {})
    ToolResult = type("ToolResult", (), {})

    class CapabilitiesConfig:
        def __init__(self, **kwargs: Any) -> None:
            self.kwargs = kwargs

    class ThinkingLevel:
        MINIMAL = "minimal"
        LOW = "low"
        MEDIUM = "medium"
        HIGH = "high"

    class GenerationConfig:
        def __init__(self, **kwargs: Any) -> None:
            self.__dict__.update(kwargs)

    class ModelEntry:
        def __init__(self, **kwargs: Any) -> None:
            self.__dict__.update(kwargs)

    class ModelConfig:
        def __init__(self, **kwargs: Any) -> None:
            self.__dict__.update(kwargs)

    class GeminiConfig:
        def __init__(self, **kwargs: Any) -> None:
            self.__dict__.update(kwargs)


@pytest.fixture(autouse=True)
def _isolate_sdk_options(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(setup_probes, "bundled_claude_sdk_options", lambda env=None: {})


@pytest.mark.parametrize("backend_name", ["claude", "codex"])
def test_sdk_backends_support_plain_and_schema_calls(
    backend_name: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    spend: list[dict[str, Any]] = []
    monkeypatch.setattr(legacy_llm, "record_llm_spend", lambda **kwargs: spend.append(kwargs))
    if backend_name == "claude":
        backend = ClaudeSdkBackend(query_fn=_claude_query, options_factory=_Options)
        expected = "plain claude"
    else:
        backend = CodexSdkBackend(
            async_codex_factory=lambda: _Codex(),
            approval_mode_factory=lambda: "deny",
        )
        expected = "plain codex"
    messages = [{"role": "user", "content": "question"}]

    assert backend.chat(messages) == expected
    assert backend.chat_json(
        messages,
        response_schema={"type": "object", "properties": {"answer": {"type": "integer"}}},
    ) == {"answer": 42}
    assert len(spend) == 2
    assert all(item["input_tokens"] and item["output_tokens"] for item in spend)


@pytest.mark.parametrize(
    "auth_kwargs",
    [
        {"api_key": "google-key"},
        {"vertex": True, "project": "project", "location": "europe-west4"},
    ],
)
def test_google_sdk_backend_supports_api_key_and_vertex_adc(
    auth_kwargs: dict[str, object],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(setup_probes, "antigravity_auth_kwargs", lambda env=None: auth_kwargs)
    configs: list[SimpleNamespace] = []

    def config_factory(**kwargs: Any) -> SimpleNamespace:
        config = SimpleNamespace(**kwargs)
        configs.append(config)
        return config

    backend = GoogleSdkBackend(
        agent_factory=_GoogleAgent,
        config_factory=config_factory,
        types_module=_GoogleTypes,
    )
    messages = [{"role": "user", "content": "question"}]

    assert backend.chat(messages) == "plain google"
    assert backend.chat_json(
        messages,
        response_schema={"type": "object", "properties": {"answer": {"type": "integer"}}},
    ) == {"answer": 42}
    for key, value in auth_kwargs.items():
        assert getattr(configs[0], key) == value


def test_claude_sdk_maps_thinking_and_normalizes_unsupported_controls() -> None:
    options: list[_Options] = []

    def options_factory(**kwargs: Any) -> _Options:
        value = _Options(**kwargs)
        options.append(value)
        return value

    backend = ClaudeSdkBackend(query_fn=_claude_query, options_factory=options_factory)

    with pytest.warns(
        SdkControlNormalizationWarning,
        match="does not support temperature, max_tokens",
    ):
        assert backend.chat(
            [{"role": "user", "content": "question"}],
            temperature=0.2,
            max_tokens=512,
            thinking_budget=256,
        ) == "plain claude"

    assert options[0].kwargs["thinking"] == {"type": "enabled", "budget_tokens": 256}
    assert "temperature" not in options[0].kwargs
    assert "max_tokens" not in options[0].kwargs


def test_codex_sdk_maps_thinking_to_effort_and_normalizes_unsupported_controls() -> None:
    calls: dict[str, Any] = {}
    backend = CodexSdkBackend(
        async_codex_factory=lambda: _Codex(calls),
        approval_mode_factory=lambda: "deny",
    )

    with pytest.warns(
        SdkControlNormalizationWarning,
        match="does not support temperature, max_tokens",
    ):
        assert backend.chat(
            [{"role": "user", "content": "question"}],
            temperature=0.0,
            max_tokens=1024,
            thinking_budget=2048,
        ) == "plain codex"

    assert calls["thread_start"]["ephemeral"] is True
    assert calls["thread_start"]["config"] == {"model_reasoning_effort": "medium"}
    assert calls["run"]["effort"] == "medium"
    assert "temperature" not in calls["run"]
    assert "max_tokens" not in calls["run"]


@pytest.mark.parametrize("effort", ["low", "medium", "high", "xhigh", "max", "ultra"])
@pytest.mark.parametrize("budget", [None, 0])
def test_saved_codex_effort_overrides_legacy_budget_at_both_sdk_boundaries(monkeypatch, effort, budget):
    monkeypatch.setattr("jobctrl.infrastructure.scoring.criteria_provider.read_config_settings", lambda _path=None: {"codex_reasoning_efforts": {"gpt-6.1-sol": effort}})
    calls = {}
    backend = CodexSdkBackend(model="gpt-6.1-sol", async_codex_factory=lambda: _Codex(calls), approval_mode_factory=lambda: "deny")
    assert backend.chat_json([{"role": "user", "content": "synthetic"}], response_schema={"type": "object"}, thinking_budget=budget) == {"answer": 42}
    assert calls["thread_start"]["config"] == {"model_reasoning_effort": effort}
    assert calls["run"]["effort"] == effort


def test_constructed_backend_retains_its_effort_after_preference_edit(monkeypatch):
    settings = {"codex_reasoning_efforts": {"gpt-6.1-sol": "high"}}
    monkeypatch.setattr("jobctrl.infrastructure.scoring.criteria_provider.read_config_settings", lambda _path=None: settings)
    before = CodexSdkBackend(model="gpt-6.1-sol")
    settings["codex_reasoning_efforts"]["gpt-6.1-sol"] = "max"
    after = CodexSdkBackend(model="gpt-6.1-sol")
    assert before.reasoning_effort == "high"
    assert after.reasoning_effort == "max"


def test_codex_sdk_retains_safe_builder_error_fields_and_usage_from_failed_turn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    spend: list[dict[str, Any]] = []
    monkeypatch.setattr(legacy_llm, "record_llm_spend", lambda **kwargs: spend.append(kwargs))
    backend = CodexSdkBackend(
        model="codex-test-model",
        async_codex_factory=lambda: _FailedCodex(),
        approval_mode_factory=lambda: "deny",
    )

    with pytest.raises(ProviderCallError) as raised:
        backend.chat_json(
            [{"role": "user", "content": "synthetic request"}],
            response_schema={"type": "object", "properties": {"answer": {"type": "integer"}}},
        )

    envelope = raised.value.envelope.to_dict()
    assert envelope.items() >= {
        "provider": "openai",
        "model": "codex-test-model",
        "operation": "chat_json",
        "category": "provider_turn",
        "error_type": "codex_turn_error",
        "code": "builder_error",
        "retryable": True,
        "message_code": "builder_error",
        "additional_detail_code": "schema_validation_failed",
        "additional_details_present": True,
        "codex_error_code": "server_overloaded",
    }.items()
    assert "schema validation failed" not in repr(envelope)
    assert spend == [
        {
            "input_tokens": 11,
            "output_tokens": 7,
            "model": "codex-test-model",
            "day": legacy_llm._utc_spend_day(),
            "lane": "tailoring",
        }
    ]


def test_codex_sdk_records_usage_before_iterator_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    spend: list[dict[str, Any]] = []
    monkeypatch.setattr(legacy_llm, "record_llm_spend", lambda **kwargs: spend.append(kwargs))
    backend = CodexSdkBackend(
        model="codex-test-model",
        async_codex_factory=lambda: _UsageThenIteratorFailureCodex(),
        approval_mode_factory=lambda: "deny",
    )

    with pytest.raises(ProviderCallError) as raised:
        backend.chat([{"role": "user", "content": "synthetic request"}])

    assert raised.value.envelope.category == "provider_exception"
    assert spend == [
        {
            "input_tokens": 13,
            "output_tokens": 5,
            "model": "codex-test-model",
            "day": legacy_llm._utc_spend_day(),
            "lane": "tailoring",
        }
    ]


def test_google_sdk_maps_thinking_level_and_normalizes_unsupported_controls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        setup_probes,
        "antigravity_auth_kwargs",
        lambda env=None: {"api_key": "google-key"},
    )
    configs: list[SimpleNamespace] = []

    def config_factory(**kwargs: Any) -> SimpleNamespace:
        value = SimpleNamespace(**kwargs)
        configs.append(value)
        return value

    backend = GoogleSdkBackend(
        agent_factory=_GoogleAgent,
        config_factory=config_factory,
        types_module=_GoogleTypes,
    )

    with pytest.warns(
        SdkControlNormalizationWarning,
        match="does not support temperature, max_tokens",
    ):
        assert backend.chat(
            [{"role": "user", "content": "question"}],
            temperature=0.4,
            max_tokens=2048,
            thinking_budget=4096,
        ) == "plain google"

    default_model = configs[0].gemini_config.models.default
    assert default_model.name == backend.model
    assert default_model.generation.thinking_level == "medium"
    assert not hasattr(configs[0], "temperature")
    assert not hasattr(configs[0], "max_tokens")


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"temperature": -0.1}, "temperature"),
        ({"max_tokens": 0}, "max_tokens"),
        ({"thinking_budget": -1}, "thinking_budget"),
    ],
)
def test_sdk_control_validation_rejects_unsafe_values(
    kwargs: dict[str, int | float],
    message: str,
) -> None:
    backend = ClaudeSdkBackend(query_fn=_claude_query, options_factory=_Options)
    with pytest.raises(ValueError, match=message):
        backend.chat([{"role": "user", "content": "question"}], **kwargs)


@pytest.mark.asyncio
async def test_sync_sdk_backend_is_safe_inside_running_event_loop() -> None:
    backend = CodexSdkBackend(
        async_codex_factory=lambda: _Codex(),
        approval_mode_factory=lambda: "deny",
    )
    assert backend.chat([{"role": "user", "content": "question"}]) == "plain codex"


def test_google_http_backend_accepts_google_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GOOGLE_API_KEY", "google-key")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    base_url, _model, key = legacy_llm._provider_config("google")
    assert base_url == "https://generativelanguage.googleapis.com/v1beta/openai"
    assert key == "google-key"


def test_raw_openai_key_is_not_an_automatic_http_route(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "raw-only")
    with pytest.raises(RuntimeError, match="No LLM provider configured"):
        legacy_llm._detect_provider()


def test_llm_messages_remain_model_neutral() -> None:
    assert LlmMessage(role="user", content="hello").content == "hello"
