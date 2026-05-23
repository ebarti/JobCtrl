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
from jobhunter.discovery.activities import discover_activity
from jobhunter.enrichment.activities import enrich_activity
from jobhunter.materials.activities import (
    cover_activity,
    tailor_activity,
)
from jobhunter.pipeline.workflow import JobPipelineWorkflow
from jobhunter.profile.activities import profile_import_activity
from jobhunter.scoring.activities import score_activity

WORKFLOWS: list[type] = [
    JobPipelineWorkflow,
    ApplyWorkflow,
]

ACTIVITIES: list[Callable[..., Any]] = [
    discover_activity,
    enrich_activity,
    score_activity,
    tailor_activity,
    cover_activity,
    apply_activity,
    profile_import_activity,
]

__all__ = ["ACTIVITIES", "WORKFLOWS"]
