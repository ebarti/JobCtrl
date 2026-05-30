"""Tests for the Gmail MCP auth row in ``jobhunter doctor``."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

from typer.testing import CliRunner

from jobhunter.cli import app


def test_doctor_reports_gmail_mcp_auth_warning(monkeypatch) -> None:
    monkeypatch.setattr("jobhunter.config.load_env", lambda: None)
    monkeypatch.setattr(
        "jobhunter.config.gmail_mcp_auth_status",
        lambda: (False, "missing OAuth keys at /tmp/.gmail-mcp/gcp-oauth.keys.json"),
    )

    with patch(
        "jobhunter.infrastructure.temporal.client.Client.connect",
        new=AsyncMock(side_effect=RuntimeError("connection refused")),
    ):
        result = CliRunner().invoke(app, ["doctor"])

    assert result.exit_code == 0, result.output
    assert "Gmail MCP auth" in result.output
    assert "email verification will stop as login_issue" in result.output


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
    assert "Gmail MCP auth" in result.output
    assert "authenticated with" in result.output
