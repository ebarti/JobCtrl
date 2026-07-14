from __future__ import annotations

from jobctrl.infrastructure.temporal.concurrency import (
    DEFAULT_MAX_CONCURRENT_ACTIVITIES,
    activity_executor_max_workers,
    resolve_max_concurrent_activities,
    resolved_max_parallel_discovery_families,
)


def test_activity_concurrency_resolves_persisted_setting_before_default(tmp_path) -> None:
    settings_path = tmp_path / "config.json"
    settings_path.write_text('{"worker_activity_slots": 7}', encoding="utf-8")

    resolved = resolve_max_concurrent_activities(settings_path)

    assert (resolved.value, resolved.source) == (7, "persisted")


def test_activity_concurrency_resolves_persisted_then_default(tmp_path) -> None:
    settings_path = tmp_path / "config.json"
    settings_path.write_text('{"worker_activity_slots": 7}', encoding="utf-8")
    persisted = resolve_max_concurrent_activities(settings_path)

    settings_path.write_text('{"worker_activity_slots": "invalid"}', encoding="utf-8")
    fallback = resolve_max_concurrent_activities(settings_path)

    assert (persisted.value, persisted.source) == (7, "persisted")
    assert (fallback.value, fallback.source) == (DEFAULT_MAX_CONCURRENT_ACTIVITIES, "default")


def test_activity_concurrency_clamps_persisted_setting_to_safe_bounds(tmp_path) -> None:
    settings_path = tmp_path / "config.json"
    settings_path.write_text('{"worker_activity_slots": 99}', encoding="utf-8")
    high = resolve_max_concurrent_activities(settings_path)
    settings_path.write_text('{"worker_activity_slots": 0}', encoding="utf-8")
    low = resolve_max_concurrent_activities(settings_path)

    assert (high.value, high.source) == (64, "persisted")
    assert (low.value, low.source) == (1, "persisted")


def test_activity_executor_keeps_extra_slots_for_activity_thread_work() -> None:
    assert activity_executor_max_workers(4) == 6
    assert activity_executor_max_workers(0) == 3


def test_discovery_fanout_uses_sqlite_config_and_is_capped_by_worker_slots() -> None:
    assert resolved_max_parallel_discovery_families({}, 20) == 1
    assert resolved_max_parallel_discovery_families({"max_parallel_families": "invalid"}, 20) == 1
    assert resolved_max_parallel_discovery_families({"max_parallel_families": 4}, 2) == 2
    assert resolved_max_parallel_discovery_families({"max_parallel_families": 99}, 20) == 4
