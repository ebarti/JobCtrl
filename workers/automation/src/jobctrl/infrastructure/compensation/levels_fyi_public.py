"""Tokenless Levels.fyi public salary-page ingestion.

Levels.fyi publishes bot-friendly ``.md`` salary routes through ``llms.txt``.
Some location routes currently return an empty Markdown response, so the
adapter falls back to the same public page's structured ``__NEXT_DATA__``
payload. It never uses private APIs, credentials, or authenticated sessions.
"""

from __future__ import annotations

import json
import math
import re
import unicodedata
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urljoin, urlsplit

from jobctrl.domain.compensation.benchmarks import classify_seniority, resolve_country_code, resolve_reported_seniority

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

    role_title: str
    location: str | None
    seniority_label: str | None = None


@dataclass(frozen=True)
class LevelsFyiPublicLoadOutcome:
    requested_pages: int
    reachable_pages: int
    parsed_pages: int
    level_lookup_unavailable: bool = False

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
    level_label: str = "all levels"
    company_name: str = LEVELS_FYI_MARKET_AGGREGATE_COMPANY


@dataclass
class _CachedPublicPage:
    pages: tuple[_PublicSalaryPage, ...]
    markdown_reachable: bool
    html_attempted: bool = False
    html_reachable: bool = False
    html: str | None = None


_ROLE_RULES: tuple[tuple[re.Pattern[str], str], ...] = (
    (
        re.compile(
            r"\b(?:director|head|vp|vice\s+president)\b.*\b(?:software\s+)?engineering\b"
            r"|\b(?:software\s+)?engineering\b.*\b(?:director|head)\b"
        ),
        "software-engineering-manager",
    ),
    (
        re.compile(r"\b(?:software|engineering|technology)\s+(?:engineering\s+)?manager\b"),
        "software-engineering-manager",
    ),
    (re.compile(r"\bdata\s+science\s+manager\b"), "data-science-manager"),
    (re.compile(r"\bproduct\s+design\s+manager\b"), "product-design-manager"),
    (re.compile(r"\btechnical\s+program\s+manager\b"), "technical-program-manager"),
    (re.compile(r"\bprogram\s+manager\b"), "program-manager"),
    (re.compile(r"\bproject\s+manager\b"), "project-manager"),
    (re.compile(r"\bproduct\s+manager\b"), "product-manager"),
    (re.compile(r"\bproduct\s+designer\b|\bux\s+designer\b|\bui\s+designer\b"), "product-designer"),
    (re.compile(r"\bux\s+researcher\b|\buser\s+researcher\b"), "ux-researcher"),
    (re.compile(r"\bdata\s+scientist\b"), "data-scientist"),
    (re.compile(r"\bdata\s+analyst\b|\bbusiness\s+intelligence\s+analyst\b"), "data-analyst"),
    (re.compile(r"\bbusiness\s+analyst\b"), "business-analyst"),
    (re.compile(r"\bsolution(?:s)?\s+architect\b|\bcloud\s+architect\b|\bdata\s+architect\b"), "solution-architect"),
    (re.compile(r"\bsales\s+engineer\b|\bsolutions?\s+engineer\b"), "sales-engineer"),
    (re.compile(r"\bsecurity\s+analyst\b|\bcyber(?:security)?\s+analyst\b"), "security-analyst"),
    (re.compile(r"\bprompt\s+engineer\b"), "prompt-engineer"),
    (
        re.compile(
            r"\b(?:software|platform|backend|front\s*end|full\s*stack|mobile|ios|android|devops|site\s+reliability|data|machine\s+learning|ml|ai)\s+(?:software\s+)?(?:engineer|developer)\b"
        ),
        "software-engineer",
    ),
    (re.compile(r"\btechnical\s+writer\b"), "technical-writer"),
    (re.compile(r"\baccount(?:\s+executive|\s+manager)\b|\bsales\b"), "sales"),
    (re.compile(r"\bcustomer\s+success\b"), "customer-success"),
    (re.compile(r"\brecruiter\b|\btalent\s+acquisition\b"), "recruiter"),
    (re.compile(r"\bmarketing\b"), "marketing"),
)

_TITLE_NOISE = re.compile(
    r"\b(?:junior|jr|mid|middle|senior|sr|staff|principal|lead|head|director|chief|vp|vice\s+president|i|ii|iii|iv)\b"
)

