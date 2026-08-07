from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from jobctrl.infrastructure.enrichment import linkedin_apply_resolver as resolver_module
from jobctrl.infrastructure.network import PublicUrlDecision
from jobctrl.infrastructure.enrichment.linkedin_apply_resolver import (
    LinkedInApplyUrlResolver,
    _extract_external_from_redirect_url,
    _is_external_apply_url,
)


@pytest.fixture(autouse=True)
def permit_browser_for_existing_resolver_parsing_tests(monkeypatch: pytest.MonkeyPatch) -> None:
    """These tests exercise URL safety after authenticated capability validation."""

    monkeypatch.setattr(
        resolver_module,
        "require_system_browser_capability",
        lambda _capability: Path("/test/Chromium"),
    )


def _allow_public_url(_url: str) -> PublicUrlDecision:
    return PublicUrlDecision(True)


def _deny_loopback_url(url: str) -> PublicUrlDecision:
    if "127.0.0.1" in url or "localhost" in url or "169.254.169.254" in url:
        return PublicUrlDecision(False, "non-public test target")
    return PublicUrlDecision(True)


def test_external_apply_url_rejects_linkedin_hosts() -> None:
    original = "https://www.linkedin.com/jobs/view/123"

    assert not _is_external_apply_url("https://www.linkedin.com/jobs/view/123", original)
    assert not _is_external_apply_url("https://linkedin.com/jobs/apply/123", original)
    assert not _is_external_apply_url("mailto:jobs@example.com", original)


def test_external_apply_url_accepts_company_hosts() -> None:
    original = "https://www.linkedin.com/jobs/view/123"

    assert _is_external_apply_url("https://boards.greenhouse.io/acme/jobs/1", original)
    assert _is_external_apply_url("https://jobs.ashbyhq.com/acme/role", original)


def test_extract_external_url_from_linkedin_redirect_query() -> None:
    original = "https://www.linkedin.com/jobs/view/123"
    redirect = "https://www.linkedin.com/jobs/apply/123?url=https%3A%2F%2Fjobs.ashbyhq.com%2Facme%2Frole"

    assert (
        _extract_external_from_redirect_url(
            redirect,
            original,
            url_safety_checker=_allow_public_url,
        )
        == "https://jobs.ashbyhq.com/acme/role"
    )


def test_extract_external_url_ignores_linkedin_redirect_target() -> None:
    original = "https://www.linkedin.com/jobs/view/123"
    redirect = "https://www.linkedin.com/jobs/apply/123?url=https%3A%2F%2Fwww.linkedin.com%2Fjobs%2Fview%2F123"

    assert _extract_external_from_redirect_url(redirect, original) is None


def test_extract_external_url_rejects_non_public_redirect_target() -> None:
    original = "https://www.linkedin.com/jobs/view/123"
    redirect = "https://www.linkedin.com/jobs/apply/123?url=http%3A%2F%2F127.0.0.1%3A8766%2Fv1%2Fprofile"

    assert (
        _extract_external_from_redirect_url(
            redirect,
            original,
            url_safety_checker=_deny_loopback_url,
        )
        is None
    )


class _ExplodingContext:
    def new_page(self) -> object:
        raise AssertionError("unsafe resolver URL must be blocked before opening a page")


def test_resolve_blocks_unsafe_job_url_before_opening_page() -> None:
    resolver = LinkedInApplyUrlResolver(
        url_safety_checker=lambda _url: PublicUrlDecision(False, "non-public test target")
    )
    resolver._context = _ExplodingContext()

    result = resolver.resolve("http://127.0.0.1:8766/jobs/view/123")

    assert result.application_url is None
    assert result.method == "unsafe_url"
    assert result.error == "non-public test target"


class _AbortRoute:
    aborted = False
    continued = False

    def abort(self, _code: str | None = None) -> None:
        self.aborted = True

    def continue_(self) -> None:
        self.continued = True


class _RouteBlockedPage:
    url = "https://www.linkedin.com/jobs/view/123"

    def __init__(self) -> None:
        self._handler = None
        self.closed = False
        self.unrouted = False

    def route(self, _pattern: str, handler) -> None:  # noqa: ANN001 - Playwright-shaped double
        self._handler = handler

    def unroute(self, _pattern: str, _handler) -> None:  # noqa: ANN001 - Playwright-shaped double
        self.unrouted = True

    def goto(self, _url: str, **_kwargs: object) -> object:
        assert self._handler is not None
        route = _AbortRoute()
        self._handler(route, SimpleNamespace(url="http://127.0.0.1:8766/v1/profile"))
        assert route.aborted
        raise RuntimeError("net::ERR_BLOCKED_BY_CLIENT")

    def close(self) -> None:
        self.closed = True


class _NeverVisibleLocator:
    def wait_for(self, *_args: object, **_kwargs: object) -> None:
        raise RuntimeError("not visible")


