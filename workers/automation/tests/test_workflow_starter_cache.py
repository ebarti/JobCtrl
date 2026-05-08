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
from unittest.mock import AsyncMock, MagicMock, patch

from jobhunter.domain.rpc.messages import WorkflowStartSpec
from jobhunter.infrastructure.rpc import workflow_starter as ws


class _FakeWorkflow:
    pass


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
        spec = WorkflowStartSpec(workflow=_FakeWorkflow, args=())

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
        spec = WorkflowStartSpec(workflow=_FakeWorkflow, args=())

        # Each asyncio.run owns its own loop — exactly the JSON-RPC dispatch path.
        asyncio.run(ws.default_workflow_starter(spec))
        asyncio.run(ws.default_workflow_starter(spec))

    assert fake_client.start_workflow.await_count == 2