# Levels.fyi location routes use ISO-3166 alpha-3 suffixes for cities.
_COUNTRY_LOCATION_CODES: dict[str, tuple[str, str]] = {
    "albania": ("albania", "alb"),
    "andorra": ("andorra", "and"),
    "austria": ("austria", "aut"),
    "belarus": ("belarus", "blr"),
    "belgium": ("belgium", "bel"),
    "bosnia and herzegovina": ("bosnia-and-herzegovina", "bih"),
    "bulgaria": ("bulgaria", "bgr"),
    "canada": ("canada", "can"),
    "croatia": ("croatia", "hrv"),
    "cyprus": ("cyprus", "cyp"),
    "czech republic": ("czech-republic", "cze"),
    "czechia": ("czech-republic", "cze"),
    "denmark": ("denmark", "dnk"),
    "estonia": ("estonia", "est"),
    "finland": ("finland", "fin"),
    "france": ("france", "fra"),
    "germany": ("germany", "deu"),
    "greece": ("greece", "grc"),
    "hungary": ("hungary", "hun"),
    "iceland": ("iceland", "isl"),
    "ireland": ("ireland", "irl"),
    "italy": ("italy", "ita"),
    "latvia": ("latvia", "lva"),
    "liechtenstein": ("liechtenstein", "lie"),
    "lithuania": ("lithuania", "ltu"),
    "luxembourg": ("luxembourg", "lux"),
    "malta": ("malta", "mlt"),
    "moldova": ("moldova", "mda"),
    "monaco": ("monaco", "mco"),
    "montenegro": ("montenegro", "mne"),
    "netherlands": ("netherlands", "nld"),
    "north macedonia": ("north-macedonia", "mkd"),
    "norway": ("norway", "nor"),
    "poland": ("poland", "pol"),
    "portugal": ("portugal", "prt"),
    "romania": ("romania", "rou"),
    "serbia": ("serbia", "srb"),
    "slovakia": ("slovakia", "svk"),
    "slovenia": ("slovenia", "svn"),
    "spain": ("spain", "esp"),
    "sweden": ("sweden", "swe"),
    "switzerland": ("switzerland", "che"),
    "ukraine": ("ukraine", "ukr"),
    "united kingdom": ("united-kingdom", "gbr"),
    "united states": ("united-states", "usa"),
}

_COUNTRY_ALPHA2_TO_NAME = {
    "AD": "andorra",
    "AL": "albania",
    "AT": "austria",
    "BA": "bosnia and herzegovina",
    "BE": "belgium",
    "BG": "bulgaria",
    "BY": "belarus",
    "CA": "canada",
    "CH": "switzerland",
    "CY": "cyprus",
    "CZ": "czechia",
    "DE": "germany",
    "DK": "denmark",
    "EE": "estonia",
    "ES": "spain",
    "FI": "finland",
    "FR": "france",
    "GB": "united kingdom",
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
    "MK": "north macedonia",
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
    "US": "united states",
}

_COUNTRY_ALIASES = {
    "es": "spain",
    "esp": "spain",
    "espana": "spain",
    "uk": "united kingdom",
    "u k": "united kingdom",
    "great britain": "united kingdom",
    "england": "united kingdom",
    "gb": "united kingdom",
    "gbr": "united kingdom",
    "us": "united states",
    "u s": "united states",
    "usa": "united states",
    "united states of america": "united states",
}
_COUNTRY_ALIASES.update(
    {country_code.casefold(): country_name for country_code, country_name in _COUNTRY_ALPHA2_TO_NAME.items()}
)

_CITY_LOCATION_SLUGS = {
    "amsterdam": "amsterdam-nld",
    "barcelona": "barcelona-esp",
    "berlin": "berlin-deu",
    "brussels": "brussels-bel",
    "copenhagen": "copenhagen-dnk",
    "dublin": "dublin-irl",
    "helsinki": "helsinki-fin",
    "lisbon": "lisbon-prt",
    "london": "london-gbr",
    "madrid": "madrid-esp",
    "milan": "milan-ita",
    "oslo": "oslo-nor",
    "paris": "paris-fra",
    "prague": "prague-cze",
    "rome": "rome-ita",
    "stockholm": "stockholm-swe",
    "vienna": "vienna-aut",
    "warsaw": "warsaw-pol",
    "zurich": "zurich-che",
}

_LEGACY_TO_EUR_RATES = {
    "EUR": 1.0,
    "USD": 0.92,
    "GBP": 1.17,
    "CHF": 1.06,
    "SEK": 0.09,
    "NOK": 0.087,
    "DKK": 0.134,
    "PLN": 0.235,
    "CZK": 0.041,
}


