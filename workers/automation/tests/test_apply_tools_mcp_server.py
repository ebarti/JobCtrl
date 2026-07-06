"""Owned apply-tools MCP server behavior."""

from __future__ import annotations

import json

from jobhunter.infrastructure.apply_tools.mcp_server import ApplyToolsMcpServer


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


def test_apply_tools_mcp_lists_only_owned_upload_tool(tmp_path):
    server = ApplyToolsMcpServer(upload_dir=tmp_path, cdp_endpoint="http://localhost:9222")

    response = server.handle_json(
        json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    )

    assert {tool["name"] for tool in response["result"]["tools"]} == {"upload_artifact"}
