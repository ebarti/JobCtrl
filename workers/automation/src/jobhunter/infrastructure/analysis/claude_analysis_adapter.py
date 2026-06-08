"""Claude Agent SDK adapter for employer analysis — draft leg + synthesizer.

Mirrors the mestre vendor-lane pattern (``mestre/vendor_lane/backends/
claude_sdk.py``): a thin wrapper over ``claude_agent_sdk.query`` that forces
native structured output via ``output_format={"type":"json_schema", ...}`` and
reads the parsed object off the final ``ResultMessage.structured_output``.

Test-mockability (no live auth in tests — D-04): the SDK ``query`` function and
the ``ClaudeAgentOptions`` class are resolved through injectable factories that
default to a lazy import. Tests pass a fake async-iterator ``query`` and a stub
options class, so the SDK boundary is exercised without any network/CLI call.

No timeout / no turn cap (D-18/D-19): ``max_turns=None`` and no
``max_budget_usd``; nothing kills a healthy run. The only stop is cooperative
cancellation of the wrapping asyncio task.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from jobhunter.domain.materials.analysis import (
    JobAnalysis,
    JobAnalysisDraft,
)
from jobhunter.infrastructure.analysis.prompts import build_synthesizer_user_prompt

# A query callable: (prompt, options) -> async iterator of SDK messages.
QueryFn = Callable[..., AsyncIterator[Any] | Awaitable[AsyncIterator[Any]]]
OptionsFactory = Callable[..., Any]

# Top Claude model + default high effort (D-18). Re-confirm the id at impl time;
# model ids drift. Mirrors the mestre Claude runtime default set.
CLAUDE_ANALYSIS_MODEL = "claude-opus-4-8"


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
    returned no structured payload (an otherwise-successful turn with no object
    is a hard failure for this constrained-extraction use case).
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
        # Some SDK shapes hand back a JSON string; tolerate that.
        structured = json.loads(structured)
    return structured


class _ClaudeStructuredCaller:
    """Shared call path for the draft adapter and the synthesizer."""

    def __init__(
        self,
        *,
        model: str = CLAUDE_ANALYSIS_MODEL,
        query_fn: QueryFn | None = None,
        options_factory: OptionsFactory | None = None,
    ) -> None:
        self._model = model
        self._query_fn = query_fn
        self._options_factory = options_factory

    async def call(self, *, system_prompt: str, user_prompt: str) -> dict[str, Any]:
        query_fn = self._query_fn or _load_sdk_query()
        options_factory = self._options_factory or _load_options_factory()
        options = options_factory(
            model=self._model,
            system_prompt=system_prompt,
            # D-19: unbounded; nothing kills a healthy run. D-18: no budget ceiling.
            max_turns=None,
            # No agent file/shell tools — constrained extraction, structured output only.
            allowed_tools=[],
            # Native structured-output mode (the contract, not a tool call).
            output_format={
                "type": "json_schema",
                "schema": JobAnalysis.model_json_schema(),
            },
        )
        raw = query_fn(prompt=user_prompt, options=options)
        iterator = await _aiter(raw)
        messages = [message async for message in iterator]
        return _structured_output_from_messages(messages)


class ClaudeAnalysisAdapter:
    """Claude Agent SDK draft leg (``AnalysisDraftPort``)."""

    def __init__(
        self,
        *,
        model: str = CLAUDE_ANALYSIS_MODEL,
        query_fn: QueryFn | None = None,
        options_factory: OptionsFactory | None = None,
    ) -> None:
        self._model = model
        self._caller = _ClaudeStructuredCaller(
            model=model, query_fn=query_fn, options_factory=options_factory
        )

    @property
    def model_id(self) -> str:
        return self._model

    async def draft(self, system_prompt: str, jd_snapshot: str) -> JobAnalysisDraft:
        structured = await self._caller.call(system_prompt=system_prompt, user_prompt=jd_snapshot)
        analysis = JobAnalysis.model_validate(structured)
        return JobAnalysisDraft(model_id=self._model, **analysis.model_dump())


class ClaudeAnalysisSynthesizer:
    """Claude Agent SDK reconciliation pass (``AnalysisSynthesizerPort``, D-07)."""

    def __init__(
        self,
        *,
        model: str = CLAUDE_ANALYSIS_MODEL,
        query_fn: QueryFn | None = None,
        options_factory: OptionsFactory | None = None,
    ) -> None:
        self._model = model
        self._caller = _ClaudeStructuredCaller(
            model=model, query_fn=query_fn, options_factory=options_factory
        )

    @property
    def model_id(self) -> str:
        return self._model

    async def reconcile(
        self,
        system_prompt: str,
        *,
        drafts: tuple[JobAnalysisDraft, ...],
        jd_snapshot: str,
    ) -> JobAnalysis:
        drafts_json = json.dumps(
            [draft.model_dump() for draft in drafts],
            ensure_ascii=False,
        )
        user_prompt = build_synthesizer_user_prompt(
            drafts_json=drafts_json,
            jd_snapshot=jd_snapshot,
        )
        structured = await self._caller.call(system_prompt=system_prompt, user_prompt=user_prompt)
        return JobAnalysis.model_validate(structured)


__all__ = [
    "CLAUDE_ANALYSIS_MODEL",
    "ClaudeAnalysisAdapter",
    "ClaudeAnalysisSynthesizer",
]
