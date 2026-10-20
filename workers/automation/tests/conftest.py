"""Shared pytest guardrails for local worker tests."""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path
from types import SimpleNamespace

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
        if "WorkflowEnvironment." in source or "time_skipping_env(" in source or "local_env(" in source:
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
def isolate_legacy_doctor_inputs(monkeypatch: pytest.MonkeyPatch, request: pytest.FixtureRequest) -> None:
    """Fence unrelated inputs while each legacy CLI case owns its tested seam.

    Temporal cases keep the real client factory and mock Client.connect;
    Langfuse cases own HEAD/disable state; Gmail cases own their row inputs;
    the budget case keeps real accounting against its own temporary database.
    """
    test_file = Path(str(request.fspath)).name
    if test_file not in {
        "test_doctor_temporal.py", "test_doctor_langfuse.py",
        "test_doctor_gmail_mcp.py", "test_doctor_llm_budget.py",
    }:
        return

    from jobctrl import config
    from jobctrl.browser_capabilities import BrowserCapabilityStatus

    app_dir = request.getfixturevalue("tmp_path")
    monkeypatch.setenv("JOBCTRL_DIR", str(app_dir))
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(app_dir / "config.json"))
    for name in ("CAPSOLVER_API_KEY", "LANGFUSE_DISABLE", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(config, "APP_DIR", app_dir)
    monkeypatch.setattr(config, "DB_PATH", app_dir / "jobctrl.db")
    monkeypatch.setattr(config, "RESUME_PATH", app_dir / "resume.txt")
    monkeypatch.setattr(config, "RESUME_PDF_PATH", app_dir / "resume.pdf")
    monkeypatch.setattr(config, "load_env", lambda: ())
    monkeypatch.setattr(config, "load_search_config", lambda: {"boards": []})
    monkeypatch.setattr(config, "load_saved_search_settings", lambda: {})
    monkeypatch.setattr(config, "gmail_mcp_auth_status", lambda: (False, "synthetic auth absent"))
    monkeypatch.setattr(config, "get_tier", lambda: 1)
    monkeypatch.setattr("jobctrl.native_credentials.native_store_label", lambda: "synthetic store")
    monkeypatch.setattr("jobctrl.infrastructure.profile.get_profile_repository", lambda: SimpleNamespace(load=lambda _tenant: None))
    monkeypatch.setattr(
        "jobctrl.browser_capabilities.list_browser_capabilities",
        lambda: (
            BrowserCapabilityStatus("core-browser", "missing", "synthetic Chromium absent"),
            BrowserCapabilityStatus("auto-apply-browser", "disabled", "synthetic choice off"),
            BrowserCapabilityStatus("authenticated-linkedin-browser", "disabled", "synthetic choice off"),
        ),
    )
    monkeypatch.setattr("jobctrl.infrastructure.setup_probes.probe_analysis_setup", lambda: [])
    monkeypatch.setattr("jobctrl.infrastructure.setup_probes.resolve_claude_apply_binary", lambda: str(app_dir / "absent-claude"))
    monkeypatch.setattr(shutil, "which", lambda _binary: None)
    monkeypatch.setattr("jobctrl.infrastructure.scoring.criteria_provider.read_apply_approval_required", lambda *, default: True)
    monkeypatch.setattr("jobctrl.cli.httpx.head", lambda *_args, **_kwargs: pytest.fail("unexpected doctor HTTP probe"))
    monkeypatch.setattr("jobctrl.cli.politeness_doctor_notices", lambda *_args: [])
    if test_file != "test_doctor_llm_budget.py":
        monkeypatch.setattr("jobctrl.database.get_connection", lambda: None)
        monkeypatch.setattr("jobctrl.cli.llm_budget_doctor_notices", lambda: [])


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


@pytest.fixture(autouse=True)
def require_explicit_model_ports(monkeypatch, request):
    """A workflow test must inject its model; never use a developer's provider.

    Adapter contract tests mock their own backend and exercise the adapter itself.
    All other tests fail distinctly when wiring accidentally reaches that boundary.
    """
    if Path(str(request.fspath)).name == "test_llm_port.py":
        return
    from jobctrl.infrastructure.llm.llm_client import LlmAdapter
    from jobctrl.domain.determinations import DeterminationFailure

    def unavailable(*args, **kwargs):
        raise DeterminationFailure("provider_unavailable")

    monkeypatch.setattr(LlmAdapter, "chat_json", unavailable)
