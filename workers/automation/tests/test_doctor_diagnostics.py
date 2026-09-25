"""Controlled diagnostic cases through the public ``jobctrl doctor`` command.

Every machine, credential, database, process, and HTTP boundary is synthetic.
The assertions describe doctor output, not provider or service readiness.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from typer.testing import CliRunner

from jobctrl.browser_capabilities import BrowserCapabilityStatus
from jobctrl.cli import app
from jobctrl.infrastructure.setup_probes import ProbeResult


@pytest.fixture
def isolated_doctor(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """Fence all doctor inputs before invoking Typer; never inspect host state."""
    from jobctrl import config

    monkeypatch.setenv("JOBCTRL_DIR", str(tmp_path))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex"))
    for name in ("CAPSOLVER_API_KEY", "LANGFUSE_DISABLE", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(config, "load_env", lambda: ())
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "jobctrl.db")
    monkeypatch.setattr(config, "RESUME_PATH", tmp_path / "resume.txt")
    monkeypatch.setattr(config, "RESUME_PDF_PATH", tmp_path / "resume.pdf")
    monkeypatch.setattr(config, "load_search_config", lambda: {"boards": []})
    monkeypatch.setattr(config, "gmail_mcp_auth_status", lambda: (False, "synthetic OAuth absent"))
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
    monkeypatch.setattr("jobctrl.infrastructure.setup_probes.probe_analysis_setup", lambda: [ProbeResult("core LLM provider", False, "synthetic provider absent")])
    monkeypatch.setattr("jobctrl.infrastructure.setup_probes.resolve_claude_apply_binary", lambda: str(tmp_path / "absent-claude"))
    monkeypatch.setattr("jobctrl.runtime.is_bundled_runtime", lambda: False)
    monkeypatch.setattr("shutil.which", lambda _binary: None)
    monkeypatch.setattr("jobctrl.infrastructure.scoring.criteria_provider.read_apply_approval_required", lambda *, default: True)
    monkeypatch.setattr("jobctrl.infrastructure.temporal.get_temporal_client", AsyncMock(side_effect=ConnectionError("synthetic Temporal absent")))
    monkeypatch.setattr("jobctrl.cli.politeness_doctor_notices", lambda _conn, _cfg: [])
    monkeypatch.setattr("jobctrl.database.get_connection", lambda: None)
    monkeypatch.setattr("jobctrl.cli.llm_budget_doctor_notices", lambda: [])
    monkeypatch.setattr("jobctrl.cli.httpx.head", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("unexpected HTTP")))

    return lambda: CliRunner().invoke(app, ["doctor"])


def _row(output: str, name: str) -> str:
    return next(line for line in output.splitlines() if line.strip().startswith(name + " "))


def test_doctor_does_not_claim_missing_langfuse_route_reachable(
    isolated_doctor, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "synthetic-public")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "synthetic-secret")
    monkeypatch.setenv("LANGFUSE_BASE_URL", "https://example.invalid")
    monkeypatch.setattr(
        "jobctrl.cli.httpx.head",
        lambda *_args, **_kwargs: httpx.Response(404, request=httpx.Request("HEAD", "https://example.invalid/api/public/otel/v1/traces")),
    )

    result = isolated_doctor()

    assert result.exit_code == 0, result.output
    assert "MISSING" in _row(result.output, "Langfuse")
    assert "status=404" in _row(result.output, "Langfuse")


def test_doctor_reports_missing_and_disabled_integrations_without_failure(
    isolated_doctor, monkeypatch: pytest.MonkeyPatch
) -> None:
    result = isolated_doctor()

    assert result.exit_code == 0, result.output
    assert "MISSING" in _row(result.output, "candidate profile")
    assert "MISSING" in _row(result.output, "core browser (scraping + PDF)")
    assert "DISABLED" in _row(result.output, "auto-apply-browser capability")
    assert "MISSING" in _row(result.output, "Langfuse")
    assert "MISSING" in _row(result.output, "Temporal")

    monkeypatch.setenv("LANGFUSE_DISABLE", "1")
    disabled = isolated_doctor()
    assert disabled.exit_code == 0, disabled.output
    assert "disabled" in _row(disabled.output, "Langfuse")
