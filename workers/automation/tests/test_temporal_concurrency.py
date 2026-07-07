from __future__ import annotations

from jobctl.infrastructure.temporal.concurrency import (
    DEFAULT_MAX_CONCURRENT_ACTIVITIES,
    DEFAULT_MAX_PARALLEL_DISCOVERY_FAMILIES,
    activity_executor_max_workers,
    max_concurrent_activities_from_env,
    max_parallel_discovery_families_from_env,
)


def test_max_concurrent_activities_defaults_when_unset_or_invalid() -> None:
    assert max_concurrent_activities_from_env({}) == DEFAULT_MAX_CONCURRENT_ACTIVITIES
    assert max_concurrent_activities_from_env({"JOBCTL_MAX_CONCURRENT_ACTIVITIES": ""}) == DEFAULT_MAX_CONCURRENT_ACTIVITIES
    assert (
        max_concurrent_activities_from_env({"JOBCTL_MAX_CONCURRENT_ACTIVITIES": "not-a-number"})
        == DEFAULT_MAX_CONCURRENT_ACTIVITIES
    )


def test_max_concurrent_activities_clamps_to_at_least_one() -> None:
    assert max_concurrent_activities_from_env({"JOBCTL_MAX_CONCURRENT_ACTIVITIES": "12"}) == 12
    assert max_concurrent_activities_from_env({"JOBCTL_MAX_CONCURRENT_ACTIVITIES": "0"}) == 1
    assert max_concurrent_activities_from_env({"JOBCTL_MAX_CONCURRENT_ACTIVITIES": "-4"}) == 1


def test_activity_executor_keeps_extra_slots_for_activity_thread_work() -> None:
    assert activity_executor_max_workers(4) == 6
    assert activity_executor_max_workers(0) == 3


def test_max_parallel_discovery_families_defaults_to_sequential() -> None:
    # Default and invalid/blank values preserve the safe sequential behavior.
    assert max_parallel_discovery_families_from_env({}) == DEFAULT_MAX_PARALLEL_DISCOVERY_FAMILIES
    assert DEFAULT_MAX_PARALLEL_DISCOVERY_FAMILIES == 1
    assert max_parallel_discovery_families_from_env({"JOBCTL_MAX_PARALLEL_DISCOVERY_FAMILIES": ""}) == 1
    assert (
        max_parallel_discovery_families_from_env(
            {"JOBCTL_MAX_PARALLEL_DISCOVERY_FAMILIES": "nope"}
        )
        == 1
    )


def test_max_parallel_discovery_families_clamps_to_at_least_one() -> None:
    assert max_parallel_discovery_families_from_env({"JOBCTL_MAX_PARALLEL_DISCOVERY_FAMILIES": "3"}) == 3
    assert max_parallel_discovery_families_from_env({"JOBCTL_MAX_PARALLEL_DISCOVERY_FAMILIES": "0"}) == 1
    assert max_parallel_discovery_families_from_env({"JOBCTL_MAX_PARALLEL_DISCOVERY_FAMILIES": "-2"}) == 1
