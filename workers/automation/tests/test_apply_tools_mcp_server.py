"""Owned apply-tools MCP server behavior."""

from __future__ import annotations

import json
import sqlite3

from jobhunter.infrastructure.apply_tools.mcp_server import (
    ApplyToolsMcpServer,
    _profile_credential,
)


def _call(server: ApplyToolsMcpServer, name: str, arguments: dict) -> dict:
    return server.handle_json(
        json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            }
        )
    )


def test_upload_artifact_resolves_reviewed_resume_without_model_path(tmp_path):
    upload_dir = tmp_path / "upload"
    upload_dir.mkdir()
    resume = upload_dir / "Candidate_Resume.pdf"
    resume.write_bytes(b"%PDF")
    uploaded: list[tuple[str, str]] = []
    server = ApplyToolsMcpServer(
        upload_dir=upload_dir,
        cdp_endpoint="http://localhost:9222",
        uploader=lambda endpoint, path: uploaded.append((endpoint, path.name)),
    )

    response = _call(server, "upload_artifact", {"kind": "resume"})

    assert uploaded == [("http://localhost:9222", "Candidate_Resume.pdf")]
    payload = json.loads(response["result"]["content"][0]["text"])
    assert payload == {
        "ok": True,
        "kind": "resume",
        "filename": "Candidate_Resume.pdf",
    }


def test_upload_artifact_refuses_unknown_kind(tmp_path):
    server = ApplyToolsMcpServer(
        upload_dir=tmp_path,
        cdp_endpoint="http://localhost:9222",
        uploader=lambda _endpoint, _path: None,
    )

    response = _call(server, "upload_artifact", {"kind": "secrets"})

    assert response["error"]["code"] == -32000
    assert "kind must be resume or cover_letter" in response["error"]["message"]


def test_upload_artifact_refuses_missing_run_artifact(tmp_path):
    server = ApplyToolsMcpServer(
        upload_dir=tmp_path,
        cdp_endpoint="http://localhost:9222",
        uploader=lambda _endpoint, _path: None,
    )

    response = _call(server, "upload_artifact", {"kind": "resume"})

    assert response["error"]["code"] == -32000
    assert "no reviewed resume artifact" in response["error"]["message"]


def test_type_credential_types_resolved_password_without_returning_secret(tmp_path):
    typed: list[tuple[str, str]] = []
    server = ApplyToolsMcpServer(
        upload_dir=tmp_path,
        cdp_endpoint="http://localhost:9222",
        credential_resolver=lambda kind: "SyntheticPasswordNeverReturned" if kind == "job_site_password" else "",
        credential_typer=lambda endpoint, credential: typed.append((endpoint, credential)),
    )

    response = _call(server, "type_credential", {"kind": "job_site_password"})

    assert typed == [("http://localhost:9222", "SyntheticPasswordNeverReturned")]
    text = response["result"]["content"][0]["text"]
    assert "SyntheticPasswordNeverReturned" not in text
    assert json.loads(text) == {
        "ok": True,
        "kind": "job_site_password",
        "typed": True,
    }


def test_type_credential_resolves_password_from_profile_db(monkeypatch, tmp_path):
    db_path = tmp_path / "profile.db"
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            CREATE TABLE candidate_profiles (
              tenant_id TEXT NOT NULL,
              profile_id TEXT NOT NULL,
              personal_password TEXT NOT NULL DEFAULT '',
              PRIMARY KEY (tenant_id, profile_id)
            )
            """
        )
        conn.execute(
            "INSERT INTO candidate_profiles (tenant_id, profile_id, personal_password) VALUES ('local', 'default', ?)",
            ("SyntheticProfilePassword",),
        )
        conn.commit()
    finally:
        conn.close()
    monkeypatch.setenv("JOBHUNTER_APPLY_PROFILE_DB_PATH", str(db_path))

    assert _profile_credential("job_site_password") == "SyntheticProfilePassword"


def test_type_credential_refuses_missing_profile_db(monkeypatch, tmp_path):
    monkeypatch.setenv("JOBHUNTER_APPLY_PROFILE_DB_PATH", str(tmp_path / "missing.db"))

    response = _call(
        ApplyToolsMcpServer(cdp_endpoint="http://localhost:9222"),
        "type_credential",
        {"kind": "job_site_password"},
    )

    assert response["error"]["code"] == -32000
    assert "job-site password credential is not configured" in response["error"]["message"]


def test_type_credential_refuses_unknown_kind(tmp_path):
    server = ApplyToolsMcpServer(
        upload_dir=tmp_path,
        cdp_endpoint="http://localhost:9222",
        credential_typer=lambda _endpoint, _credential: None,
    )

    response = _call(server, "type_credential", {"kind": "api_key"})

    assert response["error"]["code"] == -32000
    assert "kind must be job_site_password" in response["error"]["message"]


def test_apply_tools_mcp_lists_owned_tools(tmp_path):
    server = ApplyToolsMcpServer(upload_dir=tmp_path, cdp_endpoint="http://localhost:9222")

    response = server.handle_json(
        json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    )

    assert {tool["name"] for tool in response["result"]["tools"]} == {
        "type_credential",
        "upload_artifact",
    }
