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



@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["completed", "failed"])
async def test_fallback_retains_numeric_details_without_double_counting_totals(status):
    from jobctrl.infrastructure.llm.provider_errors import ProviderCallError
    totals, details = [], []
    class Thread:
        async def run(self, *_args, **_kwargs):
            return SimpleNamespace(
                status=status, final_response="owned", error=SimpleNamespace(message="owned private"),
                usage=SimpleNamespace(total=SimpleNamespace(
                    input_tokens=19, output_tokens=9, cached_input_tokens=11, reasoning_output_tokens=7,
                )),
            )
    async def invoke():
        return await run_codex_turn(
            Thread(), "owned", model="gpt-test", operation="chat", run_kwargs={},
            record_usage=lambda *value: totals.append(value),
            record_usage_details=lambda *value: details.append(value),
        )
    if status == "failed":
        with pytest.raises(ProviderCallError):
            await invoke()
    else:
        outcome = await invoke()
        assert (outcome.input_tokens, outcome.output_tokens) == (19, 9)
    assert totals == [(19, 9)]
    assert details == [(11, 7)]


@pytest.mark.asyncio
async def test_cancellation_keeps_original_error_and_both_usage_callbacks():
    thread = _CancellationThread()
    totals, details = [], []
    with pytest.raises(asyncio.CancelledError):
        await run_codex_turn(
            thread, "owned", model="gpt-test", operation="chat", run_kwargs={},
            record_usage=lambda *value: totals.append(value),
            record_usage_details=lambda *value: details.append(value),
        )
    assert totals == [(19, 3)]
    assert details == [(None, None)]
    assert thread.handle.stream_value.closed


@pytest.mark.asyncio
async def test_callback_failure_does_not_skip_accounting_or_replace_cancellation():
    thread = _CancellationThread()
    totals = []
    def broken_details(*_values):
        raise ValueError("owned detail failure")
    with pytest.raises(asyncio.CancelledError):
        await run_codex_turn(
            thread, "owned", model="gpt-test", operation="chat", run_kwargs={},
            record_usage=lambda *value: totals.append(value),
            record_usage_details=broken_details,
        )
    assert totals == [(19, 3)]
    assert thread.handle.stream_value.closed
