"""Minimal stdio MCP server exposing scoped Gmail verification values."""

from __future__ import annotations

import json
import os
import re
import sys
from typing import Any
from urllib.parse import urlparse

from jobctl import __version__
from jobctl.infrastructure.gmail.client import GmailClient


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
    def __init__(
        self,
        *,
        client: GmailClient | None = None,
        allowed_sender_domains: tuple[str, ...] | None = None,
        earliest_internal_ms: int | None = None,
        to_email: str | None = None,
    ) -> None:
        self._client = client or GmailClient()
        self._allowed_sender_domains = (
            allowed_sender_domains
            if allowed_sender_domains is not None
            else _domains_from_env()
        )
        self._earliest_internal_ms = (
            earliest_internal_ms
            if earliest_internal_ms is not None
            else _int_env("JOBCTL_GMAIL_AFTER_MS")
        )
        self._to_email = to_email if to_email is not None else os.environ.get("JOBCTL_GMAIL_TO_EMAIL", "")

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
                    "serverInfo": {"name": "jobctl-gmail", "version": __version__},
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
        if name != "get_verification_code":
            raise ValueError(f"Unknown Gmail tool: {name}")
        payload = self._get_verification_code(hint=str(args.get("hint") or ""))
        return {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(payload, ensure_ascii=False),
                }
            ]
        }

    def _get_verification_code(self, *, hint: str = "") -> dict[str, Any]:
        if not self._to_email:
            return _empty_result("recipient email is not configured")
        if not self._allowed_sender_domains:
            return _empty_result("allowed sender domain is not configured")
        messages = self._client.search_emails(
            query=hint,
            to_email=self._to_email,
            newer_than_minutes=30,
            max_results=10,
        )
        codes: list[str] = []
        links: list[str] = []
        scanned = 0
        for item in messages:
            if not isinstance(item, dict):
                continue
            if not _message_in_scope(
                item,
                allowed_domains=self._allowed_sender_domains,
                earliest_internal_ms=self._earliest_internal_ms,
            ):
                continue
            message_id = str(item.get("id") or "")
            if not message_id:
                continue
            message = self._client.read_email(message_id=message_id)
            scanned += 1
            text = " ".join(
                str(message.get(key) or "")
                for key in ("snippet", "body_text")
            )
            codes.extend(_extract_codes(text))
            links.extend(_extract_links(text))
        return {
            "codes": _dedupe(codes),
            "links": _dedupe(links),
            "source_count": scanned,
            "note": "verification values extracted; raw email content withheld",
        }


def _tools() -> list[dict[str, Any]]:
    return [
        {
            "name": "get_verification_code",
            "description": "Return scoped application verification codes or links. Raw email content is never returned.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "hint": {
                        "type": "string",
                        "description": "Optional application or sender hint.",
                    },
                },
                "additionalProperties": False,
            },
        },
    ]


def _error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": code, "message": message},
    }


def _domains_from_env() -> tuple[str, ...]:
    raw = os.environ.get("JOBCTL_GMAIL_ALLOWED_DOMAINS", "")
    return tuple(part.strip().lower() for part in raw.split(",") if part.strip())


def _int_env(name: str) -> int | None:
    raw = os.environ.get(name)
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def _message_in_scope(
    message: dict[str, Any],
    *,
    allowed_domains: tuple[str, ...],
    earliest_internal_ms: int | None,
) -> bool:
    if earliest_internal_ms is not None:
        try:
            if int(message.get("internalDate") or 0) < earliest_internal_ms:
                return False
        except (TypeError, ValueError):
            return False
    sender_domain = _email_domain(str(message.get("from") or ""))
    return any(
        sender_domain == domain or sender_domain.endswith(f".{domain}")
        for domain in allowed_domains
    )


def _email_domain(value: str) -> str:
    match = re.search(r"@([A-Za-z0-9.-]+)", value)
    return match.group(1).lower() if match else ""


def _extract_codes(text: str) -> list[str]:
    patterns = (
        r"\b(?:code|otp|one[- ]?time|verification)[^\w]{0,20}([A-Z0-9][A-Z0-9 -]{4,18}[A-Z0-9])\b",
        r"\b([0-9]{6,10})\b",
    )
    out: list[str] = []
    for pattern in patterns:
        for match in re.finditer(pattern, text, flags=re.IGNORECASE):
            code = re.sub(r"[\s-]+", "", match.group(1)).upper()
            if 6 <= len(code) <= 12:
                out.append(code)
    return out


def _extract_links(text: str) -> list[str]:
    links: list[str] = []
    for raw in re.findall(r"https?://[^\s<>'\"]+", text):
        parsed = urlparse(raw.rstrip(").,;"))
        if parsed.scheme and parsed.netloc:
            links.append(parsed.geturl())
    return links


def _dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def _empty_result(note: str) -> dict[str, Any]:
    return {"codes": [], "links": [], "source_count": 0, "note": note}


if __name__ == "__main__":
    main()
