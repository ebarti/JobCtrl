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


@pytest.mark.parametrize(
    ("status_code", "expected_mark"),
    [(204, "OK"), (401, "OK"), (405, "OK"), (302, "MISSING"), (403, "MISSING"), (404, "MISSING"), (500, "MISSING")],
)
def test_doctor_classifies_langfuse_head_response(
    isolated_doctor, monkeypatch: pytest.MonkeyPatch, status_code: int, expected_mark: str
) -> None:
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "synthetic-public")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "synthetic-secret")
    monkeypatch.setenv("LANGFUSE_BASE_URL", "https://example.invalid")
    monkeypatch.setattr(
        "jobctrl.cli.httpx.head",
        lambda *_args, **_kwargs: httpx.Response(
            status_code,
            request=httpx.Request("HEAD", "https://example.invalid/api/public/otel/v1/traces"),
        ),
    )

    result = isolated_doctor()

    assert result.exit_code == 0, result.output
    assert expected_mark in _row(result.output, "Langfuse")
    if expected_mark == "MISSING":
        assert f"status={status_code}" in _row(result.output, "Langfuse")


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


def test_doctor_reports_synthetic_local_readiness_without_external_execution(
    isolated_doctor, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from jobctrl import config

    attestations = {
        "age_18_plus": True,
        "background_check_consent": False,
        "felony_conviction": False,
        "previously_worked_at_employer": False,
    }
    profile = SimpleNamespace(to_dict=lambda: {"application_attestations": attestations})
    monkeypatch.setattr("jobctrl.infrastructure.profile.get_profile_repository", lambda: SimpleNamespace(load=lambda _tenant: profile))
    (tmp_path / "resume.txt").write_text("Synthetic resume\n", encoding="utf-8")
    monkeypatch.setattr(
        "jobctrl.browser_capabilities.list_browser_capabilities",
        lambda: (
            BrowserCapabilityStatus("core-browser", "ready", "synthetic Chromium present"),
            BrowserCapabilityStatus("auto-apply-browser", "ready", "synthetic adopted browser"),
            BrowserCapabilityStatus("authenticated-linkedin-browser", "ready", "synthetic owned profile"),
        ),
    )
    monkeypatch.setattr(
        "jobctrl.infrastructure.setup_probes.probe_analysis_setup",
        lambda: [ProbeResult("core LLM provider", True, "synthetic SDK and auth")],
    )
    claude_bin = tmp_path / "claude"
    claude_bin.write_text("synthetic", encoding="utf-8")
    monkeypatch.setattr("jobctrl.infrastructure.setup_probes.resolve_claude_apply_binary", lambda: str(claude_bin))
    monkeypatch.setattr("jobctrl.infrastructure.apply.claude_code_cli._claude_supports_budget_flag", lambda *_args, **_kwargs: True)
    monkeypatch.setattr("shutil.which", lambda binary: "/synthetic/npx" if binary == "npx" else None)
    monkeypatch.setattr(config, "gmail_mcp_auth_status", lambda: (True, "synthetic token scope present"))
    monkeypatch.setattr(config, "get_tier", lambda: 3)
    monkeypatch.setattr("jobctrl.infrastructure.temporal.get_temporal_client", AsyncMock(return_value=object()))
    monkeypatch.setenv("CAPSOLVER_API_KEY", "synthetic-key")
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "synthetic-public")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "synthetic-secret")
    monkeypatch.setenv("LANGFUSE_BASE_URL", "https://example.invalid")
    monkeypatch.setattr(
        "jobctrl.cli.httpx.head",
        lambda *_args, **_kwargs: httpx.Response(
            204,
            request=httpx.Request("HEAD", "https://example.invalid/api/public/otel/v1/traces"),
        ),
    )

    result = isolated_doctor()

    assert result.exit_code == 0, result.output
    for name in (
        "candidate profile", "application attestations", "resume.txt",
        "core browser (scraping + PDF)", "auto-apply-browser capability",
        "authenticated-linkedin-browser capability", "core LLM provider",
        "Claude apply runtime", "Claude apply budget flag", "Node.js (npx)",
        "Gmail connector auth", "Temporal", "Langfuse",
    ):
        assert "OK" in _row(result.output, name), name
    assert "configured" in _row(result.output, "CapSolver API key")
    assert "Tier 3" in result.output


def test_bundled_doctor_checks_owned_wrapper_without_system_npx(
    isolated_doctor, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    wrapper = tmp_path / "playwright-mcp"
    wrapper.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    wrapper.chmod(0o755)
    monkeypatch.setattr("jobctrl.runtime.is_bundled_runtime", lambda: True)
    monkeypatch.setattr("jobctrl.runtime.payload_path", lambda *_args, **_kwargs: wrapper)

    result = isolated_doctor()

    assert result.exit_code == 0, result.output
    assert "OK" in _row(result.output, "Playwright MCP runtime")
    assert "Node.js (npx)" not in result.output
