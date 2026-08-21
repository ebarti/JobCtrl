"""Metric tokens derived from one achievement's canonical prose.

Metrics are evidence attached to an achievement, never a free-floating resume
allowlist.  This module owns the shared token grammar used when profile bullets
are materialized and when generated claims are checked against their mapped
achievement evidence.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

_NUMBER = r"\d+(?:[,.]\d+)*"
_MAGNITUDE = r"(?:[kmb]|million|billion)"
_COUNT_UNITS = (
    r"users?|customers?|requests?|req/s|qps|events?|engineers?|developers?|teams?|"
    r"services?|systems?|pipelines?|applications?|apps?|employees?|incidents?|"
    r"deployments?|releases?|countries?|markets?|regions?|clients?|accounts?|"
    r"features?|projects?|products?|servers?|nodes?|transactions?|records?|tickets?|"
    r"ms|milliseconds?|seconds?|secs?|minutes?|hours?|days?|weeks?|months?|years?|"
    r"revenue|savings|costs?|budget|latency|uptime|availability|throughput"
)

ACHIEVEMENT_METRIC_RE = re.compile(
    rf"(?ix)"
    rf"(?:[$€£]\s?{_NUMBER}(?:\s?{_MAGNITUDE})?\+?)"
    rf"|(?:\b{_NUMBER}\+?\s?(?:bps|basis\s+points?)\b)"
    rf"|(?:\b{_NUMBER}\s?%)"
    rf"|(?:\b{_NUMBER}\s?x\b)"
    rf"|(?:\b{_NUMBER}(?:{_MAGNITUDE})?\+?\s?(?:{_COUNT_UNITS})\b)"
    rf"|(?:\b24/7\b)"
    rf"|(?:\b(?!(?:19|20)\d{{2}}\b){_NUMBER}\+?\b)"
)


def normalize_achievement_metric(value: str) -> str:
    """Return a comparison key while preserving meaningful symbols and units."""

    return re.sub(r"\s+", " ", str(value or "")).strip().casefold()


def extract_achievement_metrics(text: str) -> tuple[str, ...]:
    """Extract ordered, de-duplicated metric tokens from achievement prose."""

    metrics: list[str] = []
    seen: set[str] = set()
    for match in ACHIEVEMENT_METRIC_RE.finditer(str(text or "")):
        metric = re.sub(r"\s+", " ", match.group(0)).strip()
        key = normalize_achievement_metric(metric)
        if metric and key not in seen:
            seen.add(key)
            metrics.append(metric)
    return tuple(metrics)


def merge_achievement_metrics(
    explicit_metrics: Iterable[str] = (),
    *evidence_texts: str,
) -> tuple[str, ...]:
    """Merge tokens from explicit legacy values and canonical achievement text.

    Legacy ``metrics`` arrays may contain descriptive strings such as
    ``"35% latency reduction"``. They remain useful input, but only the metric
    tokens extracted from those strings become authorization keys.
    """

    merged_text = "\n".join(
        [*(str(value) for value in explicit_metrics), *(str(value) for value in evidence_texts)]
    )
    return extract_achievement_metrics(merged_text)


__all__ = [
    "ACHIEVEMENT_METRIC_RE",
    "extract_achievement_metrics",
    "merge_achievement_metrics",
    "normalize_achievement_metric",
]
