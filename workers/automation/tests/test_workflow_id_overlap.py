"""Deterministic workflow ids + USE_EXISTING give real no-overlap (P0).

A second start with the same workflow id returns the already-running handle
instead of launching a duplicate execution — the mechanism the deterministic
``apply-{jobKey}`` id relies on to make a double-click apply idempotent.
"""

from __future__ import annotations

import uuid

import pytest
from temporalio import workflow
from temporalio.common import WorkflowIDConflictPolicy
from .temporal_env import time_skipping_env
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

_run_count = 0


@workflow.defn(name="OverlapHarness")
class _OverlapHarness:
    def __init__(self) -> None:
        self._release = False

    @workflow.signal
    def release(self) -> None:
        self._release = True

    @workflow.run
    async def run(self) -> str:
        global _run_count
        _run_count += 1
        await workflow.wait_condition(lambda: self._release)
        return "done"


@pytest.mark.asyncio
async def test_double_start_returns_existing_handle_no_duplicate() -> None:
    global _run_count
    _run_count = 0
    queue = f"overlap-{uuid.uuid4()}"
    workflow_id = f"apply-{uuid.uuid4().hex}"

    async with time_skipping_env() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[_OverlapHarness],
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            first = await env.client.start_workflow(
                _OverlapHarness.run,
                id=workflow_id,
                task_queue=queue,
                id_conflict_policy=WorkflowIDConflictPolicy.USE_EXISTING,
            )
            # Second start with the same id + USE_EXISTING attaches to the
            # running execution rather than starting a new one.
            second = await env.client.start_workflow(
                _OverlapHarness.run,
                id=workflow_id,
                task_queue=queue,
                id_conflict_policy=WorkflowIDConflictPolicy.USE_EXISTING,
            )

            assert second.first_execution_run_id == first.first_execution_run_id

            await first.signal(_OverlapHarness.release)
            assert await first.result() == "done"
            # The second handle resolves to the same single execution.
            assert await second.result() == "done"

    # Exactly one execution ran despite two starts.
    assert _run_count == 1
