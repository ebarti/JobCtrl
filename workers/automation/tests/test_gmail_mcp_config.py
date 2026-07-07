"""Gmail auth-path configuration for auto-apply verification codes."""

from __future__ import annotations

import json
from pathlib import Path

from jobctrl import config


def test_gmail_mcp_auth_status_reports_authenticated_credentials(
    monkeypatch, tmp_path
) -> None:
    creds = tmp_path / "credentials.json"
    creds.write_text(
        json.dumps(
            {
                "scope": "https://www.googleapis.com/auth/gmail.readonly "
                "https://www.googleapis.com/auth/gmail.send"
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("GMAIL_MCP_CREDENTIALS_PATH", str(creds))
    monkeypatch.setenv("GMAIL_MCP_OAUTH_KEYS_PATH", str(tmp_path / "missing.json"))
    monkeypatch.setattr(config, "load_env", lambda: None)

    ok, note = config.gmail_mcp_auth_status()

    assert ok is True
    assert str(creds) in note


def test_gmail_mcp_auth_status_requires_send_scope(monkeypatch, tmp_path) -> None:
    creds = tmp_path / "credentials.json"
    creds.write_text(json.dumps({"scope": "https://www.googleapis.com/auth/gmail.readonly"}), encoding="utf-8")
    monkeypatch.setenv("GMAIL_MCP_CREDENTIALS_PATH", str(creds))
    monkeypatch.setenv("GMAIL_MCP_OAUTH_KEYS_PATH", str(tmp_path / "missing.json"))
    monkeypatch.setattr(config, "load_env", lambda: None)

    ok, note = config.gmail_mcp_auth_status()

    assert ok is False
    assert "missing gmail.send scope" in note


def test_gmail_mcp_auth_status_points_to_auth_command_when_keys_exist(
    monkeypatch, tmp_path
) -> None:
    oauth_keys = tmp_path / "oauth-client.json"
    oauth_keys.write_text(
        json.dumps(
            {
                "installed": {
                    "client_id": "client",
                    "client_secret": "secret",
                    "redirect_uris": ["http://127.0.0.1"],
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("GMAIL_MCP_CREDENTIALS_PATH", str(tmp_path / "missing.json"))
    monkeypatch.setenv("GMAIL_MCP_OAUTH_KEYS_PATH", str(oauth_keys))
    monkeypatch.setattr(config, "load_env", lambda: None)

    ok, note = config.gmail_mcp_auth_status()

    assert ok is False
    assert "jobctrl gmail-auth" in note


def test_gmail_mcp_auth_status_reports_web_redirect_mismatch(
    monkeypatch, tmp_path
) -> None:
    oauth_keys = tmp_path / "oauth-client.json"
    oauth_keys.write_text(
        json.dumps(
            {
                "web": {
                    "client_id": "client",
                    "client_secret": "secret",
                    "redirect_uris": ["https://vertexaisearch.cloud.google.com/oauth-redirect"],
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("GMAIL_MCP_CREDENTIALS_PATH", str(tmp_path / "missing.json"))
    monkeypatch.setenv("GMAIL_MCP_OAUTH_KEYS_PATH", str(oauth_keys))
    monkeypatch.setattr(config, "load_env", lambda: None)

    ok, note = config.gmail_mcp_auth_status()

    assert ok is False
    assert "no local redirect URI" in note


def test_gmail_mcp_auth_status_reports_missing_oauth_keys(
    monkeypatch, tmp_path
) -> None:
    mcp_dir = tmp_path / "gmail"
    monkeypatch.delenv("GMAIL_MCP_CREDENTIALS_PATH", raising=False)
    monkeypatch.delenv("GMAIL_MCP_OAUTH_KEYS_PATH", raising=False)
    monkeypatch.setenv("JOBCTRL_GMAIL_DIR", str(mcp_dir))
    monkeypatch.setattr(config, "load_env", lambda: None)

    ok, note = config.gmail_mcp_auth_status()

    assert ok is False
    assert "missing OAuth client" in note
    assert str(Path(mcp_dir) / "oauth-client.json") in note
