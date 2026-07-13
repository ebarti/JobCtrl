"""Temporal worker concurrency configuration."""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from jobctrl.infrastructure.scoring.criteria_provider import resolve_dashboard_settings_path


DEFAULT_MAX_CONCURRENT_ACTIVITIES = 4

# R9 Phase 3. Number of discovery source families crawled concurrently. Default
# 1 preserves the sequential-for-isolation behavior; a value > 1 runs that many
# families' source crawls at once (each may launch its own browser, so the
# effective bound is min(this, JOBCTRL_MAX_CONCURRENT_ACTIVITIES) and the
# owner must keep browser memory in mind). Read once at planning time and
# threaded through the plan so the workflow stays deterministic on replay.
DEFAULT_MAX_PARALLEL_DISCOVERY_FAMILIES = 1


@dataclass(frozen=True)
class ResolvedActivityConcurrency:
    value: int
    source: Literal["environment", "persisted", "default"]


def max_concurrent_activities_from_env(env: Mapping[str, str] | None = None) -> int:
    source = env if env is not None else os.environ
    raw = source.get("JOBCTRL_MAX_CONCURRENT_ACTIVITIES")
    if raw is None or raw.strip() == "":
        return DEFAULT_MAX_CONCURRENT_ACTIVITIES
    try:
        return max(1, int(raw))
    except ValueError:
        return DEFAULT_MAX_CONCURRENT_ACTIVITIES


def resolve_max_concurrent_activities(
    env: Mapping[str, str] | None = None,
    settings_path: Path | str | None = None,
) -> ResolvedActivityConcurrency:
    """Resolve the worker launch value once: environment, dashboard, default."""
    source = env if env is not None else os.environ
    raw_env = source.get("JOBCTRL_MAX_CONCURRENT_ACTIVITIES")
    if raw_env is not None and raw_env.strip() != "":
        return ResolvedActivityConcurrency(
            value=max_concurrent_activities_from_env(source),
            source="environment",
        )

    path = resolve_dashboard_settings_path(settings_path)
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        parsed = {}
    if isinstance(parsed, dict):
        raw_persisted = parsed.get("worker_activity_slots")
        if raw_persisted is None:
            raw_persisted = parsed.get("workerActivitySlots")
        try:
            persisted = int(raw_persisted)
        except (TypeError, ValueError):
            pass
        else:
            return ResolvedActivityConcurrency(
                value=min(64, max(1, persisted)),
                source="persisted",
            )

    return ResolvedActivityConcurrency(
        value=DEFAULT_MAX_CONCURRENT_ACTIVITIES,
        source="default",
    )


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
