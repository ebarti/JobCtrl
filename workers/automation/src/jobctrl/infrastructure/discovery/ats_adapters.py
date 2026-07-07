"""Canonical ATS API adapters that materialise ``JobBoardScraperPort``.

PR 2 ships four Tier 1 adapters per the RFC §"Source Hierarchy" table:

* ``WorkdayBoardAdapter`` — wraps the existing CXS JSON path used by
  ``jobctrl.discovery.workday`` while moving the write boundary
  behind ``DiscoverJobsUseCase``.
* ``GreenhouseBoardAdapter`` — pulls the Greenhouse Job Board API
  (``https://boards-api.greenhouse.io/v1/boards/{board}/jobs``).
* ``LeverBoardAdapter`` — pulls the Lever Postings API
  (``https://api.lever.co/v0/postings/{site}``).
* ``AshbyBoardAdapter`` — pulls the Ashby Public Job Posting API
  (``https://api.ashbyhq.com/posting-api/job-board/{name}``).

Each adapter is a thin HTTP client + parser. They only need a callable
``http`` that takes an HTTP URL and returns the decoded JSON payload —
keeping the signature minimal lets the unit tests substitute a fixture
loader without touching the network. Per the RFC §"Policy For Content
Acquisition" rules adapters do not bypass third-party access controls;
they only consume the documented public APIs.

Each ``scrape`` invocation is wrapped with ``adapter_fetch_span`` so
PR 4's source-quality aggregation can compute per-source yield, page
counts, and error classes from spans in addition to events.
"""

from __future__ import annotations

import logging
import html
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Iterator

from bs4 import BeautifulSoup

from jobctrl.domain.discovery.identity import AtsKind
from jobctrl.domain.discovery.value_objects import (
    JobMetadata,
    PostingUrl,
    SearchStrategy,
    Source,
)
from jobctrl.domain.ports.discovery import ScrapedJobPosting
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.discovery.location_filter import location_matches_target
from jobctrl.discovery.title_filter import title_matches_query
from jobctrl.infrastructure.observability.adapter_spans import adapter_fetch_span

log = logging.getLogger(__name__)

_NULL_DESCRIPTION_SENTINELS = {"<na>", "nan", "nat", "none", "null"}


# ---------------------------------------------------------------------------
# HTTP helper
# ---------------------------------------------------------------------------


HttpFetcher = Callable[..., Any]
"""Callable signature shared by every adapter.

Accepts a fully-formed HTTP URL and optional method/body kwargs, then
returns the decoded JSON payload (typically a ``dict`` or ``list``), or
``None`` when the politeness gateway blocked the fetch. The fetcher is
**required** — production injects a gateway-routed
:class:`~jobctrl.infrastructure.network.http_client.GatewayHttpClient`
(robots + rate + budget + honest UA) at the composition root
(``run_scheduled_ats_sources`` / ``_adapter_for_source``); tests inject a
fixture-backed fetcher. Adapters no longer build their own ``urllib`` transport
(R10): every outbound request routes through the gateway.
"""


# ---------------------------------------------------------------------------
# Workday CXS adapter (preserves current behavior)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class WorkdayEmployer:
    """Minimal Workday employer descriptor matching ``employers.yaml``.

    Stored on the adapter rather than re-loaded on every call so the
    Discovery use case can iterate over multiple employers without
    re-reading the registry.
    """

    employer_key: str
    name: str
    base_url: str
    tenant: str
    site_id: str

    @property
    def board(self) -> str:
        return self.name


