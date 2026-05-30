"""Read-only Gmail API client for application verification codes."""

from __future__ import annotations

import base64
import re
import time
from html import unescape
from typing import Any

import httpx

from jobhunter.infrastructure.gmail.auth import get_access_token

GMAIL_API_ROOT = "https://gmail.googleapis.com/gmail/v1/users/me"
_HEADERS = ("From", "To", "Subject", "Date")


class GmailClient:
    """Small Gmail readonly client backed by the existing httpx dependency."""

    def __init__(self, *, http: httpx.Client | None = None) -> None:
        self._http = http

    def search_emails(
        self,
        *,
        query: str = "",
        to_email: str = "",
        newer_than_minutes: int = 30,
        max_results: int = 10,
    ) -> list[dict[str, Any]]:
        max_results = max(1, min(int(max_results or 10), 20))
        newer_than_minutes = max(1, int(newer_than_minutes or 30))
        cutoff_ms = int((time.time() - newer_than_minutes * 60) * 1000)
        q = _build_query(query=query, to_email=to_email)
        with self._client() as http:
            response = http.get(
                f"{GMAIL_API_ROOT}/messages",
                headers=self._headers(),
                params={"q": q, "maxResults": max_results},
            )
            response.raise_for_status()
            messages = response.json().get("messages") or []
            results: list[dict[str, Any]] = []
            for item in messages[:max_results]:
                msg = self._get_message_metadata(http, str(item["id"]))
                if int(msg.get("internalDate") or 0) < cutoff_ms:
                    continue
                results.append(msg)
            return results

    def read_email(self, *, message_id: str) -> dict[str, Any]:
        with self._client() as http:
            response = http.get(
                f"{GMAIL_API_ROOT}/messages/{message_id}",
                headers=self._headers(),
                params={"format": "full"},
            )
            response.raise_for_status()
            payload = response.json()
        headers = _headers_to_dict(payload.get("payload", {}).get("headers") or [])
        return {
            "id": payload.get("id", ""),
            "threadId": payload.get("threadId", ""),
            "subject": headers.get("subject", ""),
            "from": headers.get("from", ""),
            "to": headers.get("to", ""),
            "date": headers.get("date", ""),
            "snippet": payload.get("snippet", ""),
            "body_text": _extract_body_text(payload.get("payload", {}))[:12000],
        }

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {get_access_token()}"}

    def _client(self):
        if self._http is not None:
            return _NullContext(self._http)
        return httpx.Client(timeout=20)

    def _get_message_metadata(self, http: httpx.Client, message_id: str) -> dict[str, Any]:
        response = http.get(
            f"{GMAIL_API_ROOT}/messages/{message_id}",
            headers=self._headers(),
            params={"format": "metadata", "metadataHeaders": list(_HEADERS)},
        )
        response.raise_for_status()
        payload = response.json()
        headers = _headers_to_dict(payload.get("payload", {}).get("headers") or [])
        return {
            "id": payload.get("id", ""),
            "threadId": payload.get("threadId", ""),
            "subject": headers.get("subject", ""),
            "from": headers.get("from", ""),
            "to": headers.get("to", ""),
            "date": headers.get("date", ""),
            "snippet": payload.get("snippet", ""),
            "internalDate": payload.get("internalDate", "0"),
        }


class _NullContext:
    def __init__(self, value):
        self.value = value

    def __enter__(self):
        return self.value

    def __exit__(self, *_args):
        return None


def _build_query(*, query: str, to_email: str) -> str:
    terms = [query.strip()] if query.strip() else [
        '(verification OR code OR confirm OR OTP OR "one-time" OR security OR login)'
    ]
    if to_email.strip():
        terms.append(f"to:{to_email.strip()}")
    terms.append("newer_than:1d")
    return " ".join(terms)


def _headers_to_dict(headers: list[dict[str, str]]) -> dict[str, str]:
    return {
        str(header.get("name", "")).lower(): str(header.get("value", ""))
        for header in headers
    }


def _extract_body_text(part: dict[str, Any]) -> str:
    chunks: list[str] = []
    _collect_body_parts(part, chunks)
    return "\n\n".join(chunk for chunk in chunks if chunk.strip())


def _collect_body_parts(part: dict[str, Any], chunks: list[str]) -> None:
    mime = str(part.get("mimeType") or "")
    body = part.get("body") or {}
    data = body.get("data")
    if data and mime in {"text/plain", "text/html", ""}:
        text = _decode_body(str(data))
        if mime == "text/html":
            text = _html_to_text(text)
        chunks.append(text)
    for child in part.get("parts") or []:
        _collect_body_parts(child, chunks)


def _decode_body(value: str) -> str:
    padded = value + "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8", errors="replace")


def _html_to_text(value: str) -> str:
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", value)
    text = re.sub(r"(?s)<br\s*/?>", "\n", text)
    text = re.sub(r"(?s)</p\s*>", "\n", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    return unescape(re.sub(r"[ \t]+", " ", text)).strip()
