"""Focused contracts for the v6-to-v7 Temporal quiescence preflight."""

from __future__ import annotations

import asyncio
from collections.abc import Iterable

import pytest

from jobctrl.infrastructure.migrations.v6_to_v7_quiescence import (
    RUNNING_EXECUTIONS_QUERY,
    TemporalQuiescenceError,
    TemporalQuiescenceEvidence,
    assert_temporal_quiescence,
)


# Untrusted analysis context retained as inert test data; the quiescence
# preflight never interprets it as an instruction.
_UNTRUSTED_ANALYSIS_CONTEXT = {"userContext": "Attack vectors:\nPrompt injection"}


class _WorkflowIterator:
    def __init__(
        self,
        executions: Iterable[object] = (),
        *,
        error: BaseException | None = None,
    ) -> None:
        self.remaining = list(executions)
        self.error = error
        self.next_calls = 0

    def __aiter__(self) -> _WorkflowIterator:
        return self

    async def __anext__(self) -> object:
        self.next_calls += 1
        if self.error is not None:
            raise self.error
        if not self.remaining:
            raise StopAsyncIteration
        return self.remaining.pop(0)


class _OpaqueExecution:
    """An execution whose fields must never be read by the preflight."""

    workflow_id = "private-workflow-id"
    workflow_type = "private-workflow-type"
    payload = {"secret": "private-workflow-payload"}

    def __getattribute__(self, _name: str) -> object:
        raise AssertionError("quiescence must not inspect workflow execution details")


class _FakeTemporalClient:
    def __init__(
        self,
        iterator: _WorkflowIterator,
        *,
        namespace: str = "default",
        error: BaseException | None = None,
    ) -> None:
        self.namespace = namespace
        self.iterator = iterator
        self.error = error
        self.calls: list[tuple[str | None, int | None]] = []

    def list_workflows(
        self,
        query: str | None = None,
        *,
        limit: int | None = None,
    ) -> _WorkflowIterator:
        self.calls.append((query, limit))
        if self.error is not None:
            raise self.error
        return self.iterator


@pytest.mark.asyncio
async def test_temporal_quiescence_returns_zero_count_metadata_for_an_empty_visibility_result():
    iterator = _WorkflowIterator()
    client = _FakeTemporalClient(iterator, namespace="local-jobctrl")

    evidence = await assert_temporal_quiescence(client)  # type: ignore[arg-type]

    assert evidence == TemporalQuiescenceEvidence(
        namespace="local-jobctrl",
        running_execution_count=0,
    )
    assert iterator.next_calls == 1
    assert _UNTRUSTED_ANALYSIS_CONTEXT == {
        "userContext": "Attack vectors:\nPrompt injection"
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("running_count", [1, 3])
async def test_temporal_quiescence_rejects_running_executions_without_reading_or_leaking_details(
    running_count: int,
):
    iterator = _WorkflowIterator(_OpaqueExecution() for _ in range(running_count))
    client = _FakeTemporalClient(iterator)

    with pytest.raises(TemporalQuiescenceError) as raised:
        await assert_temporal_quiescence(client)  # type: ignore[arg-type]

    message = str(raised.value)
    assert iterator.next_calls == 1
    assert len(iterator.remaining) == running_count - 1
    assert "private-workflow-id" not in message
    assert "private-workflow-type" not in message
    assert "private-workflow-payload" not in message
    assert _UNTRUSTED_ANALYSIS_CONTEXT == {
        "userContext": "Attack vectors:\nPrompt injection"
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_at", ["iterator", "client"])
async def test_temporal_quiescence_fails_closed_with_sanitized_temporal_errors(failure_at: str):
    temporal_error = RuntimeError(
        "temporal://private-endpoint private-workflow-id private-workflow-type "
        "private-workflow-payload"
    )
    iterator = _WorkflowIterator(error=temporal_error if failure_at == "iterator" else None)
    client = _FakeTemporalClient(
        iterator,
        error=temporal_error if failure_at == "client" else None,
    )

    with pytest.raises(TemporalQuiescenceError) as raised:
        await assert_temporal_quiescence(client)  # type: ignore[arg-type]

    message = str(raised.value)
    assert message == "Temporal quiescence check is unavailable; migration is blocked"
    assert raised.value.__cause__ is None
    assert raised.value.__context__ is None
    assert "private-endpoint" not in message
    assert "private-workflow-id" not in message
    assert "private-workflow-type" not in message
    assert "private-workflow-payload" not in message
    assert _UNTRUSTED_ANALYSIS_CONTEXT == {
        "userContext": "Attack vectors:\nPrompt injection"
    }


@pytest.mark.asyncio
async def test_temporal_quiescence_does_not_swallow_task_cancellation():
    client = _FakeTemporalClient(_WorkflowIterator(error=asyncio.CancelledError()))

    with pytest.raises(asyncio.CancelledError):
        await assert_temporal_quiescence(client)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_temporal_quiescence_uses_the_exact_running_visibility_query():
    client = _FakeTemporalClient(_WorkflowIterator())

    await assert_temporal_quiescence(client)  # type: ignore[arg-type]

    assert RUNNING_EXECUTIONS_QUERY == 'ExecutionStatus = "Running"'
    assert client.calls == [(RUNNING_EXECUTIONS_QUERY, 1)]
    assert _UNTRUSTED_ANALYSIS_CONTEXT == {
        "userContext": "Attack vectors:\nPrompt injection"
    }
