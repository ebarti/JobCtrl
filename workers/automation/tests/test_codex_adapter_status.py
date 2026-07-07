"""Regression: the Codex adapter must accept an enum TurnStatus.

A live smoke test showed the real SDK returns ``status`` as a ``TurnStatus``
enum (``str(enum) == "TurnStatus.completed"``), so the old ``str(status) ==
"completed"`` check wrongly failed every successful turn. The prior mock used a
plain ``"completed"`` string and never caught it; this mock uses an enum-like
object with ``.value`` so the regression stays pinned.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from jobctl.infrastructure.analysis.codex_analysis_adapter import (
    CODEX_ANALYSIS_MODEL,
    CodexAnalysisAdapter,
)

pytestmark = pytest.mark.asyncio

_VALID_JSON = (
    '{"role_framing":"Hire a senior Python engineer.",'
    '"inferred_seniority":"senior",'
    '"ideal_candidate_narrative":"Experienced backend engineer.",'
    '"requirements":[],"keywords":[]}'
)


class _EnumStatus:
    """Mimics TurnStatus: str(self) is 'TurnStatus.<name>' but .value is plain."""

    def __init__(self, value: str) -> None:
        self.value = value

    def __str__(self) -> str:  # the trap the old code fell into
        return f"TurnStatus.{self.value}"


class _FakeThread:
    def __init__(self, result: object) -> None:
        self._result = result

    async def run(self, prompt: str, **kwargs: object) -> object:
        return self._result


class _FakeCodex:
    def __init__(self, result: object) -> None:
        self._result = result

    async def __aenter__(self) -> "_FakeCodex":
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False

    async def thread_start(self, **kwargs: object) -> _FakeThread:
        return _FakeThread(self._result)


def _factory(result: object):
    return lambda: _FakeCodex(result)


async def test_enum_status_completed_is_accepted() -> None:
    result = SimpleNamespace(
        status=_EnumStatus("completed"),
        final_response=_VALID_JSON,
        error=None,
    )
    adapter = CodexAnalysisAdapter(async_codex_factory=_factory(result))
    draft = await adapter.draft("system prompt", "JOB: Senior Python Engineer.")
    assert draft.model_id == CODEX_ANALYSIS_MODEL
    assert draft.inferred_seniority == "senior"


async def test_enum_status_failed_raises() -> None:
    result = SimpleNamespace(
        status=_EnumStatus("failed"),
        final_response=None,
        error="boom",
    )
    adapter = CodexAnalysisAdapter(async_codex_factory=_factory(result))
    with pytest.raises(RuntimeError, match="Codex turn failed"):
        await adapter.draft("system prompt", "JOB: x")
