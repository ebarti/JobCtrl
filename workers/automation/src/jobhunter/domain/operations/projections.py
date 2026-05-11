"""Read-model projection value objects (ddd-target.md §4.8 / §6.6).

The projections are denormalised snapshots of canonical aggregate state.
They are *derived data* — every value lives upstream in another
aggregate's repository.  The Operations context's job is to maintain
these views so the UI / dashboards can read in O(1) without joining
across the whole database on every page load.

Per the §4.8 contract:

* ``JobListProjection``     — one row per job, denormalised pipeline
                              snapshot (current stage/state, score,
                              materials presence, apply status).
* ``DashboardProjection``   — singleton aggregate counts + funnel +
                              source breakdown + score histogram.
* ``JobDetailProjection``   — one row per job, full detail view
                              (description preview, score reasoning,
                              full stages list, recent events).
* ``ArtifactListProjection``— one row per generated artifact across
                              jobs, with provenance.
* ``ApplyRunProjection``    — one row per apply run, with denormalised
                              job context and event timeline.

All projections are immutable (``frozen=True``).  Mutations happen by
materialising a fresh dataclass and upserting through
``SqliteProjectionStore``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from jobhunter.domain.tenant import TenantId


@dataclass(frozen=True)
class StageProjection:
    """Denormalised stage row inside a ``JobDetailProjection.stages`` list."""

    stage: str
    state: str
    attempt_count: int = 0
    max_attempts: int | None = None
    started_at: str | None = None
    updated_at: str | None = None
    finished_at: str | None = None
    duration_ms: int | None = None
    error_code: str | None = None
    error_message: str | None = None
    retryable: bool = True
    blocked_by: tuple[str, ...] = ()
    next_action: str | None = None


@dataclass(frozen=True)
class JobListProjection:
    """Denormalised list-view row for one job (ddd-target.md §6.6).

    Every field on this row is a frozen snapshot of canonical aggregate
    state at the time of the last projection refresh.  The TS read-model
    projects this 1:1 to ``JobSummary``.
    """

    tenant_id: TenantId
    job_id: str
    title: str = ""
    employer: str = ""
    source: str = ""
    strategy: str = ""
    location: str = ""
    salary: str = ""
    application_url: str | None = None
    discovered_at: str | None = None
    description: str = ""
    full_description: str = ""
    fit_score: int | None = None
    score_breakdown_json: str | None = None
    score_keywords_json: str = "[]"
    score_reasoning: str = ""
    score_version: int | None = None
    scored_at: str | None = None
    current_stage: str = "discover"
    current_state: str = "pending"
    current_error_code: str | None = None
    current_error_message: str | None = None
    current_next_action: str | None = None
    has_resume: bool = False
    has_cover_letter: bool = False
    has_pdf: bool = False
    apply_status: str | None = None
    applied_at: str | None = None
    artifact_count: int = 0
    deleted_at: str | None = None
    last_updated_at: str | None = None


@dataclass(frozen=True)
class DashboardFunnelStage:
    stage: str
    total: int = 0
    succeeded: int = 0
    running: int = 0
    pending: int = 0
    blocked: int = 0
    failed: int = 0


@dataclass(frozen=True)
class DashboardProjection:
    """Singleton aggregate dashboard row per tenant.

    Numbers are recomputed from ``JobListProjection`` rows on every
    refresh — this row is a denormalised cache so the UI doesn't have to
    sweep the table for COUNTs / GROUP BYs on every page load.
    """

    tenant_id: TenantId
    total_jobs: int = 0
    failures: int = 0
    blocked: int = 0
    ready: int = 0
    applied: int = 0
    dry_runs: int = 0
    funnel: tuple[DashboardFunnelStage, ...] = ()
    by_source: tuple[tuple[str, int], ...] = ()
    score_distribution: tuple[tuple[int, int], ...] = ()
    generated_at: str = ""


@dataclass(frozen=True)
class JobDetailProjection:
    """One row per job with the data needed for the detail view."""

    tenant_id: TenantId
    job_id: str
    description_preview: str = ""
    score_breakdown_json: str | None = None
    score_keywords_json: str = "[]"
    score_reasoning: str = ""
    score_version: int | None = None
    scored_at: str | None = None
    stages: tuple[StageProjection, ...] = ()
    last_updated_at: str | None = None


@dataclass(frozen=True)
class ArtifactListProjection:
    """Denormalised artifact row across all jobs."""

    artifact_id: str
    tenant_id: TenantId
    job_id: str
    job_title: str = ""
    job_employer: str = ""
    artifact_type: str = ""
    status: str = ""
    local_path: str = ""
    size_bytes: int | None = None
    created_at: str | None = None
    generation: int | None = None


@dataclass(frozen=True)
class ApplyRunProjection:
    """Apply-run telemetry row with job context + event timeline."""

    run_id: str
    tenant_id: TenantId
    job_id: str
    job_title: str = ""
    job_employer: str = ""
    status: str = ""
    result: str | None = None
    dry_run: bool = False
    worker_id: int | None = None
    model: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    duration_ms: int | None = None
    events: tuple[dict[str, Any], ...] = field(default_factory=tuple)
