"""First-party Gmail connector behavior."""

from __future__ import annotations

import base64
import json
import time

import httpx

from jobhunter.infrastructure.gmail.auth import (
    GmailAuthError,
    OAuthClient,
    build_authorization_url,
    choose_redirect_uri,
)
from jobhunter.infrastructure.gmail.client import GmailClient
from jobhunter.infrastructure.gmail.mcp_server import GmailMcpServer


def test_desktop_oauth_uses_loopback_redirect() -> None:
    client = OAuthClient(
        client_id="client",
        client_secret="secret",
        kind="installed",
    )

    assert choose_redirect_uri(client, port=38123) == "http://127.0.0.1:38123/oauth2callback"


def test_web_oauth_requires_local_redirect() -> None:
    client = OAuthClient(
        client_id="client",
        client_secret="secret",
        kind="web",
        redirect_uris=("https://vertexaisearch.cloud.google.com/oauth-redirect",),
    )

    try:
        choose_redirect_uri(client)
    except GmailAuthError as exc:
        assert "no local redirect URI" in str(exc)
    else:
        raise AssertionError("expected GmailAuthError")


def test_authorization_url_requests_readonly_scope() -> None:
    client = OAuthClient(
        client_id="client",
        client_secret="secret",
        kind="installed",
    )

    url = build_authorization_url(client, "http://127.0.0.1:38123/oauth2callback", "state")

    assert "https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.readonly" in url
    assert "gmail.modify" not in url


def test_gmail_client_searches_recent_metadata(monkeypatch) -> None:
    monkeypatch.setattr("jobhunter.infrastructure.gmail.client.get_access_token", lambda: "token")
    now_ms = int(time.time() * 1000)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/messages"):
            assert "verification" in str(request.url.params["q"])
            return httpx.Response(200, json={"messages": [{"id": "m1"}]})
        assert request.url.path.endswith("/messages/m1")
        return httpx.Response(
            200,
            json={
                "id": "m1",
                "threadId": "t1",
                "internalDate": str(now_ms),
                "snippet": "Your code is 123456",
                "payload": {
                    "headers": [
                        {"name": "Subject", "value": "Verification code"},
                        {"name": "From", "value": "ats@example.com"},
                        {"name": "To", "value": "candidate@example.com"},
                        {"name": "Date", "value": "now"},
                    ]
                },
            },
        )

    client = GmailClient(http=httpx.Client(transport=httpx.MockTransport(handler)))

    results = client.search_emails(to_email="candidate@example.com")

    assert results == [
        {
            "id": "m1",
            "threadId": "t1",
            "subject": "Verification code",
            "from": "ats@example.com",
            "to": "candidate@example.com",
            "date": "now",
            "snippet": "Your code is 123456",
            "internalDate": str(now_ms),
        }
    ]


def test_gmail_client_reads_message_body(monkeypatch) -> None:
    monkeypatch.setattr("jobhunter.infrastructure.gmail.client.get_access_token", lambda: "token")
    body = base64.urlsafe_b64encode(b"Your verification code is 654321").decode().rstrip("=")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/messages/m1")
        return httpx.Response(
            200,
            json={
                "id": "m1",
                "threadId": "t1",
                "snippet": "Your verification code is 654321",
                "payload": {
                    "headers": [{"name": "Subject", "value": "Code"}],
                    "parts": [{"mimeType": "text/plain", "body": {"data": body}}],
                },
            },
        )

    client = GmailClient(http=httpx.Client(transport=httpx.MockTransport(handler)))

    message = client.read_email(message_id="m1")

    assert message["subject"] == "Code"
    assert "654321" in message["body_text"]


def test_mcp_server_exposes_readonly_tools() -> None:
    class FakeClient:
        def search_emails(self, **_kwargs):
            return [{"id": "m1", "subject": "Code"}]

        def read_email(self, *, message_id):
            return {"id": message_id, "body_text": "code 123456"}

    server = GmailMcpServer(client=FakeClient())
    tools = server.handle_json(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}))
    called = server.handle_json(
        json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "read_email", "arguments": {"message_id": "m1"}},
            }
        )
    )

    tool_names = {tool["name"] for tool in tools["result"]["tools"]}
    assert tool_names == {"search_emails", "read_email"}
    assert "code 123456" in called["result"]["content"][0]["text"]
