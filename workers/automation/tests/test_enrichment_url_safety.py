"""Regression coverage for enrichment SSRF-to-LLM URL safety."""

from __future__ import annotations

import socket
import urllib.error
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


def test_oversized_public_resource_remains_an_acquisition_limit():
    from jobctrl.infrastructure.enrichment.playwright_fetcher import _route_block_error
    from jobctrl.infrastructure.network.fetch_failures import PublicFetchFailureKind, PublicResponseLimitError

    page, route = _RouteOnlyPage(), _FulfillRoute()

    def oversized(*_args):
        raise PublicResponseLimitError("bounded public resource")

    guard = PublicHttpUrlRouteGuard(
        page, resolver=_resolver_for("93.184.216.34"),
        fetch_public_requests=True, request_fetcher=oversized,
    ).install()
    page.handler(route, SimpleNamespace(url="https://cdn.example/bundle.js", method="GET", headers={}))
    assert route.aborted and not route.continued
    assert guard.failure_kind is PublicFetchFailureKind.RESPONSE_LIMIT
    assert _route_block_error(guard).reason_code == "response_limit"
    guard.failure_kind = PublicFetchFailureKind.DNS_NON_PUBLIC
    assert _route_block_error(guard).reason_code == "unsafe_redirect"


@pytest.mark.parametrize("resource_type,destination", [("script", "script"), ("stylesheet", "style")])
def test_public_asset_fetch_receives_browser_owned_resource_type(resource_type, destination):
    page, route = _RouteOnlyPage(), _FulfillRoute()
    calls = []

    def fetcher(url, method, headers):
        calls.append(headers)
        return RouteFulfillment(200, {}, b"asset")

    PublicHttpUrlRouteGuard(
        page, resolver=_resolver_for("93.184.216.34"),
        fetch_public_requests=True, request_fetcher=fetcher,
    ).install()
    page.handler(route, SimpleNamespace(
        url="https://cdn.example/asset", method="GET", headers={}, resource_type=resource_type,
    ))
    assert calls[0]["sec-fetch-dest"] == destination
    assert route.fulfilled["body"] == b"asset"


@pytest.mark.parametrize("destination", ["script", "style"])
def test_public_browser_assets_accept_bounded_large_bundles(monkeypatch, destination):
    from io import BytesIO
    from jobctrl.infrastructure.network import url_safety, public_http

    body = b"x" * 4_305_305

    class Response(BytesIO):
        status = 200
        headers = {}

    opener = SimpleNamespace(open=lambda *_args, **_kwargs: Response(body))
    monkeypatch.setattr(public_http, "build_public_http_opener", lambda **_kwargs: opener)
    result = url_safety._fetch_public_route_request("https://cdn.example/asset", "GET", {"sec-fetch-dest": destination})
    assert result.body == body


def test_document_resource_type_overrides_asset_destination_header():
    page, route = _RouteOnlyPage(), _FulfillRoute()
    calls = []

    def fetcher(url, method, headers):
        calls.append(headers)
        return RouteFulfillment(200, {}, b"document")

    PublicHttpUrlRouteGuard(
        page, resolver=_resolver_for("93.184.216.34"),
        fetch_public_requests=True, request_fetcher=fetcher,
    ).install()
    page.handler(route, SimpleNamespace(
        url="https://public.example/page", method="GET",
        headers={"Sec-Fetch-Dest": "script"}, resource_type="document",
    ))
    assert calls == [{"sec-fetch-dest": "document"}]


@pytest.mark.parametrize("document_first", [False, True])
def test_document_transport_failure_cannot_be_hidden_by_subresource_failure(document_first):
    from jobctrl.infrastructure.enrichment.playwright_fetcher import _partial_resource_failure

    page = _RouteOnlyPage()

    def timeout(*_args):
        raise TimeoutError("owned timeout")

    guard = PublicHttpUrlRouteGuard(
        page, resolver=_resolver_for("93.184.216.34"), fetch_public_requests=True, request_fetcher=timeout,
    ).install()
    types = ["document", "script"] if document_first else ["script", "document"]
    for resource_type in types:
        page.handler(_FulfillRoute(), SimpleNamespace(
            url=f"https://public.example/{resource_type}", method="GET", headers={}, resource_type=resource_type,
        ))
    assert guard.failure_resource_type == "document"
    assert not _partial_resource_failure(guard)


