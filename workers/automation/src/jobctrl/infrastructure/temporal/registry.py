"""Worker registry — every Temporal workflow + activity in one place.

The CLI imports ``WORKFLOWS`` and ``ACTIVITIES`` from here and passes them to
``build_worker``. New workflows and activities are added by appending to the
two lists below; no other wiring is required.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from jobctrl.apply.activities import apply_activity
from jobctrl.apply.workflow import ApplyWorkflow
from jobctrl.contact.activities import run_contact_research_activity
from jobctrl.contact.workflow import ContactResearchWorkflow
from jobctrl.discovery.activities import (
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
from jobctrl.enrichment.activities import enrich_activity
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


@dataclass(frozen=True)
class WorkflowIdentityCutoverPolicy:
    """How one registered workflow participates in the JobId cutover.

    ``identity_fields`` names serialized URL/identity-bearing fields or the
    durable job-work relationship that requires the execution to drain. An
    empty tuple is an explicit declaration that the workflow is unrelated to
    job identity; it is never an implicit default.

    ``inventory_sources`` declares every local authority that can identify an
    exact execution for cutover preflight. A blocking workflow must always
    participate in the dispatch registry, canonical workflow-event, and
    workflow-run projection inventories; workflow-specific schedules,
    deterministic identities, or durable ownership add sources explicitly.
    """

    workflow_type: str
    blocks_cutover_when_open: bool
    identity_fields: tuple[str, ...]
    inventory_sources: tuple[str, ...]


WORKFLOW_IDENTITY_CUTOVER_POLICIES: dict[
    type,
    WorkflowIdentityCutoverPolicy,
] = {
    DiscoverWorkflow: WorkflowIdentityCutoverPolicy(
        workflow_type="DiscoverWorkflow",
        blocks_cutover_when_open=True,
        identity_fields=("durable_discovery_work",),
        inventory_sources=(
            "dispatch_registry",
            "workflow_start_event",
            "workflow_run_projection",
            "identity_schedule",
            "pipeline_child",
            "discovery_execution",
            "discovery_search_unit",
            "pipeline_step_projection",
        ),
    ),
    JobPipelineWorkflow: WorkflowIdentityCutoverPolicy(
        workflow_type="JobPipelineWorkflow",
        blocks_cutover_when_open=True,
        identity_fields=("job_url", "job_urls"),
        inventory_sources=(
            "dispatch_registry",
            "workflow_start_event",
            "workflow_run_projection",
        ),
    ),
    JobPreparationWorkflow: WorkflowIdentityCutoverPolicy(
        workflow_type="JobPreparationWorkflow",
        blocks_cutover_when_open=True,
        identity_fields=("job_url", "idempotency_key"),
        inventory_sources=(
            "dispatch_registry",
            "workflow_start_event",
            "workflow_run_projection",
            "discovery_preparation_plan",
            "preparation_work_item",
        ),
    ),
    ApplyWorkflow: WorkflowIdentityCutoverPolicy(
        workflow_type="ApplyWorkflow",
        blocks_cutover_when_open=True,
        identity_fields=("job_url", "workflow_id"),
        inventory_sources=(
            "dispatch_registry",
            "workflow_start_event",
            "workflow_run_projection",
            "pipeline_child",
            "job_identity_derived",
            "auto_apply_loop",
        ),
    ),
    ManualCaptureImportWorkflow: WorkflowIdentityCutoverPolicy(
        workflow_type="ManualCaptureImportWorkflow",
        blocks_cutover_when_open=True,
        identity_fields=("captured_url", "durable_capture_item"),
        inventory_sources=(
            "dispatch_registry",
            "workflow_start_event",
            "workflow_run_projection",
            "manual_capture_queue",
        ),
    ),
    ProfileImportWorkflow: WorkflowIdentityCutoverPolicy(
        workflow_type="ProfileImportWorkflow",
        blocks_cutover_when_open=False,
        identity_fields=(),
        inventory_sources=(),
    ),
    CompensationRefreshWorkflow: WorkflowIdentityCutoverPolicy(
        workflow_type="CompensationRefreshWorkflow",
        blocks_cutover_when_open=True,
        identity_fields=("job_url",),
        inventory_sources=(
            "dispatch_registry",
            "workflow_start_event",
            "workflow_run_projection",
        ),
    ),
    InterviewPrepWorkflow: WorkflowIdentityCutoverPolicy(
        workflow_type="InterviewPrepWorkflow",
        blocks_cutover_when_open=True,
        identity_fields=("job_url", "workflow_id"),
        inventory_sources=(
            "dispatch_registry",
            "workflow_start_event",
            "workflow_run_projection",
            "job_identity_derived",
        ),
    ),
    ContactResearchWorkflow: WorkflowIdentityCutoverPolicy(
        workflow_type="ContactResearchWorkflow",
        blocks_cutover_when_open=True,
        identity_fields=("job_url",),
        inventory_sources=(
            "dispatch_registry",
            "workflow_start_event",
            "workflow_run_projection",
            "contact_research_task",
        ),
    ),
    DurabilityProbeWorkflow: WorkflowIdentityCutoverPolicy(
        workflow_type="DurabilityProbeWorkflow",
        blocks_cutover_when_open=False,
        identity_fields=(),
        inventory_sources=(),
    ),
}

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
    manual_capture_import_activity,
    profile_import_activity,
    refresh_compensation_activity,
    generate_interview_prep_activity,
    run_contact_research_activity,
    check_spend_budget,
    record_workflow_started,
    record_workflow_outcome,
]

__all__ = [
    "ACTIVITIES",
    "WORKFLOWS",
    "WORKFLOW_IDENTITY_CUTOVER_POLICIES",
    "WorkflowIdentityCutoverPolicy",
]
