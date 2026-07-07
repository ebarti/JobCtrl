from unittest.mock import AsyncMock, patch

import pytest
from temporalio.contrib.opentelemetry import TracingInterceptor

from jobctl.infrastructure.temporal import get_temporal_client


def _assert_connect_call(connect_mock, *, address: str, namespace: str) -> None:
    """Assert ``Client.connect`` was awaited with the expected args + interceptor."""
    connect_mock.assert_awaited_once()
    args, kwargs = connect_mock.await_args
    assert args == (address,)
    assert kwargs["namespace"] == namespace
    interceptors = kwargs["interceptors"]
    assert len(interceptors) == 1
    assert isinstance(interceptors[0], TracingInterceptor)


@pytest.mark.asyncio
async def test_get_temporal_client_uses_default_address_and_namespace(monkeypatch):
    monkeypatch.delenv("TEMPORAL_ADDRESS", raising=False)
    monkeypatch.delenv("TEMPORAL_NAMESPACE", raising=False)

    sentinel = object()
    with patch(
        "jobctl.infrastructure.temporal.client.Client.connect",
        new=AsyncMock(return_value=sentinel),
    ) as connect_mock:
        client = await get_temporal_client()

    assert client is sentinel
    _assert_connect_call(connect_mock, address="localhost:7233", namespace="default")


@pytest.mark.asyncio
async def test_get_temporal_client_honours_environment(monkeypatch):
    monkeypatch.setenv("TEMPORAL_ADDRESS", "temporal.example:7777")
    monkeypatch.setenv("TEMPORAL_NAMESPACE", "jobctl")

    sentinel = object()
    with patch(
        "jobctl.infrastructure.temporal.client.Client.connect",
        new=AsyncMock(return_value=sentinel),
    ) as connect_mock:
        client = await get_temporal_client()

    assert client is sentinel
    _assert_connect_call(connect_mock, address="temporal.example:7777", namespace="jobctl")
