"""Deterministic workflow ids + USE_EXISTING give real no-overlap (P0).

A second start with the same workflow id returns the already-running handle
instead of launching a duplicate execution — the mechanism the deterministic
``apply-{jobKey}`` id relies on to make a double-click apply idempotent.
"""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, patch

import pytest
from temporalio import workflow
from temporalio.common import WorkflowIDConflictPolicy
from .temporal_env import local_env, time_skipping_env
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


@pytest.mark.asyncio
async def test_discover_starter_reuses_running_execution_and_preserves_peer(tmp_path, monkeypatch) -> None:
    """Use the real Discover spec and starter against an isolated Temporal server."""
    from jobctrl import database
    from jobctrl.infrastructure.rpc import workflow_starter
    from jobctrl.workflow_specs import build_run_stage_workflow_spec

    tenant = "local"
    peer_tenant = f"synthetic-peer-{uuid.uuid4().hex}"
    selected = build_run_stage_workflow_spec({"stages": ["discover"], "tenantId": tenant})
    peer = build_run_stage_workflow_spec({"stages": ["discover"], "tenantId": peer_tenant})

    conn = database.init_db(tmp_path / "jobctrl.db")
    monkeypatch.setattr(database, "get_connection", lambda: conn)
    async with local_env() as env:
        with patch.object(workflow_starter, "get_temporal_client", AsyncMock(return_value=env.client)):
            first = await workflow_starter.default_workflow_starter(selected)
            duplicate = await workflow_starter.default_workflow_starter(selected)
            other = await workflow_starter.default_workflow_starter(peer)
        assert first.id == duplicate.id == f"discover-{tenant}"
        assert first.first_execution_run_id == duplicate.first_execution_run_id
        assert other.id == f"discover-{peer_tenant}"
        assert other.first_execution_run_id != first.first_execution_run_id
        assert (await first.describe()).status.name == "RUNNING"
        assert (await other.describe()).status.name == "RUNNING"
        projected = conn.execute(
            "SELECT status, temporal_run_id FROM workflow_run_projections WHERE tenant_id=? AND workflow_id=?",
            (tenant, first.id),
        ).fetchone()
        assert tuple(projected) == ("in_progress", first.first_execution_run_id)
    conn.close()
