"""Tests for the Gmail connector auth row in ``jobctrl doctor``."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

from typer.testing import CliRunner

from jobctrl.cli import app
from jobctrl.domain.profile.aggregate import Profile
from jobctrl.domain.tenant import LOCAL_TENANT
from tests.test_profile_aggregate import _valid_profile_dict


def test_doctor_reports_gmail_mcp_auth_warning(monkeypatch) -> None:
    monkeypatch.setattr("jobctrl.config.load_env", lambda: None)
    monkeypatch.setattr(
        "jobctrl.config.gmail_mcp_auth_status",
        lambda: (False, "missing OAuth client at /tmp/.jobctrl/gmail/oauth-client.json"),
    )

    with patch(
        "jobctrl.infrastructure.temporal.client.Client.connect",
        new=AsyncMock(side_effect=RuntimeError("connection refused")),
    ):
        result = CliRunner().invoke(app, ["doctor"])

    assert result.exit_code == 0, result.output
    assert "Gmail connector auth" in result.output
    assert "email verification will stop" in result.output
    assert "login_issue" in result.output


def test_doctor_reports_gmail_mcp_authenticated(monkeypatch, tmp_path) -> None:
    credentials = tmp_path / "credentials.json"
    monkeypatch.setattr("jobctrl.config.load_env", lambda: None)
    monkeypatch.setattr(
        "jobctrl.config.gmail_mcp_auth_status",
        lambda: (True, f"authenticated with {credentials}"),
    )

    with patch(
        "jobctrl.infrastructure.temporal.client.Client.connect",
        new=AsyncMock(side_effect=RuntimeError("connection refused")),
    ):
        result = CliRunner().invoke(app, ["doctor"])

    assert result.exit_code == 0, result.output
    assert "Gmail connector auth" in result.output
    assert "authenticated with" in result.output


def test_doctor_warns_when_application_attestations_are_incomplete(monkeypatch) -> None:
    raw_profile = _valid_profile_dict()
    raw_profile["application_attestations"] = {
        "age_18_plus": None,
        "background_check_consent": True,
        "felony_conviction": None,
        "previously_worked_at_employer": None,
    }
    profile = Profile.from_dict(LOCAL_TENANT, raw_profile)

    class Repo:
        def load(self, _tenant_id):
            return profile

    monkeypatch.setattr("jobctrl.config.load_env", lambda: None)
    monkeypatch.setattr("jobctrl.infrastructure.profile.get_profile_repository", lambda: Repo())

    with patch(
        "jobctrl.infrastructure.temporal.client.Client.connect",
        new=AsyncMock(side_effect=RuntimeError("connection refused")),
    ):
        result = CliRunner().invoke(app, ["doctor"])

    assert result.exit_code == 0, result.output
    assert "application attestations" in result.output
    assert "WARN" in result.output
    assert "incomplete" in result.output
    assert "screening questions" in result.output


def test_doctor_reports_owned_captcha_solver_when_configured(monkeypatch) -> None:
    monkeypatch.setattr("jobctrl.config.load_env", lambda: None)
    monkeypatch.setenv("CAPSOLVER_API_KEY", "test-capsolver-key")

    with patch(
        "jobctrl.infrastructure.temporal.client.Client.connect",
        new=AsyncMock(side_effect=RuntimeError("connection refused")),
    ):
        result = CliRunner().invoke(app, ["doctor"])

    assert result.exit_code == 0, result.output
    assert "CapSolver API key" in result.output
    assert "owned solve_captcha tool" in " ".join(result.output.split())


def test_doctor_warns_when_apply_approval_gate_is_disabled(monkeypatch) -> None:
    monkeypatch.setattr("jobctrl.config.load_env", lambda: None)
    monkeypatch.setattr(
        "jobctrl.infrastructure.scoring.criteria_provider.read_apply_approval_required",
        lambda *, default: False,
    )

    with patch(
        "jobctrl.infrastructure.temporal.client.Client.connect",
        new=AsyncMock(side_effect=RuntimeError("connection refused")),
    ):
        result = CliRunner().invoke(app, ["doctor"])

    assert result.exit_code == 0, result.output
    assert "apply approval gate" in result.output
    assert "WARN" in result.output
    assert "disabled" in result.output
    # Rich may wrap the note between words at narrow test-terminal widths.
    assert "eligible live runs" in result.output
    assert "human review" in result.output
