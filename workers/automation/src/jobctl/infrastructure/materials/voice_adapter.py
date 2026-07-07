"""Claude Agent SDK adapter for the voice pass (Phase 3).

Mirrors ``infrastructure/analysis/claude_analysis_adapter.py`` (which itself
mirrors the mestre vendor-lane pattern): a thin wrapper over
``claude_agent_sdk.query`` that forces native structured output via
``output_format={"type":"json_schema", ...}`` and reads the parsed object off the
final ``ResultMessage.structured_output``.

The all-new-AI-via-SDK directive: the voice pass is a NEW AI transform, so it goes
through the Claude Agent SDK — NOT the legacy httpx ``LlmClient`` the tailor/judge
calls use. The SDK ``query`` function and ``ClaudeAgentOptions`` class are resolved
through injectable factories that default to a lazy import, so tests pass a fake
async-iterator ``query`` + a stub options class and exercise the boundary with no
network/auth (D-04 mocking, same as the analysis adapters).

No timeout / no turn cap (D-18/D-19): ``max_turns=None``, no ``max_budget_usd``;
nothing kills a healthy run. The only stop is cooperative cancellation of the
wrapping asyncio task — matching the constraint "NO timeouts on the voice LLM call".
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from typing import Any

from jobctl.domain.materials.voice import VoicePayload, VoiceRequest, VoiceResult
from jobctl.infrastructure.materials.voice_prompts import build_voice_user_prompt
from jobctl.infrastructure.observability.llm_spans import llm_generation_span

# A query callable: (prompt, options) -> async iterator of SDK messages.
QueryFn = Callable[..., AsyncIterator[Any] | Awaitable[AsyncIterator[Any]]]
OptionsFactory = Callable[..., Any]

# Top Claude model + default high effort (mirrors the analysis adapter default).
# Re-confirm the id at impl time; model ids drift.
CLAUDE_VOICE_MODEL = "claude-opus-4-8"

# OTel instrumentation scope for the voice pass's generation span.
_VOICE_SCOPE = "jobctl.materials.voice"


def _load_sdk_query() -> QueryFn:
    """Lazy-import ``claude_agent_sdk.query`` so the package imports without it."""
    from claude_agent_sdk import query  # type: ignore[import-untyped]

    return query


def _load_options_factory() -> OptionsFactory:
    from claude_agent_sdk import ClaudeAgentOptions  # type: ignore[import-untyped]

    return ClaudeAgentOptions


async def _aiter(result: AsyncIterator[Any] | Awaitable[AsyncIterator[Any]]) -> AsyncIterator[Any]:
    """Normalise sync/awaitable query return shapes into an async iterator."""
    if hasattr(result, "__aiter__"):
        return result  # type: ignore[return-value]
    awaited = await result  # type: ignore[misc]
    return awaited


def _structured_output_from_messages(messages: list[Any]) -> dict[str, Any]:
    """Extract the parsed structured object from the final ResultMessage.

    Raises if the SDK surfaced a structured-output retry-exhaustion error or
    returned no structured payload (mirrors the analysis adapter's extractor so the
    failure modes are identical and the use case can fall back uniformly).
    """
    structured: Any | None = None
    for message in messages:
        if type(message).__name__ != "ResultMessage":
            continue
        subtype = str(getattr(message, "subtype", "") or "")
        if subtype == "error_max_structured_output_retries":
            raise RuntimeError("Claude structured-output retries exhausted")
        candidate = getattr(message, "structured_output", None)
        if candidate is not None:
            structured = candidate
    if structured is None:
        raise RuntimeError("Claude Agent SDK returned no structured output for output_format")
    if not isinstance(structured, dict):
        structured = json.loads(structured)
    if not isinstance(structured, dict):
        raise RuntimeError("Claude Agent SDK structured output was not a JSON object")
    return structured


def _optional_int(value: Any) -> int | None:
    """Coerce an SDK usage field to ``int``, or ``None`` when absent/unparseable."""
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _usage_from_messages(messages: list[Any]) -> tuple[int | None, int | None]:
    """Best-effort ``(input_tokens, output_tokens)`` from the final ResultMessage.

    The Claude Agent SDK reports authoritative cumulative usage on the terminal
    ``ResultMessage``; the true input is fresh + cache-creation + cache-read
    tokens. Every field is coerced defensively so a drifted/non-int usage shape
    yields omitted counts rather than raising inside the span (telemetry must
    never fail the leg). Returns ``(None, None)`` when the SDK surfaced no usage.
    """
    for message in reversed(messages):
        if type(message).__name__ != "ResultMessage":
            continue
        usage = getattr(message, "usage", None)
        if not isinstance(usage, Mapping):
            return None, None
        input_tokens = (
            (_optional_int(usage.get("input_tokens")) or 0)
            + (_optional_int(usage.get("cache_creation_input_tokens")) or 0)
            + (_optional_int(usage.get("cache_read_input_tokens")) or 0)
        )
        output_tokens = _optional_int(usage.get("output_tokens")) or 0
        return (input_tokens or None, output_tokens or None)
    return None, None


class ClaudeVoiceAdapter:
    """Claude Agent SDK voice pass (``VoicePort``)."""

    def __init__(
        self,
        *,
        model: str = CLAUDE_VOICE_MODEL,
        query_fn: QueryFn | None = None,
        options_factory: OptionsFactory | None = None,
    ) -> None:
        self._model = model
        self._query_fn = query_fn
        self._options_factory = options_factory

    @property
    def model_id(self) -> str:
        return self._model

    async def rewrite(self, system_prompt: str, request: VoiceRequest) -> VoiceResult:
        query_fn = self._query_fn or _load_sdk_query()
        options_factory = self._options_factory or _load_options_factory()
        options = options_factory(
            model=self._model,
            system_prompt=system_prompt,
            # D-19: unbounded; nothing kills a healthy run. D-18: no budget ceiling.
            max_turns=None,
            # No agent file/shell tools — constrained rewrite, structured output only.
            allowed_tools=[],
            output_format={
                "type": "json_schema",
                "schema": VoicePayload.model_json_schema(),
            },
        )
        user_prompt = build_voice_user_prompt(request)
        span_input = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]
        with llm_generation_span(
            model=self._model,
            messages=span_input,
            params={},
            scope_name=_VOICE_SCOPE,
        ) as record:
            raw = query_fn(prompt=user_prompt, options=options)
            iterator = await _aiter(raw)
            messages = [message async for message in iterator]
            structured = _structured_output_from_messages(messages)
            input_tokens, output_tokens = _usage_from_messages(messages)
            record(
                json.dumps(structured, ensure_ascii=False),
                input_tokens=input_tokens,
                output_tokens=output_tokens,
            )
            payload = VoicePayload.model_validate(structured)
            return VoiceResult.from_payload(payload)


__all__ = [
    "CLAUDE_VOICE_MODEL",
    "ClaudeVoiceAdapter",
]