class _ExtensionNoisePage:
    url = "https://www.linkedin.com/jobs/view/123"

    def __init__(self) -> None:
        self._handler = None
        self.extension_request_aborted = False
        self.unrouted = False
        self.closed = False
        self._locator = _NeverVisibleLocator()

    def route(self, _pattern: str, handler) -> None:  # noqa: ANN001
        self._handler = handler

    def unroute(self, _pattern: str, _handler) -> None:  # noqa: ANN001
        self.unrouted = True

    def goto(self, _url: str, **_kwargs: object) -> None:
        assert self._handler is not None
        route = _AbortRoute()
        self._handler(
            route,
            SimpleNamespace(url="chrome-extension://example/background.html"),
        )
        self.extension_request_aborted = route.aborted

    def wait_for_load_state(self, *_args: object, **_kwargs: object) -> None:
        return None

    def locator(self, *_args: object, **_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(first=self._locator)

    def get_by_role(self, *_args: object, **_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(first=self._locator)

    def close(self) -> None:
        self.closed = True


def test_resolve_installs_public_route_guard_before_navigation() -> None:
    page = _RouteBlockedPage()
    resolver = LinkedInApplyUrlResolver(url_safety_checker=_allow_public_url)
    resolver._context = SimpleNamespace(new_page=lambda: page)

    result = resolver.resolve("https://www.linkedin.com/jobs/view/123")

    assert result.application_url is None
    assert result.method == "unsafe_url"
    assert "public" in str(result.error)
    assert page.unrouted is True
    assert page.closed is True


def test_resolve_ignores_blocked_extension_noise_without_weakening_guard() -> None:
    page = _ExtensionNoisePage()
    resolver = LinkedInApplyUrlResolver(url_safety_checker=_allow_public_url)
    resolver._context = SimpleNamespace(new_page=lambda: page)

    result = resolver.resolve("https://www.linkedin.com/jobs/view/123")

    assert result.application_url is None
    assert result.method == "apply_button_missing"
    assert page.extension_request_aborted is True
    assert page.unrouted is True
    assert page.closed is True


class _PopupRouteContext:
    def __init__(self) -> None:
        self._handler = None
        self.unsafe_request_aborted = False
        self.unrouted = False

    def route(self, _pattern: str, handler) -> None:  # noqa: ANN001 - Playwright-shaped double
        self._handler = handler

    def unroute(self, _pattern: str, _handler) -> None:  # noqa: ANN001 - Playwright-shaped double
        self.unrouted = True

    def trigger_unsafe_popup_navigation(self) -> None:
        assert self._handler is not None
        route = _AbortRoute()
        self._handler(route, SimpleNamespace(url="http://127.0.0.1:8766/v1/profile"))
        self.unsafe_request_aborted = route.aborted
        assert route.aborted


class _PopupOnlyLocator:
    def __init__(self, context: _PopupRouteContext) -> None:
        self._context = context

    def wait_for(self, *_args: object, **_kwargs: object) -> None:
        return None

    def get_attribute(self, *_args: object, **_kwargs: object) -> None:
        return None

    def click(self, *_args: object, **_kwargs: object) -> None:
        self._context.trigger_unsafe_popup_navigation()


class _PopupInfo:
    def __init__(self, popup: "_PopupPage") -> None:
        self.value = popup

    def __enter__(self) -> "_PopupInfo":
        return self

    def __exit__(self, *_args: object) -> None:
        return None


class _PopupPage:
    url = "https://www.linkedin.com/jobs/view/123"

    def __init__(self) -> None:
        self.closed = False

    def wait_for_load_state(self, *_args: object, **_kwargs: object) -> None:
        return None

    def wait_for_timeout(self, *_args: object, **_kwargs: object) -> None:
        return None

    def close(self) -> None:
        self.closed = True


class _LoadedPageWithPopupApply:
    url = "https://www.linkedin.com/jobs/view/123"

    def __init__(self, context: _PopupRouteContext, locator: _PopupOnlyLocator) -> None:
        self.context = context
        self._locator = locator
        self._popup = _PopupPage()

    def locator(self, *_args: object, **_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(first=self._locator)

    def get_by_role(self, *_args: object, **_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(first=self._locator)

    def expect_popup(self, *_args: object, **_kwargs: object) -> _PopupInfo:
        return _PopupInfo(self._popup)


def test_resolve_loaded_page_guards_popup_initial_navigation() -> None:
    context = _PopupRouteContext()
    locator = _PopupOnlyLocator(context)
    page = _LoadedPageWithPopupApply(context, locator)
    resolver = LinkedInApplyUrlResolver(
        timeout_seconds=0.01,
        url_safety_checker=_allow_public_url,
    )

    result = resolver.resolve_loaded_page(page, "https://www.linkedin.com/jobs/view/123")

    assert result.application_url is None
    assert result.method == "unsafe_url"
    assert "public" in str(result.error)
    assert context.unsafe_request_aborted is True
    assert context.unrouted is True


class _VisibleApplyLocator:
    def wait_for(self, *_args: object, **_kwargs: object) -> None:
        return None

    def get_attribute(self, *_args: object, **_kwargs: object) -> str:
        return "http://127.0.0.1:8766/v1/profile"


class _LoadedPageWithUnsafeHref:
    url = "https://www.linkedin.com/jobs/view/123"

    def __init__(self) -> None:
        self._locator = _VisibleApplyLocator()

    def route(self, *_args: object, **_kwargs: object) -> None:
        return None

    def unroute(self, *_args: object, **_kwargs: object) -> None:
        return None

    def locator(self, *_args: object, **_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(first=self._locator)

    def get_by_role(self, *_args: object, **_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(first=self._locator)


def test_resolve_loaded_page_rejects_unsafe_href_before_returning_it() -> None:
    resolver = LinkedInApplyUrlResolver(url_safety_checker=_deny_loopback_url)

    result = resolver.resolve_loaded_page(
        _LoadedPageWithUnsafeHref(),
        "https://www.linkedin.com/jobs/view/123",
    )

    assert result.application_url is None
    assert result.method == "external_url_missing"
