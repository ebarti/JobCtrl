"""Worker registry — every Temporal workflow + activity in one place.

The CLI imports ``WORKFLOWS`` and ``ACTIVITIES`` from here and passes them to
``build_worker``. New workflows and activities are added by appending to the
two lists below; no other wiring is required.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from jobctl.apply.activities import apply_activity
from jobctl.apply.workflow import ApplyWorkflow
from jobctl.contact.activities import run_contact_research_activity
from jobctl.contact.workflow import ContactResearchWorkflow
from jobctl.discovery.activities import (
    discovery_enrichment_activity,
    discovery_preparation_fanout_activity,
    discovery_source_family_activity,
    plan_discovery_sources,
)
from jobctl.discovery.workflow import DiscoverWorkflow
from jobctl.enrichment.activities import enrich_activity
from jobctl.infrastructure.compensation.workflow import (
    CompensationRefreshWorkflow,
    refresh_compensation_activity,
)
from jobctl.infrastructure.temporal.durability_probe import DurabilityProbeWorkflow
from jobctl.infrastructure.temporal.finalize import (
    record_workflow_outcome,
    record_workflow_started,
)
from jobctl.interview.activities import generate_interview_prep_activity
from jobctl.interview.workflow import InterviewPrepWorkflow
from jobctl.llm import check_spend_budget
from jobctl.materials.activities import (
    cover_letter_activity,
    cover_activity,
    render_pdf_activity,
    tailor_activity,
    tailor_job_activity,
)
from jobctl.pipeline.workflow import JobPipelineWorkflow
from jobctl.pipeline.preparation import derive_preparation_targets
from jobctl.preparation.workflow import JobPreparationWorkflow
from jobctl.profile.activities import profile_import_activity
from jobctl.profile.workflow import ProfileImportWorkflow
from jobctl.scoring.activities import score_activity, score_job_activity

WORKFLOWS: list[type] = [
    DiscoverWorkflow,
    JobPipelineWorkflow,
    JobPreparationWorkflow,
    ApplyWorkflow,
    ProfileImportWorkflow,
    CompensationRefreshWorkflow,
    InterviewPrepWorkflow,
    ContactResearchWorkflow,
    DurabilityProbeWorkflow,
]

ACTIVITIES: list[Callable[..., Any]] = [
    plan_discovery_sources,
    discovery_source_family_activity,
    discovery_enrichment_activity,
    discovery_preparation_fanout_activity,
    enrich_activity,
    score_activity,
    score_job_activity,
    tailor_activity,
    tailor_job_activity,
    cover_activity,
    cover_letter_activity,
    render_pdf_activity,
    derive_preparation_targets,
    apply_activity,
    profile_import_activity,
    refresh_compensation_activity,
    generate_interview_prep_activity,
    run_contact_research_activity,
    check_spend_budget,
    record_workflow_started,
    record_workflow_outcome,
]

__all__ = ["ACTIVITIES", "WORKFLOWS"]
