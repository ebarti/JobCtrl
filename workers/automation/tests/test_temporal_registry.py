"""Smoke test: every workflow + activity in the registry is properly decorated."""

from __future__ import annotations

from jobctrl.infrastructure.temporal.registry import ACTIVITIES, WORKFLOWS


def test_registry_exports_non_empty_workflows_and_activities():
    assert len(WORKFLOWS) > 0
    assert len(ACTIVITIES) > 0


def test_registry_workflows_are_temporal_workflow_definitions():
    for workflow_cls in WORKFLOWS:
        defn = getattr(workflow_cls, "__temporal_workflow_definition", None)
        assert defn is not None, (
            f"{workflow_cls.__name__} is in WORKFLOWS but is missing the "
            "@workflow.defn decorator."
        )


def test_registry_activities_are_temporal_activity_definitions():
    for activity_fn in ACTIVITIES:
        defn = getattr(activity_fn, "__temporal_activity_definition", None)
        assert defn is not None, (
            f"{getattr(activity_fn, '__name__', activity_fn)!r} is in "
            "ACTIVITIES but is missing the @activity.defn decorator."
        )