@pytest.mark.parametrize("failure", [TimeoutError("owned timeout"), socket.gaierror("owned DNS failure")])
@pytest.mark.parametrize("resource_type", ["script", "ping"])
@pytest.mark.parametrize("entrypoint", ["import_fetcher", "discovery_batch"])
@pytest.mark.parametrize("phase", ["navigation", "navigation_timeout", "snapshot"])
def test_retryable_subresource_failure_retains_content_with_unknown_availability(
    monkeypatch, failure, resource_type, entrypoint, phase,
):
    import playwright.sync_api
    from jobctrl.domain.enrichment import ActiveState
    from jobctrl.domain.enrichment.snapshot_services import ActiveStateVerifier
    from jobctrl.infrastructure.enrichment import playwright_fetcher
    from jobctrl.infrastructure.network import url_safety

    class Page(_RouteOnlyPage):
        url = "https://public.example/role"

        def fail_resource(self):
            self.handler(_FulfillRoute(), SimpleNamespace(
                url="https://public.example/dependency", method="GET", headers={}, resource_type=resource_type,
            ))

        def goto(self, *_args, **kwargs):
            assert kwargs["wait_until"] == "domcontentloaded"
            if phase != "snapshot":
                self.fail_resource()
            if phase == "navigation_timeout":
                raise TimeoutError("Owned navigation timeout after dependency failure")
            return SimpleNamespace(status=200)

        def wait_for_load_state(self, *_args, **_kwargs):
            pass

        def title(self):
            return "Captured posting"

    page = Page()
    browser = SimpleNamespace(new_context=lambda **_kwargs: SimpleNamespace(new_page=lambda: page), close=lambda: None)

    @contextmanager
    def fake_playwright():
        yield SimpleNamespace(chromium=SimpleNamespace(launch=lambda **_kwargs: browser))

    def fetch(*_args):
        raise failure

    monkeypatch.setattr(socket, "getaddrinfo", _resolver_for("93.184.216.34"))
    monkeypatch.setattr(url_safety, "_fetch_public_route_request", fetch)
    monkeypatch.setattr(playwright.sync_api, "sync_playwright", fake_playwright)
    monkeypatch.setattr(playwright_fetcher, "_collect_json_ld", lambda _page: [])
    monkeypatch.setattr(playwright_fetcher, "_collect_main_content", lambda _page: "<main>Captured posting details</main>")
    def collect_status(*_args, **_kwargs):
        if phase == "snapshot":
            page.fail_resource()
        return "<body>Captured controls</body>", True, "owned-hash"

    monkeypatch.setattr(playwright_fetcher, "_collect_status_html", collect_status)

    if entrypoint == "import_fetcher":
        result = PlaywrightDetailPageFetcher(raise_on_unavailable=True)._fetch_page(page.url, "owned-time", user_agent="JobCtrl", request_headers={})
    else:
        captured = []
        monkeypatch.setattr(detail, "_collect_json_ld", playwright_fetcher._collect_json_ld)
        monkeypatch.setattr(detail, "_collect_main_content", playwright_fetcher._collect_main_content)
        monkeypatch.setattr(detail, "_collect_status_html", playwright_fetcher._collect_status_html)

        def extract(page, *_args, **_kwargs):
            captured.append(page)
            return {"status": "captured"}

        monkeypatch.setattr(detail, "_extract_detail_page", extract)
        scrape_detail_page(page, page.url, session=offline_session(), page_interpreter=object())
        assert len(captured) == 1
        result = captured[0]

    assert result.html == "<main>Captured posting details</main>"
    assert not result.status_evidence_complete
    assert result.status_evidence_reason in {"public_resource_timeout", "public_resource_dns_failure"}
    signals = []
    active, reason = ActiveStateVerifier(page_interpreter=object()).verify(result, signals=signals)
    assert active is ActiveState.UNKNOWN
    assert reason == result.status_evidence_reason
    assert signals == [{"kind": "acquisition_failure", "value": reason}]


