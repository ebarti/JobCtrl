"""Tests for ``DurabilityProbeWorkflow`` — the hermetic durable-execution probe.

The probe backs ``scripts/reliability-demo.sh`` (launch asset 9). These tests
assert the two properties the demo relies on: it emits the standard lifecycle
events and returns its identity, and — the durability claim itself
(TR-008 / CL-050) — a run that is in flight when its worker is killed resumes on
a fresh worker as the SAME execution and completes exactly once.
"""

from __future__ import annotations

import asyncio
import contextlib
import uuid

import pytest
from temporalio import activity
from temporalio.client import WorkflowExecutionStatus
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobctrl.infrastructure.temporal.durability_probe import (
    DurabilityProbeInput,
    DurabilityProbeWorkflow,
    durability_probe_workflow_id,
)
from jobctrl.infrastructure.temporal.finalize import (
    WorkflowOutcomeInput,
    WorkflowStartedInput,
)


def test_durability_probe_workflow_id_is_stable() -> None:
    assert durability_probe_workflow_id("local", "7") == "durability-probe-local-7"


@pytest.mark.asyncio
async def test_durability_probe_completes_and_records_lifecycle() -> None:
    queue = f"durability-{uuid.uuid4()}"
    wf_id = f"durability-probe-{uuid.uuid4().hex}"
    events: list[str] = []

    @activity.defn(name="record_workflow_started")
    async def record_started(_payload: WorkflowStartedInput) -> None:
        events.append("started")

    @activity.defn(name="record_workflow_outcome")
    async def record_outcome(payload: WorkflowOutcomeInput) -> None:
        events.append(f"outcome:{payload.status}")

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[DurabilityProbeWorkflow],
            activities=[record_started, record_outcome],
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            result = await env.client.execute_workflow(
                DurabilityProbeWorkflow.run,
                DurabilityProbeInput(tenant_id="local", hold_seconds=45),
                id=wf_id,
                task_queue=queue,
            )

    assert result.workflow_id == wf_id
    assert result.hold_seconds == 45
    assert result.run_id
    # Exactly one start marker and one success outcome — no duplicates.
    assert events == ["started", "outcome:succeeded"]


@pytest.mark.asyncio
async def test_durability_probe_clamps_absurd_hold_to_ceiling() -> None:
    queue = f"durability-{uuid.uuid4()}"

    @activity.defn(name="record_workflow_started")
    async def record_started(_payload: WorkflowStartedInput) -> None:
        return None

    @activity.defn(name="record_workflow_outcome")
    async def record_outcome(_payload: WorkflowOutcomeInput) -> None:
        return None

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[DurabilityProbeWorkflow],
            activities=[record_started, record_outcome],
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            result = await env.client.execute_workflow(
                DurabilityProbeWorkflow.run,
                DurabilityProbeInput(tenant_id="local", hold_seconds=10_000_000),
                id=f"durability-probe-{uuid.uuid4().hex}",
                task_queue=queue,
            )

    assert result.hold_seconds == 3600


@pytest.mark.asyncio
async def test_durability_probe_resumes_same_run_after_worker_crash() -> None:
    """The TR-008 / CL-050 invariant the launch demo exists to prove.

    Worker A parks the run on its durable timer, then dies. With no worker
    running the execution is still ``Running`` (Temporal holds the timer); a
    fresh worker B resumes the SAME execution from history and drives it to
    ``Completed`` exactly once.

    This uses a real local dev server (``start_local``) rather than the
    in-memory time-skipping server: faithfully resuming a durable timer across a
    worker crash is exactly the behaviour the time-skipping server does not
    reproduce. The crash is a cancelled worker task (abrupt), not a graceful
    context-managed shutdown, which is both a truer crash and what keeps the
    ephemeral server alive across it. It costs a few real seconds (the short
    hold), which is the point.
    """
    queue = f"durability-{uuid.uuid4()}"
    wf_id = f"durability-probe-{uuid.uuid4().hex}"
    started_done = asyncio.Event()

    @activity.defn(name="record_workflow_started")
    async def record_started(_payload: WorkflowStartedInput) -> None:
        started_done.set()

    @activity.defn(name="record_workflow_outcome")
    async def record_outcome(_payload: WorkflowOutcomeInput) -> None:
        return None

    def new_worker(client) -> Worker:
        return Worker(
            client,
            task_queue=queue,
            workflows=[DurabilityProbeWorkflow],
            activities=[record_started, record_outcome],
            workflow_runner=UnsandboxedWorkflowRunner(),
        )

    async with await WorkflowEnvironment.start_local() as env:
        # --- worker A: start the probe and let it reach the durable timer ---
        worker_a = asyncio.create_task(new_worker(env.client).run())
        handle = await env.client.start_workflow(
            DurabilityProbeWorkflow.run,
            DurabilityProbeInput(tenant_id="local", hold_seconds=5),
            id=wf_id,
            task_queue=queue,
        )
        await asyncio.wait_for(started_done.wait(), timeout=15)
        first_run = handle.first_execution_run_id
        assert (await handle.describe()).status == WorkflowExecutionStatus.RUNNING

        # --- CRASH worker A (abrupt task cancel); the run must survive ---
        worker_a.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await worker_a
        assert (await handle.describe()).status == WorkflowExecutionStatus.RUNNING

        # --- worker B: it must resume the SAME execution from history ---
        worker_b = asyncio.create_task(new_worker(env.client).run())
        try:
            # A returned result is itself proof the run reached COMPLETED.
            result = await asyncio.wait_for(handle.result(), timeout=30)
            terminal_status = (await handle.describe()).status
        finally:
            worker_b.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await worker_b

        assert result.workflow_id == wf_id
        assert handle.first_execution_run_id == first_run  # same run resumed
        assert terminal_status == WorkflowExecutionStatus.COMPLETED
