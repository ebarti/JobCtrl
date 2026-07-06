"""Owned apply-run MCP tools for reviewed local artifacts."""

from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from urllib.request import urlopen

from jobhunter import __version__


def main() -> None:
    server = ApplyToolsMcpServer()
    for line in sys.stdin:
        if not line.strip():
            continue
        response = server.handle_json(line)
        if response is not None:
            sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
            sys.stdout.flush()


class ApplyToolsMcpServer:
    def __init__(
        self,
        *,
        upload_dir: str | os.PathLike[str] | None = None,
        cdp_endpoint: str | None = None,
        uploader: Any | None = None,
        credential_resolver: Any | None = None,
        credential_typer: Any | None = None,
    ) -> None:
        raw_upload_dir = upload_dir or os.environ.get("JOBHUNTER_APPLY_UPLOAD_DIR")
        self._upload_dir = Path(raw_upload_dir).expanduser() if raw_upload_dir else None
        self._cdp_endpoint = cdp_endpoint or os.environ.get("JOBHUNTER_APPLY_CDP_ENDPOINT", "")
        self._uploader = uploader or _upload_file_to_current_input
        self._credential_resolver = credential_resolver or _profile_credential
        self._credential_typer = credential_typer or _type_credential_into_active_field

    def handle_json(self, line: str) -> dict[str, Any] | None:
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            return _error(None, -32700, "Parse error")
        if not isinstance(request, dict):
            return _error(None, -32600, "Invalid Request")
        if "id" not in request:
            return None
        method = request.get("method")
        try:
            if method == "initialize":
                result = {
                    "protocolVersion": request.get("params", {}).get("protocolVersion", "2024-11-05"),
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "jobhunter-apply-tools", "version": __version__},
                }
            elif method == "tools/list":
                result = {"tools": _tools()}
            elif method == "tools/call":
                result = self._call_tool(request.get("params") or {})
            elif method in {"resources/list", "prompts/list"}:
                result = {"resources" if method == "resources/list" else "prompts": []}
            else:
                return _error(request.get("id"), -32601, f"Method not found: {method}")
            return {"jsonrpc": "2.0", "id": request.get("id"), "result": result}
        except Exception as exc:  # noqa: BLE001 - MCP returns tool errors as JSON-RPC errors
            return _error(request.get("id"), -32000, str(exc))

    def _call_tool(self, params: dict[str, Any]) -> dict[str, Any]:
        name = str(params.get("name") or "")
        args = params.get("arguments") or {}
        if name == "upload_artifact":
            return self._call_upload_artifact(args)
        if name == "type_credential":
            return self._call_type_credential(args)
        raise ValueError(f"Unknown apply tool: {name}")

    def _call_upload_artifact(self, args: dict[str, Any]) -> dict[str, Any]:
        kind = str(args.get("kind") or "")
        artifact = self._resolve_artifact(kind)
        self._uploader(self._cdp_endpoint, artifact)
        return {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(
                        {"ok": True, "kind": kind, "filename": artifact.name},
                        ensure_ascii=False,
                    ),
                }
            ]
        }

    def _call_type_credential(self, args: dict[str, Any]) -> dict[str, Any]:
        kind = str(args.get("kind") or "")
        credential = self._credential_resolver(kind)
        if not credential:
            raise ValueError(f"{kind or 'credential'} is not configured")
        self._credential_typer(self._cdp_endpoint, credential)
        return {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps({"ok": True, "kind": kind, "typed": True}),
                }
            ]
        }

    def _resolve_artifact(self, kind: str) -> Path:
        patterns = {
            "resume": ("*Resume.pdf",),
            "cover_letter": ("*Cover_Letter.pdf",),
        }
        if kind not in patterns:
            raise ValueError("upload_artifact kind must be resume or cover_letter")
        if self._upload_dir is None:
            raise ValueError("upload_artifact upload directory is not configured")
        root = self._upload_dir.resolve()
        candidates: list[Path] = []
        for pattern in patterns[kind]:
            candidates.extend(sorted(root.glob(pattern)))
        for candidate in candidates:
            resolved = candidate.resolve()
            if not resolved.is_file():
                continue
            try:
                resolved.relative_to(root)
            except ValueError as exc:
                raise ValueError("artifact path escaped the run upload directory") from exc
            return resolved
        raise ValueError(f"no reviewed {kind} artifact exists for this run")


def _tools() -> list[dict[str, Any]]:
    return [
        {
            "name": "upload_artifact",
            "description": "Upload the reviewed resume or cover-letter artifact for this apply run. The model supplies only the artifact kind, never a path.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["resume", "cover_letter"],
                    }
                },
                "required": ["kind"],
                "additionalProperties": False,
            },
        },
        {
            "name": "type_credential",
            "description": "Type a locally stored credential into the currently focused credential field. The credential value is resolved by this server and is never returned to the model.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["job_site_password"],
                    }
                },
                "required": ["kind"],
                "additionalProperties": False,
            },
        },
    ]


