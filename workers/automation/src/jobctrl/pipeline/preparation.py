"""Temporal-native preparation fan-out.

Discovery remains the user-facing preparation stage. This module now derives
deterministic per-job preparation targets and starts ``JobPreparationWorkflow``
executions instead of claiming a local work-item queue.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, replace
from typing import Any, Coroutine

from temporalio import activity
from temporalio.client import WorkflowHandle
from temporalio.common import WorkflowIDConflictPolicy

from jobctrl import database as db_module
from jobctrl.database import get_connection
from jobctrl.domain.discovery.execution import (
    DiscoveryExecutionCohortKind,
    DiscoveryExecutionRef,
    DiscoveryExecutionWorkPlanState,
    validate_required_steps,
)
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.preparation import PreparationWorkItemKind, make_preparation_idempotency_key
from jobctrl.domain.rpc.messages import WorkflowStartSpec
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.materials import SqliteTailoringPolicyRepository
from jobctrl.infrastructure.discovery.sqlite_execution_repository import (
    SqliteDiscoveryExecutionRepository,
)
from jobctrl.infrastructure.rpc.workflow_starter import (
    WorkflowStarter,
    default_workflow_starter,
)
from jobctrl.infrastructure.scoring import SqliteScoringPolicyRepository
from jobctrl.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC
from jobctrl.preparation.workflow import (
    JobPreparationInput,
    JobPreparationWorkflow,
    preparation_workflow_id,
)
from jobctrl.scoring.eligibility_sql import (
    register_score_eligibility_sql,
    score_eligible_for_downstream_sql,
)
from jobctrl.state import utc_now

log = logging.getLogger(__name__)

PREPARATION_CHILD_BATCH_SIZE = 25

_LATEST_SCORES_CTE = f"""
latest_scores AS (
    SELECT scores.tenant_id,
           scores.job_id,
           scores.fit_score,
           {score_eligible_for_downstream_sql('scores.breakdown_json')} AS eligible_for_downstream
      FROM job_scores scores
      INNER JOIN (
          SELECT tenant_id, job_id, MAX(version) AS version
            FROM job_scores
           GROUP BY tenant_id, job_id
      ) latest
        ON latest.tenant_id = scores.tenant_id
       AND latest.job_id = scores.job_id
       AND latest.version = scores.version
)
"""

_LATEST_ACTIVE_MATERIALS_CTE = """
latest_active_materials AS (
    SELECT tenant_id, job_id, MAX(generation) AS generation
      FROM job_materials_artifacts
     WHERE status = 'approved'
       AND artifact_type IN (
            'tailored_resume', 'cover_letter', 'resume_pdf', 'cover_letter_pdf'
       )
     GROUP BY tenant_id, job_id
)
"""


@dataclass(frozen=True)
class PreparationTarget:
    tenant_id: TenantId
    job_id: JobId
    idempotency_key: str
    target_version: str
    steps: list[str]

    def __post_init__(self) -> None:
        object.__setattr__(self, "tenant_id", TenantId(str(self.tenant_id)))
        object.__setattr__(self, "job_id", canonical_job_id(str(self.job_id)))


@dataclass(frozen=True)
class DerivePreparationTargetsInput:
    tenant_id: str = LOCAL_TENANT
    min_score: int = 7
    limit: int = 0
    # When False, only ``pending_score`` (fresh) jobs are derived and the
    # ``pending_tailor`` straggler branch is skipped. Per-family streaming
    # (R9 Phase 1) sets this False after the first fan-out so a fresh job that
    # advances ``pending_score`` -> ``pending_tailor`` between passes is never
    # re-derived as a second (TAILOR_RESUME) workflow while its SCORE_JOB
    # workflow is still tailoring it. See ``_derive_targets``.
    include_pending_tailor: bool = True


@activity.defn(name="derive_preparation_targets")
def derive_preparation_targets(payload: DerivePreparationTargetsInput) -> list[PreparationTarget]:
    """Return deterministic per-job preparation workflow targets."""
    conn = get_connection()
    tenant_id = TenantId(payload.tenant_id)
    min_score = db_module.effective_tailoring_min_score(payload.min_score)
    _suppress_ineligible_artifacts(conn, tenant_id=tenant_id, min_score=min_score)
    targets = _derive_targets(
        conn,
        tenant_id=tenant_id,
        min_score=min_score,
        include_pending_tailor=payload.include_pending_tailor,
    )
    if payload.limit > 0:
        targets = targets[: payload.limit]
    return targets


def start_discovery_preparation_workflows(
    *,
    min_score: int = 7,
    limit: int = 0,
    workers: int = 1,
    validation_mode: str = "normal",
    llm_model: str | None = DEFAULT_PIPELINE_LLM_MODEL_SPEC,
    tailor_models: tuple[str, ...] = (),
    tailor_judge_model: str | None = None,
    tailor_judge_min_score: float | None = None,
    tenant_id: TenantId = LOCAL_TENANT,
    workflow_starter: WorkflowStarter | None = None,
    include_pending_tailor: bool = True,
    discovery_execution: DiscoveryExecutionRef | None = None,
    discovery_cohort_kind: DiscoveryExecutionCohortKind = "observed_this_run",
    finalize_observed_work_plans: bool = False,
) -> dict[str, Any]:
    """Derive targets and start per-job preparation workflows in batches."""
    try:
        targets = derive_preparation_targets(
            DerivePreparationTargetsInput(
                tenant_id=str(tenant_id),
                min_score=min_score,
                limit=limit,
                include_pending_tailor=include_pending_tailor,
            )
        )
    except Exception:
        if discovery_execution is not None:
            _mark_pending_work_plans_failed(
                discovery_execution,
                reason="target_derivation_failed",
            )
        raise

    try:
        target_specs = [
            (
                target,
                _workflow_spec_for_target(
                    target,
                    tenant_id=tenant_id,
                    min_score=min_score,
                    workers=workers,
                    validation_mode=validation_mode,
                    llm_model=llm_model,
                    tailor_models=tailor_models,
                    tailor_judge_model=tailor_judge_model,
                    tailor_judge_min_score=tailor_judge_min_score,
                    discovery_execution=discovery_execution,
                    discovery_cohort_kind=discovery_cohort_kind,
                ),
            )
            for target in targets
        ]
        specs = [spec for _target, spec in target_specs]
        if discovery_execution is not None:
            workflow_cohorts_to_start = _record_preparation_work_plans(
                targets,
                tenant_id=tenant_id,
                discovery_execution=discovery_execution,
                discovery_cohort_kind=discovery_cohort_kind,
            )
            specs = [
                _with_discovery_cohort(
                    spec,
                    workflow_cohorts_to_start[spec.workflow_id],
                )
                for _target, spec in target_specs
                if spec.workflow_id in workflow_cohorts_to_start
            ]
            if finalize_observed_work_plans:
                _finalize_unplanned_observed_work_plans(
                    discovery_execution,
                    min_score=db_module.effective_tailoring_min_score(min_score),
                )
    except Exception:
        if discovery_execution is not None:
            _mark_pending_work_plans_failed(
                discovery_execution,
                reason="work_plan_persistence_failed",
            )
        raise
    starter = workflow_starter or default_workflow_starter
    started = 0
    for batch in _batches(specs, PREPARATION_CHILD_BATCH_SIZE):
        _run_start_batch(batch, starter)
        started += len(batch)
    return {
        "status": "ok",
        "has_work": bool(specs),
        "targets": len(targets),
        "started": {"job_preparation": started},
        "queued": {"job_preparation": len(specs)},
        "batch_size": PREPARATION_CHILD_BATCH_SIZE,
    }


def start_job_preparation_workflow(
    job_id: JobId,
    *,
    min_score: int = 7,
    workers: int = 1,
    validation_mode: str = "normal",
    llm_model: str | None = DEFAULT_PIPELINE_LLM_MODEL_SPEC,
    tailor_models: tuple[str, ...] = (),
    tailor_judge_model: str | None = None,
    tailor_judge_min_score: float | None = None,
    tenant_id: TenantId = LOCAL_TENANT,
    workflow_starter: WorkflowStarter | None = None,
    discovery_execution: DiscoveryExecutionRef | None = None,
    discovery_cohort_kind: DiscoveryExecutionCohortKind = "observed_this_run",
) -> bool:
    """Start ONE job's ``SCORE_JOB`` preparation workflow (R9 Phase 2 handoff).

    Called as each job crosses ``pending_score`` during enrichment so its
    preparation begins immediately, before its siblings are even enriched. The
    workflow id is the same deterministic ``prep-{idempotency_key}`` a
    ``pending_score`` job would get from the per-family / terminal fan-out
    (kind=SCORE_JOB, steps score→tailor→cover→pdf, current scoring policy
    version, latest source event), so `USE_EXISTING` makes the per-job handoff
    and the reconciling fan-outs converge on exactly one execution per job (I1).
    """
    stable_job_id = canonical_job_id(str(job_id))
    try:
        conn = get_connection()
        target_version = current_scoring_policy_version(conn, tenant_id)
        spec = build_preparation_workflow_spec(
            tenant_id=tenant_id,
            job_id=stable_job_id,
            steps=["score", "tailor", "cover", "pdf"],
            kind=PreparationWorkItemKind.SCORE_JOB,
            target_version=target_version,
            min_score=min_score,
            workers=workers,
            validation_mode=validation_mode,
            llm_model=llm_model,
            tailor_models=tailor_models,
            tailor_judge_model=tailor_judge_model,
            tailor_judge_min_score=tailor_judge_min_score,
            discovery_execution=discovery_execution,
            discovery_cohort_kind=(discovery_cohort_kind if discovery_execution is not None else None),
        )
        if discovery_execution is not None:
            preparation_payload = spec.args[0]
            if not isinstance(preparation_payload, JobPreparationInput):
                raise TypeError("preparation workflow spec has an unexpected input")
            workflow_cohorts_to_start = _record_preparation_work_plans(
                [
                    PreparationTarget(
                        tenant_id=tenant_id,
                        job_id=stable_job_id,
                        idempotency_key=preparation_payload.idempotency_key,
                        target_version=preparation_payload.target_version,
                        steps=list(preparation_payload.steps),
                    )
                ],
                tenant_id=tenant_id,
                discovery_execution=discovery_execution,
                discovery_cohort_kind=discovery_cohort_kind,
            )
            if spec.workflow_id not in workflow_cohorts_to_start:
                return False
            spec = _with_discovery_cohort(
                spec,
                workflow_cohorts_to_start[spec.workflow_id],
            )
    except Exception:
        if discovery_execution is not None:
            _mark_job_work_plan_failed(
                discovery_execution,
                job_id=stable_job_id,
                reason="work_plan_persistence_failed",
            )
        raise
    starter = workflow_starter or default_workflow_starter
    _run_start_batch([spec], starter)
    return True


def build_preparation_workflow_spec(
    *,
    tenant_id: TenantId,
    job_id: JobId,
    steps: list[str],
    kind: PreparationWorkItemKind,
    target_version: int,
    min_score: int = 7,
    workers: int = 1,
    validation_mode: str = "normal",
    rescore: bool = False,
    retailor: bool = False,
    suppress_existing_artifacts: bool = False,
    allow_low_fit_override: bool = False,
    tailor_models: tuple[str, ...] = (),
    tailor_judge_model: str | None = None,
    tailor_judge_min_score: float | None = None,
    llm_model: str | None = DEFAULT_PIPELINE_LLM_MODEL_SPEC,
    source_event_id: str | None = None,
    expected_app_dir: str | None = None,
    expected_db_path: str | None = None,
    discovery_execution: DiscoveryExecutionRef | None = None,
    discovery_cohort_kind: DiscoveryExecutionCohortKind | None = None,
) -> WorkflowStartSpec:
    stable_job_id = canonical_job_id(str(job_id))
    source_event = (
        source_event_id
        if source_event_id is not None
        else _latest_source_event_id(
            get_connection(),
            tenant_id=tenant_id,
            job_id=stable_job_id,
        )
    )
    idempotency_key = make_preparation_idempotency_key(
        tenant_id=tenant_id,
        job_id=stable_job_id,
        kind=kind,
        target_version=target_version,
        source_event_id=source_event,
    )
    payload = JobPreparationInput(
        tenant_id=str(tenant_id),
        job_id=stable_job_id,
        steps=list(steps),
        target_version=str(target_version),
        idempotency_key=idempotency_key,
        min_score=min_score,
        workers=workers,
        validation_mode=validation_mode,
        rescore=rescore,
        retailor=retailor,
        suppress_existing_artifacts=suppress_existing_artifacts,
        allow_low_fit_override=allow_low_fit_override,
        tailor_models=tailor_models,
        tailor_judge_model=tailor_judge_model,
        tailor_judge_min_score=tailor_judge_min_score,
        llm_model=llm_model or DEFAULT_PIPELINE_LLM_MODEL_SPEC,
        expected_app_dir=expected_app_dir,
        expected_db_path=expected_db_path,
        discovery_execution=discovery_execution,
        discovery_cohort_kind=discovery_cohort_kind,
    )
    return WorkflowStartSpec(
        workflow=JobPreparationWorkflow,
        args=(payload,),
        workflow_id=preparation_workflow_id(idempotency_key),
        id_conflict_policy=WorkflowIDConflictPolicy.USE_EXISTING,
    )


def current_scoring_policy_version(conn: sqlite3.Connection, tenant_id: TenantId) -> int:
    return SqliteScoringPolicyRepository(conn).get_current(tenant_id).version


def current_tailoring_policy_version(conn: sqlite3.Connection, tenant_id: TenantId) -> int:
    policy = SqliteTailoringPolicyRepository(conn).get_current(tenant_id)
    return policy.version if policy is not None else 1


def latest_source_event_id(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    job_id: JobId,
) -> str:
    return _latest_source_event_id(
        conn,
        tenant_id=tenant_id,
        job_id=canonical_job_id(str(job_id)),
    )


def _derive_targets(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    min_score: int,
    include_pending_tailor: bool = True,
) -> list[PreparationTarget]:
    score_target_version = current_scoring_policy_version(conn, tenant_id)
    targets: dict[JobId, PreparationTarget] = {}

    for job_id in _preparation_job_ids(
        conn,
        tenant_id=tenant_id,
        stage="pending_score",
        min_score=min_score,
    ):
        targets[job_id] = _target(
            tenant_id=tenant_id,
            job_id=job_id,
            kind=PreparationWorkItemKind.SCORE_JOB,
            target_version=score_target_version,
            source_event_id=_latest_source_event_id(
                conn,
                tenant_id=tenant_id,
                job_id=job_id,
            ),
            steps=["score", "tailor", "cover", "pdf"],
        )

    # A ``pending_score`` job is carried all the way through tailor/cover/pdf by
    # its own SCORE_JOB workflow (steps above). The ``pending_tailor`` branch is
    # only for pre-existing stragglers scored in a prior run. When streaming
    # fans out repeatedly (R9 Phase 1), deriving ``pending_tailor`` on every
    # pass would start a second TAILOR_RESUME workflow for a fresh job the
    # instant it crossed ``pending_score`` -> ``pending_tailor`` mid-tailor,
    # double-spending on tailoring. Callers therefore sweep stragglers exactly
    # once (``include_pending_tailor=True``) and derive score-only thereafter.
    if include_pending_tailor:
        tailoring_target_version = current_tailoring_policy_version(conn, tenant_id)
        for job_id in _preparation_job_ids(
            conn,
            tenant_id=tenant_id,
            stage="pending_tailor",
            min_score=min_score,
        ):
            if job_id in targets:
                continue
            targets[job_id] = _target(
                tenant_id=tenant_id,
                job_id=job_id,
                kind=PreparationWorkItemKind.TAILOR_RESUME,
                target_version=tailoring_target_version,
                source_event_id=_latest_source_event_id(
                    conn,
                    tenant_id=tenant_id,
                    job_id=job_id,
                ),
                steps=["tailor", "cover", "pdf"],
            )

    return [targets[job_id] for job_id in sorted(targets)]


def _preparation_job_ids(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    stage: str,
    min_score: int,
) -> list[JobId]:
    """Select exact-v7 preparation candidates by canonical identity."""
    register_score_eligibility_sql(conn)
    if stage == "pending_score":
        rows = conn.execute(
            f"""
            WITH {_LATEST_SCORES_CTE}
            SELECT jobs.job_id
              FROM jobs
              INNER JOIN job_enrichments enrichment
                ON enrichment.tenant_id = jobs.tenant_id
               AND enrichment.job_id = jobs.job_id
              LEFT JOIN latest_scores score
                ON score.tenant_id = jobs.tenant_id
               AND score.job_id = jobs.job_id
              LEFT JOIN job_stage_states score_stage
                ON score_stage.tenant_id = jobs.tenant_id
               AND score_stage.job_id = jobs.job_id
               AND score_stage.stage = 'score'
              LEFT JOIN posting_snapshot_sets snapshots
                ON snapshots.tenant_id = jobs.tenant_id
               AND snapshots.job_id = jobs.job_id
             WHERE jobs.tenant_id = ?
               AND NOT EXISTS (
                    SELECT 1
                      FROM jobctrl_deleted_jobs deleted
                     WHERE deleted.tenant_id = jobs.tenant_id
                       AND deleted.job_id = jobs.job_id
                       AND (
                            deleted.restored_at IS NULL
                            OR julianday(deleted.restored_at) <= julianday(deleted.deleted_at)
                       )
               )
               AND enrichment.full_description IS NOT NULL
               AND score.job_id IS NULL
               AND COALESCE(score_stage.state, 'pending') = 'pending'
               AND COALESCE(score_stage.attempt_count, 0) < 5
               AND (
                    snapshots.latest_active_state IS NULL
                    OR snapshots.latest_active_state NOT IN (
                        'closed', 'expired', 'removed', 'location_incompatible'
                    )
               )
             ORDER BY jobs.discovered_at DESC, jobs.job_id
            """,
            (str(tenant_id),),
        ).fetchall()
    elif stage == "pending_tailor":
        rows = conn.execute(
            f"""
            WITH {_LATEST_SCORES_CTE},
                 {_LATEST_ACTIVE_MATERIALS_CTE}
            SELECT jobs.job_id
              FROM jobs
              INNER JOIN job_enrichments enrichment
                ON enrichment.tenant_id = jobs.tenant_id
               AND enrichment.job_id = jobs.job_id
              INNER JOIN latest_scores score
                ON score.tenant_id = jobs.tenant_id
               AND score.job_id = jobs.job_id
              LEFT JOIN job_stage_states score_stage
                ON score_stage.tenant_id = jobs.tenant_id
               AND score_stage.job_id = jobs.job_id
               AND score_stage.stage = 'score'
              LEFT JOIN job_stage_states tailor_stage
                ON tailor_stage.tenant_id = jobs.tenant_id
               AND tailor_stage.job_id = jobs.job_id
               AND tailor_stage.stage = 'tailor'
              LEFT JOIN job_score_staleness stale_score
                ON stale_score.tenant_id = jobs.tenant_id
               AND stale_score.job_id = jobs.job_id
               AND stale_score.resolved = 0
              LEFT JOIN posting_snapshot_sets snapshots
                ON snapshots.tenant_id = jobs.tenant_id
               AND snapshots.job_id = jobs.job_id
              LEFT JOIN latest_active_materials materials
                ON materials.tenant_id = jobs.tenant_id
               AND materials.job_id = jobs.job_id
              LEFT JOIN job_materials_artifacts tailored_resume
                ON tailored_resume.tenant_id = materials.tenant_id
               AND tailored_resume.job_id = materials.job_id
               AND tailored_resume.generation = materials.generation
               AND tailored_resume.artifact_type = 'tailored_resume'
               AND tailored_resume.status = 'approved'
             WHERE jobs.tenant_id = ?
               AND NOT EXISTS (
                    SELECT 1
                      FROM jobctrl_deleted_jobs deleted
                     WHERE deleted.tenant_id = jobs.tenant_id
                       AND deleted.job_id = jobs.job_id
                       AND (
                            deleted.restored_at IS NULL
                            OR julianday(deleted.restored_at) <= julianday(deleted.deleted_at)
                       )
               )
               AND enrichment.full_description IS NOT NULL
               AND score.fit_score >= ?
               AND score.eligible_for_downstream = 1
               AND (score_stage.state IS NULL OR score_stage.state = 'succeeded')
               AND stale_score.job_id IS NULL
               AND (
                    COALESCE(tailor_stage.state, 'pending') = 'pending'
                    OR (
                        tailor_stage.state = 'blocked'
                        AND tailor_stage.error_code = 'SCORE_ELIGIBILITY_BLOCKED'
                        AND score.eligible_for_downstream = 1
                    )
               )
               AND COALESCE(tailor_stage.attempt_count, 0) < 5
               AND (
                    snapshots.latest_active_state IS NULL
                    OR snapshots.latest_active_state NOT IN (
                        'closed', 'expired', 'removed', 'location_incompatible'
                    )
               )
               AND (
                    snapshots.latest_confidence IS NULL
                    OR snapshots.latest_confidence != 'low'
                    OR snapshots.latest_quarantine_reason IS NULL
                    OR snapshots.latest_quarantine_reason IN ('none', '')
               )
               AND tailored_resume.artifact_id IS NULL
             ORDER BY score.fit_score DESC, jobs.discovered_at DESC, jobs.job_id
            """,
            (str(tenant_id), int(min_score)),
        ).fetchall()
    else:
        raise ValueError(f"unsupported preparation stage: {stage}")
    return [canonical_job_id(str(row["job_id"] if isinstance(row, sqlite3.Row) else row[0])) for row in rows]


def _target(
    *,
    tenant_id: TenantId,
    job_id: JobId,
    kind: PreparationWorkItemKind,
    target_version: int,
    source_event_id: str,
    steps: list[str],
) -> PreparationTarget:
    idempotency_key = make_preparation_idempotency_key(
        tenant_id=tenant_id,
        job_id=job_id,
        kind=kind,
        target_version=target_version,
        source_event_id=source_event_id,
    )
    return PreparationTarget(
        tenant_id=tenant_id,
        job_id=job_id,
        idempotency_key=idempotency_key,
        target_version=str(target_version),
        steps=list(steps),
    )


def _workflow_spec_for_target(
    target: PreparationTarget,
    *,
    tenant_id: TenantId,
    min_score: int,
    workers: int,
    validation_mode: str,
    llm_model: str | None,
    tailor_models: tuple[str, ...],
    tailor_judge_model: str | None,
    tailor_judge_min_score: float | None,
    discovery_execution: DiscoveryExecutionRef | None,
    discovery_cohort_kind: DiscoveryExecutionCohortKind,
) -> WorkflowStartSpec:
    if target.tenant_id != tenant_id:
        raise ValueError("preparation target tenant does not match workflow tenant")
    payload = JobPreparationInput(
        tenant_id=str(tenant_id),
        job_id=target.job_id,
        steps=list(target.steps),
        target_version=target.target_version,
        idempotency_key=target.idempotency_key,
        min_score=min_score,
        workers=workers,
        validation_mode=validation_mode,
        llm_model=llm_model or DEFAULT_PIPELINE_LLM_MODEL_SPEC,
        tailor_models=tailor_models,
        tailor_judge_model=tailor_judge_model,
        tailor_judge_min_score=tailor_judge_min_score,
        discovery_execution=discovery_execution,
        discovery_cohort_kind=(discovery_cohort_kind if discovery_execution is not None else None),
    )
    return WorkflowStartSpec(
        workflow=JobPreparationWorkflow,
        args=(payload,),
        workflow_id=preparation_workflow_id(target.idempotency_key),
        id_conflict_policy=WorkflowIDConflictPolicy.USE_EXISTING,
    )


def _record_preparation_work_plans(
    targets: list[PreparationTarget],
    *,
    tenant_id: TenantId,
    discovery_execution: DiscoveryExecutionRef,
    discovery_cohort_kind: DiscoveryExecutionCohortKind,
) -> dict[str, DiscoveryExecutionCohortKind]:
    """Persist selected work before asking Temporal to start it.

    Existing-backlog rows are created here because selection by the pre-run
    sweep defines membership. An observed fan-out may also derive a persistent
    enrichment backlog job that no source observed in this execution. Such a
    target is linked as existing backlog rather than inventing source metadata
    or attributing it to the current-execution cohort.
    """

    if str(tenant_id) != discovery_execution.tenant_id:
        raise ValueError("preparation tenant does not match discovery execution")
    repository = SqliteDiscoveryExecutionRepository(get_connection())
    workflow_cohorts_to_start: dict[str, DiscoveryExecutionCohortKind] = {}
    for target in targets:
        if discovery_cohort_kind == "existing_backlog":
            membership = repository.link_job(
                discovery_execution,
                target.job_id,
                cohort_kind="existing_backlog",
            )
        else:
            membership = repository.get(discovery_execution, target.job_id)
            if membership is None:
                membership = repository.link_job(
                    discovery_execution,
                    target.job_id,
                    cohort_kind="existing_backlog",
                )
        workflow_id = preparation_workflow_id(target.idempotency_key)
        canonical_steps = validate_required_steps(target.steps)
        if membership.work_plan_state in {"planned", "not_eligible"}:
            # A pre-run plan remains authoritative after backlog-to-observed
            # promotion. A later source event may derive a different idempotency
            # key, but it must neither rewrite nor start parallel work.
            if (
                membership.work_plan_state == "planned"
                and membership.preparation_workflow_id == workflow_id
                and membership.required_steps == canonical_steps
            ):
                workflow_cohorts_to_start[workflow_id] = membership.cohort_kind
            continue
        repository.set_work_plan(
            discovery_execution,
            target.job_id,
            state="planned",
            required_steps=target.steps,
            preparation_workflow_id=workflow_id,
        )
        workflow_cohorts_to_start[workflow_id] = membership.cohort_kind
    return workflow_cohorts_to_start


def _with_discovery_cohort(
    spec: WorkflowStartSpec,
    cohort_kind: DiscoveryExecutionCohortKind,
) -> WorkflowStartSpec:
    payload = spec.args[0]
    if not isinstance(payload, JobPreparationInput):
        raise TypeError("preparation workflow spec has an unexpected input")
    if payload.discovery_cohort_kind == cohort_kind:
        return spec
    return replace(
        spec,
        args=(replace(payload, discovery_cohort_kind=cohort_kind),),
    )


def _mark_pending_work_plans_failed(
    discovery_execution: DiscoveryExecutionRef,
    *,
    reason: str,
) -> None:
    repository = SqliteDiscoveryExecutionRepository(get_connection())
    for membership in repository.list_for_execution(discovery_execution):
        if membership.work_plan_state != "pending":
            continue
        repository.set_work_plan(
            discovery_execution,
            membership.job_id,
            state="failed",
            reason=reason,
        )


def _mark_job_work_plan_failed(
    discovery_execution: DiscoveryExecutionRef,
    *,
    job_id: JobId,
    reason: str,
) -> None:
    repository = SqliteDiscoveryExecutionRepository(get_connection())
    membership = repository.get(discovery_execution, job_id)
    if membership is None or membership.work_plan_state != "pending":
        return
    repository.set_work_plan(
        discovery_execution,
        job_id,
        state="failed",
        reason=reason,
    )


def _finalize_unplanned_observed_work_plans(
    discovery_execution: DiscoveryExecutionRef,
    *,
    min_score: int,
) -> None:
    """Close every unresolved current-cohort work-plan decision.

    Only canonical evidence can produce ``not_eligible``. Any unselected job
    whose lack of work cannot be proved becomes ``failed``; leaving it pending
    would make the execution drain forever and treating it as no-work would
    inflate completion.
    """

    conn = get_connection()
    repository = SqliteDiscoveryExecutionRepository(conn)
    for membership in repository.list_for_execution(discovery_execution):
        if membership.cohort_kind != "observed_this_run":
            continue
        if membership.work_plan_state not in {"pending", "failed"}:
            continue
        state, reason = _unselected_work_plan_outcome(
            conn,
            tenant_id=TenantId(discovery_execution.tenant_id),
            job_id=membership.job_id,
            min_score=min_score,
        )
        repository.set_work_plan(
            discovery_execution,
            membership.job_id,
            state=state,
            reason=reason,
        )


def _unselected_work_plan_outcome(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    job_id: JobId,
    min_score: int,
) -> tuple[DiscoveryExecutionWorkPlanState, str]:
    register_score_eligibility_sql(conn)
    row = conn.execute(
        f"""
        WITH {_LATEST_SCORES_CTE},
             {_LATEST_ACTIVE_MATERIALS_CTE}
        SELECT score.fit_score AS effective_score,
               COALESCE(score.eligible_for_downstream, 0) AS score_eligible,
               snapshots.latest_active_state AS active_state,
               resume_pdf.artifact_id IS NOT NULL AS has_resume_pdf,
               cover_pdf.artifact_id IS NOT NULL AS has_cover_pdf,
               EXISTS (
                    SELECT 1
                      FROM jobctrl_deleted_jobs deleted
                     WHERE deleted.tenant_id = jobs.tenant_id
                       AND deleted.job_id = jobs.job_id
                       AND (
                            deleted.restored_at IS NULL
                            OR julianday(deleted.restored_at) <= julianday(deleted.deleted_at)
                       )
               ) AS is_deleted
          FROM jobs
          LEFT JOIN latest_scores score
            ON score.tenant_id = jobs.tenant_id
           AND score.job_id = jobs.job_id
          LEFT JOIN posting_snapshot_sets snapshots
            ON snapshots.tenant_id = jobs.tenant_id
           AND snapshots.job_id = jobs.job_id
          LEFT JOIN latest_active_materials materials
            ON materials.tenant_id = jobs.tenant_id
           AND materials.job_id = jobs.job_id
          LEFT JOIN job_materials_artifacts resume_pdf
            ON resume_pdf.tenant_id = materials.tenant_id
           AND resume_pdf.job_id = materials.job_id
           AND resume_pdf.generation = materials.generation
           AND resume_pdf.artifact_type = 'resume_pdf'
           AND resume_pdf.status = 'approved'
          LEFT JOIN job_materials_artifacts cover_pdf
            ON cover_pdf.tenant_id = materials.tenant_id
           AND cover_pdf.job_id = materials.job_id
           AND cover_pdf.generation = materials.generation
           AND cover_pdf.artifact_type = 'cover_letter_pdf'
           AND cover_pdf.status = 'approved'
         WHERE jobs.tenant_id = ?
           AND jobs.job_id = ?
        """,
        (tenant_id, job_id),
    ).fetchone()
    if row is None:
        return ("failed", "canonical_job_missing")

    effective_score = row["effective_score"]
    if effective_score is not None and float(effective_score) < int(min_score):
        return ("not_eligible", "score_below_threshold")
    if effective_score is not None and not bool(row["score_eligible"]):
        return ("not_eligible", "score_eligibility_blocked")
    if bool(row["is_deleted"]):
        return ("not_eligible", "job_not_actionable")
    if str(row["active_state"] or "") in {"closed", "expired", "removed", "location_incompatible"}:
        return ("not_eligible", "posting_not_actionable")
    if bool(row["has_resume_pdf"]) and bool(row["has_cover_pdf"]):
        return ("not_eligible", "preparation_already_accounted")

    stage_rows = conn.execute(
        """
        SELECT stage, state
         FROM job_stage_states
         WHERE tenant_id = ?
           AND job_id = ?
           AND stage IN ('score', 'tailor', 'cover', 'apply')
        """,
        (tenant_id, job_id),
    ).fetchall()
    stage_states = {str(stage_row["stage"]): str(stage_row["state"]) for stage_row in stage_rows}
    if stage_states.get("apply") == "succeeded":
        return ("not_eligible", "preparation_already_accounted")
    if (
        stage_states.get("score") == "succeeded"
        and stage_states.get("tailor") == "skipped"
        and stage_states.get("cover") == "skipped"
    ):
        return ("not_eligible", "preparation_explicitly_skipped")
    return ("failed", "preparation_target_not_selected")


def _run_start_batch(specs: list[WorkflowStartSpec], starter: WorkflowStarter) -> list[WorkflowHandle]:
    return _run_coroutine(_start_batch(specs, starter))


async def _start_batch(specs: list[WorkflowStartSpec], starter: WorkflowStarter) -> list[WorkflowHandle]:
    return list(await asyncio.gather(*(starter(spec) for spec in specs)))


def _run_coroutine(coro: Coroutine[Any, Any, list[WorkflowHandle]]) -> list[WorkflowHandle]:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    # Synchronous enrichment callbacks can run inside a library-owned event
    # loop (for example while JobStreaming is active). The default starter
    # creates a fresh Temporal client for each invocation, so execute this
    # self-contained coroutine on a dedicated loop instead of rejecting the
    # per-job handoff and deferring all preparation to terminal reconciliation.
    with ThreadPoolExecutor(
        max_workers=1,
        thread_name_prefix="jobctrl-preparation-start",
    ) as executor:
        return executor.submit(asyncio.run, coro).result()


def _batches(items: list[WorkflowStartSpec], size: int) -> list[list[WorkflowStartSpec]]:
    return [items[index : index + size] for index in range(0, len(items), size)]


def _latest_source_event_id(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    job_id: JobId,
) -> str:
    row = conn.execute(
        """
        SELECT event_id
        FROM job_events
        WHERE tenant_id = ?
          AND job_id = ?
          AND event_type IN (
            'JobDiscovered',
            'JobUpdated',
            'JobEnriched',
            'PostingContentSnapshotCaptured',
            'StageCompleted'
          )
        ORDER BY event_id DESC
        LIMIT 1
        """,
        (tenant_id, job_id),
    ).fetchone()
    if row is None:
        return ""
    return str(row["event_id"] if isinstance(row, sqlite3.Row) else row[0])


def _suppress_ineligible_artifacts(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    min_score: int,
) -> int:
    suppressed = 0
    for job_id in _jobs_needing_artifact_suppression(
        conn,
        tenant_id=tenant_id,
        min_score=min_score,
    ):
        suppressed += _suppress_active_artifacts(
            conn,
            tenant_id=tenant_id,
            job_id=job_id,
            reason="threshold_or_hard_blocker_ineligible",
            suppressed_at=utc_now(),
        )
    return suppressed


def _suppress_active_artifacts(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    job_id: JobId,
    reason: str,
    suppressed_at: str,
) -> int:
    generation_row = conn.execute(
        f"""
        WITH {_LATEST_ACTIVE_MATERIALS_CTE}
        SELECT generation
          FROM latest_active_materials
         WHERE tenant_id = ?
           AND job_id = ?
        """,
        (str(tenant_id), str(job_id)),
    ).fetchone()
    generation = generation_row[0] if generation_row is not None else None
    if generation is None:
        return 0

    update_metadata = """
        json_set(
            CASE
                WHEN json_valid(metadata_json) AND json_type(metadata_json) = 'object'
                    THEN metadata_json
                ELSE '{}'
            END,
            '$.suppression',
            json_object('reason', ?, 'suppressed_at', ?)
        )
    """
    cursor = conn.execute(
        f"""
        UPDATE job_materials_artifacts
           SET status = 'suppressed',
               metadata_json = {update_metadata},
               superseded_at = NULL
         WHERE tenant_id = ?
           AND job_id = ?
           AND generation = ?
           AND status = 'approved'
        """,
        (reason, suppressed_at, str(tenant_id), str(job_id), generation),
    )
    if cursor.rowcount == 0:
        return 0
    conn.execute(
        f"""
        UPDATE job_materials
           SET metadata_json = {update_metadata},
               updated_at = ?
         WHERE tenant_id = ?
           AND job_id = ?
           AND generation = ?
        """,
        (reason, suppressed_at, suppressed_at, str(tenant_id), str(job_id), generation),
    )
    conn.commit()
    return 1


def _jobs_needing_artifact_suppression(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    min_score: int,
) -> list[JobId]:
    register_score_eligibility_sql(conn)
    rows = conn.execute(
        f"""
        WITH {_LATEST_SCORES_CTE},
             {_LATEST_ACTIVE_MATERIALS_CTE}
        SELECT jobs.job_id
        FROM jobs
        LEFT JOIN latest_scores score
          ON score.tenant_id = jobs.tenant_id
         AND score.job_id = jobs.job_id
        LEFT JOIN latest_active_materials materials
          ON materials.tenant_id = jobs.tenant_id
         AND materials.job_id = jobs.job_id
        LEFT JOIN job_materials_artifacts tailored_resume
          ON tailored_resume.tenant_id = materials.tenant_id
         AND tailored_resume.job_id = materials.job_id
         AND tailored_resume.generation = materials.generation
         AND tailored_resume.artifact_type = 'tailored_resume'
         AND tailored_resume.status = 'approved'
        WHERE jobs.tenant_id = ?
          AND tailored_resume.artifact_id IS NOT NULL
          AND (
            score.fit_score IS NULL
            OR score.fit_score < ?
            OR score.eligible_for_downstream = 0
          )
        ORDER BY jobs.discovered_at DESC, jobs.job_id
        """,
        (tenant_id, int(min_score)),
    ).fetchall()
    return [canonical_job_id(str(row["job_id"] if isinstance(row, sqlite3.Row) else row[0])) for row in rows]


__all__ = [
    "DerivePreparationTargetsInput",
    "PreparationTarget",
    "build_preparation_workflow_spec",
    "current_scoring_policy_version",
    "current_tailoring_policy_version",
    "derive_preparation_targets",
    "latest_source_event_id",
    "start_discovery_preparation_workflows",
    "start_job_preparation_workflow",
]