@pytest.mark.parametrize("resource_type", ["document", "iframe"])
@pytest.mark.parametrize("failure", [TimeoutError("owned timeout"), socket.gaierror("owned DNS failure")])
def test_batch_document_failure_never_reaches_extraction(monkeypatch, resource_type, failure):
    from jobctrl.infrastructure.network import url_safety

    class Page(_RouteOnlyPage):
        url = "https://public.example/role"

        def goto(self, *_args, **_kwargs):
            self.handler(_FulfillRoute(), SimpleNamespace(
                url=self.url, method="GET", headers={}, resource_type=resource_type,
            ))
            return SimpleNamespace(status=200)

        def wait_for_load_state(self, *_args, **_kwargs):
            pass

    def fail(*_args):
        raise failure

    def forbidden(*_args, **_kwargs):
        pytest.fail("A failed document cannot be collected or interpreted")

    monkeypatch.setattr(socket, "getaddrinfo", _resolver_for("93.184.216.34"))
    monkeypatch.setattr(url_safety, "_fetch_public_route_request", fail)
    monkeypatch.setattr(detail, "_page_to_detail_page", forbidden)
    monkeypatch.setattr(detail, "_extract_detail_page", forbidden)
    page = Page()
    result = scrape_detail_page(page, page.url, session=offline_session(), page_interpreter=object())
    assert result["status"] == "error"
    assert result["fetch_failure_kind"] in {"timeout", "dns_failure"}
    assert page.handler is None


@pytest.mark.parametrize("destination,size", [("document", 2_000_001), ("empty", 2_000_001), ("script", 16_000_001), ("style", 16_000_001)])
def test_public_document_data_and_asset_limits_remain_enforced(monkeypatch, destination, size):
    from io import BytesIO
    from jobctrl.infrastructure.network import url_safety, public_http
    from jobctrl.infrastructure.network.fetch_failures import PublicResponseLimitError

    class Response(BytesIO):
        status = 200
        headers = {}

    opener = SimpleNamespace(open=lambda *_args, **_kwargs: Response(b"x" * size))
    monkeypatch.setattr(public_http, "build_public_http_opener", lambda **_kwargs: opener)
    with pytest.raises(PublicResponseLimitError):
        url_safety._fetch_public_route_request("https://public.example/resource", "GET", {"sec-fetch-dest": destination})


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


@pytest.mark.parametrize("strict_availability", [False, True])
def test_forbidden_browser_write_performs_no_destination_resolution(strict_availability):
    page, route = _RouteOnlyPage(), _FulfillRoute()

    def unexpected(*_args, **_kwargs):
        raise AssertionError("A forbidden write must not resolve or fetch any destination")

    guard = PublicHttpUrlRouteGuard(
        page, resolver=unexpected, fetch_public_requests=True, request_fetcher=unexpected,
        include_resource_destination=strict_availability,
    ).install()
    page.handler(route, SimpleNamespace(
        url="https://unresolvable.example/ping", method="POST", headers={}, resource_type="ping",
    ))
    assert route.aborted and route.fulfilled is None and not route.continued
    assert guard.blocked is strict_availability
    if strict_availability:
        assert guard.blocked_reason == "browser_resource_method_POST"


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


@pytest.mark.parametrize("failure", [TimeoutError("timed out"), ConnectionResetError("connection reset")])
def test_public_transport_failure_is_retryable_without_becoming_an_unsafe_destination(monkeypatch, failure) -> None:
    from jobctrl.infrastructure.network import url_safety

    monkeypatch.setattr(socket, "getaddrinfo", _resolver_for("93.184.216.34"))

    def fetcher(*_args):
        raise urllib.error.URLError(failure)

    monkeypatch.setattr(url_safety, "_fetch_public_route_request", fetcher)

    class Page(_RouteOnlyPage):
        url = "https://jobs.example/role"

        def goto(self, *_args, **_kwargs):
            route = _FulfillRoute()
            self.handler(route, SimpleNamespace(url=self.url, method="GET", headers={}))
            assert route.aborted and not route.continued and route.fulfilled is None
            raise RuntimeError("net::ERR_BLOCKED_BY_CLIENT")

    result = scrape_detail_page(Page(), Page.url, session=offline_session())

    assert result["security_outcome"] is None
    assert result["full_description"] is None
    assert detail._detail_failure_retryable(result)


