"""Regression coverage for enrichment SSRF-to-LLM URL safety."""

from __future__ import annotations

import socket
from contextlib import contextmanager
from types import SimpleNamespace
from typing import Iterator

import pytest

from jobctrl.discovery import smartextract
from jobctrl.enrichment import detail
from jobctrl.enrichment.detail import scrape_detail_page
from jobctrl.infrastructure.enrichment.playwright_fetcher import (
    DetailPageFetchBlocked,
    PlaywrightDetailPageFetcher,
)
from jobctrl.infrastructure.network import (
    PublicHttpUrlRouteGuard,
    PublicUrlDecision,
    RouteFulfillment,
    UnsafePublicDestinationError,
    validate_public_http_url,
)

from .politeness_helpers import offline_session


def _resolver_for(*addresses: str):
    def resolve(*_args: object, **_kwargs: object):
        return [
            (
                socket.AF_INET6 if ":" in address else socket.AF_INET,
                socket.SOCK_STREAM,
                0,
                "",
                (address, 443),
            )
            for address in addresses
        ]

    return resolve


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:8080/jobs/1",
        "http://[::1]/jobs/1",
        "http://169.254.169.254/latest/meta-data/iam/security-credentials/role",
        "http://0177.0.0.1/private",
        "http://012.0.0.1/private",
        "http://0177.0.0.01/private",
        "http://0300.0250.0001.0001/private",
        "http://2130706433/private",
        "http://0x7f000001/private",
        "http://127.1/private",
        "file:///etc/passwd",
    ],
)
def test_validate_public_http_url_rejects_non_public_destinations(url: str) -> None:
    decision = validate_public_http_url(url)

    assert not decision.allowed
    assert decision.reason


def test_legacy_private_ipv4_literal_is_rejected_before_dns_resolution() -> None:
    resolver_calls: list[str] = []

    def resolver(host: str, *_args, **_kwargs):
        resolver_calls.append(host)
        return []

    decision = validate_public_http_url("http://0177.0.0.1/private", resolver=resolver)

    assert not decision.allowed
    assert resolver_calls == []


def test_validate_public_http_url_rejects_hostnames_that_resolve_private() -> None:
    decision = validate_public_http_url(
        "https://jobs.example/internal",
        resolver=_resolver_for("10.0.0.5"),
    )

    assert not decision.allowed
    assert "non-public" in str(decision.reason)


def test_validate_public_http_url_allows_public_hostname_resolution() -> None:
    decision = validate_public_http_url(
        "https://jobs.example/role",
        resolver=_resolver_for("93.184.216.34"),
    )

    assert decision.allowed


def test_validate_public_http_url_rejects_embedded_credentials_before_resolution() -> None:
    resolver_calls: list[str] = []

    def resolver(host: str, *_args, **_kwargs):
        resolver_calls.append(host)
        return []

    decision = validate_public_http_url(
        "https://user:password@example.com/jobs/42",
        resolver=resolver,
    )

    assert not decision.allowed
    assert decision.reason == "URL must not contain embedded credentials"
    assert resolver_calls == []


class _ExplodingPage:
    url = "about:blank"

    def goto(self, *_args: object, **_kwargs: object) -> object:
        raise AssertionError("unsafe URL must be blocked before navigation")


def test_scrape_detail_page_blocks_direct_loopback_before_navigation() -> None:
    result = scrape_detail_page(
        _ExplodingPage(),
        "http://127.0.0.1:8123/private",
        session=offline_session(),
    )

    assert result["status"] == "blocked"
    assert result["security_outcome"] == "unsafe_url"
    assert result["blocked_url"] == "http://127.0.0.1:8123/private"
    assert "politeness_outcome" not in result


class _AbortRoute:
    def __init__(self) -> None:
        self.aborted = False
        self.continued = False

    def abort(self, _code: str | None = None) -> None:
        self.aborted = True

    def continue_(self) -> None:
        self.continued = True


class _FulfillRoute(_AbortRoute):
    def __init__(self) -> None:
        super().__init__()
        self.fulfilled: dict[str, object] | None = None

    def fulfill(self, **kwargs: object) -> None:
        self.fulfilled = kwargs


class _RouteOnlyPage:
    def __init__(self) -> None:
        self.handler = None

    def route(self, _pattern: str, handler) -> None:  # noqa: ANN001 - Playwright-shaped test double
        self.handler = handler

    def unroute(self, _pattern: str, _handler) -> None:  # noqa: ANN001 - Playwright-shaped test double
        self.handler = None


