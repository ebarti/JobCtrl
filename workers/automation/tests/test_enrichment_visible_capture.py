"""Structural capture regressions through real, owned browser DOMs."""
from __future__ import annotations

import pytest
from playwright.sync_api import sync_playwright

from jobctrl.domain.enrichment import DetailPage
from jobctrl.domain.enrichment.services import CssSelectorExtractor
from jobctrl.infrastructure.enrichment.playwright_fetcher import (
    _collect_json_ld,
    _collect_main_content,
    _collect_status_html,
)

_DESCRIPTION = (
    "Lead the fictional engineering team. Build reliable services, coach engineers, "
    "review designs and improve delivery. Requirements include distributed systems "
    "and clear written communication. "
) * 3
_POSTING = (
    '<section class="description__text"><div class="show-more-less-html__markup">'
    + _DESCRIPTION + '</div><a href="/apply/selected">Apply</a></section>'
)


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


def collect(page, content, *, main):
    container = "main" if main else "section"
    page.set_content('<html><body><' + container + '>' + content + '</' + container + '></body></html>')
    before = page.content()
    status_before = _collect_status_html(page)
    html = _collect_main_content(page)
    assert page.content() == before  # Capture only copies, never changes the page.
    assert _collect_status_html(page) == status_before
    return html, CssSelectorExtractor().extract(DetailPage(url="https://example.com/jobs/selected", html=html))


@pytest.mark.parametrize("main", [True, False], ids=["main", "body-fallback"])
@pytest.mark.parametrize("hidden", [
    'hidden', 'aria-hidden="true"',
    'class="concealed"', 'style="visibility:hidden"', 'style="opacity:0"',
])
def test_hidden_preamble_cannot_consume_description_budget(page, main, hidden):
    preamble = (
        '<style>.concealed { display:none }</style><div ' + hidden + '>'
        '<a href="/apply/hidden">Hidden application</a>'
        '<div class="description__text"><div class="show-more-less-html__markup">'
        + 'Non-visible dialog content. ' * 3000 + '</div></div></div>'
        + '<!--' + 'Non-rendered localization payload. ' * 2000 + '-->'
    )
    html, result = collect(page, preamble + _POSTING, main=main)
    assert len(preamble) > 50000
    assert len(html) < 50000
    assert 'Non-visible dialog content' not in html
    assert 'Non-rendered localization' not in html
    assert result.ok
    assert result.full_description.text == _DESCRIPTION.strip()
    assert result.application_url.value == "https://example.com/apply/selected"


@pytest.mark.parametrize("main", [True, False], ids=["main", "body-fallback"])
def test_visible_descendant_of_visibility_hidden_container_is_retained(page, main):
    html, result = collect(
        page,
        '<div style="visibility:hidden">Hidden parent text'
        '<div style="visibility:visible">' + _POSTING + '</div></div>',
        main=main,
    )
    assert 'Hidden parent text' not in html
    assert result.ok
    assert result.full_description.text == _DESCRIPTION.strip()
    assert result.application_url.value == "https://example.com/apply/selected"


@pytest.mark.parametrize("hidden_style", ["display:none", "opacity:0"])
@pytest.mark.parametrize("ancestor", [True, False], ids=["hidden-ancestor", "hidden-main"])
def test_hidden_selected_main_does_not_mask_visible_article(page, hidden_style, ancestor):
    concealed = _POSTING.replace(_DESCRIPTION, "Concealed posting. " * 30).replace("/apply/selected", "/apply/concealed")
    hidden = (
        '<div style="' + hidden_style + '"><main>' + concealed + '</main></div>'
        if ancestor else '<main style="' + hidden_style + '">' + concealed + '</main>'
    )
    page.set_content('<html><body>' + hidden + '<article>' + _POSTING + '</article></body></html>')
    before = page.content()
    html = _collect_main_content(page)
    assert page.content() == before
    assert "Concealed posting" not in html
    result = CssSelectorExtractor().extract(DetailPage(url="https://example.com/jobs/selected", html=html))
    assert result.ok
    assert result.full_description.text == _DESCRIPTION.strip()
    assert result.application_url.value == "https://example.com/apply/selected"


@pytest.mark.parametrize("main", [True, False], ids=["main", "body-fallback"])
def test_css_overridden_hidden_attribute_keeps_visible_descendant(page, main):
    html, result = collect(page,
        '<style>[hidden] { display:block }</style>'
        '<div hidden style="visibility:hidden">Hidden parent text'
        '<div style="visibility:visible">' + _POSTING + '</div></div>', main=main)
    assert "Hidden parent text" not in html
    assert result.ok
    assert result.full_description.text == _DESCRIPTION.strip()


@pytest.mark.parametrize("main", [True, False], ids=["main", "body-fallback"])
def test_visible_display_contents_text_does_not_require_element_rectangle(page, main):
    html, result = collect(page,
        '<style>.description__text,.show-more-less-html__markup { display:contents }</style>'
        '<div style="visibility:hidden">Hidden parent text'
        '<div style="display:contents;visibility:visible">'
        + _POSTING.replace('<a href="/apply/selected">Apply</a>', '') + '</div></div>', main=main)
    assert "Hidden parent text" not in html
    assert result.ok
    assert result.full_description.text == _DESCRIPTION.strip()


@pytest.mark.parametrize("main", [True, False], ids=["main", "body-fallback"])
def test_visible_inert_posting_remains_readable(page, main):
    html, result = collect(page, '<div inert>' + _POSTING + '</div>', main=main)
    assert result.ok
    assert result.full_description.text == _DESCRIPTION.strip()


@pytest.mark.parametrize("main", [True, False], ids=["main", "body-fallback"])
def test_visible_content_still_obeys_original_budget(page, main):
    html, result = collect(page, '<p>' + 'Visible introductory content. ' * 2500 + '</p>' + _POSTING, main=main)
    assert len(html) == 50000
    assert not result.ok


def test_structured_description_is_collected_independently(page):
    page.set_content('<html><body><main>' + _POSTING + '</main>'
        '<script type="application/ld+json">{"@type":"JobPosting","description":"Structured posting"}</script>'
        '</body></html>')
    expected = [{"@type": "JobPosting", "description": "Structured posting"}]
    assert _collect_json_ld(page) == expected
    assert 'application/ld+json' not in _collect_main_content(page)
    assert _collect_json_ld(page) == expected
