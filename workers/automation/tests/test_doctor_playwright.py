"""Doctor surfaces an always-run Playwright Chromium check.

Scraping needs Chromium regardless of the resume renderer, so ``doctor`` must
report the browser even when the user opted into the LaTeX renderer. These
tests monkeypatch the shared preflight helper so no real browser is required.
"""

from __future__ import annotations

import pytest
from typer.testing import CliRunner

from jobhunter.cli import app

_CHECK_TARGET = "jobhunter.infrastructure.preflight.check_playwright_chromium"
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


def test_doctor_playwright_check_runs_under_latex_renderer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The scraping browser check runs even when the resume renderer is LaTeX."""
    monkeypatch.setenv("JOBHUNTER_RESUME_RENDERER", "latex_pdf")
    monkeypatch.setattr(
        _CHECK_TARGET,
        lambda: (True, "Playwright Chromium available at /opt/ms-playwright/chrome"),
    )

    result = CliRunner().invoke(app, ["doctor"])

    assert result.exit_code == 0, result.output
    normalized = " ".join(result.output.split())
    assert _CHECK_LABEL in normalized
