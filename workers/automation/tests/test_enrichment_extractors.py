"""Phase 7 / S-26: Enrichment domain services (extractors).

The three extractors must:

  * be pure (no I/O — they consume a ``DetailPage`` value object),
  * return a ``ExtractionResult`` with the right ``ok`` flag,
  * preserve the legacy "JSON-LD first, then CSS, then LLM" cascade
    behaviour when the pages they're given match the legacy fixtures.
"""

from __future__ import annotations

from typing import Sequence
from types import SimpleNamespace

import pytest
from bs4 import BeautifulSoup

from jobctrl.domain.enrichment import DetailPage
from jobctrl.domain.enrichment.services import (
    CssSelectorExtractor,
    JsonLdExtractor,
    LlmExtractor,
)
from jobctrl.domain.ports.llm import LlmMessage, LlmPort
from jobctrl.infrastructure.enrichment.playwright_fetcher import _collect_json_ld, _collect_main_content


class _StubLlm(LlmPort):
    """Test double for ``LlmPort`` — returns a canned JSON response."""

    def __init__(self, response: str) -> None:
        self._response = response
        self.calls: list[Sequence[LlmMessage]] = []

    def chat(
        self,
        messages: Sequence[LlmMessage],
        *,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> str:
        self.calls.append(list(messages))
        return self._response


# ---------------------------------------------------------------------------
# JsonLdExtractor
# ---------------------------------------------------------------------------


def test_json_ld_extractor_finds_top_level_job_posting() -> None:
    page = DetailPage(
        url="https://example.com/jobs/1",
        json_ld=(
            {
                "@type": "JobPosting",
                "description": "<p>Build great things at Acme.</p>" * 5,
                "directApply": True,
                "url": "https://example.com/apply",
            },
        ),
    )
    result = JsonLdExtractor().extract(page)
    assert result.ok
    assert result.full_description is not None
    assert "Build great things" in result.full_description.text
    assert result.application_url is not None
    assert result.application_url.value == "https://example.com/apply"


def test_json_ld_extractor_handles_graph_wrapper() -> None:
    page = DetailPage(
        url="https://example.com/jobs/1",
        json_ld=(
            {
                "@graph": [
                    {"@type": "Organization", "name": "Acme"},
                    {
                        "@type": "JobPosting",
                        "description": "Long description text" * 10,
                        "url": "https://example.com/apply",
                    },
                ]
            },
        ),
    )
    result = JsonLdExtractor().extract(page)
    assert result.ok


def test_json_ld_extractor_skips_too_short_descriptions() -> None:
    page = DetailPage(
        url="https://example.com/jobs/1",
        json_ld=(
            {"@type": "JobPosting", "description": "tiny", "url": "https://x"},
        ),
    )
    result = JsonLdExtractor().extract(page)
    assert not result.ok


def test_json_ld_extractor_returns_failed_for_no_json_ld() -> None:
    page = DetailPage(url="https://example.com/jobs/1")
    result = JsonLdExtractor().extract(page)
    assert not result.ok


# ---------------------------------------------------------------------------
# CssSelectorExtractor
# ---------------------------------------------------------------------------


_HTML_WITH_JOB_DESC = """
<html><body>
  <main>
    <article>
      <div class="job-description">
        Senior Engineer at Acme Corp. We are looking for a strong
        engineer to build great products. Responsibilities include
        building APIs, owning systems, and mentoring junior engineers.
        Requirements: 5+ years experience, Python, Postgres.
      </div>
      <a href="/careers/apply/123" class="apply-button">Apply now</a>
    </article>
  </main>
</body></html>
"""


def test_css_extractor_finds_description_and_apply_url() -> None:
    page = DetailPage(
        url="https://example.com/jobs/1",
        final_url="https://example.com/jobs/1",
        html=_HTML_WITH_JOB_DESC,
    )
    result = CssSelectorExtractor().extract(page)
    assert result.ok
    assert result.full_description is not None
    assert "Senior Engineer at Acme Corp" in result.full_description.text
    assert result.application_url is not None
    assert result.application_url.value == "https://example.com/careers/apply/123"


def test_css_extractor_returns_failed_for_empty_html() -> None:
    page = DetailPage(url="https://example.com/jobs/1", html="")
    assert not CssSelectorExtractor().extract(page).ok


def test_css_extractor_skips_too_short_blocks() -> None:
    page = DetailPage(
        url="https://example.com/jobs/1",
        html='<div class="job-description">tiny</div>',
    )
    assert not CssSelectorExtractor().extract(page).ok


_GUEST_DESCRIPTION = (
    "Lead a synthetic engineering team building reliable public services. "
    "Own delivery, mentor engineers, review designs, and improve operational reliability. "
    "Requirements include Python, distributed systems, and clear written communication. "
) * 3


def _guest_linkedin_html(
    *, oversized=False, description=_GUEST_DESCRIPTION, removable_prefix=False, main_container=True
) -> str:
    # The public layout uses the same show-more component for unrelated content.
    # Meaningful content keeps the description within the collector's HTML limit.
    preamble = "<div>" + "Search results navigation. " * (1200 if oversized else 1) + "</div>"
    if removable_prefix:
        preamble = ('<div style="' + 'x' * 1200 + '">Menu</div>') * 55 + preamble
    tail = "<div>" + "Related roles. " * (4000 if oversized else 1) + "</div>"
    return (
        '<html><body><nav>Account navigation</nav>' + ('<main>' if main_container else '<section>')
        + preamble
        + '<aside class="show-more-less-html__markup">'
        + "Unrelated employer overview. " * 20
        + '</aside><section class="description"><div class="description__text">'
        '<div class="show-more-less-html"><div class="show-more-less-html__markup '
        'show-more-less-html__markup--clamp-after-20 relative overflow-hidden" style="color:red">'
        '<p>' + description + '</p><script>unrelated script</script></div>'
        '<button>Show more</button></div><button>Show less</button></div></section>'
        + tail
        + ('</main>' if main_container else '</section>')
        + '<footer>Unrelated footer</footer></body></html>'
    )


class _GuestLinkedInPage:
    """Synthetic DOM boundary; production code still collects and cleans HTML."""

    def __init__(self, html):
        self.soup = BeautifulSoup(html, "html.parser")
        self.body_fallback_calls = 0

    @staticmethod
    def _element(element):
        return SimpleNamespace(
            inner_text=lambda: element.get_text(" ", strip=True),
            inner_html=element.decode_contents,
        )

    def query_selector(self, selector):
        element = self.soup.select_one(selector)
        return self._element(element) if element is not None else None

    def query_selector_all(self, selector):
        return [self._element(element) for element in self.soup.select(selector)]

    def evaluate(self, script):
        assert "document.body.cloneNode(true)" in script
        self.body_fallback_calls += 1
        clone = BeautifulSoup(str(self.soup.body), "html.parser")
        for element in clone.select("nav, header, footer, script, style, noscript, svg, iframe"):
            element.decompose()
        return clone.body.decode_contents()


@pytest.mark.parametrize("oversized", [False, True])
def test_guest_linkedin_description_survives_production_collection_and_cleaning(oversized) -> None:
    page = _GuestLinkedInPage(_guest_linkedin_html(oversized=oversized))
    cleaned = _collect_main_content(page)
    assert page.body_fallback_calls == 0
    assert "Unrelated employer overview" in cleaned  # A broad show-more selector would pick this first.
    assert "Show more" in cleaned  # The outer description wrapper includes controls.
    assert "style=" not in cleaned
    result = CssSelectorExtractor().extract(DetailPage(url="https://www.linkedin.com/jobs/view/fixture", html=cleaned))
    assert result.ok
    assert result.full_description is not None
    assert result.full_description.text == _GUEST_DESCRIPTION.strip()
    assert result.application_url is None


@pytest.mark.parametrize("main_container", [True, False], ids=["main", "body-fallback"])
def test_collector_cleans_removable_prefix_before_capping_description_and_apply_context(main_container) -> None:
    html = _guest_linkedin_html(oversized=True, removable_prefix=True, main_container=main_container)
    html = html.replace('<button>Show less</button>', '<a href="/apply/synthetic">Apply</a>')
    assert html.index("description__text") > 50000
    page = _GuestLinkedInPage(html)
    cleaned = _collect_main_content(page)
    assert page.body_fallback_calls == int(not main_container)
    assert len(cleaned) <= 50000
    result = CssSelectorExtractor().extract(
        DetailPage(url="https://www.linkedin.com/jobs/view/fixture", html=cleaned)
    )
    assert result.ok
    assert result.full_description.text == _GUEST_DESCRIPTION.strip()
    assert result.application_url.value == "https://www.linkedin.com/apply/synthetic"


@pytest.mark.parametrize("main_container", [True, False], ids=["main", "body-fallback"])
def test_collector_keeps_content_limit_when_meaningful_prefix_exceeds_cap(main_container) -> None:
    html = _guest_linkedin_html(main_container=main_container)
    html = html.replace('<aside', '<div>' + 'Meaningful introductory text. ' * 2000 + '</div><aside', 1)
    page = _GuestLinkedInPage(html)
    cleaned = _collect_main_content(page)
    assert len(cleaned) == 50000
    assert "Meaningful introductory text" in cleaned
    assert _GUEST_DESCRIPTION.strip() not in cleaned
    assert not CssSelectorExtractor().extract(DetailPage(url="https://example.com/job", html=cleaned)).ok


def test_collector_preserves_json_ld_after_capped_content() -> None:
    import json

    posting = {"@type": "JobPosting", "description": _GUEST_DESCRIPTION, "url": "https://example.com/apply"}
    html = _guest_linkedin_html(oversized=True, removable_prefix=True)
    html = html.replace('</body>', '<script type="application/ld+json">' + json.dumps(posting) + '</script></body>')
    page = _GuestLinkedInPage(html)
    json_ld = _collect_json_ld(page)
    cleaned = _collect_main_content(page)
    assert json_ld == [posting]
    assert len(cleaned) <= 50000
    assert "application/ld+json" not in cleaned
    result = JsonLdExtractor().extract(DetailPage(url="https://example.com/job", html=cleaned, json_ld=tuple(json_ld)))
    assert result.ok
    assert result.full_description.text == _GUEST_DESCRIPTION.strip()
    assert result.application_url.value == "https://example.com/apply"


@pytest.mark.parametrize("description", ["", "too short"])
def test_guest_linkedin_rejects_short_description_without_using_unrelated_show_more(description) -> None:
    page = _GuestLinkedInPage(_guest_linkedin_html(description=description))
    result = CssSelectorExtractor().extract(DetailPage(url="https://www.linkedin.com/jobs/view/fixture", html=_collect_main_content(page)))
    assert not result.ok


def test_authenticated_linkedin_description_selector_remains_supported() -> None:
    html = '<div id="JobDetails_AboutTheJob_fixture">' + _GUEST_DESCRIPTION + '</div>'
    result = CssSelectorExtractor().extract(DetailPage(url="https://www.linkedin.com/jobs/view/fixture", html=html))
    assert result.ok
    assert result.full_description.text == _GUEST_DESCRIPTION.strip()


# ---------------------------------------------------------------------------
# LlmExtractor
# ---------------------------------------------------------------------------


def test_llm_extractor_parses_json_response() -> None:
    canned = (
        '{"full_description": "Big LLM-extracted description that is longer.", '
        '"application_url": "https://example.com/apply"}'
    )
    llm = _StubLlm(canned)
    page = DetailPage(
        url="https://example.com/jobs/1",
        page_title="Title",
        html="<p>some content</p>",
    )
    result = LlmExtractor(llm=llm).extract(page)
    assert result.ok
    assert result.full_description is not None
    assert "LLM-extracted" in result.full_description.text
    assert result.application_url is not None
    assert result.application_url.value == "https://example.com/apply"
    assert len(llm.calls) == 1


def test_llm_extractor_handles_null_apply_url() -> None:
    canned = (
        '{"full_description": "Big LLM-extracted description text.", '
        '"application_url": null}'
    )
    llm = _StubLlm(canned)
    page = DetailPage(url="https://x", html="<p>x</p>")
    result = LlmExtractor(llm=llm).extract(page)
    assert result.ok
    assert result.application_url is None


def test_llm_extractor_returns_failed_on_unparseable_response() -> None:
    llm = _StubLlm("not json at all")
    page = DetailPage(url="https://x", html="<p>x</p>")
    assert not LlmExtractor(llm=llm).extract(page).ok


def test_llm_extractor_returns_failed_on_empty_html() -> None:
    llm = _StubLlm('{"full_description": "x"}')
    page = DetailPage(url="https://x", html="")
    assert not LlmExtractor(llm=llm).extract(page).ok
    # Did not call the LLM with empty content
    assert llm.calls == []


def test_llm_extractor_handles_markdown_fenced_json() -> None:
    canned = '```json\n{"full_description": "Fenced description text.", "application_url": null}\n```'
    llm = _StubLlm(canned)
    page = DetailPage(url="https://x", html="<p>x</p>")
    result = LlmExtractor(llm=llm).extract(page)
    assert result.ok
    assert result.full_description is not None
    assert "Fenced" in result.full_description.text


def test_llm_extractor_handles_think_tag_prefix() -> None:
    """Qwen-style chain-of-thought outputs prepend a <think>…</think> block."""
    canned = (
        "<think>thinking about the layout</think>\n"
        '{"full_description": "Real description after thinking.", '
        '"application_url": "https://apply"}'
    )
    llm = _StubLlm(canned)
    page = DetailPage(url="https://x", html="<p>x</p>")
    result = LlmExtractor(llm=llm).extract(page)
    assert result.ok
    assert result.full_description is not None
    assert "Real description" in result.full_description.text
