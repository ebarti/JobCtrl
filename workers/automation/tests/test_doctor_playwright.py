"""Doctor surfaces Playwright Chromium checks.

Scraping and resume PDF rendering both use Chromium, so ``doctor`` must report
the browser. These tests monkeypatch the shared preflight helper so no real
browser is required.
"""

from __future__ import annotations

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