def _profile_credential(kind: str) -> str:
    if kind != "job_site_password":
        raise ValueError("type_credential kind must be job_site_password")

    raw_db_path = os.environ.get("JOBHUNTER_APPLY_PROFILE_DB_PATH")
    if raw_db_path:
        db_path = Path(raw_db_path).expanduser()
    else:
        from jobhunter import config

        db_path = config.DB_PATH

    if not db_path.exists():
        raise ValueError("job-site password credential is not configured")

    try:
        conn = sqlite3.connect(db_path)
        try:
            row = conn.execute(
                """
                SELECT personal_password
                  FROM candidate_profiles
                 WHERE tenant_id = 'local'
                   AND profile_id = 'default'
                """
            ).fetchone()
        finally:
            conn.close()
    except sqlite3.Error as exc:
        raise ValueError("job-site password credential is not configured") from exc

    password = str(row[0] or "") if row else ""
    if not password:
        raise ValueError("job-site password credential is not configured")
    return password


def _type_credential_into_active_field(cdp_endpoint: str, credential: str) -> None:
    ws_url = _first_page_ws_url(cdp_endpoint)
    try:
        import websocket
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("websocket-client is required for type_credential") from exc
    ws = websocket.create_connection(ws_url, timeout=5, suppress_origin=True)
    counter = 0

    def send(method: str, params: dict[str, Any] | None = None) -> int:
        nonlocal counter
        counter += 1
        ws.send(json.dumps({"id": counter, "method": method, "params": params or {}}))
        return counter

    def response(message_id: int) -> dict[str, Any]:
        while True:
            message = json.loads(ws.recv())
            if message.get("id") == message_id:
                if "error" in message:
                    raise RuntimeError(str(message["error"]))
                return message

    try:
        guard = response(
            send(
                "Runtime.evaluate",
                {
                    "returnByValue": True,
                    "expression": """
(() => {
  const el = document.activeElement;
  if (!el || !(el instanceof HTMLInputElement)) {
    return {ok: false};
  }
  const type = (el.getAttribute("type") || "text").toLowerCase();
  const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase();
  const name = (el.getAttribute("name") || "").toLowerCase();
  const id = (el.getAttribute("id") || "").toLowerCase();
  return {
    ok: type === "password" || autocomplete.includes("password") ||
      name.includes("password") || id.includes("password")
  };
})()
""",
                },
            )
        )
        active = guard.get("result", {}).get("result", {}).get("value") or {}
        if not active.get("ok"):
            raise RuntimeError("active element is not a password credential field")
        response(send("Input.insertText", {"text": credential}))
    finally:
        ws.close()


def _upload_file_to_current_input(cdp_endpoint: str, path: Path) -> None:
    ws_url = _first_page_ws_url(cdp_endpoint)
    try:
        import websocket
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("websocket-client is required for upload_artifact") from exc
    ws = websocket.create_connection(ws_url, timeout=5, suppress_origin=True)
    counter = 0

    def send(method: str, params: dict[str, Any] | None = None) -> int:
        nonlocal counter
        counter += 1
        ws.send(json.dumps({"id": counter, "method": method, "params": params or {}}))
        return counter

    def response(message_id: int) -> dict[str, Any]:
        while True:
            message = json.loads(ws.recv())
            if message.get("id") == message_id:
                if "error" in message:
                    raise RuntimeError(str(message["error"]))
                return message

    try:
        response(send("DOM.enable"))
        root = response(send("DOM.getDocument", {"depth": 1}))
        root_id = root.get("result", {}).get("root", {}).get("nodeId")
        if not root_id:
            raise RuntimeError("could not inspect current page DOM")
        query = response(
            send("DOM.querySelector", {"nodeId": root_id, "selector": "input[type=file]"})
        )
        node_id = query.get("result", {}).get("nodeId")
        if not node_id:
            raise RuntimeError("no file input is currently available")
        response(send("DOM.setFileInputFiles", {"nodeId": node_id, "files": [str(path)]}))
    finally:
        ws.close()


def _first_page_ws_url(cdp_endpoint: str) -> str:
    parsed = urlparse(cdp_endpoint)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("CDP endpoint is not configured")
    with urlopen(f"{cdp_endpoint.rstrip('/')}/json/list", timeout=3) as response:
        targets = json.loads(response.read().decode("utf-8"))
    for target in targets:
        if isinstance(target, dict) and target.get("type") == "page":
            ws_url = str(target.get("webSocketDebuggerUrl") or "")
            if ws_url:
                return ws_url
    raise RuntimeError("no page target is available for artifact upload")


def _error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": code, "message": message},
    }


if __name__ == "__main__":
    main()
