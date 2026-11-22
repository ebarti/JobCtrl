"""Bounded public Euro Top Tech compensation-feed acquisition."""

from __future__ import annotations

import re
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any, Callable
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from jobctrl.features.compensation.core.ports import Classification, Observation
from jobctrl.features.compensation.providers.common import ProviderLoad, row_source

EURO_TOP_TECH_DATA_ENTRIES_URL = "https://www.eurotoptech.com/api/data-entries?sort=submitted&dir=desc"
EURO_TOP_TECH_ATTRIBUTION = "Euro Top Tech public crowdsourced compensation data (https://www.eurotoptech.com/data)"
EURO_TOP_TECH_SOURCE_URL = "https://www.eurotoptech.com/data"
JsonFeedFetcher = Callable[[str], Any]


def _cursor_url(cursor: str) -> str:
    parts = urlsplit(EURO_TOP_TECH_DATA_ENTRIES_URL)
    query = [(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True) if key != "cursor"]
    query.append(("cursor", cursor))
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), ""))


def _observation(data: dict[str, Any]) -> Observation | None:
    raw_amount = data.get("preTaxTC")
    if raw_amount in (None, ""):
        return None
    if isinstance(raw_amount, bool):
        raise ValueError("invalid amount")
    try:
        amount_value = Decimal(str(raw_amount))
        if not amount_value.is_finite() or amount_value != amount_value.to_integral_value():
            raise ValueError("invalid amount")
        amount = int(amount_value)
    except (InvalidOperation, ValueError, OverflowError):
        raise ValueError("invalid amount") from None
    if amount <= 0:
        return None

    def text(key: str) -> str:
        return str(data.get(key) or "").strip()

    company = text("company") or None
    role = text("jobTitle")
    level = text("seniority") or None
    submitted = text("submittedMonth")
    country, city = text("country"), text("city")
    location = f"{city}, {country}" if city and country else (country or city or None)
    year = None
    if re.fullmatch(r"\d{4}-\d{2}", submitted):
        try:
            year = date(int(submitted[:4]), int(submitted[5:]), 1).year
        except ValueError:
            pass
    as_of = submitted if year is not None else None
    snapshot = f"eurotoptech-data-{submitted}" if as_of else "eurotoptech-data-public"
    # Preserve the source's actual row fields; the EUR/year interpretation is
    # part of the existing Euro Top Tech feed contract, not inferred from pay.
    source_row = {
        key: data.get(key)
        for key in ("company", "jobTitle", "seniority", "country", "city", "submittedMonth", "preTaxTC")
    }
    return Observation(
        source=row_source(
            "euro_top_tech",
            source_row,
            snapshot=snapshot,
            as_of=as_of,
            url=EURO_TOP_TECH_SOURCE_URL,
            attribution=EURO_TOP_TECH_ATTRIBUTION,
        ),
        provider="euro_top_tech",
        provenance="public",
        company=company,
        company_reference=None,
        role=role,
        location=location,
        level=level,
        component="total_compensation",
        currency="EUR",
        period="year",
        minimum=amount,
        maximum=amount,
        sample_count=1,
        release_year=year,
        attribution=EURO_TOP_TECH_ATTRIBUTION,
    )


class EuroTopTechProvider:
    def __init__(self, fetch_json: JsonFeedFetcher, *, max_pages: int = 10):
        self._fetch_json = fetch_json
        self._max_pages = max_pages

    def load(self, target: Classification, policy: dict) -> ProviderLoad:
        del target
        # Euro Top Tech is the existing fixed public source; the host can opt
        # out explicitly, and is responsible for authorizing a refresh.
        if policy.get("enabled") is False:
            return ProviderLoad()
        observations: list[Observation] = []
        next_url: str | None = EURO_TOP_TECH_DATA_ENTRIES_URL
        seen: set[str] = set()
        requested = parsed = 0
        errors: list[str] = []
        while next_url and requested < max(0, self._max_pages) and next_url not in seen:
            seen.add(next_url)
            requested += 1
            try:
                payload = self._fetch_json(next_url)
                if not isinstance(payload, dict) or not isinstance(payload.get("rows"), list):
                    raise ValueError("unavailable or incompatible response")
                parsed += 1
                for item in payload["rows"]:
                    if not isinstance(item, dict):
                        errors.append("euro_top_tech_invalid_observation")
                        continue
                    try:
                        observation = _observation(item)
                    except (ValueError, TypeError, OverflowError):
                        errors.append("euro_top_tech_invalid_observation")
                        continue
                    if observation is not None:
                        observations.append(observation)
                cursor = payload.get("nextCursor") if payload.get("hasMore") else None
                if payload.get("hasMore") and not cursor:
                    errors.append("euro_top_tech_unavailable")
                next_url = _cursor_url(str(cursor)) if cursor else None
            except Exception:  # noqa: BLE001 - partial evidence and safe failure stay visible
                errors.append("euro_top_tech_unavailable")
                break
        if next_url in seen and not errors:
            errors.append("euro_top_tech_unavailable")
        # The existing source intentionally samples at most max_pages; reaching
        # that configured bound is not a failed source request or an assertion
        # that the provider has no additional data.
        page_limit_reached = bool(next_url and next_url not in seen and requested >= max(0, self._max_pages))
        return ProviderLoad(
            tuple(observations),
            tuple(dict.fromkeys(errors)),
            diagnostics=(
                ("requested_pages", requested),
                ("parsed_pages", parsed),
                ("page_limit_reached", page_limit_reached),
            ),
        )

    def observations(self, target: Classification, policy: dict) -> tuple[Observation, ...]:
        return self.load(target, policy).require_complete()
