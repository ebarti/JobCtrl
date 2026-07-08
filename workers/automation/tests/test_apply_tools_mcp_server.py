"""Owned apply-tools MCP server behavior."""

from __future__ import annotations

import json
from jobhunter.infrastructure.apply_tools.mcp_server import (
    ApplyToolsMcpServer,
    CaptchaChallenge,
    CaptchaSolveResult,
    _captcha_api_key,
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


def test_type_credential_is_not_advertised_or_callable(tmp_path):
    server = ApplyToolsMcpServer(
        upload_dir=tmp_path,
        cdp_endpoint="http://localhost:9222",
        captcha_key_resolver=lambda: "",
    )

    tools_response = server.handle_json(
        json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    )
    assert "type_credential" not in {
        tool["name"] for tool in tools_response["result"]["tools"]
    }

    response = _call(server, "type_credential", {"kind": "job_site_password"})

    assert response["error"]["code"] == -32000
    assert "Unknown apply tool: type_credential" in response["error"]["message"]


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
        captcha_solver=lambda api_key, detected: calls.append((api_key, detected))
        or CaptchaSolveResult(
            token="solver-token",
            kind=detected.kind,
            elapsed_s=1.25,
            cost_usd=0.002,
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
        captcha_key_resolver=lambda: "configured-key",
    )

    response = server.handle_json(
        json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    )

    tools = {tool["name"]: tool for tool in response["result"]["tools"]}
    assert set(tools) == {"solve_captcha", "upload_artifact"}
    solve_schema = tools["solve_captcha"]["inputSchema"]
    assert solve_schema["required"] == ["kind", "sitekey", "page_url"]
