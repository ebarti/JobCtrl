"""Tests for the declarative v6-to-v7 candidate population contract."""

from __future__ import annotations

from collections import Counter
from dataclasses import FrozenInstanceError
from inspect import Parameter, signature

import pytest

from jobctrl.infrastructure.migrations.v6_to_v7_apply_run_projections import (
    rebuild_apply_run_projections,
)
from jobctrl.infrastructure.migrations.v6_to_v7_artifact_list_projections import (
    rebuild_artifact_list_projections,
)
from jobctrl.infrastructure.migrations.v6_to_v7_contact_projections import (
    copy_contact_projections,
)
from jobctrl.infrastructure.migrations.v6_to_v7_copy import (
    copy_direct_and_scalar_tables,
)
from jobctrl.infrastructure.migrations.v6_to_v7_dashboard_projections import (
    rebuild_dashboard_projections,
)
from jobctrl.infrastructure.migrations.v6_to_v7_duplicate_links import (
    copy_duplicate_links,
)
from jobctrl.infrastructure.migrations.v6_to_v7_events import copy_job_events
from jobctrl.infrastructure.migrations.v6_to_v7_evidence_usage_projections import (
    rebuild_evidence_usage_projections,
)
from jobctrl.infrastructure.migrations.v6_to_v7_job_detail_projections import (
    rebuild_job_detail_projections,
)
from jobctrl.infrastructure.migrations.v6_to_v7_job_list_projections import (
    rebuild_job_list_projections,
)
from jobctrl.infrastructure.migrations.v6_to_v7_pipeline_step_projections import (
    copy_pipeline_step_projections,
)
from jobctrl.infrastructure.migrations.v6_to_v7_plan import (
    TABLE_PLANS,
    TableDisposition,
    target_tables,
)
from jobctrl.infrastructure.migrations.v6_to_v7_population_steps import (
    CANDIDATE_POPULATION_STEPS,
    CandidatePopulationArgumentProfile,
)
from jobctrl.infrastructure.migrations.v6_to_v7_root import copy_root_jobs
from jobctrl.infrastructure.migrations.v6_to_v7_work_items import (
    copy_structured_work_items,
)
from jobctrl.infrastructure.migrations.v6_to_v7_workflow_run_projections import (
    copy_workflow_run_projections,
)


def test_population_steps_cover_every_target_table_exactly_once() -> None:
    owned_tables = [table for step in CANDIDATE_POPULATION_STEPS for table in step.owned_tables]
    retired_tables = {
        table
        for table, plan in TABLE_PLANS.items()
        if plan.disposition is TableDisposition.RETIRED
    }

    assert set(owned_tables) == target_tables()
    assert not (Counter(owned_tables) - Counter(set(owned_tables)))
    assert not set(owned_tables) & retired_tables


def test_direct_scalar_and_structured_ownership_match_the_migration_plan() -> None:
    by_id = {step.step_id: step for step in CANDIDATE_POPULATION_STEPS}
    direct_scalar_tables = {
        table
        for table, plan in TABLE_PLANS.items()
        if plan.disposition
        in {
            TableDisposition.DIRECT_COPY,
            TableDisposition.SCALAR_JOB_ID_REWRITE,
        }
    }
    structured_tables = {
        table
        for table, plan in TABLE_PLANS.items()
        if plan.disposition is TableDisposition.STRUCTURED_REWRITE and plan.target_exists
    }

    assert by_id["direct_scalar"].owned_tables == direct_scalar_tables
    assert {
        table
        for step in CANDIDATE_POPULATION_STEPS
        if step.step_id != "direct_scalar"
        for table in step.owned_tables
    } == structured_tables
    assert len(structured_tables) == 18


