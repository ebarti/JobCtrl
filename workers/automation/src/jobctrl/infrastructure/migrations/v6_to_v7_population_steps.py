"""Immutable execution contract for the v6-to-v7 candidate population.

This module only orders the already-implemented candidate transforms.  A later
coordinator owns connections, transactions, and invocation; importing this
registry must not touch SQLite.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import Final, TypeAlias

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
)
from jobctrl.infrastructure.migrations.v6_to_v7_root import copy_root_jobs
from jobctrl.infrastructure.migrations.v6_to_v7_work_items import (
    copy_structured_work_items,
)
from jobctrl.infrastructure.migrations.v6_to_v7_workflow_run_projections import (
    copy_workflow_run_projections,
)


class CandidatePopulationArgumentProfile(StrEnum):
    """Arguments the future coordinator supplies to a population writer."""

    PLAIN = "plain"
    ROOT = "root"
    JOB_IDS = "job-ids"
    JOB_IDS_AND_MIGRATION_AT = "job-ids-and-migration-at"


CandidatePopulationWriter: TypeAlias = Callable[..., object]


@dataclass(frozen=True)
class CandidatePopulationStep:
    """One dependency-ordered writer and the target tables it exclusively owns."""

    step_id: str
    owned_tables: frozenset[str]
    depends_on: tuple[str, ...]
    writer: CandidatePopulationWriter
    argument_profile: CandidatePopulationArgumentProfile


_DIRECT_AND_SCALAR_TABLES: Final = frozenset(
    table
    for table, plan in TABLE_PLANS.items()
    if plan.disposition
    in {
        TableDisposition.DIRECT_COPY,
        TableDisposition.SCALAR_JOB_ID_REWRITE,
    }
)


CANDIDATE_POPULATION_STEPS: Final[tuple[CandidatePopulationStep, ...]] = (
    CandidatePopulationStep(
        step_id="root",
        owned_tables=frozenset({"jobs", "job_locators"}),
        depends_on=(),
        writer=copy_root_jobs,
        argument_profile=CandidatePopulationArgumentProfile.ROOT,
    ),
    CandidatePopulationStep(
        step_id="direct_scalar",
        owned_tables=_DIRECT_AND_SCALAR_TABLES,
        depends_on=("root",),
        writer=copy_direct_and_scalar_tables,
        argument_profile=CandidatePopulationArgumentProfile.PLAIN,
    ),
    CandidatePopulationStep(
        step_id="duplicate_links",
        owned_tables=frozenset({"job_duplicate_links"}),
        depends_on=("direct_scalar",),
        writer=copy_duplicate_links,
        argument_profile=CandidatePopulationArgumentProfile.JOB_IDS,
    ),
    CandidatePopulationStep(
        step_id="events",
        owned_tables=frozenset({"job_events"}),
        depends_on=("duplicate_links",),
        writer=copy_job_events,
        argument_profile=CandidatePopulationArgumentProfile.JOB_IDS,
    ),
    CandidatePopulationStep(
        step_id="work_items",
        owned_tables=frozenset(
            {"discovery_quarantine_entries", "preparation_work_items"}
        ),
        depends_on=("root",),
        writer=copy_structured_work_items,
        argument_profile=CandidatePopulationArgumentProfile.JOB_IDS,
    ),
    CandidatePopulationStep(
        step_id="contact_projections",
        owned_tables=frozenset(
            {
                "contact_projections",
                "contact_research_task_projections",
                "due_follow_up_projections",
                "outreach_thread_projections",
            }
        ),
        depends_on=("direct_scalar",),
        writer=copy_contact_projections,
        argument_profile=CandidatePopulationArgumentProfile.JOB_IDS,
    ),
    CandidatePopulationStep(
        step_id="pipeline_step_projections",
        owned_tables=frozenset({"pipeline_step_projections"}),
        depends_on=(),
        writer=copy_pipeline_step_projections,
        argument_profile=CandidatePopulationArgumentProfile.PLAIN,
    ),
    CandidatePopulationStep(
        step_id="workflow_run_projections",
        owned_tables=frozenset({"workflow_run_projections"}),
        depends_on=(),
        writer=copy_workflow_run_projections,
        argument_profile=CandidatePopulationArgumentProfile.PLAIN,
    ),
    CandidatePopulationStep(
        step_id="apply_run_projections",
        owned_tables=frozenset({"apply_run_projections"}),
        depends_on=("events",),
        writer=rebuild_apply_run_projections,
        argument_profile=CandidatePopulationArgumentProfile.JOB_IDS,
    ),
    CandidatePopulationStep(
        step_id="artifact_list_projections",
        owned_tables=frozenset({"artifact_list_projections"}),
        depends_on=("direct_scalar",),
        writer=rebuild_artifact_list_projections,
        argument_profile=CandidatePopulationArgumentProfile.JOB_IDS,
    ),
    CandidatePopulationStep(
        step_id="job_detail_projections",
        owned_tables=frozenset({"job_detail_projections"}),
        depends_on=("direct_scalar",),
        writer=rebuild_job_detail_projections,
        argument_profile=CandidatePopulationArgumentProfile.JOB_IDS_AND_MIGRATION_AT,
    ),
    CandidatePopulationStep(
        step_id="evidence_usage_projections",
        owned_tables=frozenset({"evidence_usage_projections"}),
        depends_on=("artifact_list_projections",),
        writer=rebuild_evidence_usage_projections,
        argument_profile=CandidatePopulationArgumentProfile.JOB_IDS_AND_MIGRATION_AT,
    ),
    CandidatePopulationStep(
        step_id="job_list_projections",
        owned_tables=frozenset({"job_list_projections"}),
        depends_on=("apply_run_projections", "artifact_list_projections"),
        writer=rebuild_job_list_projections,
        argument_profile=CandidatePopulationArgumentProfile.JOB_IDS_AND_MIGRATION_AT,
    ),
    CandidatePopulationStep(
        step_id="dashboard_projections",
        owned_tables=frozenset({"dashboard_projections"}),
        depends_on=(
            "apply_run_projections",
            "job_detail_projections",
            "job_list_projections",
        ),
        writer=rebuild_dashboard_projections,
        argument_profile=CandidatePopulationArgumentProfile.JOB_IDS_AND_MIGRATION_AT,
    ),
)


__all__ = [
    "CANDIDATE_POPULATION_STEPS",
    "CandidatePopulationArgumentProfile",
    "CandidatePopulationStep",
    "CandidatePopulationWriter",
]
