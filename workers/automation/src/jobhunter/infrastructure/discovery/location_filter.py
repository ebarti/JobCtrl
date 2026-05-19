"""Shared location filtering for discovery adapters."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
import re
from typing import Any


REMOTE_MARKERS = ("remote", "anywhere", "work from home", "wfh", "distributed")
US_LOCATION_ALIASES = (
    "usa",
    "us",
    "u.s.",
    "u.s.a.",
    "united states",
    "alabama",
    "alaska",
    "arizona",
    "arkansas",
    "california",
    "colorado",
    "connecticut",
    "delaware",
    "florida",
    "georgia",
    "hawaii",
    "idaho",
    "illinois",
    "indiana",
    "iowa",
    "kansas",
    "kentucky",
    "louisiana",
    "maine",
    "maryland",
    "massachusetts",
    "michigan",
    "minnesota",
    "mississippi",
    "missouri",
    "montana",
    "nebraska",
    "nevada",
    "new hampshire",
    "new jersey",
    "new mexico",
    "new york",
    "north carolina",
    "north dakota",
    "ohio",
    "oklahoma",
    "oregon",
    "pennsylvania",
    "rhode island",
    "south carolina",
    "south dakota",
    "tennessee",
    "texas",
    "utah",
    "vermont",
    "virginia",
    "washington",
    "washington dc",
    "west virginia",
    "wisconsin",
    "wyoming",
    "al",
    "ak",
    "az",
    "ar",
    "ca",
    "co",
    "ct",
    "de",
    "fl",
    "ga",
    "hi",
    "id",
    "il",
    "in",
    "ia",
    "ks",
    "ky",
    "la",
    "me",
    "md",
    "ma",
    "mi",
    "mn",
    "ms",
    "mo",
    "mt",
    "ne",
    "nv",
    "nh",
    "nj",
    "nm",
    "ny",
    "nc",
    "nd",
    "oh",
    "ok",
    "or",
    "pa",
    "ri",
    "sc",
    "sd",
    "tn",
    "tx",
    "ut",
    "vt",
    "va",
    "wa",
    "dc",
    "wv",
    "wi",
    "wy",
)
CANADA_LOCATION_ALIASES = (
    "canada",
    "canadian",
    "can",
    "ca",
    "alberta",
    "british columbia",
    "manitoba",
    "new brunswick",
    "newfoundland",
    "newfoundland and labrador",
    "northwest territories",
    "nova scotia",
    "nunavut",
    "ontario",
    "prince edward island",
    "quebec",
    "québec",
    "saskatchewan",
    "yukon",
    "ab",
    "bc",
    "mb",
    "nb",
    "nl",
    "nt",
    "ns",
    "nu",
    "on",
    "pe",
    "qc",
    "sk",
    "yt",
)
REJECT_ALIASES = {
    "usa": US_LOCATION_ALIASES,
    "us": US_LOCATION_ALIASES,
    "u.s.": US_LOCATION_ALIASES,
    "u.s.a.": US_LOCATION_ALIASES,
    "united states": US_LOCATION_ALIASES,
    "canada": CANADA_LOCATION_ALIASES,
    "canada only": CANADA_LOCATION_ALIASES,
}


def configured_location_filters(search_cfg: Mapping[str, Any]) -> tuple[list[str], list[str]]:
    """Return accepted and rejected location patterns from either config shape."""

    accept = [*_string_list(search_cfg.get("location_accept"))]
    reject = [*_string_list(search_cfg.get("location_reject_non_remote"))]
    nested = search_cfg.get("location")
    if isinstance(nested, Mapping):
        accept.extend(_string_list(nested.get("accept_patterns")))
        reject.extend(_string_list(nested.get("reject_patterns")))
    return _dedupe(accept), _dedupe(reject)


def location_matches_target(
    location: str | None,
    *,
    accept: Sequence[str],
    reject: Sequence[str],
    search_location: str | None = None,
) -> bool:
    """Return whether a posting location fits the configured target.

    Explicit reject geography wins first, so "Remote, United States" is
    rejected for a Spain/Europe search while "Remote EMEA" still passes.
    """

    concrete_accept = _concrete_accept_patterns(accept)
    if not location:
        return not concrete_accept

    normalized = _normalize(location)
    if _matches_reject(normalized, reject):
        return False

    if search_location and _matches(normalized, search_location) and not concrete_accept:
        return True

    if _matches_any(normalized, concrete_accept):
        return True

    return not concrete_accept and _matches_any(normalized, REMOTE_MARKERS)


def _string_list(value: object) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, str):
        return []
    return [item.strip() for item in (str(item) for item in value) if item.strip()]


def _dedupe(values: Sequence[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        key = value.casefold()
        if key not in seen:
            seen.add(key)
            result.append(value)
    return result


def _matches_any(location: str, patterns: Sequence[str]) -> bool:
    return any(_matches(location, pattern) for pattern in patterns)


def _concrete_accept_patterns(patterns: Sequence[str]) -> list[str]:
    return [pattern for pattern in patterns if _normalize(pattern) not in REMOTE_MARKERS]


def _matches_reject(location: str, patterns: Sequence[str]) -> bool:
    for pattern in patterns:
        aliases = REJECT_ALIASES.get(_normalize(pattern), (pattern,))
        if _matches_any(location, aliases):
            return True
    return False


def _matches(location: str, pattern: str | None) -> bool:
    normalized = _normalize(pattern)
    if not normalized:
        return False
    if normalized.isalnum() and len(normalized) <= 3:
        return re.search(rf"(?<![a-z0-9]){re.escape(normalized)}(?![a-z0-9])", location) is not None
    return normalized in location


def _normalize(value: str | None) -> str:
    return " ".join(str(value or "").casefold().split())
