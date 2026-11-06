"""Literal digest timestamp and navigation rules."""

from datetime import datetime, timezone
import re
from urllib.parse import urlencode

def parse_time(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        raw = value.strip()
        parsed = datetime.fromisoformat(raw[:-1] + "+00:00" if raw.endswith(("Z", "z")) else raw)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except (ValueError, OverflowError, OSError):
        return None


def is_later(left, right):
    lhs, rhs = parse_time(left), parse_time(right)
    if lhs is None or rhs is None:
        raise ValueError("invalid digest watermark")
    if lhs != rhs:
        return lhs > rhs
    def tail(value):
        match = re.search(r"[T ]\d{2}:\d{2}:\d{2}[.,](\d+)(?:Z|[+-]\d{2}:?\d{2})?$", value.strip(), re.IGNORECASE)
        return match.group(1)[6:] if match else ""
    a, b = tail(left), tail(right)
    width = max(len(a), len(b))
    return a.ljust(width, "0") > b.ljust(width, "0")


def links(since):
    jobs = {"deleted": "active", "sort": "discovered_at", "dir": "desc"}
    if since:
        jobs.update(discoveredSince=since, scoredSince=since)
    return {"newMatches": "/jobs?" + urlencode(jobs), "blockedSources": "/discovery",
            "reviewNeededMaterials": "/apply-review", "staleScores": "/jobs?" + urlencode({"deleted": "active", "state": "stale", "sort": "fit_score", "dir": "desc"}),
            "pendingApprovals": "/apply-review", "followUpsDue": "/jobs?applyStatus=applied", "budget": "/settings"}
