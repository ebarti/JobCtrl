"""Worker registry — every Temporal workflow + activity in one place.

The CLI imports ``WORKFLOWS`` and ``ACTIVITIES`` from here and passes them to
``build_worker``. New workflows and activities are added by appending to the
two lists below; no other wiring is required.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from jobhunter.apply.activities import apply_activity
from jobhunter.apply.workflow import ApplyWorkflow
from jobhunter.discovery.activities import (
    discover_activity,
    discovery_enrichment_activity,
    discovery_source_family_activity,
    plan_discovery_sources,
)
from jobhunter.discovery.workflow import DiscoverWorkflow
from jobhunter.enrichment.activities import enrich_activity
from jobhunter.infrastructure.temporal.finalize import (
    record_workflow_outcome,
    record_workflow_started,
)
from jobhunter.materials.activities import (
    cover_letter_activity,
    cover_activity,
    render_pdf_activity,
    tailor_activity,
    tailor_job_activity,
)
from jobhunter.pipeline.workflow import JobPipelineWorkflow
from jobhunter.pipeline.preparation import derive_preparation_targets
from jobhunter.preparation.workflow import JobPreparationWorkflow
from jobhunter.profile.activities import profile_import_activity
from jobhunter.scoring.activities import score_activity, score_job_activity

WORKFLOWS: list[type] = [
    DiscoverWorkflow,
    JobPipelineWorkflow,
    JobPreparationWorkflow,
    ApplyWorkflow,
]

ACTIVITIES: list[Callable[..., Any]] = [
    discover_activity,
    plan_discovery_sources,
    discovery_source_family_activity,
    discovery_enrichment_activity,
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
    record_workflow_started,
    record_workflow_outcome,
]

__all__ = ["ACTIVITIES", "WORKFLOWS"]
