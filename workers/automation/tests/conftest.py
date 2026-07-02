"""Shared pytest guardrails for local worker tests."""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import set_tracer_provider


_TEST_APP_DIR = Path(tempfile.mkdtemp(prefix="jobhunter-pytest-"))
os.environ["JOBHUNTER_DIR"] = str(_TEST_APP_DIR)


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    """Remove the session-scoped user-data sandbox after pytest exits."""
    if os.environ.get("JOBHUNTER_DIR") == str(_TEST_APP_DIR):
        shutil.rmtree(_TEST_APP_DIR, ignore_errors=True)


@pytest.fixture(autouse=True)
def disable_langfuse_network_export_by_default(monkeypatch: pytest.MonkeyPatch, request: pytest.FixtureRequest) -> None:
    """Keep routine tests from exporting spans to a real Langfuse project.

    The focused observability and doctor tests own their own environment setup;
    every other test should stay hermetic even when a developer shell has live
    Langfuse credentials loaded.
    """
    test_file = Path(str(request.fspath)).name
    if test_file in {"test_otel_init.py", "test_doctor_langfuse.py"}:
        return
    monkeypatch.setenv("LANGFUSE_DISABLE", "1")


@pytest.fixture
def in_memory_exporter(monkeypatch):
    """TracerProvider piped to an in-memory exporter for span assertions.

    Resets the global provider guard so each requesting test gets a fresh,
    isolated exporter; shared by the observability + generation-span tests.
    """
    from opentelemetry import trace as trace_api
    from opentelemetry.util._once import Once

    monkeypatch.setattr(trace_api, "_TRACER_PROVIDER_SET_ONCE", Once())
    monkeypatch.setattr(trace_api, "_TRACER_PROVIDER", None)

    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    set_tracer_provider(provider)
    yield exporter
    exporter.clear()
