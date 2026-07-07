"""Temporal client factory."""

from __future__ import annotations

import os

from temporalio.client import Client
from temporalio.contrib.opentelemetry import TracingInterceptor

DEFAULT_ADDRESS = "localhost:7233"
DEFAULT_NAMESPACE = "default"


async def get_temporal_client() -> Client:
    """Connect to the Temporal frontend defined by ``TEMPORAL_ADDRESS`` / ``TEMPORAL_NAMESPACE``."""
    address = os.environ.get("TEMPORAL_ADDRESS", DEFAULT_ADDRESS)
    namespace = os.environ.get("TEMPORAL_NAMESPACE", DEFAULT_NAMESPACE)
    return await Client.connect(
        address,
        namespace=namespace,
        interceptors=[TracingInterceptor()],
    )
