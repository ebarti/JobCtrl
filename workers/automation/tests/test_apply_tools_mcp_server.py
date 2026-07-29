"""Owned apply-tools MCP server behavior."""

from __future__ import annotations

import json
import sqlite3
import sys
from types import SimpleNamespace

from jobctrl.infrastructure.apply_tools import mcp_server as apply_tools_mcp
from jobctrl.infrastructure.apply_tools.mcp_server import (
    ApplyToolsMcpServer,
    CaptchaChallenge,
    CaptchaSolveResult,
    _UploadDestinationRejected,
    _captcha_api_key,
    _upload_input_guard_expression,
    _upload_file_to_current_input,
    _profile_credential,
    _type_credential_into_active_field,
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


def test_upload_artifact_records_blocked_cross_origin_attempt(tmp_path):
    upload_dir = tmp_path / "upload"
    upload_dir.mkdir()
    resume = upload_dir / "Candidate_Resume.pdf"
    resume.write_bytes(b"%PDF")

    def rejected_upload(_endpoint, _path, approved_url):
        raise _UploadDestinationRejected(
            "current upload destination does not match the approved application origin",
            destination_url="https://attacker.example/upload",
            approved_application_url=approved_url,
        )

    server = ApplyToolsMcpServer(
        upload_dir=upload_dir,
        cdp_endpoint="http://localhost:9222",
        approved_application_url="https://apply.example.com/job",
        uploader=rejected_upload,
    )

    response = _call(server, "upload_artifact", {"kind": "resume"})

    assert response["error"]["code"] == -32000
    assert "approved application origin" in response["error"]["message"]
    audit_event = json.loads((upload_dir / "artifact_upload_events.jsonl").read_text(encoding="utf-8"))
    assert audit_event["event_type"] == "ApplyArtifactUpload"
    assert audit_event["payload"] == {
        "approved_origin": "https://apply.example.com:443",
        "destination_url": "https://attacker.example/upload",
        "filename": "Candidate_Resume.pdf",
        "kind": "resume",
        "reason": "current upload destination does not match the approved application origin",
        "status": "blocked",
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
    typed: list[tuple[str, str, tuple[str, ...]]] = []
    server = ApplyToolsMcpServer(
        upload_dir=tmp_path,
        cdp_endpoint="http://localhost:9222",
        credential_resolver=lambda kind: "SyntheticPasswordNeverReturned" if kind == "job_site_password" else "",
        credential_typer=lambda endpoint, credential, origins: typed.append(
            (endpoint, credential, origins)
        ),
        allowed_credential_origins=("https://apply.example.com",),
    )

    response = _call(server, "type_credential", {"kind": "job_site_password"})

    assert typed == [
        (
            "http://localhost:9222",
            "SyntheticPasswordNeverReturned",
            ("https://apply.example.com",),
        )
    ]
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
            {"id": 2, "result": {"result": {"objectId": "selection-1"}}},
            {
                "id": 3,
                "result": {
                    "result": [
                        {"name": "ok", "value": {"value": True}},
                        {"name": "href", "value": {"value": "https://attacker.example/upload"}},
                        {"name": "input", "value": {"objectId": "input-1"}},
                    ]
                },
            },
            {"id": 4, "result": {}},
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
            {"id": 2, "result": {"result": {"objectId": "selection-1"}}},
            {
                "id": 3,
                "result": {
                    "result": [
                        {"name": "ok", "value": {"value": True}},
                        {"name": "href", "value": {"value": "https://apply.example.com/job/form"}},
                        {"name": "input", "value": {"objectId": "input-1"}},
                    ]
                },
            },
            {
                "id": 4,
                "result": {
                    "result": {
                        "value": {
                            "ok": True,
                            "href": "https://apply.example.com/job/form",
                        }
                    }
                },
            },
            {"id": 5, "result": {"nodeId": 7}},
            {"id": 6, "result": {}},
            {"id": 7, "result": {}},
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


def test_upload_input_guard_allows_sole_hidden_enabled_file_input():
    expression = _upload_input_guard_expression()

    assert "visible.length === 1" in expression
    assert "} else if (inputs.length === 1) {" in expression
    assert "multiple file inputs are available" in expression
    assert "no visible file input is currently available" not in expression


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
        ApplyToolsMcpServer(
            cdp_endpoint="http://localhost:9222",
            allowed_credential_origins=("https://apply.example.com",),
        ),
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
        allowed_credential_origins=("https://apply.example.com",),
    )

    response = _call(server, "type_credential", {"kind": "api_key"})

    assert response["error"]["code"] == -32000
    assert "kind must be job_site_password" in response["error"]["message"]


def test_type_credential_fails_closed_without_origin_policy(tmp_path):
    resolved: list[str] = []
    server = ApplyToolsMcpServer(
        upload_dir=tmp_path,
        cdp_endpoint="http://localhost:9222",
        credential_resolver=lambda kind: resolved.append(kind) or "SyntheticPassword",
        credential_typer=lambda _endpoint, _credential, _origins: None,
    )

    response = _call(server, "type_credential", {"kind": "job_site_password"})

    assert resolved == []
    assert response["error"]["code"] == -32000
    assert "credential origin policy is not configured" in response["error"]["message"]


def test_type_credential_rejects_unapproved_page_origin(monkeypatch):
    ws = _FakeCdpWebSocket(
        origin="https://evil.example",
        field_ok=True,
    )
    _install_fake_cdp(monkeypatch, ws)

    try:
        _type_credential_into_active_field(
            "http://localhost:9222",
            "SyntheticPasswordNeverTyped",
            ("https://apply.example.com",),
        )
    except RuntimeError as exc:
        assert "stored credential is not approved for this page origin" in str(exc)
    else:
        raise AssertionError("credential typing should fail for mismatched origins")

    assert not any(message.get("method") == "Input.insertText" for message in ws.sent)


def test_type_credential_types_only_on_approved_page_origin(monkeypatch):
    ws = _FakeCdpWebSocket(
        origin="https://apply.example.com",
        field_ok=True,
    )
    _install_fake_cdp(monkeypatch, ws)

    _type_credential_into_active_field(
        "http://localhost:9222",
        "SyntheticPasswordTyped",
        ("https://apply.example.com",),
    )

    insert = [message for message in ws.sent if message.get("method") == "Input.insertText"]
    assert insert == [{"id": 2, "method": "Input.insertText", "params": {"text": "SyntheticPasswordTyped"}}]


def test_solve_captcha_uses_owned_solver_without_returning_secret(monkeypatch, tmp_path):
    challenge = CaptchaChallenge(
        kind="hcaptcha",
        sitekey="active-site-key",
        page_url="https://example.com/apply/form",
    )
    calls: list[tuple[str, CaptchaChallenge]] = []
    injected: list[tuple[str, str]] = []
    ws = _install_fake_captcha_cdp(
        monkeypatch,
        detection={
            "ok": True,
            "href": "https://example.com/apply/form",
            "sitekey": "active-site-key",
        },
    )
    server = ApplyToolsMcpServer(
        upload_dir=tmp_path,
        cdp_endpoint="http://localhost:9222",
        approved_application_url="https://example.com/apply",
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
        },
    )

    assert calls == [("capsolver-secret-never-returned", challenge)]
    assert injected == [("hcaptcha", "solver-token")]
    assert ws.closed is True
    text = response["result"]["content"][0]["text"]
    assert "capsolver-secret-never-returned" not in text
    assert "solver-token" not in text
    assert "active-site-key" not in text
    assert json.loads(text) == {
        "cost_usd": 0.002,
        "elapsed_s": 1.25,
        "kind": "hcaptcha",
        "solved": True,
    }
    usage_events = (tmp_path / "captcha_solve_events.jsonl").read_text(encoding="utf-8")
    assert "solver-token" not in usage_events
    assert "capsolver-secret-never-returned" not in usage_events
    assert "active-site-key" not in usage_events
    assert json.loads(usage_events)["event_type"] == "CaptchaSolveCompleted"