def test_temporary_dns_failure_stops_navigation_but_is_retryable(monkeypatch) -> None:
    def unavailable(*_args, **_kwargs):
        raise socket.gaierror(socket.EAI_AGAIN, "temporary failure in name resolution")

    monkeypatch.setattr(socket, "getaddrinfo", unavailable)
    result = scrape_detail_page(_ExplodingPage(), "https://jobs.example/role", session=offline_session())

    assert result["security_outcome"] is None
    assert result["full_description"] is None
    assert detail._detail_failure_retryable(result)


def test_rejected_redirect_records_its_actual_target_for_later_destination_recheck() -> None:
    import urllib.request

    from jobctrl.infrastructure.network.fetch_failures import PublicFetchFailureKind
    from jobctrl.infrastructure.network.public_http import PublicDestinationRedirectHandler

    rejected_url = "https://signin.example.test/button?scope=public"
    redirect = PublicDestinationRedirectHandler(resolver=_resolver_for("192.0.0.88"))
    page = _RouteOnlyPage()

    def fetcher(url, _method, _headers):
        redirect.redirect_request(urllib.request.Request(url), None, 302, "Found", {}, rejected_url)
        pytest.fail("non-public redirect must not be fetched")

    guard = PublicHttpUrlRouteGuard(
        page, resolver=_resolver_for("93.184.216.34"), fetch_public_requests=True, request_fetcher=fetcher,
    ).install()
    route = _FulfillRoute()
    page.handler(route, SimpleNamespace(url="https://jobs.example/role", method="GET", headers={}))
    assert route.aborted and not route.continued and route.fulfilled is None
    assert guard.blocked_url == rejected_url
    assert guard.failure_kind is PublicFetchFailureKind.DNS_NON_PUBLIC


@pytest.mark.parametrize("private_first", [False, True])
def test_transport_failure_never_replaces_a_page_safety_denial(private_first) -> None:
    from jobctrl.infrastructure.network.fetch_failures import PublicFetchFailureKind

    page = _RouteOnlyPage()

    def fetcher(*_args):
        raise TimeoutError("transient timeout")

    guard = PublicHttpUrlRouteGuard(
        page, resolver=_resolver_for("93.184.216.34"), fetch_public_requests=True, request_fetcher=fetcher,
    ).install()
    urls = ["http://127.0.0.1/private", "https://jobs.example/role"]
    for url in urls if private_first else reversed(urls):
        route = _FulfillRoute()
        page.handler(route, SimpleNamespace(url=url, method="GET", headers={}))
        assert route.aborted and not route.continued and route.fulfilled is None
    assert guard.blocked_url == "http://127.0.0.1/private"
    assert guard.failure_kind is PublicFetchFailureKind.NON_PUBLIC_LITERAL


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


@pytest.mark.parametrize("denial_phase", ["before_capture", "after_capture"])
def test_live_chrome_preserves_typed_destination_denial(
    monkeypatch: pytest.MonkeyPatch, denial_phase: str,
) -> None:
    """Both live-capture checks must use the shared typed fetch-failure path."""
    url = "https://jobs.example/role"
    validation_calls: list[str] = []
    capture_calls: list[str] = []

    def validate(destination: str) -> PublicUrlDecision:
        validation_calls.append(destination)
        address = "93.184.216.34" if denial_phase == "after_capture" and len(validation_calls) == 1 else "10.0.0.5"
        return validate_public_http_url(destination, resolver=_resolver_for(address))

    def capture(destination: str, **_kwargs: object) -> SimpleNamespace:
        capture_calls.append(destination)
        return SimpleNamespace(final_url=url)

    def reject_extraction(*_args: object, **_kwargs: object) -> None:
        pytest.fail("destination denial must stop before snapshot extraction")

    monkeypatch.setattr(detail, "validate_public_http_url", validate)
    monkeypatch.setattr(detail, "_live_result_to_detail_page", reject_extraction)
    result = detail.scrape_detail_page_via_live_chrome(
        SimpleNamespace(rendered_page=capture), url, session=offline_session(),
    )

    assert capture_calls == ([url] if denial_phase == "after_capture" else [])
    assert len(validation_calls) == (2 if denial_phase == "after_capture" else 1)
    assert result["status"] == "blocked"
    assert result["security_outcome"] == "unsafe_url"
    assert result["fetch_failure_kind"] == "dns_non_public"
    assert result["blocked_url"] == url
    assert "non-public" in result["error"]
    assert not detail._detail_failure_retryable(result)
