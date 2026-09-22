"""Failure-path usage retention for the shared Codex turn collector."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from jobctrl.infrastructure.llm.codex_turn import run_codex_turn


class _UsageThenCancellationStream:
    def __init__(self, turn_id: str) -> None:
        self._turn_id = turn_id
        self._yielded = False
        self.closed = False

    def __aiter__(self) -> _UsageThenCancellationStream:
        return self

    async def __anext__(self) -> Any:
        if not self._yielded:
            self._yielded = True
            return SimpleNamespace(
                payload=SimpleNamespace(
                    turn_id=self._turn_id,
                    token_usage=SimpleNamespace(
                        total=SimpleNamespace(input_tokens=19, output_tokens=3)
                    ),
                )
            )
        raise asyncio.CancelledError

    async def aclose(self) -> None:
        self.closed = True


class _CancellationHandle:
    id = "turn-cancelled"

    def __init__(self) -> None:
        self.stream_value = _UsageThenCancellationStream(self.id)

    def stream(self) -> _UsageThenCancellationStream:
        return self.stream_value


class _CancellationThread:
    def __init__(self) -> None:
        self.handle = _CancellationHandle()

    async def turn(self, prompt: str, **kwargs: Any) -> _CancellationHandle:
        return self.handle


@pytest.mark.asyncio
async def test_run_codex_turn_records_usage_once_and_preserves_cancellation() -> None:
    thread = _CancellationThread()
    observations: list[tuple[int | None, int | None]] = []

    with pytest.raises(asyncio.CancelledError):
        await run_codex_turn(
            thread,
            "synthetic prompt",
            model="gpt-test",
            operation="chat",
            run_kwargs={},
            record_usage=lambda input_tokens, output_tokens: observations.append(
                (input_tokens, output_tokens)
            ),
        )

    assert observations == [(19, 3)]
    assert thread.handle.stream_value.closed
