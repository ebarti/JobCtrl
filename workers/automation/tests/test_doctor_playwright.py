"""Doctor surfaces Playwright Chromium checks.

Scraping and resume PDF rendering both use Chromium, so ``doctor`` must report
the browser. These tests monkeypatch the shared preflight helper so no real
browser is required.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from typer.testing import CliRunner

from jobctrl.cli import app

_CHECK_TARGET = "jobctrl.infrastructure.preflight.check_playwright_chromium"
_CHECK_LABEL = "playwright chromium (scraping + PDF)"


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


def test_bundled_doctor_uses_embedded_playwright_mcp_without_system_npx(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    payload = tmp_path / "payload"
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


def test_bundled_doctor_rejects_non_executable_playwright_mcp_wrapper(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    payload = tmp_path / "payload"
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