def test_public_route_guard_fulfills_public_requests_with_pinned_fetcher() -> None:
    page = _RouteOnlyPage()
    calls: list[tuple[str, str, dict[str, str]]] = []

    def fetcher(url: str, method: str, headers: dict[str, str]) -> RouteFulfillment:
        calls.append((url, method, headers))
        return RouteFulfillment(
            status=200,
            headers={"content-type": "text/html"},
            body=b"<main>remote role</main>",
        )

    PublicHttpUrlRouteGuard(
        page,
        resolver=_resolver_for("93.184.216.34"),
        fetch_public_requests=True,
        request_fetcher=fetcher,
    ).install()
    route = _FulfillRoute()

    assert page.handler is not None
    page.handler(
        route,
        SimpleNamespace(url="https://jobs.example/role", method="GET", headers={"user-agent": "JobCtrl"}),
    )

    assert calls == [("https://jobs.example/role", "GET", {"user-agent": "JobCtrl"})]
    assert route.fulfilled == {
        "status": 200,
        "headers": {"content-type": "text/html"},
        "body": b"<main>remote role</main>",
    }
    assert not route.continued
    assert not route.aborted


def test_public_route_guard_aborts_public_write_without_poisoning_page() -> None:
    page = _RouteOnlyPage()
    calls: list[tuple[str, str, dict[str, str]]] = []

    def fetcher(url: str, method: str, headers: dict[str, str]) -> RouteFulfillment:
        calls.append((url, method, headers))
        raise AssertionError("write requests must never reach the pinned fetcher")

    guard = PublicHttpUrlRouteGuard(
        page,
        resolver=_resolver_for("93.184.216.34"),
        fetch_public_requests=True,
        request_fetcher=fetcher,
    ).install()
    route = _FulfillRoute()

    assert page.handler is not None
    page.handler(
        route,
        SimpleNamespace(
            url="https://jobs.example/telemetry",
            method="POST",
            headers={"content-type": "application/json"},
        ),
    )

    assert route.aborted
    assert not route.continued
    assert route.fulfilled is None
    assert calls == []
    assert not guard.blocked
    assert guard.blocked_url is None
    assert guard.blocked_reason is None


def test_public_route_guard_aborts_chrome_extension_without_poisoning_page() -> None:
    page = _RouteOnlyPage()
    guard = PublicHttpUrlRouteGuard(page).install()
    route = _AbortRoute()

    assert page.handler is not None
    page.handler(
        route,
        SimpleNamespace(url="chrome-extension://example/background.html"),
    )

    assert route.aborted
    assert not route.continued
    assert not guard.blocked
    assert guard.blocked_url is None
    assert guard.blocked_reason is None


def test_public_route_guard_aborts_when_pinned_fetch_rejects_rebound_dns() -> None:
    page = _RouteOnlyPage()

    def fetcher(_url: str, _method: str, _headers: dict[str, str]) -> RouteFulfillment:
        raise UnsafePublicDestinationError("URL host resolves to a non-public address: 127.0.0.1")

    guard = PublicHttpUrlRouteGuard(
        page,
        resolver=_resolver_for("93.184.216.34"),
        fetch_public_requests=True,
        request_fetcher=fetcher,
    ).install()
    route = _FulfillRoute()

    assert page.handler is not None
    page.handler(
        route,
        SimpleNamespace(url="https://jobs.example/role", method="GET", headers={}),
    )

    assert route.aborted
    assert not route.continued
    assert route.fulfilled is None
    assert guard.blocked_url == "https://jobs.example/role"
    assert "non-public address" in str(guard.blocked_reason)


class _RedirectToLoopbackPage:
    def __init__(self) -> None:
        self.url = "https://jobs.example/final"
        self._handler = None
        self.goto_called = False
        self.content_collected = False

    def route(self, _pattern: str, handler) -> None:  # noqa: ANN001 - Playwright-shaped test double
        self._handler = handler

    def unroute(self, _pattern: str, _handler) -> None:  # noqa: ANN001 - Playwright-shaped test double
        self._handler = None

    def on(self, *_args: object, **_kwargs: object) -> None:
        return None

    def goto(self, _url: str, **_kwargs: object) -> object:
        self.goto_called = True
        route = _AbortRoute()
        assert self._handler is not None
        self._handler(route, SimpleNamespace(url="http://127.0.0.1:8123/latest/meta-data"))
        if route.aborted:
            raise RuntimeError("net::ERR_BLOCKED_BY_CLIENT")
        raise AssertionError("unsafe redirect was not aborted")

    def query_selector_all(self, *_args: object, **_kwargs: object) -> list[object]:
        self.content_collected = True
        return []


