"""Temporal-native preparation fan-out.

Discovery remains the user-facing preparation stage. This module now derives
deterministic per-job preparation targets and starts ``JobPreparationWorkflow``
executions instead of claiming a local work-item queue.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
from dataclasses import dataclass
from typing import Any, Coroutine

from temporalio import activity
from temporalio.client import WorkflowHandle
from temporalio.common import WorkflowIDConflictPolicy

from jobhunter import database as db_module
from jobhunter.database import get_connection, get_jobs_by_stage
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.materials.use_cases import SuppressTailoredArtifactsUseCase
from jobhunter.domain.preparation import PreparationWorkItemKind, make_preparation_idempotency_key
from jobhunter.domain.rpc.messages import WorkflowStartSpec
from jobhunter.domain.tenant import LOCAL_TENANT, TenantId
from jobhunter.infrastructure.materials import SqliteMaterialsRepository, SqliteTailoringPolicyRepository
from jobhunter.infrastructure.rpc.workflow_starter import (
    WorkflowStarter,
    default_workflow_starter,
)
from jobhunter.infrastructure.scoring import SqliteScoringPolicyRepository
from jobhunter.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC
from jobhunter.preparation.workflow import (
    JobPreparationInput,
    JobPreparationWorkflow,
    preparation_workflow_id,
)
from jobhunter.state import utc_now

log = logging.getLogger(__name__)

PREPARATION_CHILD_BATCH_SIZE = 25


@dataclass(frozen=True)
class PreparationTarget:
    job_url: str
    idempotency_key: str
    target_version: str
    steps: list[str]


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
) -> dict[str, Any]:
    """Derive targets and start per-job preparation workflows in batches."""
    targets = derive_preparation_targets(
        DerivePreparationTargetsInput(
            tenant_id=str(tenant_id),
            min_score=min_score,
            limit=limit,
            include_pending_tailor=include_pending_tailor,
        )
    )
    specs = [
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
        )
        for target in targets
    ]
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


def build_preparation_workflow_spec(
    *,
    tenant_id: TenantId,
    job_url: str,
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
) -> WorkflowStartSpec:
    source_event = source_event_id if source_event_id is not None else _latest_source_event_id(get_connection(), job_url)
    idempotency_key = make_preparation_idempotency_key(
        tenant_id=tenant_id,
        job_id=JobId(job_url),
        kind=kind,
        target_version=target_version,
        source_event_id=source_event,
    )
    payload = JobPreparationInput(
        tenant_id=str(tenant_id),
        job_url=job_url,
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


def latest_source_event_id(conn: sqlite3.Connection, job_url: str) -> str:
    return _latest_source_event_id(conn, job_url)


def _derive_targets(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    min_score: int,
    include_pending_tailor: bool = True,
) -> list[PreparationTarget]:
    score_target_version = current_scoring_policy_version(conn, tenant_id)
    targets: dict[str, PreparationTarget] = {}

    for job in get_jobs_by_stage(conn=conn, stage="pending_score", limit=0):
        job_url = str(job["url"])
        targets[job_url] = _target(
            tenant_id=tenant_id,
            job_url=job_url,
            kind=PreparationWorkItemKind.SCORE_JOB,
            target_version=score_target_version,
            source_event_id=_latest_source_event_id(conn, job_url),
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
        for job in get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=min_score, limit=0):
            job_url = str(job["url"])
            if job_url in targets:
                continue
            targets[job_url] = _target(
                tenant_id=tenant_id,
                job_url=job_url,
                kind=PreparationWorkItemKind.TAILOR_RESUME,
                target_version=tailoring_target_version,
                source_event_id=_latest_source_event_id(conn, job_url),
                steps=["tailor", "cover", "pdf"],
            )

    return [targets[job_url] for job_url in sorted(targets)]


def _target(
    *,
    tenant_id: TenantId,
    job_url: str,
    kind: PreparationWorkItemKind,
    target_version: int,
    source_event_id: str,
    steps: list[str],
) -> PreparationTarget:
    idempotency_key = make_preparation_idempotency_key(
        tenant_id=tenant_id,
        job_id=JobId(job_url),
        kind=kind,
        target_version=target_version,
        source_event_id=source_event_id,
    )
    return PreparationTarget(
        job_url=job_url,
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
) -> WorkflowStartSpec:
    payload = JobPreparationInput(
        tenant_id=str(tenant_id),
        job_url=target.job_url,
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
    )
    return WorkflowStartSpec(
        workflow=JobPreparationWorkflow,
        args=(payload,),
        workflow_id=preparation_workflow_id(target.idempotency_key),
        id_conflict_policy=WorkflowIDConflictPolicy.USE_EXISTING,
    )


def _run_start_batch(specs: list[WorkflowStartSpec], starter: WorkflowStarter) -> list[WorkflowHandle]:
    return _run_coroutine(_start_batch(specs, starter))


async def _start_batch(specs: list[WorkflowStartSpec], starter: WorkflowStarter) -> list[WorkflowHandle]:
    return list(await asyncio.gather(*(starter(spec) for spec in specs)))


def _run_coroutine(coro: Coroutine[Any, Any, list[WorkflowHandle]]) -> list[WorkflowHandle]:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    raise RuntimeError("preparation workflow fan-out cannot run inside an active event loop")


def _batches(items: list[WorkflowStartSpec], size: int) -> list[list[WorkflowStartSpec]]:
    return [items[index : index + size] for index in range(0, len(items), size)]


def _latest_source_event_id(conn: sqlite3.Connection, job_url: str) -> str:
    row = conn.execute(
        """
        SELECT event_id
        FROM job_events
        WHERE job_url = ?
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
        (job_url,),
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
    use_case = SuppressTailoredArtifactsUseCase(repository=SqliteMaterialsRepository(conn))
    suppressed = 0
    for job_id in _jobs_needing_artifact_suppression(conn, min_score=min_score):
        outcome = use_case.execute(
            tenant_id=tenant_id,
            job_id=job_id,
            reason="threshold_or_hard_blocker_ineligible",
            suppressed_at=utc_now(),
        )
        suppressed += int(outcome.suppressed)
    return suppressed


def _jobs_needing_artifact_suppression(
    conn: sqlite3.Connection,
    *,
    min_score: int,
) -> list[JobId]:
    rows = conn.execute(
        f"""
        SELECT jobs.url
        FROM jobs
        {db_module._LATEST_SCORE_JOIN}
        {db_module._LATEST_MATERIALS_JOIN}
        WHERE {db_module._EFFECTIVE_TAILOR_PATH} IS NOT NULL
          AND (
            {db_module._EFFECTIVE_FIT_SCORE} IS NULL
            OR {db_module._EFFECTIVE_FIT_SCORE} < ?
            OR NOT {db_module._SCORE_ELIGIBLE_FOR_DOWNSTREAM}
          )
        ORDER BY jobs.discovered_at DESC
        """,
        (int(min_score),),
    ).fetchall()
    return [JobId(str(row["url"] if isinstance(row, sqlite3.Row) else row[0])) for row in rows]


__all__ = [
    "DerivePreparationTargetsInput",
    "PreparationTarget",
    "build_preparation_workflow_spec",
    "current_scoring_policy_version",
    "current_tailoring_policy_version",
    "derive_preparation_targets",
    "latest_source_event_id",
    "start_discovery_preparation_workflows",
]
