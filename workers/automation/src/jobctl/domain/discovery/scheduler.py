"""Discovery run and source-quality scheduling policy.

The scheduler is deliberately small and deterministic. It consumes the
Discovery-owned source registry plus the Operations-owned quality snapshot and
returns crawl budgets; adapters still own how those budgets translate into
pagination.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Iterable

from jobctl.domain.discovery.source_registry import (
    SourceKind,
    SourcePriority,
    SourceRegistryEntry,
    SourceState,
)
from jobctl.domain.tenant import TenantId


class DiscoveryRunStatus(str, Enum):
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass(frozen=True)
class DiscoveryRunCounts:
    total: int = 0
    new_jobs: int = 0
    existing_jobs: int = 0
    observed_jobs: int = 0
    duplicate_jobs: int = 0
    rejected_duplicates: int = 0

    @classmethod
    def from_result(cls, result: object) -> "DiscoveryRunCounts":
        if not isinstance(result, dict):
            return cls()
        new_jobs = _int_value(result, "new", "total_new", "new_jobs")
        existing_jobs = _int_value(result, "existing", "total_existing", "existing_jobs")
        observed_jobs = _int_value(result, "observed", "observed_jobs")
        duplicate_jobs = _int_value(
            result,
            "duplicates_linked",
            "duplicate_jobs",
            "duplicates",
        )
        rejected_duplicates = _int_value(
            result,
            "duplicates_rejected",
            "rejected_duplicates",
        )
        total = _int_value(result, "total", "found")
        if total == 0:
            total = new_jobs + existing_jobs + observed_jobs + duplicate_jobs
        return cls(
            total=total,
            new_jobs=new_jobs,
            existing_jobs=existing_jobs,
            observed_jobs=observed_jobs,
            duplicate_jobs=duplicate_jobs,
            rejected_duplicates=rejected_duplicates,
        )

    def plus(self, other: "DiscoveryRunCounts") -> "DiscoveryRunCounts":
        return DiscoveryRunCounts(
            total=self.total + other.total,
            new_jobs=self.new_jobs + other.new_jobs,
            existing_jobs=self.existing_jobs + other.existing_jobs,
            observed_jobs=self.observed_jobs + other.observed_jobs,
            duplicate_jobs=self.duplicate_jobs + other.duplicate_jobs,
            rejected_duplicates=self.rejected_duplicates + other.rejected_duplicates,
        )

    def to_dict(self) -> dict[str, int]:
        return {
            "total": self.total,
            "new_jobs": self.new_jobs,
            "existing_jobs": self.existing_jobs,
            "observed_jobs": self.observed_jobs,
            "duplicate_jobs": self.duplicate_jobs,
            "rejected_duplicates": self.rejected_duplicates,
        }


@dataclass(frozen=True)
class DiscoveryRunProgress:
    completed: int = 0
    total: int = 0
    unit: str = ""
    current_query: str | None = None
    current_location: str | None = None
    new_jobs: int | None = None
    existing_jobs: int | None = None
    filtered_jobs: int | None = None
    error_count: int | None = None
    raw_total: int | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            "completed": self.completed,
            "total": self.total,
            "unit": self.unit,
            "current_query": self.current_query,
            "currentQuery": self.current_query,
            "current_location": self.current_location,
            "currentLocation": self.current_location,
            "new_jobs": self.new_jobs,
            "newJobs": self.new_jobs,
            "existing_jobs": self.existing_jobs,
            "existingJobs": self.existing_jobs,
            "filtered_jobs": self.filtered_jobs,
            "filteredJobs": self.filtered_jobs,
            "error_count": self.error_count,
            "errorCount": self.error_count,
            "raw_total": self.raw_total,
            "rawTotal": self.raw_total,
        }


@dataclass(frozen=True)
class DiscoveryRun:
    tenant_id: TenantId
    run_id: str
    source_ids: tuple[str, ...]
    profile_snapshot_id: str | None
    status: DiscoveryRunStatus
    counts: DiscoveryRunCounts = field(default_factory=DiscoveryRunCounts)
    progress: DiscoveryRunProgress = field(default_factory=DiscoveryRunProgress)
    error_classes: tuple[str, ...] = ()
    started_at: str = ""
    updated_at: str | None = None
    completed_at: str | None = None
    failed_at: str | None = None
    workflow_id: str | None = None

    @classmethod
    def start(
        cls,
        *,
        tenant_id: TenantId,
        run_id: str,
        source_ids: Iterable[str],
        started_at: str,
        profile_snapshot_id: str | None = None,
        workflow_id: str | None = None,
    ) -> "DiscoveryRun":
        materialized = tuple(dict.fromkeys(source_ids))
        if not run_id.strip():
            raise ValueError("DiscoveryRun.run_id must be a non-empty string")
        if not materialized:
            raise ValueError("DiscoveryRun.source_ids must contain at least one source")
        return cls(
            tenant_id=tenant_id,
            run_id=run_id,
            source_ids=materialized,
            profile_snapshot_id=profile_snapshot_id,
            status=DiscoveryRunStatus.RUNNING,
            started_at=started_at,
            updated_at=started_at,
            workflow_id=workflow_id,
        )

    def with_progress(
        self,
        *,
        progress: DiscoveryRunProgress,
        counts: DiscoveryRunCounts | None = None,
        updated_at: str,
    ) -> "DiscoveryRun":
        return replace(
            self,
            counts=counts or self.counts,
            progress=progress,
            updated_at=updated_at,
        )

    def complete(
        self,
        *,
        counts: DiscoveryRunCounts,
        error_classes: Iterable[str],
        completed_at: str,
    ) -> "DiscoveryRun":
        return replace(
            self,
            status=DiscoveryRunStatus.COMPLETED,
            counts=counts,
            error_classes=tuple(dict.fromkeys(error_classes)),
            completed_at=completed_at,
            updated_at=completed_at,
        )

    def fail(
        self,
        *,
        error_class: str,
        failed_at: str,
    ) -> "DiscoveryRun":
        return replace(
            self,
            status=DiscoveryRunStatus.FAILED,
            error_classes=(error_class,),
            failed_at=failed_at,
            updated_at=failed_at,
        )


@dataclass(frozen=True)
class SourceQualitySnapshot:
    source_id: str
    observed_jobs: int = 0
    new_jobs: int = 0
    existing_jobs: int = 0
    duplicate_jobs: int = 0
    failed_runs: int = 0
    consecutive_failures: int = 0
    active_rate: float | None = None
    detail_success_rate: float | None = None
    stale_rate: float | None = None
    duplicate_rate: float | None = None
    recommended_state: str = "normal"

    @property
    def sample_size(self) -> int:
        return max(self.observed_jobs, self.new_jobs + self.existing_jobs)


@dataclass(frozen=True)
class ScheduledSource:
    source_id: str
    display_name: str
    source_kind: SourceKind
    priority: SourcePriority
    configured_state: SourceState
    crawl_budget: int
    decision: str
    reason: str
    recommended_state: str
    adapter_config: dict[str, object] = field(default_factory=dict)

    @property
    def should_run(self) -> bool:
        return self.decision == "run" and self.crawl_budget > 0


@dataclass(frozen=True)
class DiscoverySchedule:
    sources: tuple[ScheduledSource, ...]

    @property
    def runnable_source_ids(self) -> tuple[str, ...]:
        return tuple(source.source_id for source in self.sources if source.should_run)

    def for_prefix(self, prefix: str) -> tuple[ScheduledSource, ...]:
        normalized = prefix.rstrip(":") + ":"
        return tuple(source for source in self.sources if source.source_id.startswith(normalized))

    def for_kinds(self, *kinds: SourceKind) -> tuple[ScheduledSource, ...]:
        wanted = set(kinds)
        return tuple(source for source in self.sources if source.source_kind in wanted)

    def budget_for_prefix(self, prefix: str) -> int:
        return sum(source.crawl_budget for source in self.for_prefix(prefix) if source.should_run)

    def should_run_prefix(self, prefix: str) -> bool:
        return any(source.should_run for source in self.for_prefix(prefix))


class DiscoveryScheduler:
    """Turn source quality into crawl budgets and demotion decisions."""

    def plan(
        self,
        *,
        registry: Iterable[SourceRegistryEntry],
        quality: Iterable[SourceQualitySnapshot] = (),
        global_limit: int = 0,
    ) -> DiscoverySchedule:
        by_source = {snapshot.source_id: snapshot for snapshot in quality}
        scheduled = tuple(
            self._schedule_one(entry, by_source.get(entry.source_id), global_limit=global_limit)
            for entry in registry
        )
        return DiscoverySchedule(scheduled)

    def _schedule_one(
        self,
        entry: SourceRegistryEntry,
        snapshot: SourceQualitySnapshot | None,
        *,
        global_limit: int,
    ) -> ScheduledSource:
        if entry.state == SourceState.DISABLED:
            return self._skip(entry, "source disabled", "disabled")

        budget = min(entry.policy.max_pages_per_run, _priority_budget(entry.priority))
        if global_limit > 0:
            budget = min(budget, global_limit)

        if entry.state == SourceState.QUARANTINED:
            budget = min(budget, 5)

        if snapshot is None:
            if entry.state == SourceState.EXPERIMENTAL:
                budget = max(1, min(budget, 10))
            return ScheduledSource(
                source_id=entry.source_id,
                display_name=entry.display_name,
                source_kind=entry.kind,
                priority=entry.priority,
                configured_state=entry.state,
                crawl_budget=budget,
                decision="run" if budget > 0 else "skip",
                reason="no quality history",
                recommended_state=entry.state.value,
                adapter_config=dict(entry.adapter_config),
            )

        demoted = _recommended_state(snapshot)
        if demoted in {"disabled", "quarantined"}:
            return self._skip(entry, _demotion_reason(snapshot), demoted)

        multiplier = 1.0
        reason = "quality normal"
        if snapshot.duplicate_rate is not None and snapshot.duplicate_rate >= 0.65:
            multiplier *= 0.5
            reason = "high duplicate rate"
        if snapshot.active_rate is not None and snapshot.active_rate < 0.5:
            multiplier *= 0.5
            reason = "low active rate"
        if snapshot.detail_success_rate is not None and snapshot.detail_success_rate < 0.5:
            multiplier *= 0.5
            reason = "low detail success rate"
        if entry.state == SourceState.EXPERIMENTAL:
            multiplier *= 0.5

        budget = max(1, int(budget * multiplier)) if budget > 0 else 0
        return ScheduledSource(
            source_id=entry.source_id,
            display_name=entry.display_name,
            source_kind=entry.kind,
            priority=entry.priority,
            configured_state=entry.state,
            crawl_budget=budget,
            decision="run" if budget > 0 else "skip",
            reason=reason,
            recommended_state=demoted,
            adapter_config=dict(entry.adapter_config),
        )

    @staticmethod
    def _skip(entry: SourceRegistryEntry, reason: str, recommended_state: str) -> ScheduledSource:
        return ScheduledSource(
            source_id=entry.source_id,
            display_name=entry.display_name,
            source_kind=entry.kind,
            priority=entry.priority,
            configured_state=entry.state,
            crawl_budget=0,
            decision="skip",
            reason=reason,
            recommended_state=recommended_state,
            adapter_config=dict(entry.adapter_config),
        )


def _priority_budget(priority: SourcePriority) -> int:
    budgets = {
        SourcePriority.CANONICAL: 500,
        SourcePriority.PREFERRED: 250,
        SourcePriority.STANDARD: 150,
        SourcePriority.FALLBACK: 50,
        SourcePriority.LEAD_GENERATOR: 100,
    }
    return budgets[priority]


def _recommended_state(snapshot: SourceQualitySnapshot) -> str:
    if snapshot.consecutive_failures >= 5:
        return "disabled"
    if snapshot.consecutive_failures >= 3:
        return "quarantined"
    if snapshot.sample_size >= 10:
        if snapshot.active_rate is not None and snapshot.active_rate < 0.25:
            return "quarantined"
        if snapshot.duplicate_rate is not None and snapshot.duplicate_rate >= 0.85:
            return "quarantined"
        if snapshot.detail_success_rate is not None and snapshot.detail_success_rate < 0.25:
            return "quarantined"
    return "normal"


def _demotion_reason(snapshot: SourceQualitySnapshot) -> str:
    if snapshot.consecutive_failures >= 5:
        return "repeated failures"
    if snapshot.consecutive_failures >= 3:
        return "consecutive failures"
    if snapshot.active_rate is not None and snapshot.active_rate < 0.25:
        return "very low active rate"
    if snapshot.duplicate_rate is not None and snapshot.duplicate_rate >= 0.85:
        return "very high duplicate rate"
    if snapshot.detail_success_rate is not None and snapshot.detail_success_rate < 0.25:
        return "very low detail success rate"
    return "quality demotion"


def _int_value(result: dict, *keys: str) -> int:
    for key in keys:
        value = result.get(key)
        if value is None:
            continue
        try:
            return int(value)
        except (TypeError, ValueError):
            continue
    return 0
