from unittest.mock import AsyncMock, patch

import pytest

from jobhunter.infrastructure.temporal import get_temporal_client


@pytest.mark.asyncio
async def test_get_temporal_client_uses_default_address_and_namespace(monkeypatch):
    monkeypatch.delenv("TEMPORAL_ADDRESS", raising=False)
    monkeypatch.delenv("TEMPORAL_NAMESPACE", raising=False)

    sentinel = object()
    with patch(
        "jobhunter.infrastructure.temporal.client.Client.connect",
        new=AsyncMock(return_value=sentinel),
    ) as connect_mock:
        client = await get_temporal_client()

    assert client is sentinel
    connect_mock.assert_awaited_once_with("localhost:7233", namespace="default")


@pytest.mark.asyncio
async def test_get_temporal_client_honours_environment(monkeypatch):
    monkeypatch.setenv("TEMPORAL_ADDRESS", "temporal.example:7777")
    monkeypatch.setenv("TEMPORAL_NAMESPACE", "jobhunter")

    sentinel = object()
    with patch(
        "jobhunter.infrastructure.temporal.client.Client.connect",
        new=AsyncMock(return_value=sentinel),
    ) as connect_mock:
        client = await get_temporal_client()

    assert client is sentinel
    connect_mock.assert_awaited_once_with("temporal.example:7777", namespace="jobhunter")
