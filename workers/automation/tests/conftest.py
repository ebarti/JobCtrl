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


_TEST_APP_DIR = Path(tempfile.mkdtemp(prefix="jobctrl-pytest-"))
os.environ["JOBCTRL_DIR"] = str(_TEST_APP_DIR)

# Initialise the session sandbox DB so activities that open the default
# thread-local connection (e.g. the Temporal finalize activities) find their
# tables. Per-test suites that need isolated state still use their own
# ``tmp_path`` databases via ``init_db(path)``.
from jobctrl.config import ensure_dirs  # noqa: E402
from jobctrl.database import init_db  # noqa: E402

ensure_dirs()
init_db()


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    """Remove the session-scoped user-data sandbox after pytest exits."""
    if os.environ.get("JOBCTRL_DIR") == str(_TEST_APP_DIR):
        shutil.rmtree(_TEST_APP_DIR, ignore_errors=True)


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    """Assign every test file exactly one suite marker for targeted runs.

    Migration files take precedence, then any file that owns a Temporal
    ``WorkflowEnvironment`` lifecycle, then the hermetic core. Reading source
    keeps the assignment current when a new Temporal test file is added, so
    ``-m temporal`` / ``-m migration`` / ``-m core`` stay exact selectors.
    """

    source_by_path: dict[Path, str] = {}
    for item in items:
        item_path = Path(str(item.path))
        if item_path.name.startswith("test_v6_to_v7_"):
            item.add_marker(pytest.mark.migration)
            continue
        source = source_by_path.get(item_path)
        if source is None:
            source = item_path.read_text(encoding="utf-8")
            source_by_path[item_path] = source
        if (
            "WorkflowEnvironment." in source
            or "time_skipping_env(" in source
            or "local_env(" in source
        ):
            item.add_marker(pytest.mark.temporal)
        else:
            item.add_marker(pytest.mark.core)


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


@pytest.fixture(autouse=True)
def source_runtime_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep source tests independent of an installed launcher's ambient env."""

    monkeypatch.setenv("JOBCTRL_RUNTIME_MODE", "source")
    for key in ("JOBCTRL_ENV_FILE", "JOBCTRL_PAYLOAD_DIR", "JOBCTRL_PROVIDER_PACKS_DIR"):
        monkeypatch.delenv(key, raising=False)


@pytest.fixture(autouse=True)
def reset_apply_dashboard_state() -> None:
    """Keep the module-level apply dashboard state from leaking across tests."""
    from jobctrl.apply import dashboard

    with dashboard._lock:
        dashboard._events.clear()
        dashboard._worker_states.clear()
    yield
    with dashboard._lock:
        dashboard._events.clear()
        dashboard._worker_states.clear()


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
