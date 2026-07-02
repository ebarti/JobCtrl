"""Claude Agent SDK voice adapter (Phase 3) — mocked SDK boundary.

Mirrors the analysis-adapter tests: a fake async-iterator ``query`` and a stub
options class exercise the SDK boundary with NO live auth/network (the all-new-AI-
via-SDK directive — voice is a Claude adapter, mocked in tests). These pin:

  * the adapter parses ``ResultMessage.structured_output`` into a typed
    :class:`VoiceResult` mapping bullets back by experience id;
  * it passes the voice schema + an empty tool set + no turn cap to the options
    (no timeout, no budget — VOICE LLM runs to completion);
  * a structured-output retry-exhaustion surfaces as an error so the use case can
    fall back to the pre-voice candidate.
"""

from __future__ import annotations

from typing import Any

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import set_tracer_provider

from jobhunter.domain.materials.voice import VoiceRequest
from jobhunter.infrastructure.materials.voice_adapter import ClaudeVoiceAdapter


@pytest.fixture
def in_memory_exporter(monkeypatch):
    """TracerProvider piped to an in-memory exporter for generation-span assertions."""
    from opentelemetry import trace as trace_api
    from opentelemetry.util._once import Once

    monkeypatch.setattr(trace_api, "_TRACER_PROVIDER_SET_ONCE", Once())
    monkeypatch.setattr(trace_api, "_TRACER_PROVIDER", None)

    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    set_tracer_provider(provider)
    yield exporter
    exporter.clear()


class ResultMessage:
    """Minimal ResultMessage double (same shape + name the analysis tests use).

    The adapter dispatches on ``type(message).__name__ == "ResultMessage"``, so the
    double MUST be named ``ResultMessage`` (a leading underscore would hide it).
    """

    def __init__(
        self,
        structured_output: Any,
        subtype: str = "success",
        usage: dict[str, int] | None = None,
    ) -> None:
        self.structured_output = structured_output
        self.subtype = subtype
        self.usage = usage


class _FakeClaudeOptions:
    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs


def _fake_query(
    structured: Any,
    *,
    captured: list[dict[str, Any]] | None = None,
    usage: dict[str, int] | None = None,
):
    def _query(*, prompt: str, options: Any):
        if captured is not None:
            captured.append({"prompt": prompt, "options": options})

        async def _gen():
            yield ResultMessage(structured, usage=usage)

        return _gen()

    return _query


def _request() -> VoiceRequest:
    return VoiceRequest(
        executive_profile="Spearheaded robust scalable solutions.",
        experience_bullets=(("acme", ("Leveraged synergy to drive value.",)),),
        banned_terms=("spearheaded", "robust", "synergy"),
    )


def _voiced_structured() -> dict[str, Any]:
    return {
        "executive_profile": "Rebuilt the deploy pipeline so releases dropped to ten minutes.",
        "experience_updates": [
            {"id": "acme", "bullets": ["Cut API latency 40% by batching writes."]}
        ],
    }


@pytest.mark.asyncio
async def test_parses_structured_output_into_voice_result() -> None:
    adapter = ClaudeVoiceAdapter(
        query_fn=_fake_query(_voiced_structured()),
        options_factory=_FakeClaudeOptions,
    )
    result = await adapter.rewrite("system", _request())
    assert result.executive_profile.startswith("Rebuilt the deploy pipeline")
    assert result.experience_bullets == (("acme", ("Cut API latency 40% by batching writes.",)),)


@pytest.mark.asyncio
async def test_passes_voice_schema_empty_tools_and_no_turn_cap() -> None:
    captured: list[dict[str, Any]] = []
    adapter = ClaudeVoiceAdapter(
        query_fn=_fake_query(_voiced_structured(), captured=captured),
        options_factory=_FakeClaudeOptions,
    )
    await adapter.rewrite("system", _request())
    opts = captured[0]["options"].kwargs
    assert opts["max_turns"] is None  # no turn cap (no timeout)
    assert opts["allowed_tools"] == []  # constrained, structured output only
    assert opts["output_format"]["type"] == "json_schema"
    # The schema is the VoicePayload schema (prose-only: executive_profile + experience).
    props = opts["output_format"]["schema"]["properties"]
    assert "executive_profile" in props and "experience_updates" in props


@pytest.mark.asyncio
async def test_raises_on_structured_output_retry_exhaustion() -> None:
    def _query(*, prompt: str, options: Any):
        async def _gen():
            yield ResultMessage(None, subtype="error_max_structured_output_retries")

        return _gen()

    adapter = ClaudeVoiceAdapter(query_fn=_query, options_factory=_FakeClaudeOptions)
    with pytest.raises(RuntimeError):
        await adapter.rewrite("system", _request())


@pytest.mark.asyncio
async def test_rewrite_opens_generation_span_with_model_and_tokens(in_memory_exporter) -> None:
    adapter = ClaudeVoiceAdapter(
        query_fn=_fake_query(
            _voiced_structured(),
            usage={"input_tokens": 700, "output_tokens": 120},
        ),
        options_factory=_FakeClaudeOptions,
    )
    await adapter.rewrite("system", _request())

    spans = in_memory_exporter.get_finished_spans()
    assert len(spans) == 1
    span = spans[0]
    assert span.name == "llm.claude-opus-4-8"
    assert span.instrumentation_scope.name == "jobhunter.materials.voice"
    attrs = dict(span.attributes or {})
    assert attrs["langfuse.observation.type"] == "generation"
    assert attrs["langfuse.observation.model.name"] == "claude-opus-4-8"
    assert attrs["gen_ai.usage.input_tokens"] == 700
    assert attrs["gen_ai.usage.output_tokens"] == 120


@pytest.mark.asyncio
async def test_rewrite_span_omits_tokens_when_sdk_reports_no_usage(in_memory_exporter) -> None:
    # Instrumentation must never break the voice pass: no SDK usage -> the rewrite
    # still succeeds and the span omits token counts rather than fabricating them.
    adapter = ClaudeVoiceAdapter(
        query_fn=_fake_query(_voiced_structured()),
        options_factory=_FakeClaudeOptions,
    )
    result = await adapter.rewrite("system", _request())
    assert result.executive_profile.startswith("Rebuilt the deploy pipeline")

    attrs = dict(in_memory_exporter.get_finished_spans()[0].attributes or {})
    assert attrs["langfuse.observation.model.name"] == "claude-opus-4-8"
    assert "gen_ai.usage.input_tokens" not in attrs
