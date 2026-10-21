"""Canonical rendered and declared posting sources shared by automatic and manual intake."""

import json
import math
from typing import Any
from urllib.parse import urljoin

from bs4 import BeautifulSoup
from datetime import datetime, timezone
import hashlib

from jobctrl.domain.enrichment.snapshot_services import same_posting_url
from jobctrl.domain.enrichment.value_objects import DetailPage


def live_posting_page(result, url):
    """Preserve the extension's captured page without interpreting its content."""
    html = result.body_html or result.body_text
    soup = BeautifulSoup(html, "html.parser")
    declared = []
    for element in soup.select('script[type="application/ld+json"]'):
        try:
            declared.append(json.loads(element.get_text()))
        except (TypeError, json.JSONDecodeError):
            continue
    return DetailPage(
        url=url,
        final_url=result.final_url,
        page_title=result.title,
        html=html[:1_000_000],
        status_html=html[:1_000_000],
        status_evidence_complete=len(html) <= 1_000_000,
        raw_html_hash=hashlib.sha256(html.encode()).hexdigest(),
        json_ld=tuple(declared),
        status=result.status_code,
        fetched_at=datetime.now(timezone.utc).isoformat(),
    )


def _find_job_postings(value: Any) -> tuple[dict[str, Any], ...]:
    found: list[dict[str, Any]] = []
    if isinstance(value, dict):
        type_value = value.get("@type")
        types = type_value if isinstance(type_value, list) else [type_value]
        if "JobPosting" in types:
            found.append(value)
        graph = value.get("@graph")
        if isinstance(graph, list):
            found.extend(_find_job_postings(graph))
    elif isinstance(value, (list, tuple)):
        for item in value:
            found.extend(_find_job_postings(item))
    return tuple(found)


def _employer_name(posting: dict[str, Any] | None) -> str:
    if not posting:
        return ""
    organization = posting.get("hiringOrganization")
    return _text(organization.get("name")) if isinstance(organization, dict) else ""


def _location_text(posting: dict[str, Any] | None) -> str:
    if not posting:
        return ""
    if _text(posting.get("jobLocationType")).casefold() == "telecommute":
        return "Remote"
    locations = posting.get("jobLocation")
    values = locations if isinstance(locations, list) else [locations]
    parts: list[str] = []
    for value in values:
        if not isinstance(value, dict):
            continue
        address = value.get("address")
        if not isinstance(address, dict):
            continue
        formatted = ", ".join(
            part
            for part in (
                _text(address.get("addressLocality")),
                _text(address.get("addressRegion")),
                _text(address.get("addressCountry")),
            )
            if part
        )
        if formatted and formatted not in parts:
            parts.append(formatted)
    return "; ".join(parts)


def _salary_text(posting: dict[str, Any] | None) -> str:
    if not posting:
        return ""
    salary = posting.get("baseSalary")
    if not isinstance(salary, dict):
        return ""
    currency = _text(salary.get("currency"))
    value = salary.get("value")
    if isinstance(value, dict):
        minimum = _number_text(value.get("minValue"))
        maximum = _number_text(value.get("maxValue"))
        exact = _number_text(value.get("value"))
        amount = f"{minimum}-{maximum}" if minimum and maximum else minimum or maximum or exact
        unit = _text(value.get("unitText")).casefold()
    else:
        amount = _number_text(value)
        unit = ""
    if not amount:
        return ""
    period = {"year": "year", "month": "month", "week": "week", "day": "day", "hour": "hour"}.get(unit)
    priced = " ".join(part for part in (currency, amount) if part)
    return f"{priced}/{period}" if period else priced


def _number_text(value: Any) -> str:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return ""
    numeric = float(value)
    if not math.isfinite(numeric):
        return ""
    return str(int(value)) if numeric.is_integer() else str(value)


def _text(value: Any) -> str:
    return BeautifulSoup(str(value or ""), "html.parser").get_text(" ", strip=True)


def rendered_page_text(page):
    status = getattr(page, "status_html", "")
    captured = (
        status
        if status and getattr(page, "status_evidence_complete", True)
        else getattr(page, "html", "") or status or ""
    )
    soup = BeautifulSoup(str(captured), "html.parser")
    for element in soup.select("script,style,noscript,template,[hidden],[inert],[aria-hidden='true']"):
        if element.parent is None:
            continue
        element.decompose()
    return str(getattr(page, "page_title", "") or "") + "\n" + soup.get_text("\n", strip=True)


def posting_page_sources(page, *, entity_id):
    from jobctrl.domain.determinations import Source

    sources, origins = [], {}
    links_remaining = 100

    def add(ident, text, origin):
        sources.append(Source(source_id=ident, text=text))
        origins[ident] = origin

    components = [
        ("", page),
        *((f"embedded:{index}:", frame) for index, frame in enumerate(getattr(page, "embedded_pages", ()))),
    ]
    for prefix, component in components:
        origin = str(getattr(component, "final_url", "") or getattr(component, "url", "") or entity_id)
        add(prefix + "rendered_page", rendered_page_text(component), origin)
        add(prefix + "page_url", origin, origin)
        # Interpret declared fields through the model; URL fences exclude neighbors.
        for index, posting in enumerate(_find_job_postings(getattr(component, "json_ld", ()) or ())):
            posting_url = _text(posting.get("url"))
            if posting_url and not same_posting_url(posting_url, origin):
                continue
            add(f"{prefix}posting:{index}:structured", json.dumps(posting, ensure_ascii=False), origin)
            fields = {
                "title": _text(posting.get("title")),
                "employer": _employer_name(posting),
                "description": _text(posting.get("description")),
                "location": _location_text(posting),
                "salary": _salary_text(posting),
            }
            for name, value in fields.items():
                if value:
                    add(f"{prefix}posting:{index}:{name}", value, origin)
        soup = BeautifulSoup(getattr(component, "html", "") or "", "html.parser")
        links = soup.find_all("a", href=True)[:links_remaining]
        links_remaining -= len(links)
        for index, link in enumerate(links):
            add(f"{prefix}link:{index}:url", urljoin(origin, str(link["href"])), origin)
            label = link.get_text(" ", strip=True)
            if label:
                add(f"{prefix}link:{index}:label", label, origin)
    return sources, origins
