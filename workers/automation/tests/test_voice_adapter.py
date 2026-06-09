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

from jobhunter.domain.materials.voice import VoiceRequest
from jobhunter.infrastructure.materials.voice_adapter import ClaudeVoiceAdapter


class ResultMessage:
    """Minimal ResultMessage double (same shape + name the analysis tests use).

    The adapter dispatches on ``type(message).__name__ == "ResultMessage"``, so the
    double MUST be named ``ResultMessage`` (a leading underscore would hide it).
    """

    def __init__(self, structured_output: Any, subtype: str = "success") -> None:
        self.structured_output = structured_output
        self.subtype = subtype


class _FakeClaudeOptions:
    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs


def _fake_query(structured: Any, *, captured: list[dict[str, Any]] | None = None):
    def _query(*, prompt: str, options: Any):
        if captured is not None:
            captured.append({"prompt": prompt, "options": options})

        async def _gen():
            yield ResultMessage(structured)

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
