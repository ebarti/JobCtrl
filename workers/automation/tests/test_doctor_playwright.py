"""Doctor surfaces Playwright Chromium checks.

Scraping and resume PDF rendering both use Chromium, so ``doctor`` must report
the browser. These tests monkeypatch the shared preflight helper so no real
browser is required.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from typer.testing import CliRunner

from jobctrl.cli import app

_CHECK_TARGET = "jobctrl.infrastructure.preflight.check_playwright_chromium"
_CHECK_LABEL = "core browser (scraping + PDF)"


@pytest.fixture(autouse=True)
def isolated_doctor_boundaries(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Run each real doctor command without personal data or external probes."""
    from jobctrl import config

    app_dir = tmp_path / "jobctrl"
    app_dir.mkdir()
    monkeypatch.setenv("JOBCTRL_DIR", str(app_dir))
    monkeypatch.setattr(config, "APP_DIR", app_dir)
    monkeypatch.setattr(config, "DB_PATH", app_dir / "jobctrl.db")
    monkeypatch.setattr(config, "RESUME_PATH", app_dir / "resume.txt")
    monkeypatch.setattr(config, "RESUME_PDF_PATH", app_dir / "resume.pdf")
    monkeypatch.setattr(config, "load_env", lambda: ())
    monkeypatch.setattr(config, "load_search_config", lambda: {"boards": []})
    monkeypatch.setattr(config, "gmail_mcp_auth_status", lambda: (False, "synthetic auth absent"))
    monkeypatch.setattr(config, "get_tier", lambda: 1)
    monkeypatch.setattr("jobctrl.native_credentials.native_store_label", lambda: "synthetic store")
    monkeypatch.setattr(
        "jobctrl.infrastructure.profile.get_profile_repository",
        lambda: SimpleNamespace(load=lambda _tenant: None),
    )
    monkeypatch.setattr("jobctrl.infrastructure.setup_probes.probe_analysis_setup", lambda: [])
    monkeypatch.setattr(
        "jobctrl.infrastructure.setup_probes.resolve_claude_apply_binary",
        lambda: "missing-claude",
    )
    monkeypatch.setattr(
        "jobctrl.infrastructure.scoring.criteria_provider.read_apply_approval_required",
        lambda **_kwargs: True,
    )
    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.get_temporal_client",
        AsyncMock(side_effect=RuntimeError("synthetic Temporal unavailable")),
    )
    monkeypatch.setattr("jobctrl.infrastructure.observability.langfuse_disabled", lambda: True)
    monkeypatch.setattr("jobctrl.cli.httpx.head", lambda *_args, **_kwargs: pytest.fail("network probe"))
    monkeypatch.setattr("jobctrl.cli.politeness_doctor_notices", lambda *_args: [])
    monkeypatch.setattr("jobctrl.cli.llm_budget_doctor_notices", lambda: [])
    monkeypatch.setattr("jobctrl.database.get_connection", lambda: None)
    monkeypatch.setattr(shutil, "which", lambda _name: None)


def _write_bundled_capability_policy(payload: Path) -> None:
    source = Path(__file__).parents[3] / "packaging/distribution/capability-policy.json"
    destination = payload / "release/capability-policy.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")


def test_doctor_reports_playwright_chromium_available(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        _CHECK_TARGET,
        lambda: (True, "Playwright Chromium available at /opt/ms-playwright/chrome"),
    )

    result = CliRunner().invoke(app, ["doctor"])

    assert result.exit_code == 0, result.output
    normalized = " ".join(result.output.split())
    assert _CHECK_LABEL in normalized
    assert "Playwright Chromium available at" in normalized


def test_doctor_reports_playwright_chromium_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        _CHECK_TARGET,
        lambda: (False, "Playwright Chromium binary is missing at /nope"),
    )

    result = CliRunner().invoke(app, ["doctor"])

    # Doctor is diagnostic; it reports MISSING but still exits 0.
    assert result.exit_code == 0, result.output
    normalized = " ".join(result.output.split())
    assert _CHECK_LABEL in normalized
    assert "MISSING" in normalized


def test_doctor_reports_disabled_optional_browsers_without_probing_system_chrome(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from jobctrl import config

    monkeypatch.setattr(_CHECK_TARGET, lambda: (True, "managed Chromium"))
    monkeypatch.setattr(
        config,
        "get_chrome_path",
        lambda: (_ for _ in ()).throw(AssertionError("system Chrome must not be probed")),
    )

    result = CliRunner().invoke(app, ["doctor"])

    assert result.exit_code == 0, result.output
    normalized = " ".join(result.output.split())
    assert "auto-apply-browser capability" in normalized
    assert "authenticated-linkedin-browser capability" in normalized
    assert "DISABLED" in normalized
    assert "Chrome/Chromium" not in normalized


def test_bundled_doctor_uses_embedded_playwright_mcp_without_system_npx(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    payload = tmp_path / "payload"
    _write_bundled_capability_policy(payload)
    wrapper = payload / "playwright-mcp/bin/playwright-mcp"
    wrapper.parent.mkdir(parents=True)
    wrapper.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    wrapper.chmod(0o755)
    monkeypatch.setenv("JOBCTRL_RUNTIME_MODE", "bundled")
    monkeypatch.setenv("JOBCTRL_PAYLOAD_DIR", str(payload))
    monkeypatch.setattr("jobctrl.config.load_env", lambda: None)
    real_which = shutil.which
    monkeypatch.setattr(
        shutil,
        "which",
        lambda name: None if name == "npx" else real_which(name),
    )

    result = CliRunner().invoke(app, ["doctor"])

    assert result.exit_code == 0, result.output
    normalized = " ".join(result.output.split())
    assert "Playwright MCP runtime" in normalized
    assert "playwright-mcp" in normalized
    assert "Node.js (npx)" not in normalized


def test_source_doctor_missing_npx_recommends_supported_node(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("JOBCTRL_RUNTIME_MODE", "source")

    result = CliRunner().invoke(app, ["doctor"])

    assert result.exit_code == 0, result.output
    normalized = " ".join(result.output.split())
    assert "Node.js (npx) MISSING Install Node.js 22.13+" in normalized
    assert "Node.js 18+" not in normalized


def test_bundled_doctor_rejects_non_executable_playwright_mcp_wrapper(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    payload = tmp_path / "payload"
    _write_bundled_capability_policy(payload)
    wrapper = payload / "playwright-mcp/bin/playwright-mcp"
    wrapper.parent.mkdir(parents=True)
    wrapper.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    wrapper.chmod(0o644)
    monkeypatch.setenv("JOBCTRL_RUNTIME_MODE", "bundled")
    monkeypatch.setenv("JOBCTRL_PAYLOAD_DIR", str(payload))
    monkeypatch.setattr("jobctrl.config.load_env", lambda: None)

    result = CliRunner().invoke(app, ["doctor"])

    assert result.exit_code == 0, result.output
    normalized = " ".join(result.output.split())
    assert "Playwright MCP runtime" in normalized
    assert "MISSING" in normalized
    assert "not executable" in normalized