def test_population_step_ids_and_owners_are_exact() -> None:
    direct_scalar_tables = {
        table
        for table, plan in TABLE_PLANS.items()
        if plan.disposition
        in {
            TableDisposition.DIRECT_COPY,
            TableDisposition.SCALAR_JOB_ID_REWRITE,
        }
    }

    assert tuple(step.step_id for step in CANDIDATE_POPULATION_STEPS) == (
        "root",
        "direct_scalar",
        "duplicate_links",
        "events",
        "work_items",
        "contact_projections",
        "pipeline_step_projections",
        "workflow_run_projections",
        "apply_run_projections",
        "artifact_list_projections",
        "job_detail_projections",
        "evidence_usage_projections",
        "job_list_projections",
        "dashboard_projections",
    )
    assert {step.step_id: step.owned_tables for step in CANDIDATE_POPULATION_STEPS} == {
        "root": {"jobs", "job_locators"},
        "direct_scalar": direct_scalar_tables,
        "duplicate_links": {"job_duplicate_links"},
        "events": {"job_events"},
        "work_items": {"discovery_quarantine_entries", "preparation_work_items"},
        "contact_projections": {
            "contact_projections",
            "contact_research_task_projections",
            "due_follow_up_projections",
            "outreach_thread_projections",
        },
        "pipeline_step_projections": {"pipeline_step_projections"},
        "workflow_run_projections": {"workflow_run_projections"},
        "apply_run_projections": {"apply_run_projections"},
        "artifact_list_projections": {"artifact_list_projections"},
        "job_detail_projections": {"job_detail_projections"},
        "evidence_usage_projections": {"evidence_usage_projections"},
        "job_list_projections": {"job_list_projections"},
        "dashboard_projections": {"dashboard_projections"},
    }


def test_population_step_dependencies_are_ordered_and_acyclic() -> None:
    by_id = {step.step_id: step for step in CANDIDATE_POPULATION_STEPS}
    assert len(by_id) == len(CANDIDATE_POPULATION_STEPS)

    seen: set[str] = set()
    for step in CANDIDATE_POPULATION_STEPS:
        assert set(step.depends_on) <= seen
        seen.add(step.step_id)

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(step_id: str) -> None:
        assert step_id not in visiting
        if step_id in visited:
            return
        visiting.add(step_id)
        for dependency in by_id[step_id].depends_on:
            visit(dependency)
        visiting.remove(step_id)
        visited.add(step_id)

    for step_id in by_id:
        visit(step_id)


def test_population_writers_and_argument_profiles_match_exact_signatures() -> None:
    expected_writers = (
        copy_root_jobs,
        copy_direct_and_scalar_tables,
        copy_duplicate_links,
        copy_job_events,
        copy_structured_work_items,
        copy_contact_projections,
        copy_pipeline_step_projections,
        copy_workflow_run_projections,
        rebuild_apply_run_projections,
        rebuild_artifact_list_projections,
        rebuild_job_detail_projections,
        rebuild_evidence_usage_projections,
        rebuild_job_list_projections,
        rebuild_dashboard_projections,
    )
    expected_keywords = {
        CandidatePopulationArgumentProfile.PLAIN: (),
        CandidatePopulationArgumentProfile.ROOT: ("job_id_factory", "migration_at"),
        CandidatePopulationArgumentProfile.JOB_IDS: ("job_ids",),
        CandidatePopulationArgumentProfile.JOB_IDS_AND_MIGRATION_AT: (
            "job_ids",
            "migration_at",
        ),
    }

    assert tuple(step.writer for step in CANDIDATE_POPULATION_STEPS) == expected_writers
    for step in CANDIDATE_POPULATION_STEPS:
        parameters = signature(step.writer).parameters
        assert tuple(parameters)[:2] == ("source", "candidate")
        assert tuple(parameters)[2:] == expected_keywords[step.argument_profile]
        assert all(
            parameters[name].kind is Parameter.KEYWORD_ONLY
            for name in expected_keywords[step.argument_profile]
        )


def test_population_registry_and_steps_are_immutable() -> None:
    step = CANDIDATE_POPULATION_STEPS[0]

    with pytest.raises(TypeError):
        CANDIDATE_POPULATION_STEPS[0] = step  # type: ignore[misc]
    with pytest.raises(FrozenInstanceError):
        step.step_id = "replacement"  # type: ignore[misc]
    with pytest.raises(AttributeError):
        step.owned_tables.add("replacement")
