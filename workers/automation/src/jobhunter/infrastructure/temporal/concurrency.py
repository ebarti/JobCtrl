"""Temporal worker concurrency configuration."""

from __future__ import annotations

import os
from collections.abc import Mapping


DEFAULT_MAX_CONCURRENT_ACTIVITIES = 4


def max_concurrent_activities_from_env(env: Mapping[str, str] | None = None) -> int:
    source = env if env is not None else os.environ
    raw = source.get("JOBHUNTER_MAX_CONCURRENT_ACTIVITIES")
    if raw is None or raw.strip() == "":
        return DEFAULT_MAX_CONCURRENT_ACTIVITIES
    try:
        return max(1, int(raw))
    except ValueError:
        return DEFAULT_MAX_CONCURRENT_ACTIVITIES


def activity_executor_max_workers(max_concurrent_activities: int) -> int:
    return max(1, int(max_concurrent_activities)) + 2
