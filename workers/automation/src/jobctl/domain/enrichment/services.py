"""Enrichment domain services — pure functions over the value objects.

See ddd-target.md §4.2. Three extractor services represent the
three-tier extraction cascade. Each extractor:

  * takes a ``DetailPage`` value object,
  * returns an ``ExtractionResult`` (description + apply URL +
    success flag),
  * has NO I/O of its own — Tier 1 reads JSON-LD already collected
    by the fetcher; Tier 2 walks ``page.html`` via BeautifulSoup;
    Tier 3 calls the injected ``LlmPort``.

The use case (``EnrichJobUseCase``) is responsible for ordering the
cascade and persisting the result via ``EnrichmentRepository``. The
extractors stay pure so they can be unit-tested independently.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from jobctl.domain.enrichment.value_objects import (
    ApplicationUrl,
    DetailPage,
    FullDescription,
)
from jobctl.domain.extraction import extract_json
from jobctl.domain.ports.llm import LlmMessage, LlmPort

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Result type — returned by every extractor
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ExtractionResult:
    """Outcome of one extractor's pass over a ``DetailPage``.

    ``ok=True`` ⇒ ``full_description`` is non-None and ready to be
    written to the aggregate. ``application_url`` is best-effort —
    callers may still record an ``ok=True`` result without an apply
    URL (see ``status='partial'`` in the legacy pipeline).
    """

    ok: bool
    full_description: FullDescription | None = None
    application_url: ApplicationUrl | None = None


# ---------------------------------------------------------------------------
# Tier 1 — JSON-LD JobPosting
# ---------------------------------------------------------------------------


class JsonLdExtractor:
    """Tier-1 extractor: read the description from JSON-LD JobPosting blobs.

    Cheapest tier (zero LLM tokens). The fetcher already parsed the
    ``<script type="application/ld+json">`` payloads into the
    ``DetailPage.json_ld`` tuple — this extractor just walks them.
    """

    _MIN_DESC_LEN = 50

    def extract(self, page: DetailPage) -> ExtractionResult:
        for ld in page.json_ld:
            posting = _find_job_posting(ld)
            if not posting:
                continue
            desc = posting.get("description", "")
            if not desc:
                continue
            cleaned = _clean_description(desc)
            if len(cleaned) < self._MIN_DESC_LEN:
                continue

            apply_url: str | None = None
            if posting.get("directApply"):
                apply_url = posting.get("url")
            if not apply_url:
                contact = posting.get("applicationContact")
                if isinstance(contact, dict):
                    apply_url = contact.get("url")
            if not apply_url:
                apply_url = posting.get("url")

            return ExtractionResult(
                ok=True,
                full_description=FullDescription(text=cleaned),
                application_url=(
                    ApplicationUrl(value=apply_url) if apply_url else None
                ),
            )
        return ExtractionResult(ok=False)


def _find_job_posting(data: Any) -> dict | None:
    if isinstance(data, dict):
        if data.get("@type") == "JobPosting":
            return data
        graph = data.get("@graph")
        if isinstance(graph, list):
            for item in graph:
                result = _find_job_posting(item)
                if result:
                    return result
    elif isinstance(data, list):
        for item in data:
            result = _find_job_posting(item)
            if result:
                return result
    return None


# ---------------------------------------------------------------------------
# Tier 2 — Deterministic CSS pattern matching
# ---------------------------------------------------------------------------


_DESCRIPTION_SELECTORS = (
    "#job-description",
    "#job_description",
    "#jobDescriptionText",
    ".job-description",
    ".job_description",
    ".job__description",
    '[class*="job-description"]',
    '[class*="jobDescription"]',
    '[data-testid*="description"]',
    '[data-testid="job-description"]',
    ".posting-page .posting-categories + div",
    "#content .posting-page",
    "#app_body .content",
    "#grnhse_app .content",
    ".job-post-container",
    ".ashby-job-posting-description",
    '[class*="posting-description"]',
    '[class*="job-detail"]',
    '[class*="jobDetail"]',
    '[class*="job-content"]',
    '[class*="job-body"]',
    '[role="main"] article',
    "main article",
    'article[class*="job"]',
    ".job-posting-content",
)

_APPLY_SELECTORS = (
    'a[href*="apply"]',
    'a[data-testid*="apply"]',
    'a[class*="apply"]',
    'a[aria-label*="pply"]',
    "a#apply_button",
    ".postings-btn-wrapper a",
    "a.ashby-job-posting-apply-button",
    '#grnhse_app a[href*="apply"]',
    'a[data-qa="btn-apply"]',
    'a[class*="btn-apply"]',
    'a[class*="apply-btn"]',
    'a[class*="apply-button"]',
)


class CssSelectorExtractor:
    """Tier-2 extractor: walk known CSS patterns over the cleaned HTML.

    Operates on the ``page.html`` chunk the fetcher prepared; uses
    BeautifulSoup so it remains a pure function over the value
    object (no Playwright dependency at extract time).
    """

    _MIN_DESC_LEN = 100

    def extract(self, page: DetailPage) -> ExtractionResult:
        if not page.html:
            return ExtractionResult(ok=False)
        soup = BeautifulSoup(page.html, "html.parser")

        description: str | None = None
        for sel in _DESCRIPTION_SELECTORS:
            try:
                el = soup.select_one(sel)
            except Exception:
                continue
            if not el:
                continue
            text = el.get_text(" ", strip=True)
            if len(text) >= self._MIN_DESC_LEN:
                description = _clean_description(text)
                break

        apply_url: str | None = None
        for sel in _APPLY_SELECTORS:
            try:
                el = soup.select_one(sel)
            except Exception:
                continue
            if not el:
                continue
            href = el.get("href")
            if href and href != "#":
                apply_url = _resolve_relative(str(href), page.final_url or page.url)
                break

        if description:
            return ExtractionResult(
                ok=True,
                full_description=FullDescription(text=description),
                application_url=(
                    ApplicationUrl(value=apply_url) if apply_url else None
                ),
            )
        return ExtractionResult(ok=False)


# ---------------------------------------------------------------------------
# Tier 3 — LLM-assisted extraction
# ---------------------------------------------------------------------------


_LLM_PROMPT = """You are extracting job details from a single job posting page.

