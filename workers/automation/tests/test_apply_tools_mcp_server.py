"""Owned apply-tools MCP server behavior."""

from __future__ import annotations

import json
import sqlite3
import sys
from types import SimpleNamespace

from jobctrl.infrastructure.apply_tools.mcp_server import (
    ApplyToolsMcpServer,
    CaptchaChallenge,
    CaptchaSolveResult,
    _captcha_api_key,
    _upload_file_to_current_input,
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
    uploaded: list[tuple[str, str, str]] = []
    server = ApplyToolsMcpServer(
        upload_dir=upload_dir,
        cdp_endpoint="http://localhost:9222",
        approved_application_url="https://apply.example.com/job",
        uploader=lambda endpoint, path, approved_url: (
            uploaded.append((endpoint, path.name, approved_url)) or {"destination_url": "https://apply.example.com/job"}
        ),
    )

    response = _call(server, "upload_artifact", {"kind": "resume"})

    assert uploaded == [
        (
            "http://localhost:9222",
            "Candidate_Resume.pdf",
            "https://apply.example.com/job",
        )
    ]
    payload = json.loads(response["result"]["content"][0]["text"])
    assert payload == {
        "ok": True,
        "kind": "resume",
        "filename": "Candidate_Resume.pdf",
        "destination_url": "https://apply.example.com/job",
    }
    audit_event = json.loads((upload_dir / "artifact_upload_events.jsonl").read_text(encoding="utf-8"))
    assert audit_event["event_type"] == "ApplyArtifactUpload"
    assert audit_event["payload"] == {
        "kind": "resume",
        "filename": "Candidate_Resume.pdf",
        "destination_url": "https://apply.example.com/job",
    }


def test_upload_artifact_refuses_missing_approved_application_url(tmp_path):
    resume = tmp_path / "Candidate_Resume.pdf"
    resume.write_bytes(b"%PDF")
    uploaded: list[str] = []
    server = ApplyToolsMcpServer(
        upload_dir=tmp_path,
        cdp_endpoint="http://localhost:9222",
        uploader=lambda _endpoint, path, _approved_url: uploaded.append(path.name),
    )

    response = _call(server, "upload_artifact", {"kind": "resume"})

    assert uploaded == []
    assert response["error"]["code"] == -32000
    assert "approved application URL is not configured" in response["error"]["message"]


def test_upload_artifact_refuses_unknown_kind(tmp_path):
    server = ApplyToolsMcpServer(
        upload_dir=tmp_path,
        cdp_endpoint="http://localhost:9222",
        approved_application_url="https://apply.example.com/job",
        uploader=lambda _endpoint, _path, _approved_url: None,
    )

    response = _call(server, "upload_artifact", {"kind": "secrets"})

    assert response["error"]["code"] == -32000
    assert "kind must be resume or cover_letter" in response["error"]["message"]


def test_upload_artifact_refuses_missing_run_artifact(tmp_path):
    server = ApplyToolsMcpServer(
        upload_dir=tmp_path,
        cdp_endpoint="http://localhost:9222",
        approved_application_url="https://apply.example.com/job",
        uploader=lambda _endpoint, _path, _approved_url: None,
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


class _FakeHttpResponse:
    def __init__(self, payload):
        self._payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return None

    def read(self):
        return json.dumps(self._payload).encode("utf-8")


class _FakeWebSocket:
    def __init__(self, responses):
        self._responses = list(responses)
        self.sent: list[dict] = []
        self.closed = False

    def send(self, payload):
        self.sent.append(json.loads(payload))

    def recv(self):
        assert self._responses
        return json.dumps(self._responses.pop(0))

    def close(self):
        self.closed = True


def test_upload_file_to_current_input_refuses_cross_origin_page(monkeypatch, tmp_path):
    artifact = tmp_path / "Candidate_Resume.pdf"
    artifact.write_bytes(b"%PDF")
    fake_ws = _FakeWebSocket(
        [
            {"id": 1, "result": {}},
            {
                "id": 2,
                "result": {
                    "result": {
                        "value": {
                            "ok": True,
                            "href": "https://attacker.example/upload",
                        }
                    }
                },
            },
            {"id": 3, "result": {"result": {"value": True}}},
        ]
    )
    monkeypatch.setattr(
        "jobctrl.infrastructure.apply_tools.mcp_server.urlopen",
        lambda *_args, **_kwargs: _FakeHttpResponse(
            [
                {
                    "type": "page",
                    "url": "https://attacker.example/upload",
                    "webSocketDebuggerUrl": "ws://localhost/devtools/page/1",
                }
            ]
        ),
    )
    monkeypatch.setitem(
        sys.modules,
        "websocket",
        SimpleNamespace(create_connection=lambda *_args, **_kwargs: fake_ws),
    )

    try:
        _upload_file_to_current_input(
            "http://localhost:9222",
            artifact,
            "https://apply.example.com/job",
        )
    except RuntimeError as exc:
        assert "approved application origin" in str(exc)
    else:  # pragma: no cover - explicit assertion branch
        raise AssertionError("cross-origin upload destination was accepted")

    assert fake_ws.closed is True
    assert not any(message.get("method") == "DOM.setFileInputFiles" for message in fake_ws.sent)


def test_upload_file_to_current_input_uploads_visible_same_origin_input(monkeypatch, tmp_path):
    artifact = tmp_path / "Candidate_Resume.pdf"
    artifact.write_bytes(b"%PDF")
    fake_ws = _FakeWebSocket(
        [
            {"id": 1, "result": {}},
            {
                "id": 2,
                "result": {
                    "result": {
                        "value": {
                            "ok": True,
                            "href": "https://apply.example.com/job/form",
                        }
                    }
                },
            },
            {"id": 3, "result": {"root": {"nodeId": 1}}},
            {"id": 4, "result": {"nodeId": 7}},
            {"id": 5, "result": {}},
            {"id": 6, "result": {"result": {"value": True}}},
        ]
    )
    monkeypatch.setattr(
        "jobctrl.infrastructure.apply_tools.mcp_server.urlopen",
        lambda *_args, **_kwargs: _FakeHttpResponse(
            [
                {
                    "type": "page",
                    "url": "https://apply.example.com/job/form",
                    "webSocketDebuggerUrl": "ws://localhost/devtools/page/1",
                }
            ]
        ),
    )
    monkeypatch.setitem(
        sys.modules,
        "websocket",
        SimpleNamespace(create_connection=lambda *_args, **_kwargs: fake_ws),
    )

    result = _upload_file_to_current_input(
        "http://localhost:9222",
        artifact,
        "https://apply.example.com/job",
    )

    assert result == {"destination_url": "https://apply.example.com/job/form"}
    set_files = [message for message in fake_ws.sent if message.get("method") == "DOM.setFileInputFiles"]
    assert len(set_files) == 1
    assert set_files[0]["params"]["nodeId"] == 7
    assert set_files[0]["params"]["files"] == [str(artifact)]


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
    monkeypatch.setenv("JOBCTRL_APPLY_PROFILE_DB_PATH", str(db_path))

    assert _profile_credential("job_site_password") == "SyntheticProfilePassword"


def test_type_credential_refuses_missing_profile_db(monkeypatch, tmp_path):
    monkeypatch.setenv("JOBCTRL_APPLY_PROFILE_DB_PATH", str(tmp_path / "missing.db"))

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


def test_solve_captcha_uses_owned_solver_without_returning_secret(tmp_path):
    challenge = CaptchaChallenge(
        kind="hcaptcha",
        sitekey="site-key",
        page_url="https://example.com/apply",
    )
    calls: list[tuple[str, CaptchaChallenge]] = []
    injected: list[tuple[str, str]] = []
    server = ApplyToolsMcpServer(
        upload_dir=tmp_path,
        cdp_endpoint="http://localhost:9222",
        captcha_key_resolver=lambda: "capsolver-secret-never-returned",
        captcha_solver=lambda api_key, detected: (
            calls.append((api_key, detected))
            or CaptchaSolveResult(
                token="solver-token",
                kind=detected.kind,
                elapsed_s=1.25,
                cost_usd=0.002,
            )
        ),
        captcha_injector=lambda _endpoint, _challenge, token: injected.append((_challenge.kind, token)),
    )

    response = _call(
        server,
        "solve_captcha",
        {
            "kind": "hcaptcha",
            "sitekey": "site-key",
            "page_url": "https://example.com/apply",
        },
    )

    assert calls == [("capsolver-secret-never-returned", challenge)]
    assert injected == [("hcaptcha", "solver-token")]
    text = response["result"]["content"][0]["text"]
    assert "capsolver-secret-never-returned" not in text
    assert "solver-token" not in text
    assert json.loads(text) == {
        "cost_usd": 0.002,
        "elapsed_s": 1.25,
        "kind": "hcaptcha",
        "solved": True,
    }
    usage_events = (tmp_path / "captcha_solve_events.jsonl").read_text(encoding="utf-8")
    assert "solver-token" not in usage_events
    assert "capsolver-secret-never-returned" not in usage_events
    assert json.loads(usage_events)["event_type"] == "CaptchaSolveCompleted"


def test_solve_captcha_fails_closed_without_solver_key(tmp_path):
    server = ApplyToolsMcpServer(
        cdp_endpoint="http://localhost:9222",
        captcha_key_resolver=lambda: "",
    )

    response = _call(
        server,
        "solve_captcha",
        {
            "kind": "hcaptcha",
            "sitekey": "site-key",
            "page_url": "https://example.com/apply",
        },
    )

    assert response["error"]["code"] == -32000
    assert "CAPTCHA solver is not configured" in response["error"]["message"]


def test_captcha_key_resolves_from_server_env(monkeypatch):
    monkeypatch.delenv("CAPSOLVER_API_KEY", raising=False)
    assert _captcha_api_key() == ""
    monkeypatch.setenv("CAPSOLVER_API_KEY", "capsolver-from-server-env")

    assert _captcha_api_key() == "capsolver-from-server-env"


def test_apply_tools_mcp_omits_captcha_tool_when_key_absent(tmp_path):
    server = ApplyToolsMcpServer(
        upload_dir=tmp_path,
        cdp_endpoint="http://localhost:9222",
        captcha_key_resolver=lambda: "",
    )

    response = server.handle_json(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}))

    assert {tool["name"] for tool in response["result"]["tools"]} == {
        "type_credential",
        "upload_artifact",
    }


def test_apply_tools_mcp_lists_captcha_tool_when_key_present(tmp_path):
    server = ApplyToolsMcpServer(
        upload_dir=tmp_path,
        cdp_endpoint="http://localhost:9222",
        captcha_key_resolver=lambda: "configured-key",
    )

    response = server.handle_json(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}))

    tools = {tool["name"]: tool for tool in response["result"]["tools"]}
    assert set(tools) == {"solve_captcha", "type_credential", "upload_artifact"}
    solve_schema = tools["solve_captcha"]["inputSchema"]
    assert solve_schema["required"] == ["kind", "sitekey", "page_url"]
