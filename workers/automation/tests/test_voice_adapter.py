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

from jobctrl.domain.materials.voice import VoiceRequest
from jobctrl.infrastructure.materials import voice_adapter
from jobctrl.infrastructure.materials.voice_adapter import ClaudeVoiceAdapter


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


def _isolated_sdk_options() -> dict[str, object]:
    return {
        "cwd": "/tmp/jobctrl-test",
        "env": {
            "CLAUDE_CONFIG_DIR": "/tmp/jobctrl-test/claude_home/config",
            "CLAUDE_CODE_OAUTH_TOKEN": "",
        },
        "extra_args": {"bare": None},
        "setting_sources": [],
    }


@pytest.fixture(autouse=True)
def _stub_authenticated_sdk_options(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(voice_adapter, "bundled_claude_sdk_options", _isolated_sdk_options)


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
        executive_profile_sentences=("Spearheaded robust scalable solutions.",),
        experience_bullets=(("acme", ("Leveraged synergy to drive value.",)),),
        banned_terms=("spearheaded", "robust", "synergy"),
    )


def _voiced_structured() -> dict[str, Any]:
    return {
        "executive_profile": "Rebuilt the deploy pipeline so releases dropped to ten minutes.",
        "executive_profile_sentences": [
            "Rebuilt the deploy pipeline so releases dropped to ten minutes."
        ],
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
    assert result.executive_profile_sentences == (
        "Rebuilt the deploy pipeline so releases dropped to ten minutes.",
    )
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
    assert opts["tools"] == []  # built-in file/shell tools are absent
    assert opts["allowed_tools"] == []  # no tools are auto-approved
    assert opts["output_format"]["type"] == "json_schema"
    assert opts["setting_sources"] == []
    assert opts["extra_args"] == {"bare": None}
    assert opts["env"]["CLAUDE_CODE_OAUTH_TOKEN"] == ""
    # The schema is the VoicePayload schema (summary sentences + experience prose).
    schema = opts["output_format"]["schema"]
    props = schema["properties"]
    assert {
        "executive_profile",
        "executive_profile_sentences",
        "experience_updates",
    }.issubset(props)
    # The sentence array is REQUIRED with at least one item: a voice model that
    # omitted it would otherwise silently disable summary voicing forever.
    assert "executive_profile_sentences" in schema["required"]
    assert props["executive_profile_sentences"]["minItems"] == 1


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
    assert span.instrumentation_scope.name == "jobctrl.materials.voice"
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


@pytest.mark.asyncio
async def test_rewrite_span_survives_malformed_sdk_usage(in_memory_exporter) -> None:
    # A drifted / non-int usage field must NEVER fail the voice pass — token
    # extraction runs inside the re-raising span block, so it degrades the
    # unparseable count to omitted rather than raising.
    adapter = ClaudeVoiceAdapter(
        query_fn=_fake_query(
            _voiced_structured(),
            usage={"input_tokens": "n/a", "output_tokens": 10},
        ),
        options_factory=_FakeClaudeOptions,
    )
    result = await adapter.rewrite("system", _request())  # must not raise
    assert result.executive_profile.startswith("Rebuilt the deploy pipeline")

    attrs = dict(in_memory_exporter.get_finished_spans()[0].attributes or {})
    assert "gen_ai.usage.input_tokens" not in attrs
    assert "langfuse.observation.usage_details" not in attrs
    assert attrs["gen_ai.usage.output_tokens"] == 10
