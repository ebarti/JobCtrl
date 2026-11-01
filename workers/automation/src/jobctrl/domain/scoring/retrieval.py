"""Mechanical recency order for bounded scoring runs; no text ranking."""

from datetime import datetime, timezone


def _timestamp(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return (parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)).timestamp()
    except (ValueError, TypeError):
        return float("-inf")


def preselect_jobs_for_scoring(jobs, *, top_k=0):
    ordered = sorted(
        jobs, key=lambda row: (-_timestamp(row.get("discovered_at")), str(row.get("job_id") or row.get("url") or ""))
    )
    return ordered[:top_k] if top_k > 0 else ordered
