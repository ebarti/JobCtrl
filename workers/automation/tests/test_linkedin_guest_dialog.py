"""Offered guest-dialog dismissal uses only owned, offline browser pages."""
import pytest
from playwright.sync_api import sync_playwright

from jobctrl.domain.enrichment import DetailPage
from jobctrl.domain.enrichment.services import CssSelectorExtractor
from jobctrl.infrastructure.enrichment.playwright_fetcher import (
    DetailPageFetchUnavailable,
    _collect_main_content,
    _dismiss_optional_linkedin_dialog,
)

_DESCRIPTION = "Owned synthetic posting responsibilities and requirements. " * 10
_HTML = """<html><body><main aria-hidden="true"><div class="description__text">
<div class="show-more-less-html__markup">""" + _DESCRIPTION + """</div></div></main>
<div id="dialog" role="dialog"><form onsubmit="window.submits++;return false">
<button type="button" class="contextual-sign-in-modal__modal-dismiss"
onclick="window.dismisses++;document.getElementById('dialog').hidden=true;
document.querySelector('main').removeAttribute('aria-hidden')">Dismiss</button>
<button type="submit">Sign in</button></form></div>
<script>window.dismisses=0;window.submits=0;</script></body></html>"""


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as playwright:
        owner = playwright.chromium.launch(headless=True)
        try:
            yield owner
        finally:
            owner.close()


@pytest.fixture
def page(browser):
    owner = browser.new_page()
    owner.context.set_offline(True)
    try:
        yield owner
    finally:
        owner.close()


def load(page, url="https://www.linkedin.com/jobs/view/owned", html=_HTML):
    page.route("**/*", lambda route: route.fulfill(status=200, content_type="text/html", body=html))
    page.goto(url)


def test_offered_guest_dialog_is_closed_before_description_capture(page):
    load(page)
    assert not CssSelectorExtractor().extract(DetailPage(url=page.url, html=_collect_main_content(page))).ok
    assert _dismiss_optional_linkedin_dialog(page)
    result = CssSelectorExtractor().extract(DetailPage(url=page.url, html=_collect_main_content(page)))
    assert result.ok and result.full_description.text == _DESCRIPTION.strip()
    assert page.evaluate("[window.dismisses,window.submits]") == [1, 0]
    assert page.url == "https://www.linkedin.com/jobs/view/owned"
    assert not _dismiss_optional_linkedin_dialog(page)  # No second click on a hidden control.


@pytest.mark.parametrize("url", [
    "https://example.com/jobs/view/owned",
    "https://www.linkedin.com.example.com/jobs/view/owned",
    "https://www.linkedin.com/login",
])
def test_other_origins_and_non_posting_routes_are_untouched(page, url):
    load(page, url=url)
    before = page.content()
    assert not _dismiss_optional_linkedin_dialog(page)
    assert page.content() == before
    assert page.evaluate("[window.dismisses,window.submits]") == [0, 0]


def test_required_wall_without_offered_dismiss_control_remains_untouched(page):
    load(page, html=_HTML.replace('contextual-sign-in-modal__modal-dismiss', 'ordinary-control'))
    before = page.content()
    assert not _dismiss_optional_linkedin_dialog(page)
    assert page.content() == before
    assert page.evaluate("[window.dismisses,window.submits]") == [0, 0]
    assert not CssSelectorExtractor().extract(DetailPage(url=page.url, html=_collect_main_content(page))).ok


def test_unexpected_navigation_cannot_keep_original_posting_identity(page):
    load(page, html=_HTML.replace('window.dismisses++;', "window.location='/jobs/view/other';"))
    with pytest.raises(DetailPageFetchUnavailable, match="navigated away"):
        _dismiss_optional_linkedin_dialog(page)
    assert page.url == "https://www.linkedin.com/jobs/view/other"

@pytest.mark.parametrize("effective_type", ["submit", "default"])
def test_matching_form_submit_control_is_never_clicked(page, effective_type):
    html = _HTML.replace('type="button"', 'type="submit"' if effective_type == "submit" else '')
    load(page, html=html)
    before = page.content()
    assert not _dismiss_optional_linkedin_dialog(page)
    assert page.content() == before
    assert page.evaluate("[window.dismisses,window.submits]") == [0, 0]


def test_transparent_control_cannot_hide_the_actual_dismiss_control(page):
    html = _HTML.replace('<div id="dialog" role="dialog">',
        '<button type="button" class="contextual-sign-in-modal__modal-dismiss" '
        'style="opacity:0" onclick="window.concealedClicks++">Concealed</button>'
        '<div id="dialog" role="dialog">')
    html = html.replace('window.dismisses=0;', 'window.concealedClicks=0;window.dismisses=0;')
    load(page, html=html)
    assert _dismiss_optional_linkedin_dialog(page)
    assert page.evaluate("[window.concealedClicks,window.dismisses,window.submits]") == [0, 1, 0]


def delayed_navigation_html():
    return _HTML.replace('window.dismisses++;',
        "window.dismisses++;setTimeout(()=>{history.replaceState({},'', '/jobs/view/other');"
        "document.querySelector('main').innerHTML='<p>Changed posting.</p>';},100);")


def test_batch_capture_rejects_delayed_post_dismissal_identity_change(page, monkeypatch):
    from jobctrl.enrichment import detail
    load(page, html=delayed_navigation_html())
    collect = detail._collect_main_content

    def delayed_collect(owner):
        owner.wait_for_timeout(150)
        return collect(owner)

    monkeypatch.setattr(detail, "_collect_main_content", delayed_collect)
    with pytest.raises(DetailPageFetchUnavailable, match="capture was being collected"):
        detail._page_to_detail_page(page, page.url, status=200)
    assert page.url == "https://www.linkedin.com/jobs/view/other"


def test_direct_capture_rejects_delayed_post_dismissal_identity_change(browser, monkeypatch):
    from contextlib import nullcontext
    from types import SimpleNamespace
    from playwright import sync_api
    from jobctrl.infrastructure.enrichment import playwright_fetcher as fetcher
    contexts = []

    class OwnedBrowser:
        def new_context(self, **kwargs):
            context = browser.new_context(**kwargs)
            context.set_offline(True)
            contexts.append(context)
            return context

        def close(self):
            for context in contexts:
                context.close()

    class OwnedGuard:
        blocked = False

        def __init__(self, owner, **kwargs):
            self.owner = owner

        def install(self):
            self.owner.route("**/*", lambda route: route.fulfill(
                status=200, content_type="text/html", body=delayed_navigation_html()))
            return self

        def close(self):
            pass

    chromium = SimpleNamespace(launch=lambda **kwargs: OwnedBrowser())
    monkeypatch.setattr(sync_api, "sync_playwright", lambda: nullcontext(SimpleNamespace(chromium=chromium)))
    # The owned route replaces only transport; separate URL-safety tests exercise
    # the production network guard. This probe owns the complete DOM capture.
    monkeypatch.setattr(fetcher, "PublicHttpUrlRouteGuard", OwnedGuard)
    monkeypatch.setattr(fetcher, "validate_public_http_url", lambda url: SimpleNamespace(allowed=True))
    collect = fetcher._collect_main_content

    def delayed_collect(owner):
        owner.wait_for_timeout(150)
        return collect(owner)

    monkeypatch.setattr(fetcher, "_collect_main_content", delayed_collect)
    with pytest.raises(DetailPageFetchUnavailable, match="capture was being collected"):
        fetcher.PlaywrightDetailPageFetcher()._fetch_page(
            "https://www.linkedin.com/jobs/view/owned", "2026-10-22T00:00:00Z", user_agent="Owned capture QA")
