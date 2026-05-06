"""Phase 7 / S-26: Enrichment domain services (extractors).

The three extractors must:

  * be pure (no I/O — they consume a ``DetailPage`` value object),
  * return a ``ExtractionResult`` with the right ``ok`` flag,
  * preserve the legacy "JSON-LD first, then CSS, then LLM" cascade
    behaviour when the pages they're given match the legacy fixtures.
"""

from __future__ import annotations

from typing import Sequence

from jobhunter.domain.enrichment import DetailPage
from jobhunter.domain.enrichment.services import (
    CssSelectorExtractor,
    JsonLdExtractor,
    LlmExtractor,
)
from jobhunter.domain.ports.llm import LlmMessage, LlmPort


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
