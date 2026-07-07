"""setup/doctor surface the always-required Claude synthesis auth.

Every employer-analysis run reconciles its legs with the Claude Agent SDK
(``ClaudeAnalysisSynthesizer``) regardless of ``JOBCTRL_ANALYSIS_LEGS``. These
tests drive the CLI surfaces with a faked synthesis-auth probe — no real vendor
CLI or network — and assert the user-facing readiness signals.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from typer.testing import CliRunner

from jobctrl.cli import app
from jobctrl.infrastructure import setup_probes

_SETUP_ARGS = [
    "setup",
    "--skip-system",
    "--skip-dependencies",
    "--skip-browsers",
    "--skip-doctor",
    "--non-interactive",
    "--dry-run",
]


def _fake_synthesis(ok: bool):
    note = (
        "ANTHROPIC_API_KEY"
        if ok
        else (
            "required for ensemble synthesis even when the claude leg is disabled; "
            "set ANTHROPIC_API_KEY or enroll local Claude credentials"
        )
    )
    return lambda env=None: setup_probes.ProbeResult("Claude synthesis auth", ok, note)


def test_setup_warns_analysis_not_ready_without_synthesis_auth(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("JOBCTRL_ANALYSIS_LEGS", "codex,antigravity")
    monkeypatch.setattr(setup_probes, "probe_claude_synthesis_auth", _fake_synthesis(False))

    result = CliRunner().invoke(app, _SETUP_ARGS)

    assert result.exit_code == 0, result.output
    text = " ".join(result.output.split())
    assert "Employer analysis is NOT ready" in text
    assert "synthesis" in text.lower()


def test_setup_reports_ready_with_synthesis_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JOBCTRL_ANALYSIS_LEGS", "codex,antigravity")
    monkeypatch.setattr(setup_probes, "probe_claude_synthesis_auth", _fake_synthesis(True))

    result = CliRunner().invoke(app, _SETUP_ARGS)

    assert result.exit_code == 0, result.output
    text = " ".join(result.output.split())
    assert "Employer analysis is NOT ready" not in text
    assert "synthesis auth ready" in text.lower()


def test_doctor_shows_red_synthesis_auth_when_claude_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("JOBCTRL_ANALYSIS_LEGS", "codex,antigravity")
    monkeypatch.setenv("COLUMNS", "220")  # keep the row on one line for the assert
    monkeypatch.setattr(setup_probes, "probe_claude_synthesis_auth", _fake_synthesis(False))

    with patch(
        "jobctrl.infrastructure.temporal.client.Client.connect",
        new=AsyncMock(side_effect=RuntimeError("connection refused")),
    ):
        result = CliRunner().invoke(app, ["doctor"])

    assert result.exit_code == 0, result.output
    text = " ".join(result.output.split())
    # doctor renders a not-ok probe as red MISSING; the synthesis line must be it.
    assert "Claude synthesis auth MISSING" in text
