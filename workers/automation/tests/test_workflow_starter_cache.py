"""``default_workflow_starter`` / ``default_workflow_canceler`` connect-per-call.

The earlier module-scope ``Client`` cache plus ``asyncio.Lock`` was bound
to the first event loop that touched it; ``JsonRpcServer.dispatch`` opens
a fresh loop via ``asyncio.run(...)`` per request, so the cache crashed
on the second JSON-RPC call with
``RuntimeError: <Lock ...> is bound to a different event loop``.

The cache was removed; correctness > a few-ms TCP handshake. These tests
pin the new behaviour: every call constructs a fresh client via
``get_temporal_client()``, and the second call across a fresh event loop
succeeds.
"""

from __future__ import annotations

import asyncio
import sqlite3
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from temporalio.client import WorkflowExecutionStatus
from temporalio.service import RPCError, RPCStatusCode

from jobctrl import config
from jobctrl.cli import _reconcile_workflow_runs
from jobctrl.database import get_connection
from jobctrl.domain.rpc.messages import WorkflowStartSpec
from jobctrl.infrastructure.rpc import workflow_starter as ws
from jobctrl.infrastructure.runtime_identity import RuntimeIdentityMismatch
from jobctrl.infrastructure.temporal.workflow_dispatch_control import (
    WorkflowDispatchFencedError,
    set_workflow_dispatches_blocked,
)
from jobctrl.pipeline.workflow import JobPipelineWorkflow, JobPipelineWorkflowInput


class _FakeDescribe:
    def __init__(self, status: WorkflowExecutionStatus) -> None:
        self.status = status
        self.run_id = "temporal-run"


class _FakeDescribeHandle:
    def __init__(self, outcome) -> None:
        self._outcome = outcome

    async def describe(self):
        if isinstance(self._outcome, Exception):
            raise self._outcome
        return self._outcome


class _FakeDescribeClient:
    def __init__(self, workflow_id: str, outcome) -> None:
        self._workflow_id = workflow_id
        self._outcome = outcome

    def get_workflow_handle(
        self, workflow_id: str, *, run_id: str | None = None
    ) -> _FakeDescribeHandle:
        if workflow_id == self._workflow_id:
            return _FakeDescribeHandle(self._outcome)
        return _FakeDescribeHandle(_FakeDescribe(WorkflowExecutionStatus.RUNNING))


def test_starter_connects_per_call() -> None:
    """Each ``default_workflow_starter`` call must invoke ``get_temporal_client``.

    The previous cache was correctness-broken under per-request
    ``asyncio.run`` loops — see the module docstring for the failure
    mode. Reconnecting per call is the trade-off.
    """
    handle = MagicMock()
    fake_client = MagicMock()
    fake_client.start_workflow = AsyncMock(return_value=handle)

    with patch.object(
        ws, "get_temporal_client", AsyncMock(return_value=fake_client)
    ) as connect_mock:
        spec = _registered_spec()

        async def _drive() -> None:
            await ws.default_workflow_starter(spec)
            await ws.default_workflow_starter(spec)
            await ws.default_workflow_starter(spec)

        asyncio.run(_drive())

    assert connect_mock.await_count == 3
    assert fake_client.start_workflow.await_count == 3


def test_canceler_connects_per_call() -> None:
    """Each ``default_workflow_canceler`` call must invoke ``get_temporal_client`` too."""
    handle = MagicMock()
    handle.cancel = AsyncMock(return_value=None)
    fake_client = MagicMock()
    fake_client.get_workflow_handle = MagicMock(return_value=handle)

    with patch.object(
        ws, "get_temporal_client", AsyncMock(return_value=fake_client)
    ) as connect_mock:
        async def _drive() -> None:
            await ws.default_workflow_canceler("wf-1")
            await ws.default_workflow_canceler("wf-2")

        asyncio.run(_drive())

    assert connect_mock.await_count == 2
    assert handle.cancel.await_count == 2


def test_starter_survives_cross_loop_invocation() -> None:
    """The original bug: two ``asyncio.run(...)`` calls back-to-back.

    With the broken cache, the second loop hit
    ``RuntimeError: <Lock ...> is bound to a different event loop``.
    Now each call connects fresh and the second loop succeeds.
    """
    handle = MagicMock()
    fake_client = MagicMock()
    fake_client.start_workflow = AsyncMock(return_value=handle)

    with patch.object(
        ws, "get_temporal_client", AsyncMock(return_value=fake_client)
    ):
        spec = _registered_spec()

        # Each asyncio.run owns its own loop — exactly the JSON-RPC dispatch path.
        asyncio.run(ws.default_workflow_starter(spec))
        asyncio.run(ws.default_workflow_starter(spec))

    assert fake_client.start_workflow.await_count == 2