def load_levels_fyi_public_observations(
    targets: Iterable[LevelsFyiPublicTarget],
    *,
    fetch_text: TextFetcher,
    max_pages: int = DEFAULT_LEVELS_FYI_PUBLIC_MAX_PAGES,
    preserve_source_currency: bool = False,
    on_load_outcome: Callable[[LevelsFyiPublicLoadOutcome], None] | None = None,
) -> tuple[ReportedCompensationObservation, ...]:
    """Load attributed public observations for unique job-family/location pages."""

    queries: dict[tuple[str, str, str], LevelsFyiPublicTarget] = {}
    for target in targets:
        canonical_url = levels_fyi_public_url(target)
        if canonical_url:
            queries.setdefault((canonical_url, _target_level(target), target.role_title), target)

    observations: dict[tuple[Any, ...], ReportedCompensationObservation] = {}
    cache: dict[str, _CachedPublicPage] = {}
    level_lookup_unavailable = False
    for target in queries.values():
        requested_level = _target_level(target)
        queue = _geographic_routes(target)
        visited: set[str] = set()
        # Each query can follow only a bounded subset of provider-published links.
        # Cached pages are shared across roles/levels in a refresh.
        while queue and len(visited) < 12:
            canonical_url = queue.pop(0)
            if canonical_url in visited:
                continue
            visited.add(canonical_url)
            if canonical_url not in cache:
                if len(cache) >= max(0, max_pages):
                    break
                markdown, markdown_reachable = _fetch_outcome(fetch_text, _markdown_url(canonical_url))
                page = _safe_parse(parse_levels_fyi_markdown, markdown, canonical_url) if markdown else None
                cache[canonical_url] = _CachedPublicPage((page,) if page is not None else (), markdown_reachable)
            cached = cache[canonical_url]
            # A generic request may have needed only Markdown. Upgrade that same
            # cache entry when a later known-level request needs HTML discovery.
            if not cached.html_attempted and (not cached.pages or (requested_level != "unknown" and not any(
                resolve_reported_seniority(item.role_title, item.level_label) == requested_level for item in cached.pages
            ))):
                cached.html_attempted = True
                cached.html, cached.html_reachable = _fetch_outcome(fetch_text, canonical_url)
                if cached.html:
                    html_page = _safe_parse(parse_levels_fyi_html, cached.html, canonical_url)
                    if html_page:
                        cached.pages = (html_page,)
                    cached.pages += _company_level_pages(cached.html, canonical_url)
            pages = cached.pages
            links = _salary_links(cached.html, canonical_url, target) if cached.html else ()
            if requested_level != "unknown" and not cached.html_reachable and not any(
                resolve_reported_seniority(item.role_title, item.level_label) == requested_level for item in pages
            ):
                level_lookup_unavailable = True
            for page in pages:
                if not _page_matches_canonical_location(page, page.canonical_url):
                    continue
                if levels_fyi_role_slug(page.role_title) != levels_fyi_role_slug(target.role_title):
                    continue
                # Broader levels remain context; only source-labelled exact levels
                # become level evidence, regardless of the requested route.
                for observation in _page_observations(page, preserve_source_currency=preserve_source_currency):
                    key = (observation.source_url, observation.company_name, observation.role_title,
                           observation.level_label)
                    observations[key] = observation
            if requested_level != "unknown":
                if any(page.company_name == LEVELS_FYI_MARKET_AGGREGATE_COMPANY
                       and resolve_reported_seniority(page.role_title, page.level_label) == requested_level
                       and _page_matches_canonical_location(page, canonical_url) for page in pages):
                    break
                queue.extend(link for link in links if link not in visited and link not in queue)
                queue.sort(key=lambda url: _route_priority(url, target))

    if on_load_outcome is not None:
        on_load_outcome(LevelsFyiPublicLoadOutcome(
            len(cache), sum(page.markdown_reachable or page.html_reachable for page in cache.values()),
            sum(bool(page.pages) for page in cache.values()), level_lookup_unavailable,
        ))
    return tuple(observations.values())


def _target_level(target: LevelsFyiPublicTarget) -> str:
    return target.seniority_label or classify_seniority(target.role_title)