class WorkdayBoardAdapter:
    """``JobBoardScraperPort`` over a single Workday CXS employer.

    Preserves the same JSON shape the legacy ``discovery.workday``
    module already consumes; the difference is that this adapter yields
    ``ScrapedJobPosting`` value objects so the Discovery use case can
    own write/dedupe instead of the scraper writing directly to SQLite.
    """

    def __init__(
        self,
        *,
        source_id: str,
        employer: WorkdayEmployer,
        http: HttpFetcher,
        page_size: int = 20,
        max_pages: int = 25,
        location_accept: Iterable[str] = (),
        location_reject: Iterable[str] = (),
    ) -> None:
        self._source_id = source_id
        self._employer = employer
        self._http = http
        self._page_size = page_size
        self._max_pages = max_pages
        self._location_accept = tuple(location_accept)
        self._location_reject = tuple(location_reject)

    @property
    def source_id(self) -> str:
        return self._source_id

    def scrape(
        self,
        *,
        tenant_id: TenantId,
        query: str,
        location: str,
    ) -> Iterable[ScrapedJobPosting]:
        run_id = f"workday:{self._source_id}:{query}:{location}"
        results: list[ScrapedJobPosting] = []
        pages = 0
        with adapter_fetch_span(
            tenant_id=str(tenant_id),
            run_id=run_id,
            source_id=self._source_id,
            adapter_kind="workday_api",
            page_count=0,
            result_count=0,
        ):
            for posting in self._iter_postings(query=query, location=location):
                results.append(posting)
            # iter exhausted — pages updated below from the last loop
            pages = self._last_page_count
            log.info(
                "workday adapter %s: %d postings across %d pages",
                self._source_id,
                len(results),
                pages,
            )
        return results

    # ----- internal -------------------------------------------------------

    _last_page_count: int = 0

    def _iter_postings(self, *, query: str, location: str) -> Iterator[ScrapedJobPosting]:
        url = f"{self._employer.base_url}/wday/cxs/{self._employer.tenant}/{self._employer.site_id}/jobs"
        offset = 0
        pages = 0
        while pages < self._max_pages:
            payload = self._http(
                url,
                method="POST",
                json_body={
                    "appliedFacets": {},
                    "limit": self._page_size,
                    "offset": offset,
                    "searchText": query,
                },
            )
            postings = (payload or {}).get("jobPostings") or []
            if not postings:
                break
            for posting in postings:
                yielded = self._to_scraped(posting, query=query, location_filter=location)
                if yielded is not None:
                    yield yielded
            pages += 1
            offset += self._page_size
            total = int((payload or {}).get("total") or 0)
            if offset >= total:
                break
        self._last_page_count = pages

    def _to_scraped(
        self,
        posting: dict[str, Any],
        *,
        query: str,
        location_filter: str,
    ) -> ScrapedJobPosting | None:
        external_path = str(posting.get("externalPath") or "").strip()
        title = str(posting.get("title") or "").strip()
        if not external_path or not title:
            return None
        # Workday CXS sometimes returns extra postings beyond the
        # filtered set (the API treats ``searchText`` as a soft hint).
        # Re-apply the filter on title so the adapter contract holds:
        # "yield postings matching the query".
        if not title_matches_query(title, query):
            return None
        canonical_url = f"{self._employer.base_url}/{self._employer.site_id}{external_path}"
        source_native_id = external_path.split("/")[-1] or external_path
        location = str(posting.get("locationsText") or "").strip()
        if not location_matches_target(
            location,
            accept=self._location_accept,
            reject=self._location_reject,
            search_location=location_filter,
        ):
            return None
        return ScrapedJobPosting(
            posting_url=PostingUrl(value=canonical_url),
            source=Source(board=self._employer.board),
            metadata=JobMetadata(
                title=title,
                salary="",
                description="",
                location=location,
            ),
            strategy=SearchStrategy.WORKDAY_API,
            source_id=self._source_id,
            source_native_id=source_native_id,
            canonical_url=canonical_url,
            ats_kind=AtsKind.WORKDAY,
        )


# ---------------------------------------------------------------------------
# Greenhouse public Job Board API
# ---------------------------------------------------------------------------


