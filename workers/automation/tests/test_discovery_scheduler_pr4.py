from __future__ import annotations

from jobctrl.domain.discovery.scheduler import DiscoveryScheduler, SourceQualitySnapshot
from jobctrl.domain.discovery.source_registry import (
    BROAD_BOARD_LEAD_POLICY,
    WORKDAY_API_POLICY,
    SourceKind,
    SourcePriority,
    SourceRegistryEntry,
    SourceState,
)
from jobctrl.domain.tenant import LOCAL_TENANT


def _source(
    source_id: str,
    *,
    priority: SourcePriority = SourcePriority.CANONICAL,
    state: SourceState = SourceState.ACTIVE,
) -> SourceRegistryEntry:
    return SourceRegistryEntry(
        tenant_id=LOCAL_TENANT,
        source_id=source_id,
        kind=SourceKind.ATS_API if priority == SourcePriority.CANONICAL else SourceKind.BROAD_BOARD,
        display_name=source_id,
        owner="system",
        priority=priority,
        state=state,
        policy=WORKDAY_API_POLICY if priority == SourcePriority.CANONICAL else BROAD_BOARD_LEAD_POLICY,
    )


def test_scheduler_gives_new_experimental_sources_a_small_probe_budget() -> None:
    schedule = DiscoveryScheduler().plan(
        registry=[_source("jobspy:linkedin", priority=SourcePriority.LEAD_GENERATOR, state=SourceState.EXPERIMENTAL)]
    )

    [source] = schedule.sources
    assert source.should_run is True
    assert source.crawl_budget == 10
    assert source.reason == "no quality history"


def test_scheduler_demotes_repeatedly_failing_sources() -> None:
    schedule = DiscoveryScheduler().plan(
        registry=[_source("workday:acme")],
        quality=[
            SourceQualitySnapshot(
                source_id="workday:acme",
                observed_jobs=20,
                consecutive_failures=3,
                detail_success_rate=0.9,
            )
        ],
    )

    [source] = schedule.sources
    assert source.should_run is False
    assert source.recommended_state == "quarantined"
    assert source.reason == "consecutive failures"


def test_scheduler_reduces_budget_for_noisy_sources_without_disabling_them() -> None:
    schedule = DiscoveryScheduler().plan(
        registry=[_source("jobspy:linkedin", priority=SourcePriority.LEAD_GENERATOR)],
        quality=[
            SourceQualitySnapshot(
                source_id="jobspy:linkedin",
                observed_jobs=100,
                duplicate_jobs=80,
                duplicate_rate=0.8,
                active_rate=0.4,
                detail_success_rate=0.9,
            )
        ],
    )

    [source] = schedule.sources
    assert source.should_run is True
    assert source.crawl_budget == 25
    assert source.reason == "low active rate"
