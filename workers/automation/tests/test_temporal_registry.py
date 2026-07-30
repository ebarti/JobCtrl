"""Smoke test: every workflow + activity in the registry is properly decorated."""

from __future__ import annotations

from jobctrl.infrastructure.temporal.registry import (
    ACTIVITIES,
    WORKFLOWS,
    WORKFLOW_IDENTITY_CUTOVER_POLICIES,
)


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


def test_every_workflow_declares_an_identity_cutover_policy():
    assert set(WORKFLOW_IDENTITY_CUTOVER_POLICIES) == set(WORKFLOWS)
    workflow_types = [
        policy.workflow_type
        for policy in WORKFLOW_IDENTITY_CUTOVER_POLICIES.values()
    ]
    assert len(workflow_types) == len(set(workflow_types))
    for workflow_cls, policy in WORKFLOW_IDENTITY_CUTOVER_POLICIES.items():
        definition = getattr(
            workflow_cls,
            "__temporal_workflow_definition",
        )
        assert policy.workflow_type == definition.name
        if policy.blocks_cutover_when_open:
            assert policy.identity_fields
            assert "dispatch_registry" in policy.inventory_sources
            assert "workflow_start_event" in policy.inventory_sources
            assert "workflow_run_projection" in policy.inventory_sources
        else:
            assert policy.identity_fields == ()
            assert policy.inventory_sources == ()


def test_registry_activities_are_temporal_activity_definitions():
    for activity_fn in ACTIVITIES:
        defn = getattr(activity_fn, "__temporal_activity_definition", None)
        assert defn is not None, (
            f"{getattr(activity_fn, '__name__', activity_fn)!r} is in "
            "ACTIVITIES but is missing the @activity.defn decorator."
        )