class _LateLoopbackDuringContentPage:
    def __init__(self, *, trigger_on: str) -> None:
        self.url = "https://jobs.example/final"
        self._handler = None
        self.trigger_on = trigger_on
        self.goto_called = False
        self.content_collected = False
        self.local_aborted = False

    def route(self, _pattern: str, handler) -> None:  # noqa: ANN001 - Playwright-shaped test double
        self._handler = handler

    def unroute(self, _pattern: str, _handler) -> None:  # noqa: ANN001 - Playwright-shaped test double
        self._handler = None

    def on(self, *_args: object, **_kwargs: object) -> None:
        return None

    def goto(self, _url: str, **_kwargs: object) -> object:
        self.goto_called = True
        return SimpleNamespace(status=200)

    def wait_for_load_state(self, *_args: object, **_kwargs: object) -> None:
        return None

    def title(self) -> str:
        return "Role"

    def query_selector_all(self, *_args: object, **_kwargs: object) -> list[object]:
        self.content_collected = True
        if self.trigger_on == "query_selector_all":
            self._request_local_content()
        return []

    def query_selector(self, *_args: object, **_kwargs: object) -> None:
        return None

    def evaluate(self, script: str, *_args: object, **_kwargs: object) -> object:
        if "data-testid" in script or "candidates" in script:
            return []
        if "total_elements" in script:
            return {}
        return ""

    def content(self) -> str:
        self.content_collected = True
        if self.trigger_on == "content":
            self._request_local_content()
        return "<main>LOCAL SECRET</main>"

    def _request_local_content(self) -> None:
        if self._handler is None:
            return
        route = _AbortRoute()
        self._handler(route, SimpleNamespace(url="http://127.0.0.1:8123/latest/meta-data"))
        self.local_aborted = route.aborted


def test_scrape_detail_page_blocks_redirect_to_loopback_before_extractors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(detail, "validate_public_http_url", lambda _url: PublicUrlDecision(True))
    page = _RedirectToLoopbackPage()

    result = scrape_detail_page(page, "https://jobs.example/role", session=offline_session())

    assert page.goto_called
    assert not page.content_collected
    assert result["status"] == "blocked"
    assert result["security_outcome"] == "unsafe_url"
    assert result["blocked_url"] == "http://127.0.0.1:8123/latest/meta-data"


def test_scrape_detail_page_keeps_route_guard_through_content_collection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(detail, "validate_public_http_url", lambda _url: PublicUrlDecision(True))
    page = _LateLoopbackDuringContentPage(trigger_on="query_selector_all")

    result = scrape_detail_page(page, "https://jobs.example/role", session=offline_session())

    assert page.goto_called
    assert page.content_collected
    assert page.local_aborted
    assert result["status"] == "blocked"
    assert result["security_outcome"] == "unsafe_url"
    assert result["blocked_url"] == "http://127.0.0.1:8123/latest/meta-data"


def test_playwright_detail_fetcher_blocks_direct_loopback_before_browser() -> None:
    page = PlaywrightDetailPageFetcher().fetch("http://127.0.0.1:8123/private")

    assert page.final_url == "http://127.0.0.1:8123/private"
    assert page.html == ""
    assert page.json_ld == ()


class _RecordingBrowser:
    def __init__(self, page: object | None = None) -> None:
        self.context_created = False
        self._page = page or _RedirectToLoopbackPage()

    def new_context(self, **_kwargs: object) -> "_RecordingBrowser":
        self.context_created = True
        return self

    def new_page(self, **_kwargs: object) -> object:
        return self._page

    def close(self) -> None:
        return None


class _RecordingChromium:
    def __init__(self, browser: _RecordingBrowser) -> None:
        self._browser = browser

    def launch(self, **_kwargs: object) -> _RecordingBrowser:
        return self._browser


class _RecordingPlaywright:
    def __init__(self, browser: _RecordingBrowser) -> None:
        self.chromium = _RecordingChromium(browser)

    def __enter__(self) -> "_RecordingPlaywright":
        return self

    def __exit__(self, *_args: object) -> None:
        return None


