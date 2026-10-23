"""Tokenless Levels.fyi public salary-page ingestion.

Levels.fyi publishes bot-friendly ``.md`` salary routes through ``llms.txt``.
Some location routes currently return an empty Markdown response, so the
adapter falls back to the same public page's structured ``__NEXT_DATA__``
payload. It never uses private APIs, credentials, or authenticated sessions.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import unicodedata
from collections.abc import Callable, Iterable
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Any, Literal
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit


from jobctrl.domain.compensation import (
    LEVELS_FYI_MARKET_AGGREGATE_COMPANY,
    ReportedCompensationObservation,
)

LEVELS_FYI_BASE_URL = "https://www.levels.fyi"
LEVELS_FYI_ATTRIBUTION = "Data source: Levels.fyi (https://www.levels.fyi)"
DEFAULT_LEVELS_FYI_PUBLIC_MAX_PAGES = 25

TextFetcher = Callable[[str], str | None]


@dataclass(frozen=True)
class LevelsFyiPublicTarget:
    """A job-family/location page needed by the current local job set."""

    occupation_family_code: str
    country_code: str | None
    seniority_code: str = "unknown"


@dataclass(frozen=True)
class LevelsFyiPublicRequestOutcome:
    url: str
    status: Literal["available", "empty", "unavailable", "http_error", "fetch_error"]
    http_status: int | None = None
    error_type: str | None = None
    snapshot_sha256: str | None = None
    parse_status: Literal["parsed", "unparsed", "parse_error"] | None = None

    def as_dict(self) -> dict[str, Any]:
        # No exception messages, response bodies or request headers enter receipts.
        return {
            "url": self.url, "status": self.status, "httpStatus": self.http_status,
            "errorType": self.error_type, "snapshotSha256": self.snapshot_sha256,
            "parseStatus": self.parse_status,
        }


@dataclass(frozen=True)
class LevelsFyiPublicTargetOutcome:
    target: LevelsFyiPublicTarget
    coverage: Literal["supported", "unsupported_role", "unsupported_country"]
    requested_pages: int = 0
    reachable_pages: int = 0
    parsed_pages: int = 0
    level_lookup_unavailable: bool = False
    page_budget_exhausted: bool = False
    requests: tuple[LevelsFyiPublicRequestOutcome, ...] = ()

    @property
    def failed(self) -> bool:
        return self.coverage == "supported" and (
            self.page_budget_exhausted or self.level_lookup_unavailable
            or self.reachable_pages < self.requested_pages
            or (self.requested_pages > 0 and self.parsed_pages == 0)
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "occupationFamilyCode": self.target.occupation_family_code,
            "countryCode": self.target.country_code,
            "seniorityCode": self.target.seniority_code,
            "coverage": self.coverage,
            "requestedPages": self.requested_pages, "reachablePages": self.reachable_pages,
            "parsedPages": self.parsed_pages,
            "levelLookupUnavailable": self.level_lookup_unavailable,
            "pageBudgetExhausted": self.page_budget_exhausted,
            "failed": self.failed,
            "requests": [request.as_dict() for request in self.requests],
        }


@dataclass(frozen=True)
class LevelsFyiPublicLoadOutcome:
    requested_pages: int
    reachable_pages: int
    parsed_pages: int
    level_lookup_unavailable: bool = False
    targets: tuple[LevelsFyiPublicTargetOutcome, ...] = ()

    @property
    def unavailable(self) -> bool:
        return self.requested_pages > 0 and self.reachable_pages == 0


@dataclass(frozen=True)
class _TopCompany:
    name: str
    median_total_compensation: int


@dataclass(frozen=True)
class _PublicSalaryPage:
    role_title: str
    location: str
    currency: str
    minimum_amount: int
    maximum_amount: int
    sample_count: int | None
    release_year: int
    canonical_url: str
    top_companies: tuple[_TopCompany, ...] = ()
    level_label: str = ""
    company_name: str = LEVELS_FYI_MARKET_AGGREGATE_COMPANY


@dataclass
class _CachedPublicPage:
    pages: tuple[_PublicSalaryPage, ...]
    markdown_reachable: bool
    html_attempted: bool = False
    html_reachable: bool = False
    html: str | None = None
    requests: tuple[LevelsFyiPublicRequestOutcome, ...] = ()


_FAMILY_SLUGS = {
    "software_engineering": "software-engineer",
    "engineering_management": "software-engineering-manager",
    "data_science": "data-scientist",
    "data_engineering": "data-engineer",
    "machine_learning": "machine-learning-engineer",
    "product_management": "product-manager",
    "product_design": "product-designer",
    "sales": "sales",
    "marketing": "marketing",
    "finance": "financial-analyst",
    "human_resources": "human-resources",
    "information_technology": "information-technologist",
}
_COUNTRY_ROUTES = {
    "AD": "andorra",
    "AL": "albania",
    "AT": "austria",
    "BA": "bosnia-and-herzegovina",
    "BE": "belgium",
    "BG": "bulgaria",
    "BY": "belarus",
    "CA": "canada",
    "CH": "switzerland",
    "CY": "cyprus",
    "CZ": "czech-republic",
    "DE": "germany",
    "DK": "denmark",
    "EE": "estonia",
    "ES": "spain",
    "FI": "finland",
    "FR": "france",
    "GB": "united-kingdom",
    "GR": "greece",
    "HR": "croatia",
    "HU": "hungary",
    "IE": "ireland",
    "IS": "iceland",
    "IT": "italy",
    "LI": "liechtenstein",
    "LT": "lithuania",
    "LU": "luxembourg",
    "LV": "latvia",
    "MC": "monaco",
    "MD": "moldova",
    "ME": "montenegro",
    "MK": "north-macedonia",
    "MT": "malta",
    "NL": "netherlands",
    "NO": "norway",
    "PL": "poland",
    "PT": "portugal",
    "RO": "romania",
    "RS": "serbia",
    "SE": "sweden",
    "SI": "slovenia",
    "SK": "slovakia",
    "UA": "ukraine",
    "US": "united-states",
}
_LEVEL_ROUTES = {"senior": "senior", "junior": "entry-level"}


def load_levels_fyi_public_observations(
    targets: Iterable[LevelsFyiPublicTarget],
    *,
    fetch_text: TextFetcher,
    max_pages: int = DEFAULT_LEVELS_FYI_PUBLIC_MAX_PAGES,
    on_load_outcome: Callable[[LevelsFyiPublicLoadOutcome], None] | None = None,
) -> tuple[ReportedCompensationObservation, ...]:
    """Load attributed public observations for unique job-family/location pages."""

    targets = tuple(dict.fromkeys(targets))
    queries: dict[tuple[str, str, str], LevelsFyiPublicTarget] = {}
    target_outcomes: dict[LevelsFyiPublicTarget, LevelsFyiPublicTargetOutcome] = {}
    for target in targets:
        canonical_url = levels_fyi_public_url(target)
        if canonical_url:
            queries.setdefault((canonical_url, _target_level(target), target.occupation_family_code), target)
        else:
            target_outcomes[target] = LevelsFyiPublicTargetOutcome(
                target, "unsupported_role" if target.occupation_family_code not in _FAMILY_SLUGS else "unsupported_country",
            )

    observations: dict[tuple[Any, ...], ReportedCompensationObservation] = {}
    cache: dict[str, _CachedPublicPage] = {}
    level_lookup_unavailable = False
    for target in queries.values():
        requested_level = _target_level(target)
        queue = _geographic_routes(target)
        visited: set[str] = set()
        target_pages: list[_CachedPublicPage] = []
        target_lookup_unavailable = False
        page_budget_exhausted = False
        # Each query can follow only a bounded subset of provider-published links.
        # Cached pages are shared across roles/levels in a refresh.
        while queue and len(visited) < 12:
            canonical_url = queue.pop(0)
            if canonical_url in visited:
                continue
            visited.add(canonical_url)
            if canonical_url not in cache:
                if len(cache) >= max(0, max_pages):
                    page_budget_exhausted = True
                    break
                markdown, request = _fetch_outcome(fetch_text, _markdown_url(canonical_url))
                page, parse_status = _parse_outcome(parse_levels_fyi_markdown, markdown, canonical_url)
                request = replace(request, parse_status=parse_status)
                cache[canonical_url] = _CachedPublicPage(
                    (page,) if page is not None else (), bool(markdown), requests=(request,),
                )
            cached = cache[canonical_url]
            # A generic request may have needed only Markdown. Upgrade that same
            # cache entry when a later known-level request needs HTML discovery.
            if not cached.html_attempted and (not cached.pages or requested_level != "unknown"):
                cached.html_attempted = True
                cached.html, request = _fetch_outcome(fetch_text, canonical_url)
                cached.html_reachable = bool(cached.html)
                if cached.html:
                    html_page, parse_status = _parse_outcome(parse_levels_fyi_html, cached.html, canonical_url)
                    request = replace(request, parse_status=parse_status)
                    if html_page:
                        cached.pages = (html_page,)
                    cached.pages += _company_level_pages(cached.html, canonical_url)
                cached.requests += (request,)
            target_pages.append(cached)
            pages = cached.pages
            links = _salary_links(cached.html, canonical_url, target) if cached.html else ()
            if requested_level != "unknown" and not cached.html_reachable:
                level_lookup_unavailable = True
                target_lookup_unavailable = True
            for page in pages:
                # Broader levels remain context; only source-labelled exact levels
                # become level evidence, regardless of the requested route.
                for observation in _page_observations(page):
                    key = (
                        observation.source_url,
                        observation.company_name,
                        observation.role_title,
                        observation.level_label,
                    )
                    observations[key] = observation
            if requested_level != "unknown":
                queue.extend(link for link in links if link not in visited and link not in queue)
                queue.sort(key=lambda url: _route_priority(url, target))
        # Snapshot this target now: a later cache upgrade for another level must
        # not retroactively assign its HTML failure to a successful generic read.
        target_outcomes[target] = LevelsFyiPublicTargetOutcome(
            target, "supported", requested_pages=len(target_pages),
            reachable_pages=sum(page.markdown_reachable or page.html_reachable for page in target_pages),
            parsed_pages=sum(bool(page.pages) for page in target_pages),
            level_lookup_unavailable=target_lookup_unavailable,
            page_budget_exhausted=page_budget_exhausted or bool(queue),
            requests=tuple(request for page in target_pages for request in page.requests),
        )

    if on_load_outcome is not None:
        on_load_outcome(
            LevelsFyiPublicLoadOutcome(
                len(cache),
                sum(page.markdown_reachable or page.html_reachable for page in cache.values()),
                sum(bool(page.pages) for page in cache.values()),
                level_lookup_unavailable,
                tuple(target_outcomes[target] for target in targets),
            )
        )
    return tuple(observations.values())


def _target_level(target):
    return target.seniority_code


def _geographic_routes(target):
    route = levels_fyi_public_url(target)
    if not route:
        return []
    level_slug = _LEVEL_ROUTES.get(target.seniority_code)
    if level_slug and target.occupation_family_code == "software_engineering":
        return [route.replace("/t/software-engineer", f"/t/software-engineer/levels/{level_slug}"), route]
    return [route]


def _markdown_url(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path}.md" + (f"?{parts.query}" if parts.query else "")


def _salary_links(text: str, canonical_url: str, target: LevelsFyiPublicTarget) -> tuple[str, ...]:
    parser = _NextDataParser()
    parser.feed(text)
    role_slug = levels_fyi_role_slug(target.occupation_family_code)
    links: set[str] = set()
    for href in parser.links:
        url = urljoin(canonical_url, href)
        parts = urlsplit(url)
        if parts.scheme != "https" or parts.netloc != "www.levels.fyi" or parts.fragment or parts.query:
            continue
        path = parts.path.rstrip("/")
        if path.endswith(".md"):
            continue
        company_match = re.fullmatch(
            r"/companies/[a-z0-9-]+/salaries(?:/([a-z0-9-]+)(?:/(?:levels|locations)/[a-z0-9-]+){0,2})?", path
        )
        regional = path == f"/t/{role_slug}" or path.startswith(f"/t/{role_slug}/")
        if regional or (company_match and company_match.group(1) in {None, role_slug}):
            links.add(f"{LEVELS_FYI_BASE_URL}{path}")
    return tuple(sorted(links, key=lambda url: (_route_priority(url, target), url)))[:12]


def _route_priority(url, target):
    path = urlsplit(url).path
    location = _COUNTRY_ROUTES.get(target.country_code)
    return (0 if location and path.endswith("/locations/" + location) else 1, 0 if "/levels/" in path else 1, url)


def levels_fyi_public_url(target):
    role_slug = _FAMILY_SLUGS.get(target.occupation_family_code)
    location_slug = _COUNTRY_ROUTES.get(target.country_code)
    if not role_slug or not location_slug:
        return None
    return f"{LEVELS_FYI_BASE_URL}/t/{role_slug}" + (
        f"/locations/{location_slug}" if target.country_code != "US" else ""
    )


def levels_fyi_role_slug(occupation_family_code):
    return _FAMILY_SLUGS.get(occupation_family_code)


def parse_levels_fyi_markdown(text: str, *, canonical_url: str) -> _PublicSalaryPage | None:
    if "Levels.fyi" not in text or "Aggregate Highlights" not in text:
        return None
    role_match = re.search(r"^#\s+Levels\.fyi\s+[–-]\s+(.+?)\s+Salar(?:y|ies)(?:\s+in\s+.+)?$", text, re.MULTILINE)
    location_match = re.search(r"^\*\*Location:\*\*\s*(.+?)\s*$", text, re.MULTILINE)
    currency_match = re.search(r"^\*\*Currency:\*\*\s*([A-Z]{3})", text, re.MULTILINE)
    generated_match = re.search(r"^\*\*Generated:\*\*\s*(\d{4})-", text, re.MULTILINE)
    median = _markdown_money(text, r"Median Total Compensation:\s*([^\n]+)")
    percentile_match = re.search(r"25th\s*/\s*75th Percentile:\s*([^/\n]+)\s*/\s*([^\n]+)", text)
    if not role_match or not location_match or not currency_match or median is None:
        return None
    minimum = _money(percentile_match.group(1)) if percentile_match else median
    maximum = _money(percentile_match.group(2)) if percentile_match else median
    if minimum is None or maximum is None:
        return None
    top_companies: list[_TopCompany] = []
    company_section = (
        text.split("### Top Paying Companies", 1)[1].split("\n#", 1)[0] if "### Top Paying Companies" in text else ""
    )
    for company, amount in re.findall(
        r"^\|\s*\d+\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$", company_section, re.MULTILINE
    ):
        parsed_amount = _money(amount)
        if parsed_amount is not None:
            top_companies.append(_TopCompany(name=company.strip(), median_total_compensation=parsed_amount))
    return _PublicSalaryPage(
        role_title=role_match.group(1).strip(),
        location=location_match.group(1).strip(),
        currency=currency_match.group(1),
        minimum_amount=minimum,
        maximum_amount=maximum,
        sample_count=None,
        release_year=int(generated_match.group(1)) if generated_match else datetime.now(timezone.utc).year,
        canonical_url=canonical_url,
        top_companies=tuple(top_companies),
        level_label="",
    )


def parse_levels_fyi_html(text: str, *, canonical_url: str) -> _PublicSalaryPage | None:
    parser = _NextDataParser()
    parser.feed(text)
    if not parser.payload:
        return None
    try:
        next_data = json.loads(parser.payload)
        page_props = next_data["props"]["pageProps"]
        schema = next(
            (
                page_props[key]
                for key in (
                    "levelPageOccupationSchema",
                    "generatedOccupationSchema",
                    "jobFamilyLocationPageOccupationSchema",
                )
                if page_props.get(key)
            ),
            None,
        )
        occupation = json.loads(schema) if isinstance(schema, str) else schema
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(page_props, dict) or not isinstance(occupation, dict):
        return None
    distributions = occupation.get("estimatedSalary")
    total = (
        next(
            (
                value
                for value in distributions
                if isinstance(value, dict) and str(value.get("name") or "").casefold() == "total"
            ),
            None,
        )
        if isinstance(distributions, list)
        else None
    )
    if not isinstance(total, dict):
        return None
    minimum = _integer(total.get("percentile25"))
    maximum = _integer(total.get("percentile75"))
    median = _integer(total.get("median"))
    role_title = _text(page_props.get("jobFamily"))
    location_info = page_props.get("locationInfo") or page_props.get("locationMeta") or {}
    location = _text(page_props.get("location")) or _text(location_info.get("displayName") or location_info.get("name"))
    currency = _text(total.get("currency") or page_props.get("locationCurrency")).upper()
    if total.get("unitText") not in {None, "YEAR"}:
        return None
    if not role_title or not location or not re.fullmatch(r"[A-Z]{3}", currency) or median is None:
        return None
    if minimum is None:
        minimum = median
    if maximum is None:
        maximum = median

    exchange_rate = _positive_float(page_props.get("locationExchangeRate")) or 1.0
    top_companies: list[_TopCompany] = []
    raw_top_companies = page_props.get("topPayingCompanies")
    if isinstance(raw_top_companies, list):
        for value in raw_top_companies:
            if not isinstance(value, dict):
                continue
            name = _text(value.get("name"))
            raw_amount = _positive_float(value.get("totalCompensation"))
            if name and raw_amount:
                top_companies.append(
                    _TopCompany(
                        name=name,
                        median_total_compensation=round(raw_amount * exchange_rate),
                    )
                )

    reviewed = occupation.get("mainEntityOfPage")
    reviewed_at = reviewed.get("lastReviewed") if isinstance(reviewed, dict) else None
    return _PublicSalaryPage(
        role_title=role_title,
        location=location,
        currency=currency,
        minimum_amount=minimum,
        maximum_amount=maximum,
        sample_count=_integer(occupation.get("sampleSize") or page_props.get("totalJobFamilySubmissionCount")),
        release_year=_year(reviewed_at),
        canonical_url=canonical_url,
        top_companies=tuple(top_companies),
        level_label=_text(page_props.get("level")),
        company_name=_company_name(page_props)
        or _text((occupation.get("hiringOrganization") or {}).get("name"))
        or LEVELS_FYI_MARKET_AGGREGATE_COMPANY,
    )


def _page_props(text: str) -> dict[str, Any]:
    parser = _NextDataParser()
    parser.feed(text)
    try:
        value = json.loads(parser.payload)["props"]["pageProps"]
        return value if isinstance(value, dict) else {}
    except (ValueError, TypeError, KeyError):
        return {}


def _company_name(props: dict[str, Any]) -> str:
    company = props.get("company")
    if isinstance(company, dict):
        return _text(company.get("name"))
    if isinstance(company, str):
        return _text(company)
    levels = props.get("levels")
    if isinstance(levels, dict):
        return _text(levels.get("company"))
    return ""


def _company_level_pages(text: str, canonical_url: str) -> tuple[_PublicSalaryPage, ...]:
    """Read the displayed company/location career-level table, never global percentiles.

    Levels' table totals are USD; its explicit location exchange rate converts
    those values to the page currency. Numeric company grades carry no inferred
    seniority. Per-level links and names are supplied by the provider itself.
    """
    props = _page_props(text)
    rows = props.get("averages")
    company = _company_name(props)
    location_info = props.get("locationMeta")
    if not isinstance(rows, list) or not company or not isinstance(location_info, dict):
        return ()
    location = _text(location_info.get("displayName") or location_info.get("name"))
    currency = _text(props.get("locationCurrency"))
    rate = _positive_float(props.get("locationExchangeRate"))
    role = _text(props.get("jobFamily"))
    if not location or not role or not re.fullmatch(r"[A-Z]{3}", currency) or rate is None:
        return ()
    schema = props.get("generatedOccupationSchema")
    if isinstance(schema, str):
        try:
            schema = json.loads(schema)
        except ValueError:
            schema = None
    reviewed = schema.get("mainEntityOfPage") if isinstance(schema, dict) else None
    year = _year(reviewed.get("lastReviewed") if isinstance(reviewed, dict) else None)
    pages = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        level = _text(row.get("primaryLevelName"))
        total = _positive_float(row.get("total"))
        count = _integer(row.get("count"))
        source_url = urljoin(canonical_url, _text(row.get("levelPageUrl")))
        parts = urlsplit(source_url)
        # A link for the same company/family is a source-owned identifier. Do not
        # synthesize grade slugs from job titles or arbitrary employer names.
        company_prefix = urlsplit(canonical_url).path.split("/salaries", 1)[0]
        if (
            not level
            or total is None
            or count is None
            or count < 1
            or parts.netloc != "www.levels.fyi"
            or parts.scheme != "https"
            or parts.query
            or parts.fragment
            or not parts.path.startswith(f"{company_prefix}/salaries/{props.get('jobFamilySlug')}/levels/")
        ):
            continue
        amount = round(total * rate)
        pages.append(
            _PublicSalaryPage(
                role,
                location,
                currency,
                amount,
                amount,
                count,
                year,
                source_url,
                level_label=level,
                company_name=company,
            )
        )
    return tuple(pages)


class _NextDataParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._inside_next_data = False
        self._chunks: list[str] = []
        self.links: list[str] = []

    @property
    def payload(self) -> str:
        return "".join(self._chunks)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        self._inside_next_data = tag == "script" and attributes.get("id") == "__NEXT_DATA__"
        if tag == "a" and attributes.get("href"):
            self.links.append(str(attributes["href"]))

    def handle_endtag(self, tag: str) -> None:
        if tag == "script":
            self._inside_next_data = False

    def handle_data(self, data: str) -> None:
        if self._inside_next_data:
            self._chunks.append(data)


def _page_observations(
    page: _PublicSalaryPage,
) -> tuple[ReportedCompensationObservation, ...]:
    minimum = page.minimum_amount
    maximum = page.maximum_amount
    if minimum is None or maximum is None or minimum <= 0 or maximum < minimum:
        return ()
    currency = page.currency
    snapshot = f"levels-fyi-public-{page.release_year}"
    observations = [
        ReportedCompensationObservation(
            source_id="levels_fyi",
            source_provenance="public",
            company_name=page.company_name,
            role_title=page.role_title,
            minimum_amount=minimum,
            maximum_amount=maximum,
            currency=currency,
            period="year",
            component="total_compensation",
            location=page.location,
            level_label=page.level_label,
            release_year=page.release_year,
            snapshot_version=snapshot,
            sample_count=page.sample_count,
            attribution=LEVELS_FYI_ATTRIBUTION,
            source_url=page.canonical_url,
        )
    ]
    for company in page.top_companies:
        amount = company.median_total_compensation
        if amount is None or amount <= 0:
            continue
        observations.append(
            ReportedCompensationObservation(
                source_id="levels_fyi",
                source_provenance="public",
                company_name=company.name,
                role_title=page.role_title,
                minimum_amount=amount,
                maximum_amount=amount,
                currency=currency,
                period="year",
                component="total_compensation",
                location=page.location,
                level_label=page.level_label,
                release_year=page.release_year,
                snapshot_version=snapshot,
                sample_count=None,
                attribution=LEVELS_FYI_ATTRIBUTION,
                source_url=page.canonical_url,
            )
        )
    return tuple(observations)


def _fetch_outcome(fetch_text: TextFetcher, url: str) -> tuple[str | None, LevelsFyiPublicRequestOutcome]:
    try:
        value = fetch_text(url)
    except HTTPError as error:
        return None, LevelsFyiPublicRequestOutcome(url, "http_error", http_status=error.code)
    except Exception as error:  # noqa: BLE001 - keep the failure scoped and omit sensitive messages
        return None, LevelsFyiPublicRequestOutcome(url, "fetch_error", error_type=type(error).__name__)
    if value is None:
        return None, LevelsFyiPublicRequestOutcome(url, "unavailable")
    raw = str(value)
    text = raw.strip()
    return text or None, LevelsFyiPublicRequestOutcome(
        url, "available" if text else "empty", snapshot_sha256=hashlib.sha256(raw.encode()).hexdigest(),
    )


def _parse_outcome(parser, text, canonical_url):
    if not text:
        return None, None
    try:
        page = parser(text, canonical_url=canonical_url)
        return page, "parsed" if page is not None else "unparsed"
    except Exception:  # noqa: BLE001 - retain the structural failure without source text
        return None, "parse_error"


def _markdown_money(text: str, pattern: str) -> int | None:
    match = re.search(pattern, text)
    return _money(match.group(1)) if match else None


def _money(value: Any) -> int | None:
    match = re.search(r"\d[\d,._\s]*", str(value or ""))
    if not match:
        return None
    digits = re.sub(r"\D", "", match.group(0))
    return int(digits) if digits else None


def _integer(value: Any) -> int | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return round(parsed) if math.isfinite(parsed) else None


def _positive_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) and parsed > 0 else None


def _year(value: Any) -> int:
    match = re.match(r"(\d{4})", str(value or ""))
    return int(match.group(1)) if match else datetime.now(timezone.utc).year


def _text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _normalized_words(value: Any) -> str:
    folded = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode("ascii")
    folded = folded.casefold().replace("&", " and ")
    folded = re.sub(r"[^a-z0-9,]+", " ", folded)
    return re.sub(r"\s+", " ", folded).strip()


def _slugify(value: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", value.casefold())).strip("-")
