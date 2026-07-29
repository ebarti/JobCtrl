"""Authorization boundaries for Apply browser and credential destinations."""

from __future__ import annotations

import json

import pytest

from jobctrl.apply import chrome
from jobctrl.infrastructure.network import PublicUrlDecision


@pytest.fixture(autouse=True)
def public_network_decisions(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        chrome,
        "validate_public_http_url",
        lambda _url: PublicUrlDecision(True),
    )


def _paused_request(
    *,
    request_id: str,
    url: str,
    method: str = "GET",
    resource_type: str = "Document",
) -> dict:
    return {
        "method": "Fetch.requestPaused",
        "params": {
            "requestId": request_id,
            "networkId": f"network-{request_id}",
            "resourceType": resource_type,
            "request": {
                "method": method,
                "url": url,
            },
        },
    }


def test_live_guard_blocks_public_cross_origin_requests() -> None:
    guard = chrome._PublicDestinationCdpGuard(
        port=1,
        approved_application_url="https://apply.example.com/job/42",
        capability_checker=lambda: True,
    )
    sent: list[tuple[str, dict | None]] = []

    chrome._handle_apply_page_event(
        _paused_request(
            request_id="approved",
            url="https://apply.example.com/job/42/submit",
            method="POST",
        ),
        guard,
        lambda method, params=None: sent.append((method, params)),
    )
    chrome._handle_apply_page_event(
        _paused_request(
            request_id="collector",
            url="https://collector.example/collect",
            method="POST",
        ),
        guard,
        lambda method, params=None: sent.append((method, params)),
    )

    assert sent == [
        ("Fetch.continueRequest", {"requestId": "approved"}),
        (
            "Fetch.failRequest",
            {"requestId": "collector", "errorReason": "BlockedByClient"},
        ),
    ]
    assert guard.evidence()["blocked_channels"] == ("approval_origin:POST",)


def test_dry_run_consumes_one_exact_initial_navigation_grant() -> None:
    approved_url = "https://apply.example.com/job/42?source=review"
    guard = chrome._DryRunCdpGuard(
        port=1,
        approved_application_url=approved_url,
    )
    guard.record_protected_target("page-1")
    sent: list[tuple[str, dict | None]] = []

    def dispatch(request_id: str, url: str, *, method: str = "GET") -> None:
        chrome._handle_apply_page_event(
            _paused_request(
                request_id=request_id,
                url=url,
                method=method,
            ),
            guard,
            lambda command, params=None: sent.append((command, params)),
        )

    dispatch("initial", approved_url)

    initial_evidence = guard.evidence()
    assert initial_evidence["coverage"] == "full"
    assert len(initial_evidence["allowed_navigations"]) == 1
    allowed = initial_evidence["allowed_navigations"][0]
    assert allowed["decision"] == "run_bound_initial_url"
    assert allowed["grant_id"] == "initial_application_url"
    assert allowed["method"] == "GET"
    assert allowed["url"] == "https://apply.example.com/job/42"
    assert len(allowed["url_fingerprint"]) == 64

    dispatch("head", approved_url, method="HEAD")
    dispatch("replay", approved_url)
    dispatch("query", "https://apply.example.com/job/42?source=attacker")
    dispatch("path", "https://apply.example.com/job/43?source=review")

    assert sent == [
        ("Fetch.continueRequest", {"requestId": "initial"}),
        (
            "Fetch.failRequest",
            {"requestId": "head", "errorReason": "BlockedByClient"},
        ),
        (
            "Fetch.failRequest",
            {"requestId": "replay", "errorReason": "BlockedByClient"},
        ),
        (
            "Fetch.failRequest",
            {"requestId": "query", "errorReason": "BlockedByClient"},
        ),
        (
            "Fetch.failRequest",
            {"requestId": "path", "errorReason": "BlockedByClient"},
        ),
    ]
    evidence = guard.evidence()
    assert len(evidence["allowed_navigations"]) == 1
    assert evidence["coverage"] == "partial"
    assert evidence["blocked_channels"] == ("network:GET", "network:HEAD")


def test_launch_fails_before_profile_or_process_without_approved_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        chrome,
        "require_system_browser_capability",
        lambda _capability: "/bin/chrome",
    )
    monkeypatch.setattr(
        chrome,
        "setup_worker_profile",
        lambda _worker_id: (_ for _ in ()).throw(
            AssertionError("invalid authorization must fail before profile access")
        ),
    )

    with pytest.raises(ValueError, match="approved application URL"):
        chrome.launch_chrome(worker_id=1, approved_application_url="")


def test_worker_target_is_closed_before_resume() -> None:
    class _FakeWebSocket:
        def __init__(self) -> None:
            self.sent: list[dict] = []

        def send(self, payload: str) -> None:
            self.sent.append(json.loads(payload))

        def close(self) -> None:
            return None

    class _FakeWebsocketModule:
        class WebSocketTimeoutException(Exception):
            pass

    websocket = _FakeWebSocket()
    guard = chrome._PublicDestinationCdpGuard(
        port=1,
        approved_application_url="https://apply.example.com/job/42",
        capability_checker=lambda: True,
    )
    session = chrome._BrowserApplyGuardSession(
        _FakeWebsocketModule,
        websocket,
        guard,
    )

    session._handle_message(
        {
            "method": "Target.attachedToTarget",
            "params": {
                "sessionId": "worker-session",
                "waitingForDebugger": True,
                "targetInfo": {
                    "targetId": "worker-target",
                    "type": "worker",
                },
            },
        }
    )

    assert websocket.sent == [
        {
            "id": websocket.sent[0]["id"],
            "method": "Target.closeTarget",
            "params": {"targetId": "worker-target"},
        }
    ]
    assert guard.evidence()["blocked_channels"] == ("worker_target:TARGET",)
    assert guard.evidence()["protected_targets"] == 0


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("HTTPS://Example.COM:443/path", "https://example.com"),
        ("https://example.com.:8443/path", "https://example.com:8443"),
        ("https://bücher.example/apply", "https://xn--bcher-kva.example"),
        ("http://[2001:0db8::1]:80/apply", "http://[2001:db8::1]"),
    ],
)
def test_canonical_http_origin_normalizes_security_equivalent_urls(
    value: str,
    expected: str,
) -> None:
    assert chrome.canonical_http_origin(value) == expected


@pytest.mark.parametrize(
    "value",
    [
        "",
        "javascript:alert(1)",
        "https://user:password@example.com/apply",
        "https://example.com:invalid/apply",
        "https://exa mple.com/apply",
        "https://example.com\\@collector.example/apply",
        "https://%65xample.com/apply",
        "https://[fe80::1%25en0]/apply",
    ],
)
def test_canonical_http_origin_rejects_ambiguous_urls(value: str) -> None:
    with pytest.raises(ValueError):
        chrome.canonical_http_origin(value)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("HTTPS://Example.COM:443", "https://example.com/"),
        (
            "https://bücher.example/apply%2Frole?source=review#section",
            "https://xn--bcher-kva.example/apply%2Frole?source=review",
        ),
        (
            "http://[2001:0db8::1]:80/apply?q=1",
            "http://[2001:db8::1]/apply?q=1",
        ),
    ],
)
def test_canonical_http_url_preserves_exact_request_identity(
    value: str,
    expected: str,
) -> None:
    assert chrome.canonical_http_url(value) == expected
