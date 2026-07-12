from __future__ import annotations

from jobctrl.infrastructure.temporal.concurrency import (
    DEFAULT_MAX_CONCURRENT_ACTIVITIES,
    DEFAULT_MAX_PARALLEL_DISCOVERY_FAMILIES,
    activity_executor_max_workers,
    max_concurrent_activities_from_env,
    max_parallel_discovery_families_from_env,
    resolve_max_concurrent_activities,
)


def test_max_concurrent_activities_defaults_when_unset_or_invalid() -> None:
    assert max_concurrent_activities_from_env({}) == DEFAULT_MAX_CONCURRENT_ACTIVITIES
    assert max_concurrent_activities_from_env({"JOBCTRL_MAX_CONCURRENT_ACTIVITIES": ""}) == DEFAULT_MAX_CONCURRENT_ACTIVITIES
    assert (
        max_concurrent_activities_from_env({"JOBCTRL_MAX_CONCURRENT_ACTIVITIES": "not-a-number"})
        == DEFAULT_MAX_CONCURRENT_ACTIVITIES
    )


def test_max_concurrent_activities_clamps_to_at_least_one() -> None:
    assert max_concurrent_activities_from_env({"JOBCTRL_MAX_CONCURRENT_ACTIVITIES": "12"}) == 12
    assert max_concurrent_activities_from_env({"JOBCTRL_MAX_CONCURRENT_ACTIVITIES": "0"}) == 1
    assert max_concurrent_activities_from_env({"JOBCTRL_MAX_CONCURRENT_ACTIVITIES": "-4"}) == 1


def test_activity_concurrency_resolves_environment_before_persisted_settings(tmp_path) -> None:
    settings_path = tmp_path / "dashboard.json"
    settings_path.write_text('{"worker_activity_slots": 7}', encoding="utf-8")

    resolved = resolve_max_concurrent_activities(
        {"JOBCTRL_MAX_CONCURRENT_ACTIVITIES": "11"},
        settings_path,
    )

    assert (resolved.value, resolved.source) == (11, "environment")


def test_activity_concurrency_resolves_persisted_then_default(tmp_path) -> None:
    settings_path = tmp_path / "dashboard.json"
    settings_path.write_text('{"worker_activity_slots": 7}', encoding="utf-8")
    persisted = resolve_max_concurrent_activities({}, settings_path)

    settings_path.write_text('{"worker_activity_slots": "invalid"}', encoding="utf-8")
    fallback = resolve_max_concurrent_activities({}, settings_path)

    assert (persisted.value, persisted.source) == (7, "persisted")
    assert (fallback.value, fallback.source) == (DEFAULT_MAX_CONCURRENT_ACTIVITIES, "default")


def test_invalid_nonempty_environment_remains_visible_as_environment_managed(tmp_path) -> None:
    settings_path = tmp_path / "dashboard.json"
    settings_path.write_text('{"worker_activity_slots": 7}', encoding="utf-8")

    resolved = resolve_max_concurrent_activities(
        {"JOBCTRL_MAX_CONCURRENT_ACTIVITIES": "invalid"},
        settings_path,
    )

    assert (resolved.value, resolved.source) == (DEFAULT_MAX_CONCURRENT_ACTIVITIES, "environment")


def test_activity_executor_keeps_extra_slots_for_activity_thread_work() -> None:
    assert activity_executor_max_workers(4) == 6
    assert activity_executor_max_workers(0) == 3


def test_max_parallel_discovery_families_defaults_to_sequential() -> None:
    # Default and invalid/blank values preserve the safe sequential behavior.
    assert max_parallel_discovery_families_from_env({}) == DEFAULT_MAX_PARALLEL_DISCOVERY_FAMILIES
    assert DEFAULT_MAX_PARALLEL_DISCOVERY_FAMILIES == 1
    assert max_parallel_discovery_families_from_env({"JOBCTRL_MAX_PARALLEL_DISCOVERY_FAMILIES": ""}) == 1
    assert (
        max_parallel_discovery_families_from_env(
            {"JOBCTRL_MAX_PARALLEL_DISCOVERY_FAMILIES": "nope"}
        )
        == 1
    )


def test_max_parallel_discovery_families_clamps_to_at_least_one() -> None:
    assert max_parallel_discovery_families_from_env({"JOBCTRL_MAX_PARALLEL_DISCOVERY_FAMILIES": "3"}) == 3
    assert max_parallel_discovery_families_from_env({"JOBCTRL_MAX_PARALLEL_DISCOVERY_FAMILIES": "0"}) == 1
    assert max_parallel_discovery_families_from_env({"JOBCTRL_MAX_PARALLEL_DISCOVERY_FAMILIES": "-2"}) == 1