def _geographic_routes(target: LevelsFyiPublicTarget) -> list[str]:
    routes = [levels_fyi_public_url(target)]
    country = resolve_country_code(target.location)
    if country and _target_level(target) != "unknown":
        routes.append(levels_fyi_public_url(LevelsFyiPublicTarget(target.role_title, country)))
    routes = list(dict.fromkeys(route for route in routes if route))
    # These two software-engineer routes are published by the regional page's
    # level selector. Principal and leadership have no such regional option.
    level_slug = {"senior": "senior", "entry": "entry-level"}.get(_target_level(target))
    if level_slug and levels_fyi_role_slug(target.role_title) == "software-engineer":
        routes = [route.replace("/t/software-engineer", f"/t/software-engineer/levels/{level_slug}")
                  for route in routes] + routes
    return routes


def _markdown_url(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path}.md" + (f"?{parts.query}" if parts.query else "")


def _salary_links(text: str, canonical_url: str, target: LevelsFyiPublicTarget) -> tuple[str, ...]:
    parser = _NextDataParser()
    parser.feed(text)
    role_slug = levels_fyi_role_slug(target.role_title)
    links: set[str] = set()
    for href in parser.links:
        url = urljoin(canonical_url, href)
        parts = urlsplit(url)
        if parts.scheme != "https" or parts.netloc != "www.levels.fyi" or parts.fragment or parts.query:
            continue
        path = parts.path.rstrip("/")
        if path.endswith(".md"):
            continue
        company_match = re.fullmatch(r"/companies/[a-z0-9-]+/salaries(?:/([a-z0-9-]+)(?:/(?:levels|locations)/[a-z0-9-]+){0,2})?", path)
        regional = path == f"/t/{role_slug}" or path.startswith(f"/t/{role_slug}/")
        if regional or (company_match and company_match.group(1) in {None, role_slug}):
            links.add(f"{LEVELS_FYI_BASE_URL}{path}")
    return tuple(sorted(links, key=lambda url: (_route_priority(url, target), url)))[:12]


def _route_priority(url: str, target: LevelsFyiPublicTarget) -> tuple[int, int, int]:
    path = urlsplit(url).path
    location = levels_fyi_location_slug(target.location)
    country = levels_fyi_location_slug(resolve_country_code(target.location))
    source_location = path.split("/locations/", 1)[1].split("/", 1)[0] if "/locations/" in path else ""
    geography = 0 if source_location == location else 1 if source_location == country else 2 if not source_location else 3
    level = classify_seniority(path.split("/levels/", 1)[1].split("/", 1)[0].replace("-", " ")) if "/levels/" in path else "unknown"
    return (geography, 0 if level == _target_level(target) else 1 if level == "unknown" else 2,
            0 if f"/salaries/{levels_fyi_role_slug(target.role_title)}" in path else 1)


def levels_fyi_public_url(target: LevelsFyiPublicTarget) -> str | None:
    """Return the canonical public salary page for one local job target."""

    role_slug = levels_fyi_role_slug(target.role_title)
    if not role_slug:
        return None
    location_slug = levels_fyi_location_slug(target.location)
    if location_slug == "united-states":
        return f"{LEVELS_FYI_BASE_URL}/t/{role_slug}"
    if not location_slug:
        return None
    return f"{LEVELS_FYI_BASE_URL}/t/{role_slug}/locations/{location_slug}"


def levels_fyi_role_slug(title: str) -> str | None:
    normalized = _normalized_words(title)
    if not normalized:
        return None
    for pattern, slug in _ROLE_RULES:
        if pattern.search(normalized):
            return slug
    without_noise = _TITLE_NOISE.sub(" ", normalized)
    return _slugify(without_noise) or None


def levels_fyi_location_slug(location: str | None) -> str | None:
    normalized = _normalized_words(location)
    if not normalized:
        return None
    normalized = re.sub(r"\b(?:remote|remoto|teletrabajo|work from home|wfh)\b", " ", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip(" ,-|")
    if not normalized:
        return None

    parts = [part.strip() for part in normalized.split(",") if part.strip()]
    canonical_country: str | None = None
    country_part_index: int | None = None
    for index in range(len(parts) - 1, -1, -1):
        candidate = _COUNTRY_ALIASES.get(parts[index], parts[index])
        if candidate in _COUNTRY_LOCATION_CODES:
            canonical_country = candidate
            country_part_index = index
            break

    city = next(
        (
            part
            for index, part in enumerate(parts)
            if index != country_part_index and part not in {"europe", "emea"} and part not in _COUNTRY_LOCATION_CODES
        ),
        None,
    )
    if city is not None:
        city_slug = _slugify(city)
        if canonical_country:
            return f"{city_slug}-{_COUNTRY_LOCATION_CODES[canonical_country][1]}"
        if city_slug in _CITY_LOCATION_SLUGS:
            return _CITY_LOCATION_SLUGS[city_slug]

    if canonical_country:
        country_slug, _code = _COUNTRY_LOCATION_CODES[canonical_country]
        return "united-states" if canonical_country == "united states" else country_slug

    direct_city = _slugify(parts[0])
    if direct_city in _CITY_LOCATION_SLUGS:
        return _CITY_LOCATION_SLUGS[direct_city]
    if normalized in {"europe", "emea"}:
        return "europe"
    return None


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
    company_section = text.split("### Top Paying Companies", 1)[1].split("\n#", 1)[0] if "### Top Paying Companies" in text else ""
    for company, amount in re.findall(r"^\|\s*\d+\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$", company_section, re.MULTILINE):
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
        level_label=_source_level(role_match.group(1)),
    )


