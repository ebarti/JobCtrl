"""Codex SDK adapter for employer analysis — one ensemble draft leg.

Mirrors the mestre vendor-lane pattern (``mestre/vendor_lane/backends/
codex_sdk.py``): drive the official ``openai_codex`` Python SDK directly (no
Node sidecar, no CLI-subprocess wrapper), forcing JSON-schema-constrained
output via ``output_schema`` on ``thread.run`` and parsing the structured
result off ``TurnResult.final_response``.

Test-mockability (no live auth in tests — D-04): the ``AsyncCodex`` class is
resolved through an injectable factory that defaults to a lazy import, so tests
pass a fake context-manager whose thread returns a canned ``final_response``.
No live Codex login / app-server is needed in the suite.

No timeout (D-19): ``thread.run`` is awaited to completion; effort is pinned to
``high`` (D-18). Cancellation = cancel the wrapping asyncio task.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from jobhunter.domain.materials.analysis import (
    JobAnalysis,
    JobAnalysisDraft,
)

AsyncCodexFactory = Callable[[], Any]

# Top current Codex model + max reasoning effort (D-18). Re-confirm the id at
# impl time; model ids drift.
CODEX_ANALYSIS_MODEL = "gpt-5.4"


def _load_async_codex_factory() -> AsyncCodexFactory:
    """Lazy-import ``openai_codex.AsyncCodex`` so the package imports without it."""
    from openai_codex import AsyncCodex  # type: ignore[import-untyped]

    return AsyncCodex


def _load_sandbox_read_only() -> Any:
    """Return the read-only sandbox enum value, tolerating SDK shape drift."""
    try:
        from openai_codex import Sandbox  # type: ignore[import-untyped]
    except ImportError:
        return "read-only"
    try:
        return Sandbox.read_only
    except AttributeError:
        return Sandbox("read-only")


class CodexAnalysisAdapter:
    """Codex SDK draft leg (``AnalysisDraftPort``)."""

    def __init__(
        self,
        *,
        model: str = CODEX_ANALYSIS_MODEL,
        async_codex_factory: AsyncCodexFactory | None = None,
    ) -> None:
        self._model = model
        self._async_codex_factory = async_codex_factory

    @property
    def model_id(self) -> str:
        return self._model

    async def draft(self, system_prompt: str, jd_snapshot: str) -> JobAnalysisDraft:
        factory = self._async_codex_factory or _load_async_codex_factory()
        prompt = f"{system_prompt}\n\nJOB DESCRIPTION:\n{jd_snapshot}"
        async with factory() as codex:  # reuses existing Codex login (D-04)
            thread = await codex.thread_start(
                model=self._model,
                # Max reasoning effort (D-18); analysis reads the JD, no FS writes.
                config={"model_reasoning_effort": "high"},
                sandbox=_load_sandbox_read_only(),
            )
            result = await thread.run(
                prompt,
                output_schema=JobAnalysis.model_json_schema(),
                effort="high",
            )
        status = str(getattr(result, "status", "") or "")
        final_response = getattr(result, "final_response", None)
        if (status and status != "completed") or not final_response:
            error = getattr(result, "error", None)
            raise RuntimeError(f"Codex turn failed: status={status!r} err={error!r}")
        analysis = JobAnalysis.model_validate_json(final_response)
        return JobAnalysisDraft(model_id=self._model, **analysis.model_dump())


__all__ = [
    "CODEX_ANALYSIS_MODEL",
    "CodexAnalysisAdapter",
]