PAGE URL: {url}
PAGE TITLE: {title}

Find TWO things in the HTML below:
1. The full job description text (responsibilities, requirements, etc.)
2. The URL of the "Apply" button/link

Rules:
- For description: extract the FULL text. Include all sections (About, Responsibilities, Requirements, etc.)
- For apply URL: find the href of the link/button that starts the application process
- If you cannot find one, set it to null

Return ONLY valid JSON:
{{"full_description": "the complete job description text here", "application_url": "https://..." or null}}

No explanation, no markdown. Keep reasoning under 20 words.

HTML:
{content}"""

_LLM_HTML_LIMIT = 30000


class LlmExtractor:
    """Tier-3 extractor: send the cleaned HTML chunk to an LLM.

    Most expensive tier (one LLM call). The legacy detail extractor
    used a single prompt with the JSON response shape; we preserve
    that contract verbatim so the LLM cost / quality profile is
    unchanged.
    """

    def __init__(self, *, llm: LlmPort, prompt: str = _LLM_PROMPT) -> None:
        self._llm = llm
        self._prompt = prompt

    def extract(self, page: DetailPage) -> ExtractionResult:
        if not page.html:
            return ExtractionResult(ok=False)
        prompt = self._prompt.format(
            url=page.final_url or page.url,
            title=page.page_title or "",
            content=page.html[:_LLM_HTML_LIMIT],
        )
        try:
            raw = self._llm.chat(
                [LlmMessage(role="user", content=prompt)],
                max_tokens=4096,
                temperature=0.0,
            )
        except Exception as exc:  # noqa: BLE001 — surface as failed extraction
            log.warning("LlmExtractor: LLM call failed: %s", exc)
            return ExtractionResult(ok=False)
        try:
            parsed = extract_json(raw)
        except Exception as exc:  # noqa: BLE001
            log.warning("LlmExtractor: could not parse LLM response: %s", exc)
            return ExtractionResult(ok=False)

        desc_raw = parsed.get("full_description")
        apply_raw = parsed.get("application_url")

        description = (
            FullDescription(text=_clean_description(str(desc_raw)))
            if desc_raw
            else None
        )
        apply_url = (
            ApplicationUrl(value=str(apply_raw))
            if apply_raw
            else None
        )

        if description is None:
            return ExtractionResult(ok=False)
        return ExtractionResult(
            ok=True,
            full_description=description,
            application_url=apply_url,
        )


# ---------------------------------------------------------------------------
# Shared description cleaner (lifted verbatim from legacy detail.py)
# ---------------------------------------------------------------------------


def _clean_description(text: str) -> str:
    """Convert HTML description to clean readable text.

    Mirrors the behaviour of the legacy ``enrichment.detail.clean_description``
    so descriptions written through the new use case are byte-identical
    with the historical pipeline output for the same input.
    """
    if not text:
        return ""

    if "<" in text and ">" in text:
        soup = BeautifulSoup(text, "html.parser")
        for br in soup.find_all("br"):
            br.replace_with("\n")
        for tag in soup.find_all(["p", "div", "h1", "h2", "h3", "h4", "li", "tr"]):
            tag.insert_before("\n")
            tag.insert_after("\n")
        for li in soup.find_all("li"):
            li.insert_before("- ")
        text = soup.get_text()

    lines: list[str] = []
    for line in text.split("\n"):
        line = line.strip()
        if line:
            lines.append(line)

    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _resolve_relative(href: str, base: str) -> str:
    """Resolve a possibly-relative href against the page's final URL."""
    if href.startswith(("http://", "https://")):
        return href
    if not base:
        return href
    try:
        return urljoin(base, href)
    except Exception:
        return href
