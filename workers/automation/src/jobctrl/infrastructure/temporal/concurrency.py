"""Temporal worker concurrency configuration."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
import re
from typing import Literal

from jobctrl.infrastructure.scoring.criteria_provider import read_config_settings


DEFAULT_MAX_CONCURRENT_ACTIVITIES = 4
LOCAL_CONTROL_ACTIVITY_SLOTS = 2

# R9 Phase 3. Number of discovery source families crawled concurrently. Default
# 1 preserves the sequential-for-isolation behavior; a value > 1 runs that many
# families' source crawls at once (each may launch its own browser, so the
# effective bound is min(this, the configured worker activity slots) and the
# owner must keep browser memory in mind). Read once at planning time and
# threaded through the plan so the workflow stays deterministic on replay.
DEFAULT_MAX_PARALLEL_DISCOVERY_FAMILIES = 1


@dataclass(frozen=True)
class ResolvedActivityConcurrency:
    value: int
    source: Literal["persisted", "default"]


def resolve_max_concurrent_activities(
    config_path: Path | str | None = None,
) -> ResolvedActivityConcurrency:
    """Resolve the worker launch value once from config.json or the default."""
    settings = read_config_settings(config_path)
    raw_persisted = settings.get("worker_activity_slots")
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


def resolve_pipeline_internal_concurrency(config_path: Path | str | None = None) -> int:
    """Snapshot Settings internal parallelism for a newly dispatched workflow."""
    raw = read_config_settings(config_path).get("pipeline_internal_concurrency")
    # Match the Settings reader's decimal-prefix parsing for saved numeric and
    # legacy string values. This is format parsing, not a semantic decision.
    match = re.match(r"^[+-]?[0-9]+", str(raw).strip())
    return min(16, max(1, int(match[0]))) if match else 1


def resolved_max_parallel_discovery_families(
    search_cfg: Mapping[str, object],
    active_activity_slots: int,
) -> int:
    """Bound the next-run fanout by policy, safety cap, and active worker slots."""
    try:
        configured = int(search_cfg.get("max_parallel_families") or 1)
    except (TypeError, ValueError):
        configured = DEFAULT_MAX_PARALLEL_DISCOVERY_FAMILIES
    return min(4, max(1, configured), max(1, int(active_activity_slots)))


def activity_executor_max_workers(max_concurrent_activities: int) -> int:
    return max(1, int(max_concurrent_activities)) + LOCAL_CONTROL_ACTIVITY_SLOTS
