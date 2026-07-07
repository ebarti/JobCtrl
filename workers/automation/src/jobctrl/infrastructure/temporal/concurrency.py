"""Temporal worker concurrency configuration."""

from __future__ import annotations

import os
from collections.abc import Mapping


DEFAULT_MAX_CONCURRENT_ACTIVITIES = 4

# R9 Phase 3. Number of discovery source families crawled concurrently. Default
# 1 preserves the sequential-for-isolation behavior; a value > 1 runs that many
# families' source crawls at once (each may launch its own browser, so the
# effective bound is min(this, JOBCTRL_MAX_CONCURRENT_ACTIVITIES) and the
# owner must keep browser memory in mind). Read once at planning time and
# threaded through the plan so the workflow stays deterministic on replay.
DEFAULT_MAX_PARALLEL_DISCOVERY_FAMILIES = 1


def max_concurrent_activities_from_env(env: Mapping[str, str] | None = None) -> int:
    source = env if env is not None else os.environ
    raw = source.get("JOBCTRL_MAX_CONCURRENT_ACTIVITIES")
    if raw is None or raw.strip() == "":
        return DEFAULT_MAX_CONCURRENT_ACTIVITIES
    try:
        return max(1, int(raw))
    except ValueError:
        return DEFAULT_MAX_CONCURRENT_ACTIVITIES


def max_parallel_discovery_families_from_env(env: Mapping[str, str] | None = None) -> int:
    source = env if env is not None else os.environ
    raw = source.get("JOBCTRL_MAX_PARALLEL_DISCOVERY_FAMILIES")
    if raw is None or raw.strip() == "":
        return DEFAULT_MAX_PARALLEL_DISCOVERY_FAMILIES
    try:
        return max(1, int(raw))
    except ValueError:
        return DEFAULT_MAX_PARALLEL_DISCOVERY_FAMILIES


def activity_executor_max_workers(max_concurrent_activities: int) -> int:
    return max(1, int(max_concurrent_activities)) + 2