def parse_levels_fyi_html(text: str, *, canonical_url: str) -> _PublicSalaryPage | None:
    parser = _NextDataParser()
    parser.feed(text)
    if not parser.payload:
        return None
    try:
        next_data = json.loads(parser.payload)
        page_props = next_data["props"]["pageProps"]
        schema = next((page_props[key] for key in ("levelPageOccupationSchema", "generatedOccupationSchema", "jobFamilyLocationPageOccupationSchema") if page_props.get(key)), None)
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
    source_locations = occupation.get("occupationLocation")
    country = resolve_country_code(location)
    if isinstance(source_locations, list) and country and any(
        resolve_country_code(item.get("name")) not in {None, country}
        for item in source_locations if isinstance(item, dict)
    ):
        return None
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
        level_label=_source_level(page_props.get("level") or occupation.get("name") or role_title),
        company_name=_company_name(page_props) or _text((occupation.get("hiringOrganization") or {}).get("name")) or LEVELS_FYI_MARKET_AGGREGATE_COMPANY,
    )


def _source_level(title: Any) -> str:
    text = _text(title)
    return text if classify_seniority(text) != "unknown" else "all levels"


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
        if (classify_seniority(level) == "unknown" or total is None or count is None or count < 1
                or parts.netloc != "www.levels.fyi" or parts.scheme != "https" or parts.query or parts.fragment
                or not parts.path.startswith(f"{company_prefix}/salaries/{props.get('jobFamilySlug')}/levels/")):
            continue
        amount = round(total * rate)
        pages.append(_PublicSalaryPage(role, location, currency, amount, amount, count, year,
                                      source_url, level_label=level, company_name=company))
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
    *,
    preserve_source_currency: bool,
) -> tuple[ReportedCompensationObservation, ...]:
    minimum = page.minimum_amount if preserve_source_currency else _legacy_to_eur(page.minimum_amount, page.currency)
    maximum = page.maximum_amount if preserve_source_currency else _legacy_to_eur(page.maximum_amount, page.currency)
    if minimum is None or maximum is None or minimum <= 0 or maximum < minimum:
        return ()
    currency = page.currency if preserve_source_currency else "EUR"
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
        amount = (
            company.median_total_compensation
            if preserve_source_currency
            else _legacy_to_eur(company.median_total_compensation, page.currency)
        )
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


def _page_matches_canonical_location(page: _PublicSalaryPage, canonical_url: str) -> bool:
    marker = "/locations/"
    if marker not in canonical_url:
        return page.location.casefold() in {"united states", "united states of america", "usa"}
    expected_slug = canonical_url.split(marker, 1)[1].split("/", 1)[0]
    return levels_fyi_location_slug(page.location) == expected_slug


def _fetch_outcome(fetch_text: TextFetcher, url: str) -> tuple[str | None, bool]:
    try:
        value = fetch_text(url)
    except Exception:  # noqa: BLE001 - one unavailable public page must not block refresh
        return None, False
    if value is None:
        return None, False
    text = str(value or "").strip()
    return text or None, bool(text)


def _safe_parse(
    parser: Callable[..., _PublicSalaryPage | None],
    text: str,
    canonical_url: str,
) -> _PublicSalaryPage | None:
    try:
        return parser(text, canonical_url=canonical_url)
    except Exception:  # noqa: BLE001 - one malformed public page must not discard other pages
        return None


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


def _legacy_to_eur(amount: int, currency: str) -> int | None:
    rate = _LEGACY_TO_EUR_RATES.get(currency.upper())
    return round(amount * rate) if rate is not None else None


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
