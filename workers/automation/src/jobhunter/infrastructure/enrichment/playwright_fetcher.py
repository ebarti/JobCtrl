"""PlaywrightDetailPageFetcher — local-mode adapter for ``DetailPageFetcherPort``.

Wraps a Playwright session to load a job detail page and return a
``DetailPage`` value object. The fetcher takes care of:

  * navigation + ``domcontentloaded`` / ``networkidle`` waits,
  * collecting JSON-LD ``<script>`` payloads,
  * extracting the cleaned main-content HTML chunk used by Tier-3 LLM
    extraction,
  * reading the HTTP status code so the use case can short-circuit on
    permanent failures.

The fetcher does NOT decide which tier succeeds — that's the
extractors' job. It also does NOT write anything to the database — the
use case is responsible for persistence via ``EnrichmentRepository``.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from typing import Any

from bs4 import BeautifulSoup

from jobhunter.domain.discovery.source_registry import ENRICHMENT_CRAWL_POLICY
from jobhunter.domain.enrichment.value_objects import DetailPage
from jobhunter.domain.ports.politeness import default_honest_user_agent
from jobhunter.infrastructure.network import (
    PolitenessGateway,
    PolitenessSession,
    PolitenessSourceContext,
    RunBudgetCounter,
)
from jobhunter.infrastructure.network.proxy import ProxyConfig

log = logging.getLogger(__name__)


# Honest outbound identity (R10) — no browser impersonation on a surface we control.
_USER_AGENT = default_honest_user_agent().header_value()
_NAV_TIMEOUT_MS = 45000
_DCL_TIMEOUT_MS = 15000
_IDLE_TIMEOUT_MS = 10000
_MAIN_CONTENT_HTML_LIMIT = 50000


class PlaywrightDetailPageFetcher:
    """Local-mode ``DetailPageFetcherPort`` implementation.

    The fetcher is **stateless across calls** — every ``fetch`` opens a
    fresh Playwright context, navigates, captures the page, and tears
    down. This is wasteful per-call but keeps the port surface clean
    for the cloud cutover (Browserbase issues a session per request).

    For batch enrichment, callers should instead drive the legacy
    ``scrape_site_batch`` path which reuses one Playwright browser
    across many URLs; the use case wraps individual one-off fetches
    where the per-call overhead is acceptable.
    """

    def __init__(
        self,
        *,
        proxy: ProxyConfig | None = None,
        user_agent: str = _USER_AGENT,
        headless: bool = True,
        session: PolitenessSession | None = None,
    ) -> None:
        self._proxy = proxy
        self._user_agent = user_agent
        self._headless = headless
        # R10: every navigation is gated by the politeness gateway. Callers may
        # inject a session bound to a run budget + recording connection; a
        # standalone fetcher self-provisions one per call.
        self._session = session

    def _politeness_session(self) -> PolitenessSession:
        if self._session is not None:
            return self._session
        return PolitenessSession(
            PolitenessGateway(),
            policy=ENRICHMENT_CRAWL_POLICY,
            budget=RunBudgetCounter(ENRICHMENT_CRAWL_POLICY.max_requests_per_run),
            context=PolitenessSourceContext(stage="enrich", adapter="enrichment_detail_fetcher"),
        )

    # ------------------------------------------------------------------
    # Public API — implements ``DetailPageFetcherPort.fetch``
    # ------------------------------------------------------------------

    def fetch(self, url: str) -> DetailPage:
        fetched_at = datetime.now(timezone.utc).isoformat()
        # R10 pre-navigation gate: a robots-deny / budget-exhaustion performs
        # zero navigation and returns an empty page rather than fetching.
        with self._politeness_session().guard(url) as decision:
            if not decision.allowed:
                log.warning(
                    "PlaywrightDetailPageFetcher: navigation skipped by politeness gate %s: %s",
                    url,
                    decision.reason,
                )
                return DetailPage(
                    url=url,
                    final_url=url,
                    page_title="",
                    html="",
                    json_ld=(),
                    status=None,
                    fetched_at=fetched_at,
                )
            return self._fetch_page(url, fetched_at)

    def _fetch_page(self, url: str, fetched_at: str) -> DetailPage:
        # Imported lazily because Playwright is heavyweight + optional
        # in some test environments (see workers/automation/pyproject).
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            launch_opts: dict[str, Any] = {"headless": self._headless}
            if self._proxy is not None:
                launch_opts["proxy"] = self._proxy.playwright
            browser = p.chromium.launch(**launch_opts)
            try:
                context = browser.new_context(user_agent=self._user_agent)
                page = context.new_page()
                status: int | None = None
                resp = None
                try:
                    resp = page.goto(url, timeout=_NAV_TIMEOUT_MS)
                    if resp is not None:
                        status = resp.status
                    page.wait_for_load_state("domcontentloaded", timeout=_DCL_TIMEOUT_MS)
                    try:
                        page.wait_for_load_state("networkidle", timeout=_IDLE_TIMEOUT_MS)
                    except Exception:
                        # networkidle is best-effort; many pages keep
                        # a long-poll connection open and that's fine
                        # for our purposes.
                        pass
                except Exception as exc:
                    log.warning("PlaywrightDetailPageFetcher: navigation error %s: %s", url, exc)
                    return DetailPage(
                        url=url,
                        final_url=url,
                        page_title="",
                        html="",
                        json_ld=(),
                        status=status,
                        fetched_at=fetched_at,
                    )

                final_url = page.url
                page_title = ""
                try:
                    page_title = page.title() or ""
                except Exception:
                    pass

                json_ld_payloads = _collect_json_ld(page)
                html = _collect_main_content(page)

                return DetailPage(
                    url=url,
                    final_url=final_url,
                    page_title=page_title,
                    html=html,
                    json_ld=tuple(json_ld_payloads),
                    status=status,
                    fetched_at=fetched_at,
                )
            finally:
                browser.close()


# ---------------------------------------------------------------------------
# Helpers — pure functions called by the fetcher
# ---------------------------------------------------------------------------


def _collect_json_ld(page: Any) -> list[Any]:
    """Parse ``<script type="application/ld+json">`` payloads on the page."""
    payloads: list[Any] = []
    try:
        for el in page.query_selector_all('script[type="application/ld+json"]'):
            try:
                payloads.append(json.loads(el.inner_text()))
            except Exception:
                continue
    except Exception:
        pass
    return payloads


def _collect_main_content(page: Any) -> str:
    """Pick the largest plausible main-content block and clean it for LLM use."""
    for sel in ("main", "article", '[role="main"]', "#content", ".content"):
        try:
            el = page.query_selector(sel)
            if not el:
                continue
            text_len = len((el.inner_text() or "").strip())
            if text_len > 200:
                html = el.inner_html()
                if len(html) < _MAIN_CONTENT_HTML_LIMIT:
                    return _clean_content_html(html)
        except Exception:
            continue
    try:
        html = page.evaluate(
            """
            () => {
                const clone = document.body.cloneNode(true);
                clone.querySelectorAll('nav, header, footer, script, style, noscript, svg, iframe').forEach(el => el.remove());
                return clone.innerHTML;
            }
            """
        )
        return _clean_content_html(html[:_MAIN_CONTENT_HTML_LIMIT])
    except Exception:
        return ""


def _clean_content_html(html: str) -> str:
    """Strip noisy attributes / chrome from a content HTML chunk."""
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup.select("script, style, noscript, svg, iframe, nav, header, footer"):
        tag.decompose()

    for tag in soup.find_all(True):
        new_attrs: dict = {}
        for attr, val in list(tag.attrs.items()):
            if attr in (
                "id",
                "href",
                "class",
                "role",
                "aria-label",
                "data-testid",
                "name",
                "for",
                "type",
            ):
                if attr == "class":
                    classes = val if isinstance(val, list) else val.split()
                    kept = [
                        c for c in classes if len(c) < 30 and not re.match(r"^[a-z]{1,2}-\d+$", c)
                    ]
                    if kept:
                        new_attrs["class"] = " ".join(kept[:3])
                else:
                    new_attrs[attr] = val
            elif attr.startswith("data-") or attr.startswith("aria-"):
                new_attrs[attr] = val
        tag.attrs = new_attrs

    return str(soup)