@pytest.mark.asyncio
async def test_starter_never_contacts_temporal_while_dispatch_is_fenced(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    monkeypatch.setattr(config, "DB_PATH", db_path)
    set_workflow_dispatches_blocked(
        blocked=True,
        reason="identity-cutover",
        db_path=db_path,
    )
    fake_client = MagicMock()
    fake_client.start_workflow = AsyncMock()
    spec = WorkflowStartSpec(
        workflow=JobPipelineWorkflow,
        args=(
            JobPipelineWorkflowInput(
                tenant_id="local",
                stages=["score"],
                expected_db_path=str(db_path),
            ),
        ),
    )

    with (
        patch.object(
            ws,
            "get_temporal_client",
            AsyncMock(return_value=fake_client),
        ) as connect_mock,
        pytest.raises(
            WorkflowDispatchFencedError,
            match="stable JobId cutover",
        ),
    ):
        await ws.default_workflow_starter(spec)

    connect_mock.assert_not_awaited()
    fake_client.start_workflow.assert_not_awaited()


@pytest.mark.asyncio
async def test_starter_rejects_an_alternate_expected_db_before_temporal_contact(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    canonical_db_path = tmp_path / "canonical.db"
    alternate_db_path = tmp_path / "alternate.db"
    monkeypatch.setattr(config, "DB_PATH", canonical_db_path)
    fake_client = MagicMock()
    fake_client.start_workflow = AsyncMock()
    spec = WorkflowStartSpec(
        workflow=JobPipelineWorkflow,
        args=(
            JobPipelineWorkflowInput(
                tenant_id="local",
                stages=["score"],
                expected_db_path=str(alternate_db_path),
            ),
        ),
    )

    with (
        patch.object(
            ws,
            "get_temporal_client",
            AsyncMock(return_value=fake_client),
        ) as connect_mock,
        pytest.raises(
            RuntimeIdentityMismatch,
            match="Worker runtime mismatch",
        ),
    ):
        await ws.default_workflow_starter(spec)

    connect_mock.assert_not_awaited()
    fake_client.start_workflow.assert_not_awaited()
    assert alternate_db_path.exists() is False


@pytest.mark.asyncio
async def test_starter_connector_failure_keeps_an_uncertain_reservation(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    monkeypatch.setattr(config, "DB_PATH", db_path)
    spec = WorkflowStartSpec(
        workflow=JobPipelineWorkflow,
        args=(
            JobPipelineWorkflowInput(
                tenant_id="local",
                stages=["score"],
                expected_db_path=str(db_path),
            ),
        ),
        workflow_id="run-connect-timeout",
    )

    with (
        patch.object(
            ws,
            "get_temporal_client",
            AsyncMock(side_effect=TimeoutError("connector timeout")),
        ),
        pytest.raises(TimeoutError, match="connector timeout"),
    ):
        await ws.default_workflow_starter(spec)

    with sqlite3.connect(db_path) as conn:
        row = conn.execute(
            """
            SELECT workflow_id, temporal_run_id, state
            FROM workflow_dispatch_registry
            """
        ).fetchone()
    assert row == ("run-connect-timeout", None, "uncertain")


@pytest.mark.asyncio
async def test_dispatch_started_row_is_visible_and_reconciler_terminalizes_not_found() -> None:
    workflow_id = f"run-{uuid.uuid4().hex}"
    handle = MagicMock()
    handle.first_execution_run_id = None
    handle.result_run_id = None
    handle.run_id = "temporal-run"
    spec = WorkflowStartSpec(
        workflow=JobPipelineWorkflow,
        args=(JobPipelineWorkflowInput(tenant_id="local", stages=["score"], limit=3),),
        workflow_id=workflow_id,
    )

    ws._record_dispatch_started(spec, workflow_id, handle)

    conn = get_connection()
    row = conn.execute(
        "SELECT status, workflow_type, input_summary_json FROM workflow_run_projections WHERE workflow_id = ?",
        (workflow_id,),
    ).fetchone()
    assert row is not None
    assert row["status"] == "in_progress"
    assert row["workflow_type"] == "JobPipelineWorkflow"
    assert '"limit": 3' in (row["input_summary_json"] or "")

    client = _FakeDescribeClient(
        workflow_id,
        RPCError("not found", RPCStatusCode.NOT_FOUND, b""),
    )
    terminalized = await _reconcile_workflow_runs(client)

    row = conn.execute(
        "SELECT status, error_code FROM workflow_run_projections WHERE workflow_id = ?",
        (workflow_id,),
    ).fetchone()
    assert terminalized >= 1
    assert row["status"] == "terminated"
    assert row["error_code"] == "reconciled_not_found"


def _registered_spec() -> WorkflowStartSpec:
    return WorkflowStartSpec(
        workflow=JobPipelineWorkflow,
        args=(
            JobPipelineWorkflowInput(
                tenant_id="local",
                stages=["score"],
            ),
        ),
    )
