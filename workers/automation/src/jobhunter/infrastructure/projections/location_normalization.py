"""normalize_job_location — Python mirror of apps/api/src/location-normalization.ts.

The TS and Python projection builders both write
``job_list_projections.location`` and MUST produce byte-identical output. Keep
this module in lockstep with the TS ``normalizeJobLocation``; the shared
cross-runtime location table (``packages/domain-types/test/fixtures/
audit_projection_parity.json`` -> ``locationCases``, exercised by both
``apps/api/test/location-normalization.test.ts`` and
``workers/automation/tests/test_location_normalization.py``) fails if the two
implementations drift. Any change to the Spain region labels, the country tokens,
or the remote-token/marker patterns below must be mirrored in TS and covered by a
shared ``locationCases`` entry.
"""

from __future__ import annotations

import re

_SPAIN_REGION_LABELS = {
    "AN": "Andalusia",
    "CT": "Catalonia",
    "MD": "Community of Madrid",
}

_REMOTE_PATTERN = re.compile(
    r"\b(?:remote|en remoto|remoto|teletrabajo|work from home|wfh)\b", re.IGNORECASE
)
_REMOTE_MARKER_PATTERN = re.compile(
    r"\s*\((?:remote|en remoto|remoto)\)\s*", re.IGNORECASE
)
_REMOTE_PAREN_PATTERN = re.compile(r"\((?:remote|en remoto|remoto)\)", re.IGNORECASE)
_REMOTE_SEPARATOR_PATTERN = re.compile(r"^\s*[-:|]+\s*|\s*[-:|]+\s*$")
_MULTISPACE_PATTERN = re.compile(r"\s{2,}")
_BARE_REMOTE_PATTERN = re.compile(r"\bremote\b", re.IGNORECASE)


def normalize_job_location(location: str | None) -> str:
    raw = ("" if location is None else str(location)).strip()
    if not raw:
        return ""

    is_remote = bool(_REMOTE_PATTERN.search(raw)) or bool(
        _REMOTE_PAREN_PATTERN.search(raw)
    )
    cleaned = [
        part
        for part in (
            _strip_remote_markers(segment)
            for segment in _REMOTE_MARKER_PATTERN.sub(" ", raw).split(",")
        )
        if part
    ]
    has_spain_country = any(_is_spain_country_token(part) for part in cleaned)
    parts = [
        normalized
        for normalized in (
            _normalize_location_part(part, has_spain_country) for part in cleaned
        )
        if normalized
    ]
    deduped = _dedupe_adjacent(parts)
    base = ", ".join(deduped) if deduped else ("Remote" if is_remote else raw)

    if is_remote and not _BARE_REMOTE_PATTERN.search(base):
        return f"{base} (Remote)"
    return base


def _strip_remote_markers(part: str) -> str:
    result = _REMOTE_MARKER_PATTERN.sub(" ", part)
    result = _REMOTE_PATTERN.sub(" ", result)
    result = _REMOTE_SEPARATOR_PATTERN.sub("", result)
    result = _MULTISPACE_PATTERN.sub(" ", result)
    return result.strip()


def _normalize_location_part(part: str, has_spain_country: bool) -> str:
    token = part.strip()
    if not token:
        return ""
    if _is_spain_country_token(token):
        return "Spain"
    if has_spain_country:
        region = _SPAIN_REGION_LABELS.get(token.upper())
        if region:
            return region
    return token


def _is_spain_country_token(part: str) -> bool:
    return bool(re.fullmatch(r"(?:ES|ESP|Spain|España)", part.strip(), re.IGNORECASE))


def _dedupe_adjacent(parts: list[str]) -> list[str]:
    result: list[str] = []
    for part in parts:
        if not result or result[-1].lower() != part.lower():
            result.append(part)
    return result
