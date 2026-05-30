"""Gmail MCP auth-path configuration for auto-apply verification codes."""

from __future__ import annotations

from pathlib import Path

from jobhunter import config


def test_gmail_mcp_auth_status_reports_authenticated_credentials(
    monkeypatch, tmp_path
) -> None:
    creds = tmp_path / "credentials.json"
    creds.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("GMAIL_MCP_CREDENTIALS_PATH", str(creds))
    monkeypatch.setenv("GMAIL_MCP_OAUTH_KEYS_PATH", str(tmp_path / "missing.json"))
    monkeypatch.setattr(config, "load_env", lambda: None)

    ok, note = config.gmail_mcp_auth_status()

    assert ok is True
    assert str(creds) in note


def test_gmail_mcp_auth_status_points_to_auth_command_when_keys_exist(
    monkeypatch, tmp_path
) -> None:
    oauth_keys = tmp_path / "gcp-oauth.keys.json"
    oauth_keys.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("GMAIL_MCP_CREDENTIALS_PATH", str(tmp_path / "missing.json"))
    monkeypatch.setenv("GMAIL_MCP_OAUTH_KEYS_PATH", str(oauth_keys))
    monkeypatch.setattr(config, "load_env", lambda: None)

    ok, note = config.gmail_mcp_auth_status()

    assert ok is False
    assert "server-gmail-autoauth-mcp auth" in note


def test_gmail_mcp_auth_status_reports_missing_oauth_keys(
    monkeypatch, tmp_path
) -> None:
    mcp_dir = tmp_path / ".gmail-mcp"
    monkeypatch.delenv("GMAIL_MCP_CREDENTIALS_PATH", raising=False)
    monkeypatch.delenv("GMAIL_MCP_OAUTH_KEYS_PATH", raising=False)
    monkeypatch.setenv("GMAIL_MCP_DIR", str(mcp_dir))
    monkeypatch.setattr(config, "load_env", lambda: None)

    ok, note = config.gmail_mcp_auth_status()

    assert ok is False
    assert "missing OAuth keys" in note
    assert str(Path(mcp_dir) / "gcp-oauth.keys.json") in note
