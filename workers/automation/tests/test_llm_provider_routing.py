"""No-network provider routing for plain and schema-constrained LlmPort calls."""

from __future__ import annotations

import json
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


class ResultMessage:
    def __init__(self, *, result: str = "", structured_output: dict | None = None) -> None:
        self.result = result
        self.structured_output = structured_output
        self.subtype = "success"
        self.usage = {"input_tokens": 4, "output_tokens": 2}


class _Options:
    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs


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


class _GoogleResponse:
    usage_metadata = SimpleNamespace(
        prompt_token_count=6,
        candidates_token_count=2,
        thoughts_token_count=1,
    )

    def __init__(self) -> None:
        self.consumed = False

    @property
    def chunks(self):
        async def stream():
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
        return _GoogleResponse()


class _GoogleTypes:
    class BuiltinTools:
        FINISH = "finish"

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

    assert calls["thread_start"]["config"] == {"model_reasoning_effort": "medium"}
    assert calls["run"]["effort"] == "medium"
    assert "temperature" not in calls["run"]
    assert "max_tokens" not in calls["run"]


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
