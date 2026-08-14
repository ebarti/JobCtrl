"""Worker registry — every Temporal workflow + activity in one place.

The CLI imports ``WORKFLOWS`` and ``ACTIVITIES`` from here and passes them to
``build_worker``. New workflows and activities are added by appending to the
two lists below; no other wiring is required.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from jobctrl.apply.activities import apply_activity
from jobctrl.apply.workflow import ApplyWorkflow
from jobctrl.contact.activities import run_contact_research_activity
from jobctrl.contact.workflow import ContactResearchWorkflow
from jobctrl.discovery.activities import (
    automatic_compensation_refresh_activity,
    discovery_enrichment_activity,
    discovery_preparation_fanout_activity,
    discovery_source_family_activity,
    plan_discovery_sources,
)
from jobctrl.discovery.manual_capture_workflow import (
    ManualCaptureImportWorkflow,
    manual_capture_import_activity,
)
from jobctrl.discovery.workflow import DiscoverWorkflow
from jobctrl.enrichment.activities import (
    cancel_enrichment_cohort_activity,
    enrich_activity,
)
from jobctrl.infrastructure.compensation.workflow import (
    CompensationRefreshWorkflow,
    refresh_compensation_activity,
)
from jobctrl.infrastructure.temporal.durability_probe import DurabilityProbeWorkflow
from jobctrl.infrastructure.temporal.finalize import (
    record_workflow_outcome,
    record_workflow_started,
)
from jobctrl.interview.activities import generate_interview_prep_activity
from jobctrl.interview.workflow import InterviewPrepWorkflow
from jobctrl.llm import check_spend_budget
from jobctrl.materials.activities import (
    cover_letter_activity,
    cover_activity,
    render_pdf_activity,
    tailor_activity,
    tailor_job_activity,
)
from jobctrl.pipeline.workflow import JobPipelineWorkflow
from jobctrl.pipeline.preparation import derive_preparation_targets
from jobctrl.infrastructure.preparation_recovery import (
    cancel_preparation_state_activity,
    recover_preparation_state_activity,
)
from jobctrl.preparation.workflow import JobPreparationWorkflow
from jobctrl.profile.activities import profile_import_activity
from jobctrl.profile.workflow import ProfileImportWorkflow
from jobctrl.scoring.activities import score_activity, score_job_activity

WORKFLOWS: list[type] = [
    DiscoverWorkflow,
    JobPipelineWorkflow,
    JobPreparationWorkflow,
    ApplyWorkflow,
    ManualCaptureImportWorkflow,
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
    automatic_compensation_refresh_activity,
    discovery_preparation_fanout_activity,
    enrich_activity,
    cancel_enrichment_cohort_activity,
    score_activity,
    score_job_activity,
    recover_preparation_state_activity,
    cancel_preparation_state_activity,
    tailor_activity,
    tailor_job_activity,
    cover_activity,
    cover_letter_activity,
    render_pdf_activity,
    derive_preparation_targets,
    apply_activity,
    manual_capture_import_activity,
    profile_import_activity,
    refresh_compensation_activity,
    generate_interview_prep_activity,
    run_contact_research_activity,
    check_spend_budget,
    record_workflow_started,
    record_workflow_outcome,
]

__all__ = ["ACTIVITIES", "WORKFLOWS"]