def test_solve_captcha_rejects_model_supplied_challenge_coordinates(tmp_path):
    calls: list[tuple[str, CaptchaChallenge]] = []
    injected: list[str] = []
    server = ApplyToolsMcpServer(
        upload_dir=tmp_path,
        cdp_endpoint="http://localhost:9222",
        approved_application_url="https://example.com/apply",
        captcha_key_resolver=lambda: "capsolver-secret",
        captcha_solver=lambda api_key, detected: calls.append((api_key, detected)),
        captcha_injector=lambda _endpoint, _challenge, token: injected.append(token),
    )

    response = _call(
        server,
        "solve_captcha",
        {
            "kind": "hcaptcha",
            "sitekey": "model-supplied-sitekey",
            "page_url": "https://attacker.example/apply",
        },
    )

    assert response["error"]["code"] == -32000
    assert "challenge coordinates are derived from the active page" in response["error"]["message"]
    assert calls == []
    assert injected == []
    assert not (tmp_path / "captcha_solve_events.jsonl").exists()


def test_solve_captcha_rejects_active_page_origin_mismatch(monkeypatch, tmp_path):
    calls: list[tuple[str, CaptchaChallenge]] = []
    injected: list[str] = []
    _install_fake_captcha_cdp(
        monkeypatch,
        detection={
            "ok": True,
            "href": "https://attacker.example/apply/form",
            "sitekey": "active-site-key",
        },
    )
    server = ApplyToolsMcpServer(
        upload_dir=tmp_path,
        cdp_endpoint="http://localhost:9222",
        approved_application_url="https://example.com/apply",
        captcha_key_resolver=lambda: "capsolver-secret",
        captcha_solver=lambda api_key, detected: calls.append((api_key, detected)),
        captcha_injector=lambda _endpoint, _challenge, token: injected.append(token),
    )

    response = _call(server, "solve_captcha", {"kind": "hcaptcha"})

    assert response["error"]["code"] == -32000
    assert "approved application origin" in response["error"]["message"]
    assert calls == []
    assert injected == []
    assert not (tmp_path / "captcha_solve_events.jsonl").exists()


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
        allowed_credential_origins=("https://apply.example.com",),
        captcha_key_resolver=lambda: "",
    )

    response = server.handle_json(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}))

    assert {tool["name"] for tool in response["result"]["tools"]} == {
        "type_credential",
        "upload_artifact",
    }