class GreenhouseBoardAdapter:
    """``JobBoardScraperPort`` over the Greenhouse Job Board API.

    The board endpoint is documented at
    https://developer.greenhouse.io/job-board.html. Each board returns
    every job posting in a single response; pagination is not part of
    the public API, so adapters scrape once and yield each result.
    """

    def __init__(
        self,
        *,
        source_id: str,
        board_token: str,
        http: HttpFetcher,
        company: str | None = None,
        location_accept: Iterable[str] = (),
        location_reject: Iterable[str] = (),
    ) -> None:
        self._source_id = source_id
        self._board_token = board_token
        self._http = http
        self._company = company
        self._location_accept = tuple(location_accept)
        self._location_reject = tuple(location_reject)

    @property
    def source_id(self) -> str:
        return self._source_id

    @property
    def url(self) -> str:
        return f"https://boards-api.greenhouse.io/v1/boards/{self._board_token}/jobs?content=true"

    def scrape(
        self,
        *,
        tenant_id: TenantId,
        query: str,
        location: str,
    ) -> Iterable[ScrapedJobPosting]:
        run_id = f"greenhouse:{self._source_id}:{query}:{location}"
        results: list[ScrapedJobPosting] = []
        with adapter_fetch_span(
            tenant_id=str(tenant_id),
            run_id=run_id,
            source_id=self._source_id,
            adapter_kind="greenhouse_api",
            page_count=1,
            result_count=0,
        ):
            payload = self._http(self.url) or {}
            jobs = payload.get("jobs") or []
            for raw in jobs:
                posting = self._to_scraped(raw, query=query, location=location)
                if posting is not None:
                    results.append(posting)
        return results

    def _to_scraped(
        self,
        raw: dict[str, Any],
        *,
        query: str,
        location: str,
    ) -> ScrapedJobPosting | None:
        title = str(raw.get("title") or "").strip()
        absolute_url = str(raw.get("absolute_url") or "").strip()
        gh_id = raw.get("id")
        if not title or not absolute_url or gh_id is None:
            return None
        if not title_matches_query(title, query):
            # Lightweight server-side filter so callers can pass a
            # non-empty query without the API raising.
            return None
        canonical_url = absolute_url
        source_native_id = str(gh_id)
        loc_obj = raw.get("location")
        loc = ""
        if isinstance(loc_obj, dict):
            loc = str(loc_obj.get("name") or "").strip()
        elif isinstance(loc_obj, str):
            loc = loc_obj.strip()
        if not location_matches_target(
            loc,
            accept=self._location_accept,
            reject=self._location_reject,
            search_location=location,
        ):
            return None
        description = _html_to_text(raw.get("content"))
        if not description:
            return None
        company = str(raw.get("company_name") or self._company or "").strip()
        return ScrapedJobPosting(
            posting_url=PostingUrl(value=canonical_url),
            source=Source(board=company or f"greenhouse:{self._board_token}"),
            metadata=JobMetadata(
                title=title,
                salary="",
                description=description,
                location=loc,
            ),
            strategy=SearchStrategy.WORKDAY_API,  # ATS family marker
            source_id=self._source_id,
            source_native_id=source_native_id,
            canonical_url=canonical_url,
            ats_kind=AtsKind.GREENHOUSE,
        )


# ---------------------------------------------------------------------------
# Lever Postings API
# ---------------------------------------------------------------------------


class LeverBoardAdapter:
    """``JobBoardScraperPort`` over the Lever Postings API.

    See https://github.com/lever/postings-api. The default mode list
    returns every published posting for a site; we set ``mode=json`` so
    the response is machine-readable.
    """

    def __init__(
        self,
        *,
        source_id: str,
        site: str,
        http: HttpFetcher,
        company: str | None = None,
        location_accept: Iterable[str] = (),
        location_reject: Iterable[str] = (),
    ) -> None:
        self._source_id = source_id
        self._site = site
        self._http = http
        self._company = company
        self._location_accept = tuple(location_accept)
        self._location_reject = tuple(location_reject)

    @property
    def source_id(self) -> str:
        return self._source_id

    @property
    def url(self) -> str:
        return f"https://api.lever.co/v0/postings/{self._site}?mode=json"

    def scrape(
        self,
        *,
        tenant_id: TenantId,
        query: str,
        location: str,
    ) -> Iterable[ScrapedJobPosting]:
        run_id = f"lever:{self._source_id}:{query}:{location}"
        results: list[ScrapedJobPosting] = []
        with adapter_fetch_span(
            tenant_id=str(tenant_id),
            run_id=run_id,
            source_id=self._source_id,
            adapter_kind="lever_api",
            page_count=1,
            result_count=0,
        ):
            payload = self._http(self.url) or []
            postings = payload if isinstance(payload, list) else payload.get("data") or []
            for raw in postings:
                posting = self._to_scraped(raw, query=query, location=location)
                if posting is not None:
                    results.append(posting)
        return results

    def _to_scraped(
        self,
        raw: dict[str, Any],
        *,
        query: str,
        location: str,
    ) -> ScrapedJobPosting | None:
        text = str(raw.get("text") or "").strip()
        hosted_url = str(raw.get("hostedUrl") or raw.get("applyUrl") or "").strip()
        posting_id = str(raw.get("id") or "").strip()
        if not text or not hosted_url or not posting_id:
            return None
        if not title_matches_query(text, query):
            return None
        cats = raw.get("categories") or {}
        loc = str(cats.get("location") or "").strip() if isinstance(cats, dict) else ""
        if not location_matches_target(
            loc,
            accept=self._location_accept,
            reject=self._location_reject,
            search_location=location,
        ):
            return None
        description = _lever_description(raw)
        if not description:
            return None
        company = self._company or f"lever:{self._site}"
        return ScrapedJobPosting(
            posting_url=PostingUrl(value=hosted_url),
            source=Source(board=company),
            metadata=JobMetadata(
                title=text,
                salary="",
                description=description,
                location=loc,
            ),
            strategy=SearchStrategy.WORKDAY_API,
            source_id=self._source_id,
            source_native_id=posting_id,
            canonical_url=hosted_url,
            ats_kind=AtsKind.LEVER,
        )


