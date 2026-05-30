"""Minimal stdio MCP server exposing read-only Gmail verification tools."""

from __future__ import annotations

import json
import sys
from typing import Any

from jobhunter import __version__
from jobhunter.infrastructure.gmail.client import GmailClient


def main() -> None:
    server = GmailMcpServer()
    for line in sys.stdin:
        if not line.strip():
            continue
        response = server.handle_json(line)
        if response is not None:
            sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
            sys.stdout.flush()


class GmailMcpServer:
    def __init__(self, *, client: GmailClient | None = None) -> None:
        self._client = client or GmailClient()

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
                    "serverInfo": {"name": "jobhunter-gmail", "version": __version__},
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
        if name == "search_emails":
            payload = self._client.search_emails(
                query=str(args.get("query") or ""),
                to_email=str(args.get("to_email") or args.get("to") or ""),
                newer_than_minutes=int(args.get("newer_than_minutes") or 30),
                max_results=int(args.get("max_results") or 10),
            )
        elif name == "read_email":
            message_id = str(args.get("message_id") or args.get("id") or "")
            if not message_id:
                raise ValueError("read_email requires message_id")
            payload = self._client.read_email(message_id=message_id)
        else:
            raise ValueError(f"Unknown Gmail tool: {name}")
        return {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(payload, ensure_ascii=False),
                }
            ]
        }


def _tools() -> list[dict[str, Any]]:
    return [
        {
            "name": "search_emails",
            "description": "Search recent Gmail messages for application verification codes. Read-only.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "to_email": {"type": "string"},
                    "newer_than_minutes": {"type": "integer", "default": 30},
                    "max_results": {"type": "integer", "default": 10},
                },
            },
        },
        {
            "name": "read_email",
            "description": "Read one Gmail message body by message ID. Read-only.",
            "inputSchema": {
                "type": "object",
                "properties": {"message_id": {"type": "string"}},
                "required": ["message_id"],
            },
        },
    ]


def _error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": code, "message": message},
    }


if __name__ == "__main__":
    main()
