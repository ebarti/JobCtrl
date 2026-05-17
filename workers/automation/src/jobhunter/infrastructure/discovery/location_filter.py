"""Shared location filtering for discovery adapters."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
import re
from typing import Any


REMOTE_MARKERS = ("remote", "anywhere", "work from home", "wfh", "distributed")


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

    if not location:
        return True

    normalized = _normalize(location)
    if _matches_any(normalized, reject):
        return False

    if search_location and _matches(normalized, search_location):
        return True

    if _matches_any(normalized, accept):
        return True

    return _matches_any(normalized, REMOTE_MARKERS)


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


def _matches(location: str, pattern: str | None) -> bool:
    normalized = _normalize(pattern)
    if not normalized:
        return False
    if normalized.isalnum() and len(normalized) <= 3:
        return re.search(rf"(?<![a-z0-9]){re.escape(normalized)}(?![a-z0-9])", location) is not None
    return normalized in location


def _normalize(value: str | None) -> str:
    return " ".join(str(value or "").casefold().split())