# ---------------------------------------------------------------------------
# Ashby Public Job Posting API
# ---------------------------------------------------------------------------


class AshbyBoardAdapter:
    """``JobBoardScraperPort`` over the Ashby Public Job Posting API.

    See https://developers.ashbyhq.com/docs/public-job-posting-api. The
    listing endpoint returns one page of postings per board name.
    """

    def __init__(
        self,
        *,
        source_id: str,
        board_name: str,
        http: HttpFetcher,
        company: str | None = None,
        location_accept: Iterable[str] = (),
        location_reject: Iterable[str] = (),
    ) -> None:
        self._source_id = source_id
        self._board_name = board_name
        self._http = http
        self._company = company
        self._location_accept = tuple(location_accept)
        self._location_reject = tuple(location_reject)

    @property
    def source_id(self) -> str:
        return self._source_id

    @property
    def url(self) -> str:
        return f"https://api.ashbyhq.com/posting-api/job-board/{self._board_name}"

    def scrape(
        self,
        *,
        tenant_id: TenantId,
        query: str,
        location: str,
    ) -> Iterable[ScrapedJobPosting]:
        run_id = f"ashby:{self._source_id}:{query}:{location}"
        results: list[ScrapedJobPosting] = []
        with adapter_fetch_span(
            tenant_id=str(tenant_id),
            run_id=run_id,
            source_id=self._source_id,
            adapter_kind="ashby_api",
            page_count=1,
            result_count=0,
        ):
            payload = self._http(self.url) or {}
            postings = payload.get("jobs") or []
            for raw in postings:
                posting = self._to_scraped(raw, query=query, location=location)
                if posting is not None:
                    results.append(posting)
        return results

    def _to_scraped(
        self,
        raw: dict[str, Any],
        *,
        query: str,
        location: str,
    ) -> ScrapedJobPosting | None:
        title = str(raw.get("title") or "").strip()
        job_url = str(raw.get("jobUrl") or raw.get("applyUrl") or "").strip()
        posting_id = str(raw.get("id") or "").strip()
        if not title or not job_url or not posting_id:
            return None
        if not title_matches_query(title, query):
            return None
        loc = str(raw.get("location") or raw.get("locationName") or "").strip()
        if not location_matches_target(
            loc,
            accept=self._location_accept,
            reject=self._location_reject,
            search_location=location,
        ):
            return None
        description = _ashby_description(raw)
        if not description:
            return None
        company = self._company or f"ashby:{self._board_name}"
        return ScrapedJobPosting(
            posting_url=PostingUrl(value=job_url),
            source=Source(board=company),
            metadata=JobMetadata(
                title=title,
                salary="",
                description=description,
                location=loc,
            ),
            strategy=SearchStrategy.WORKDAY_API,
            source_id=self._source_id,
            source_native_id=posting_id,
            canonical_url=job_url,
            ats_kind=AtsKind.ASHBY,
        )


def _lever_description(raw: dict[str, Any]) -> str:
    parts = [
        _html_to_text(raw.get("descriptionPlain") or raw.get("description")),
        _html_to_text(raw.get("additionalPlain") or raw.get("additional")),
    ]
    lists = raw.get("lists") or []
    if isinstance(lists, list):
        for item in lists:
            if isinstance(item, dict):
                parts.append(_html_to_text(item.get("content")))
    return _collapse_text("\n\n".join(part for part in parts if part))


def _ashby_description(raw: dict[str, Any]) -> str:
    return _html_to_text(
        raw.get("descriptionPlain")
        or raw.get("descriptionHtml")
        or raw.get("description")
        or raw.get("jobDescription")
    )


def _html_to_text(value: object) -> str:
    raw = str(value or "").strip()
    if not raw or raw.casefold() in _NULL_DESCRIPTION_SENTINELS:
        return ""
    unescaped = html.unescape(raw)
    text = BeautifulSoup(unescaped, "html.parser").get_text(" ")
    if text.strip().casefold() in _NULL_DESCRIPTION_SENTINELS:
        return ""
    return _collapse_text(text)


def _collapse_text(value: str) -> str:
    return " ".join(str(value or "").split())


__all__ = [
    "AshbyBoardAdapter",
    "GreenhouseBoardAdapter",
    "HttpFetcher",
    "LeverBoardAdapter",
    "WorkdayBoardAdapter",
    "WorkdayEmployer",
]
