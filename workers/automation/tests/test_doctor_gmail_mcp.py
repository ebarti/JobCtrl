"""Tests for the Gmail connector auth row in ``jobhunter doctor``."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

from typer.testing import CliRunner

from jobhunter.cli import app
from jobhunter.domain.profile.aggregate import Profile
from jobhunter.domain.tenant import LOCAL_TENANT
from tests.test_profile_aggregate import _valid_profile_dict


def test_doctor_reports_gmail_mcp_auth_warning(monkeypatch) -> None:
    monkeypatch.setattr("jobhunter.config.load_env", lambda: None)
    monkeypatch.setattr(
        "jobhunter.config.gmail_mcp_auth_status",
        lambda: (False, "missing OAuth client at /tmp/.jobhunter/gmail/oauth-client.json"),
    )

    with patch(
        "jobhunter.infrastructure.temporal.client.Client.connect",
        new=AsyncMock(side_effect=RuntimeError("connection refused")),
    ):
        result = CliRunner().invoke(app, ["doctor"])

    assert result.exit_code == 0, result.output
    assert "Gmail connector auth" in result.output
    assert "email verification will stop" in result.output
    assert "login_issue" in result.output


def test_doctor_reports_gmail_mcp_authenticated(monkeypatch, tmp_path) -> None:
    credentials = tmp_path / "credentials.json"
    monkeypatch.setattr("jobhunter.config.load_env", lambda: None)
    monkeypatch.setattr(
        "jobhunter.config.gmail_mcp_auth_status",
        lambda: (True, f"authenticated with {credentials}"),
    )

    with patch(
        "jobhunter.infrastructure.temporal.client.Client.connect",
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

    monkeypatch.setattr("jobhunter.config.load_env", lambda: None)
    monkeypatch.setattr("jobhunter.infrastructure.profile.get_profile_repository", lambda: Repo())

    with patch(
        "jobhunter.infrastructure.temporal.client.Client.connect",
        new=AsyncMock(side_effect=RuntimeError("connection refused")),
    ):
        result = CliRunner().invoke(app, ["doctor"])

    assert result.exit_code == 0, result.output
    assert "application attestations" in result.output
    assert "WARN" in result.output
    assert "incomplete" in result.output
    assert "screening questions" in result.output


def test_doctor_reports_owned_captcha_solver_when_configured(monkeypatch) -> None:
    monkeypatch.setattr("jobhunter.config.load_env", lambda: None)
    monkeypatch.setenv("CAPSOLVER_API_KEY", "test-capsolver-key")

    with patch(
        "jobhunter.infrastructure.temporal.client.Client.connect",
        new=AsyncMock(side_effect=RuntimeError("connection refused")),
    ):
        result = CliRunner().invoke(app, ["doctor"])

    assert result.exit_code == 0, result.output
    assert "CapSolver API key" in result.output
    assert "owned solve_captcha tool" in result.output
