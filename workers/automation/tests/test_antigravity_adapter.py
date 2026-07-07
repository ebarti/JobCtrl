"""Unit tests for the Antigravity (Gemini) analysis adapter.

Mocked SDK boundary — NO live Gemini key / network call (D-04). A fake
``Agent`` context-manager yields a fake ``response`` with an async ``chunks``
iterator and a ``structured_output()`` coroutine returning a valid JobAnalysis
dict. Asserts: ``draft()`` returns a tagged ``JobAnalysisDraft``; a missing API
key raises a clear error; the ``response_schema`` handed to the config is
Gemini-serialised (no ``additionalProperties``).

``asyncio_mode = strict`` (pyproject) -> every coroutine test is marked.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest

from jobctl.domain.materials.analysis import JobAnalysisDraft
from jobctl.infrastructure.analysis.antigravity_analysis_adapter import (
    ANTIGRAVITY_ANALYSIS_MODEL,
    AntigravityAnalysisAdapter,
)

pytestmark = pytest.mark.asyncio


def _valid_analysis_dict() -> dict[str, Any]:
    """A schema-valid JobAnalysis payload whose spans are JD substrings."""
    return {
        "role_framing": "Build and own the payments backend.",
        "inferred_seniority": "senior",
        "ideal_candidate_narrative": "A seasoned backend engineer who ships payments.",
        "requirements": [
            {
                "id": "r1",
                "text": "6+ years of Python",
                "tier": "must_have",
                "weight": 0.9,
                "evidence_span": "6+ years of Python",
            }
        ],
        "keywords": [
            {
                "keyword": "Python",
                "evidence_span": "6+ years of Python",
                "requirement_ref": "r1",
                "rationale": "core language",
                "is_orphan": False,
            }
        ],
    }


class _FakeResponse:
    """Mimics the SDK response: an async ``chunks`` iterator + structured_output()."""

    def __init__(
        self, structured: Any, *, chunks: list[Any] | None = None, usage_metadata: Any = None
    ) -> None:
        self._structured = structured
        self._chunks = chunks if chunks is not None else ["chunk-a", "chunk-b"]
        self.drained = False
        self.usage_metadata = usage_metadata

    @property
    async def chunks(self):  # noqa: D401 - async generator property mirroring the SDK
        for chunk in self._chunks:
            yield chunk
        self.drained = True

    async def structured_output(self) -> Any:
        return self._structured


class _FakeAgent:
    """Async context-manager agent whose ``chat`` returns a canned response."""

    def __init__(self, config: Any, *, response: _FakeResponse, calls: dict[str, Any]) -> None:
        self._config = config
        self._response = response
        self._calls = calls

    async def __aenter__(self) -> _FakeAgent:
        self._calls["entered"] = True
        return self

    async def __aexit__(self, *exc: Any) -> bool:
        self._calls["exited"] = True
        return False

    async def chat(self, prompt: str) -> _FakeResponse:
        self._calls["chat_prompt"] = prompt
        return self._response


class _FakeBuiltinTools:
    FINISH = "FINISH"


class _FakeCapabilitiesConfig:
    def __init__(self, *, enabled_tools: list[Any]) -> None:
        self.enabled_tools = enabled_tools


class _FakeTypes:
    BuiltinTools = _FakeBuiltinTools
    CapabilitiesConfig = _FakeCapabilitiesConfig
    DEFAULT_MODEL = "gemini-3.5-flash"


def _make_adapter(
    *,
    structured: Any,
    calls: dict[str, Any],
    chunks: list[Any] | None = None,
    usage_metadata: Any = None,
) -> AntigravityAnalysisAdapter:
    """Build an adapter wired to fakes; ``calls`` captures the config kwargs."""
    response = _FakeResponse(structured, chunks=chunks, usage_metadata=usage_metadata)

    def config_factory(**kwargs: Any) -> dict[str, Any]:
        calls["config_kwargs"] = kwargs
        calls["response"] = response
        return {"config": kwargs}

    def agent_factory(config: Any) -> _FakeAgent:
        calls["config_arg"] = config
        return _FakeAgent(config, response=response, calls=calls)

    return AntigravityAnalysisAdapter(
        agent_factory=agent_factory,
        config_factory=config_factory,
        types_module=_FakeTypes,
    )


async def test_draft_returns_tagged_draft(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    calls: dict[str, Any] = {}
    adapter = _make_adapter(structured=_valid_analysis_dict(), calls=calls)

    draft = await adapter.draft("SYS", "6+ years of Python required.")

    assert isinstance(draft, JobAnalysisDraft)
    assert draft.model_id == ANTIGRAVITY_ANALYSIS_MODEL == "gemini-3.5-flash"
    assert draft.requirements[0].text == "6+ years of Python"
    assert draft.keywords[0].keyword == "Python"
    # The agent was entered, chat called with the JD, the context exited.
    assert calls["entered"] is True
    assert calls["chat_prompt"] == "6+ years of Python required."
    assert calls["exited"] is True
    # The chunk stream was drained before structured_output() resolved.
    assert calls["response"].drained is True


async def test_response_schema_is_gemini_serialised(monkeypatch: pytest.MonkeyPatch) -> None:
    """The schema passed to the config has NO additionalProperties (Gemini rule)."""
    monkeypatch.setenv("GOOGLE_API_KEY", "test-key")  # also proves GOOGLE_API_KEY fallback
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    calls: dict[str, Any] = {}
    adapter = _make_adapter(structured=_valid_analysis_dict(), calls=calls)

    await adapter.draft("SYS", "6+ years of Python required.")

    kwargs = calls["config_kwargs"]
    raw_schema = kwargs["response_schema"]
    assert isinstance(raw_schema, str), "response_schema must be a JSON string"
    parsed = json.loads(raw_schema)

    def _walk(node: Any):
        if isinstance(node, dict):
            yield node
            for value in node.values():
                yield from _walk(value)
        elif isinstance(node, list):
            for item in node:
                yield from _walk(item)

    for sub in _walk(parsed):
        assert "additionalProperties" not in sub, sub
        assert "$schema" not in sub, sub

    # The config also carried the model + the FINISH-only capability + key.
    assert kwargs["model"] == "gemini-3.5-flash"
    assert kwargs["api_key"] == "test-key"
    assert kwargs["capabilities"].enabled_tools == ["FINISH"]
    assert kwargs["policies"] == []
    assert kwargs["workspaces"] == []
    assert kwargs["system_instructions"] == "SYS"


async def test_missing_api_key_raises_clear_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_GENAI_USE_VERTEXAI", raising=False)
    calls: dict[str, Any] = {}
    adapter = _make_adapter(structured=_valid_analysis_dict(), calls=calls)

    with pytest.raises(RuntimeError, match="Antigravity analysis auth requires"):
        await adapter.draft("SYS", "6+ years of Python required.")


async def test_vertex_adc_config_is_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.setenv("GOOGLE_GENAI_USE_VERTEXAI", "1")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "project-a")
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "europe-west4")
    calls: dict[str, Any] = {}
    adapter = _make_adapter(structured=_valid_analysis_dict(), calls=calls)

    await adapter.draft("SYS", "6+ years of Python required.")

    kwargs = calls["config_kwargs"]
    assert "api_key" not in kwargs
    assert kwargs["vertex"] is True
    assert kwargs["project"] == "project-a"
    assert kwargs["location"] == "europe-west4"


async def test_none_structured_output_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    calls: dict[str, Any] = {}
    adapter = _make_adapter(structured=None, calls=calls)

    with pytest.raises(RuntimeError, match="no structured output"):
        await adapter.draft("SYS", "6+ years of Python required.")


async def test_json_string_structured_output_is_parsed(monkeypatch: pytest.MonkeyPatch) -> None:
    """A JSON-string structured payload is tolerated and parsed into the draft."""
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    calls: dict[str, Any] = {}
    adapter = _make_adapter(structured=json.dumps(_valid_analysis_dict()), calls=calls)

    draft = await adapter.draft("SYS", "6+ years of Python required.")
    assert isinstance(draft, JobAnalysisDraft)
    assert draft.requirements[0].text == "6+ years of Python"


async def test_model_id_property() -> None:
    adapter = AntigravityAnalysisAdapter()
    assert adapter.model_id == "gemini-3.5-flash"

    custom = AntigravityAnalysisAdapter(model="gemini-x")
    assert custom.model_id == "gemini-x"


async def test_draft_opens_generation_span_with_model_and_tokens(
    monkeypatch: pytest.MonkeyPatch, in_memory_exporter
) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    usage = SimpleNamespace(
        prompt_token_count=900,
        candidates_token_count=150,
        thoughts_token_count=40,
        cached_content_token_count=0,
        total_token_count=1090,
    )
    calls: dict[str, Any] = {}
    adapter = _make_adapter(
        structured=_valid_analysis_dict(), calls=calls, usage_metadata=usage
    )

    await adapter.draft("SYS", "6+ years of Python required.")

    spans = in_memory_exporter.get_finished_spans()
    assert len(spans) == 1
    span = spans[0]
    assert span.name == "llm.gemini-3.5-flash"
    assert span.instrumentation_scope.name == "jobctl.analysis.antigravity"
    attrs = dict(span.attributes or {})
    assert attrs["langfuse.observation.type"] == "generation"
    assert attrs["langfuse.observation.model.name"] == "gemini-3.5-flash"
    assert attrs["gen_ai.usage.input_tokens"] == 900
    # output = visible candidates (150) + reasoning thoughts (40).
    assert attrs["gen_ai.usage.output_tokens"] == 190


async def test_draft_span_omits_tokens_when_sdk_reports_no_usage(
    monkeypatch: pytest.MonkeyPatch, in_memory_exporter
) -> None:
    # Instrumentation must never break a leg: no usage metadata -> the draft still
    # succeeds and the span omits token counts rather than fabricating them.
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    calls: dict[str, Any] = {}
    adapter = _make_adapter(structured=_valid_analysis_dict(), calls=calls)

    draft = await adapter.draft("SYS", "6+ years of Python required.")
    assert isinstance(draft, JobAnalysisDraft)

    attrs = dict(in_memory_exporter.get_finished_spans()[0].attributes or {})
    assert attrs["langfuse.observation.model.name"] == "gemini-3.5-flash"
    assert "gen_ai.usage.input_tokens" not in attrs
