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
    current_substage: str = "discover"
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
    # Phase 1: the canonical employer-analysis read shape (JSON of the latest
    # generation's ``EmployerAnalysis.to_read_model()``), or None when no
    # analysis exists yet. Built by the single projection owner from canonical
    # rows so the inspector read path has one source of truth.
    employer_analysis_json: str | None = None
    # Requirement-led fit audit read shape (JSON of the latest
    # ``RequirementFitReport.to_read_model()``), or None when this job has not
    # been scored with requirement-level assessments yet.
    requirement_fit_report_json: str | None = None


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
    metadata_json: str | None = None
    # Phase 2: the canonical per-bullet provenance read shape (JSON of the
    # generation's ``BulletProvenanceSet.to_read_model()``), or None when no
    # provenance was recorded (e.g. PDF artifacts, or a legacy generation tailored
    # before Phase 2). Built by the single projection owner from canonical rows so
    # the inspector read path has one source of truth — never derived from
    # ``metadata_json``.
    bullet_provenance_json: str | None = None
    # Phase 3: the canonical generation-time keyword-coverage read shape (JSON of
    # ``BulletProvenanceSet.coverage_to_read_model()``, GROUND-06) and the voice-pass
    # audit read shape (JSON of ``voice_to_read_model()``, VOICE-02), or None when
    # not recorded. Same single-owner, canonical-rows discipline as provenance —
    # coverage is computed against the rendered text at generation time, never
    # recomputed from the JD at read time.
    coverage_audit_json: str | None = None
    voice_pass_json: str | None = None


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


@dataclass(frozen=True)
class DiscoveryRunProjection:
    """Read-side row for scheduled discovery runs."""

    run_id: str
    tenant_id: TenantId
    source_ids: tuple[str, ...] = ()
    profile_snapshot_id: str | None = None
    status: str = "running"
    counts: dict[str, int] = field(default_factory=dict)
    error_classes: tuple[str, ...] = ()
    started_at: str | None = None
    completed_at: str | None = None
    failed_at: str | None = None
    failed_source_id: str | None = None
    retryable: bool = True


@dataclass(frozen=True)
class SourceQualityStats:
    """Operations projection for source health and scheduling feedback."""

    tenant_id: TenantId
    source_id: str
    window_start: str
    window_end: str
    run_count: int = 0
    failed_run_count: int = 0
    consecutive_failures: int = 0
    observed_jobs: int = 0
    new_jobs: int = 0
    existing_jobs: int = 0
    duplicate_jobs: int = 0
    active_jobs: int = 0
    stale_jobs: int = 0
    detail_success_count: int = 0
    detail_failure_count: int = 0
    active_verification_rate: float | None = None
    duplicate_rate: float | None = None
    full_description_success_rate: float | None = None
    apply_url_success_rate: float | None = None
    last_run_id: str | None = None
    last_error_class: str | None = None
    recommended_state: str = "normal"
    updated_at: str = ""
