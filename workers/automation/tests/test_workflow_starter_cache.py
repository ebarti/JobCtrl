"""Module-scope Temporal client cache in ``workflow_starter``.

The ``jobhunter rpc`` server is long-lived; opening a fresh gRPC connection
on every ``apply`` / ``cancel_run`` JSON-RPC call would burn a TCP / TLS /
namespace-describe handshake per request.  ``default_workflow_starter`` and
``default_workflow_canceler`` must reuse a single cached :class:`Client`.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from jobhunter.domain.rpc.messages import WorkflowStartSpec
from jobhunter.infrastructure.rpc import workflow_starter as ws


class _FakeWorkflow:
    pass


@pytest.fixture(autouse=True)
def _clear_client_cache():
    """Drop the cached client before and after every test."""
    asyncio.run(ws._reset_cached_client_for_tests())
    yield
    asyncio.run(ws._reset_cached_client_for_tests())


def test_repeated_starter_calls_reuse_single_client() -> None:
    """``default_workflow_starter`` must call ``get_temporal_client`` exactly once."""
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

    assert connect_mock.await_count == 1
    assert fake_client.start_workflow.await_count == 3


def test_starter_and_canceler_share_cached_client() -> None:
    """``default_workflow_canceler`` must reuse the same client the starter cached."""
    handle = MagicMock()
    handle.cancel = AsyncMock(return_value=None)
    fake_client = MagicMock()
    fake_client.start_workflow = AsyncMock(return_value=handle)
    fake_client.get_workflow_handle = MagicMock(return_value=handle)

    with patch.object(
        ws, "get_temporal_client", AsyncMock(return_value=fake_client)
    ) as connect_mock:
        spec = WorkflowStartSpec(workflow=_FakeWorkflow, args=())

        async def _drive() -> None:
            await ws.default_workflow_starter(spec)
            await ws.default_workflow_canceler("wf-123")

        asyncio.run(_drive())

    assert connect_mock.await_count == 1
    fake_client.get_workflow_handle.assert_called_once_with("wf-123")
    handle.cancel.assert_awaited_once()


def test_reset_cache_helper_forces_reconnect() -> None:
    """``_reset_cached_client_for_tests`` must clear the cache between runs."""
    fake_client = MagicMock()
    fake_client.start_workflow = AsyncMock(return_value=MagicMock())

    with patch.object(
        ws, "get_temporal_client", AsyncMock(return_value=fake_client)
    ) as connect_mock:
        spec = WorkflowStartSpec(workflow=_FakeWorkflow, args=())

        async def _drive() -> None:
            await ws.default_workflow_starter(spec)
            await ws._reset_cached_client_for_tests()
            await ws.default_workflow_starter(spec)

        asyncio.run(_drive())

    assert connect_mock.await_count == 2