def test_playwright_detail_fetcher_blocks_redirect_to_loopback_before_content(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "jobctrl.infrastructure.enrichment.playwright_fetcher.validate_public_http_url",
        lambda _url: PublicUrlDecision(True),
    )
    browser = _RecordingBrowser()

    @contextmanager
    def fake_playwright() -> Iterator[_RecordingPlaywright]:
        yield _RecordingPlaywright(browser)

    monkeypatch.setattr("playwright.sync_api.sync_playwright", fake_playwright)

    page = PlaywrightDetailPageFetcher(session=offline_session()).fetch("https://jobs.example/role")

    assert browser.context_created
    assert page.final_url == "http://127.0.0.1:8123/latest/meta-data"
    assert page.html == ""
    assert page.json_ld == ()


def test_playwright_detail_fetcher_can_surface_an_explicit_unsafe_redirect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "jobctrl.infrastructure.enrichment.playwright_fetcher.validate_public_http_url",
        lambda _url: PublicUrlDecision(True),
    )
    browser = _RecordingBrowser()

    @contextmanager
    def fake_playwright() -> Iterator[_RecordingPlaywright]:
        yield _RecordingPlaywright(browser)

    monkeypatch.setattr("playwright.sync_api.sync_playwright", fake_playwright)

    with pytest.raises(DetailPageFetchBlocked) as raised:
        PlaywrightDetailPageFetcher(
            session=offline_session(),
            raise_on_unavailable=True,
        ).fetch("https://jobs.example/role")

    assert raised.value.reason_code == "unsafe_redirect"


def test_playwright_detail_fetcher_keeps_route_guard_through_content_collection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "jobctrl.infrastructure.enrichment.playwright_fetcher.validate_public_http_url",
        lambda _url: PublicUrlDecision(True),
    )
    late_page = _LateLoopbackDuringContentPage(trigger_on="query_selector_all")
    browser = _RecordingBrowser(page=late_page)

    @contextmanager
    def fake_playwright() -> Iterator[_RecordingPlaywright]:
        yield _RecordingPlaywright(browser)

    monkeypatch.setattr("playwright.sync_api.sync_playwright", fake_playwright)

    detail_page = PlaywrightDetailPageFetcher(session=offline_session()).fetch("https://jobs.example/role")

    assert browser.context_created
    assert late_page.content_collected
    assert late_page.local_aborted
    assert detail_page.final_url == "http://127.0.0.1:8123/latest/meta-data"
    assert detail_page.html == ""
    assert detail_page.json_ld == ()


def test_smartextract_blocks_direct_loopback_before_browser(monkeypatch: pytest.MonkeyPatch) -> None:
    def explode_playwright() -> object:
        raise AssertionError("unsafe URL must be blocked before browser startup")

    monkeypatch.setattr(smartextract, "sync_playwright", explode_playwright)

    intel = smartextract.collect_page_intelligence(
        "http://127.0.0.1:8123/list",
        session=offline_session(),
    )

    assert intel["page_title"] == ""
    assert "full_html" not in intel


def test_smartextract_blocks_redirect_to_loopback_before_html_capture(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(smartextract, "validate_public_http_url", lambda _url: PublicUrlDecision(True))
    page = _RedirectToLoopbackPage()
    browser = _RecordingBrowser(page=page)

    @contextmanager
    def fake_playwright() -> Iterator[_RecordingPlaywright]:
        yield _RecordingPlaywright(browser)

    monkeypatch.setattr(smartextract, "sync_playwright", fake_playwright)

    intel = smartextract.collect_page_intelligence("https://jobs.example/list", session=offline_session())

    assert page.goto_called
    assert not page.content_collected
    assert intel["page_title"] == ""
    assert "full_html" not in intel


def test_smartextract_keeps_route_guard_through_html_capture(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(smartextract, "validate_public_http_url", lambda _url: PublicUrlDecision(True))
    page = _LateLoopbackDuringContentPage(trigger_on="content")
    browser = _RecordingBrowser(page=page)

    @contextmanager
    def fake_playwright() -> Iterator[_RecordingPlaywright]:
        yield _RecordingPlaywright(browser)

    monkeypatch.setattr(smartextract, "sync_playwright", fake_playwright)

    intel = smartextract.collect_page_intelligence("https://jobs.example/list", session=offline_session())

    assert page.goto_called
    assert page.content_collected
    assert page.local_aborted
    assert intel["page_title"] == ""
    assert "full_html" not in intel