def test_apply_tools_mcp_omits_credential_tool_without_origin_policy(tmp_path):
    server = ApplyToolsMcpServer(
        upload_dir=tmp_path,
        cdp_endpoint="http://localhost:9222",
        captcha_key_resolver=lambda: "",
    )

    response = server.handle_json(
        json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    )

    assert {tool["name"] for tool in response["result"]["tools"]} == {
        "upload_artifact",
    }


def test_apply_tools_mcp_lists_captcha_tool_when_key_present(tmp_path):
    server = ApplyToolsMcpServer(
        upload_dir=tmp_path,
        cdp_endpoint="http://localhost:9222",
        allowed_credential_origins=("https://apply.example.com",),
        captcha_key_resolver=lambda: "configured-key",
    )

    response = server.handle_json(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}))

    tools = {tool["name"]: tool for tool in response["result"]["tools"]}
    assert set(tools) == {"solve_captcha", "type_credential", "upload_artifact"}
    solve_schema = tools["solve_captcha"]["inputSchema"]
    assert solve_schema["required"] == ["kind"]
    assert set(solve_schema["properties"]) == {"kind"}


class _FakeCdpResponse:
    def __enter__(self):
        return self

    def __exit__(self, *_exc_info):
        return None

    def read(self) -> bytes:
        return json.dumps(
            [
                {
                    "type": "page",
                    "webSocketDebuggerUrl": "ws://127.0.0.1/devtools/page/1",
                }
            ]
        ).encode("utf-8")


class _FakeCdpWebSocket:
    def __init__(self, *, origin: str, field_ok: bool) -> None:
        self._origin = origin
        self._field_ok = field_ok
        self.sent: list[dict] = []
        self._last_id = 0
        self.closed = False

    def send(self, payload: str) -> None:
        message = json.loads(payload)
        self.sent.append(message)
        self._last_id = int(message["id"])

    def recv(self) -> str:
        method = self.sent[-1]["method"]
        if method == "Runtime.evaluate":
            result = {"origin": self._origin, "fieldOk": self._field_ok}
        else:
            result = True
        return json.dumps(
            {
                "id": self._last_id,
                "result": {"result": {"value": result}},
            }
        )

    def close(self) -> None:
        self.closed = True


class _FakeCaptchaCdpWebSocket:
    def __init__(self, detection: dict) -> None:
        self._detection = detection
        self.sent: list[dict] = []
        self._last_id = 0
        self.closed = False

    def send(self, payload: str) -> None:
        message = json.loads(payload)
        self.sent.append(message)
        self._last_id = int(message["id"])

    def recv(self) -> str:
        return json.dumps(
            {
                "id": self._last_id,
                "result": {"result": {"value": self._detection}},
            }
        )

    def close(self) -> None:
        self.closed = True


def _install_fake_cdp(monkeypatch, ws: _FakeCdpWebSocket) -> None:
    monkeypatch.setattr(apply_tools_mcp, "urlopen", lambda _url, timeout: _FakeCdpResponse())
    monkeypatch.setitem(
        sys.modules,
        "websocket",
        SimpleNamespace(create_connection=lambda *_args, **_kwargs: ws),
    )


def _install_fake_captcha_cdp(monkeypatch, detection: dict) -> _FakeCaptchaCdpWebSocket:
    ws = _FakeCaptchaCdpWebSocket(detection)
    monkeypatch.setattr(apply_tools_mcp, "urlopen", lambda _url, timeout: _FakeCdpResponse())
    monkeypatch.setitem(
        sys.modules,
        "websocket",
        SimpleNamespace(create_connection=lambda *_args, **_kwargs: ws),
    )
    return ws
