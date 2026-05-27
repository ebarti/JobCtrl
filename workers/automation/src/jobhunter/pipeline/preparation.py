"""Internal Discovery preparation orchestration.

Discovery remains the user-facing preparation stage. This module owns the
durable internal queue glue that turns enriched jobs into scoring, tailoring,
or suppression work without merging the Scoring and Materials contexts.
"""

from __future__ import annotations

import logging
import sqlite3
from collections import defaultdict
from typing import Any, Callable

from jobhunter import database as db_module
from jobhunter.database import get_connection, get_jobs_by_stage
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.materials.use_cases import SuppressTailoredArtifactsUseCase
from jobhunter.domain.preparation import PreparationWorkItem, PreparationWorkItemKind
from jobhunter.domain.tenant import LOCAL_TENANT, TenantId
from jobhunter.infrastructure.materials import SqliteMaterialsRepository, SqliteTailoringPolicyRepository
from jobhunter.infrastructure.preparation import SqlitePreparationWorkItemRepository
from jobhunter.infrastructure.scoring import SqliteScoringPolicyRepository
from jobhunter.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC
from jobhunter.state import record_job_event, utc_now

log = logging.getLogger(__name__)

WorkItemProcessor = Callable[[PreparationWorkItem], dict[str, Any]]


def drain_discovery_preparation(
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
) -> dict[str, Any]:
    """Enqueue and drain internal Discovery preparation work.

    The orchestration is intentionally bounded: each run enqueues work from
    current read-model selectors, then claims durable items until the queue is
    empty or the caller's limit is reached.
    """
    conn = get_connection()
    repo = SqlitePreparationWorkItemRepository(conn)
    stats = _new_stats()

    score_target_version = _current_scoring_policy_version(conn, tenant_id)
    _enqueue_pending_scores(
        conn=conn,
        repo=repo,
        stats=stats,
        tenant_id=tenant_id,
        target_version=score_target_version,
    )
    _drain_kind(
        conn=conn,
        repo=repo,
        stats=stats,
        tenant_id=tenant_id,
        kind=PreparationWorkItemKind.SCORE_JOB,
        limit=limit,
        processor=lambda item: _score_item(
            item,
            llm_model=llm_model,
            tenant_id=tenant_id,
        ),
    )

    tailoring_target_version = _current_tailoring_policy_version(conn, tenant_id)
    _recompute_tailoring_eligibility(
        conn=conn,
        repo=repo,
        stats=stats,
        tenant_id=tenant_id,
        min_score=min_score,
        target_version=tailoring_target_version,
    )
    _drain_kind(
        conn=conn,
        repo=repo,
        stats=stats,
        tenant_id=tenant_id,
        kind=PreparationWorkItemKind.SUPPRESS_TAILORED_ARTIFACTS,
        limit=limit,
        processor=lambda item: _suppress_item(item, conn=conn, tenant_id=tenant_id),
    )
    _drain_kind(
        conn=conn,
        repo=repo,
        stats=stats,
        tenant_id=tenant_id,
        kind=PreparationWorkItemKind.TAILOR_RESUME,
        limit=limit,
        processor=lambda item: _tailor_item(
            item,
            min_score=min_score,
            validation_mode=validation_mode,
            workers=workers,
            llm_model=llm_model,
            tailor_models=tailor_models,
            tailor_judge_model=tailor_judge_model,
            tailor_judge_min_score=tailor_judge_min_score,
            tenant_id=tenant_id,
        ),
    )

    return _finalize_stats(stats)


def _new_stats() -> dict[str, Any]:
    return {
        "queued": defaultdict(int),
        "started": defaultdict(int),
        "completed": defaultdict(int),
        "failed": defaultdict(int),
        "skipped": defaultdict(int),
        "errors": {},
    }


def _finalize_stats(stats: dict[str, Any]) -> dict[str, Any]:
    materialized = {
        key: dict(value) if isinstance(value, defaultdict) else value
        for key, value in stats.items()
    }
    failed = sum(materialized["failed"].values())
    total = sum(
        sum(materialized[key].values())
        for key in ("queued", "started", "completed", "failed", "skipped")
    )
    materialized["status"] = "partial" if failed else "ok"
    materialized["has_work"] = total > 0
    return materialized


def _enqueue_pending_scores(
    *,
    conn: sqlite3.Connection,
    repo: SqlitePreparationWorkItemRepository,
    stats: dict[str, Any],
    tenant_id: TenantId,
    target_version: int,
) -> None:
    for job in get_jobs_by_stage(conn=conn, stage="pending_score", limit=0):
        job_id = JobId(str(job["url"]))
        source_event_id = _latest_source_event_id(conn, str(job_id))
        if _retry_failed_item(
            conn,
            repo,
            stats,
            tenant_id,
            job_id,
            PreparationWorkItemKind.SCORE_JOB,
            target_version,
            source_event_id,
        ):
            continue
        if _has_incomplete_item(
            conn,
            tenant_id,
            job_id,
            PreparationWorkItemKind.SCORE_JOB,
            target_version,
            source_event_id,
        ):
            continue
        item = repo.enqueue(
            tenant_id=tenant_id,
            job_id=job_id,
            kind=PreparationWorkItemKind.SCORE_JOB,
            target_version=target_version,
            source_event_id=source_event_id,
        )
        stats["queued"][item.kind.value] += 1
        _record_work_item_event(conn, item, "PreparationWorkItemQueued", "Score work item queued")


def _recompute_tailoring_eligibility(
    *,
    conn: sqlite3.Connection,
    repo: SqlitePreparationWorkItemRepository,
    stats: dict[str, Any],
    tenant_id: TenantId,
    min_score: int,
    target_version: int,
) -> None:
    for job in get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=min_score, limit=0):
        job_id = JobId(str(job["url"]))
        source_event_id = _latest_source_event_id(conn, str(job_id))
        if _retry_failed_item(
            conn,
            repo,
            stats,
            tenant_id,
            job_id,
            PreparationWorkItemKind.TAILOR_RESUME,
            target_version,
            source_event_id,
        ):
            continue
        if _has_incomplete_item(
            conn,
            tenant_id,
            job_id,
            PreparationWorkItemKind.TAILOR_RESUME,
            target_version,
            source_event_id,
        ):
            continue
        item = repo.enqueue(
            tenant_id=tenant_id,
            job_id=job_id,
            kind=PreparationWorkItemKind.TAILOR_RESUME,
            target_version=target_version,
            source_event_id=source_event_id,
        )
        stats["queued"][item.kind.value] += 1
        _record_work_item_event(conn, item, "PreparationWorkItemQueued", "Tailor work item queued")

    for job_id, source_event_id in _jobs_needing_artifact_suppression(
        conn,
        min_score=min_score,
    ):
        if _retry_failed_item(
            conn,
            repo,
            stats,
            tenant_id,
            job_id,
            PreparationWorkItemKind.SUPPRESS_TAILORED_ARTIFACTS,
            min_score,
            source_event_id,
        ):
            continue
        if _has_incomplete_item(
            conn,
            tenant_id,
            job_id,
            PreparationWorkItemKind.SUPPRESS_TAILORED_ARTIFACTS,
            min_score,
            source_event_id,
        ):
            continue
        item = repo.enqueue(
            tenant_id=tenant_id,
            job_id=job_id,
            kind=PreparationWorkItemKind.SUPPRESS_TAILORED_ARTIFACTS,
            target_version=min_score,
            source_event_id=source_event_id,
        )
        stats["queued"][item.kind.value] += 1
        _record_work_item_event(
            conn,
            item,
            "PreparationWorkItemQueued",
            "Artifact suppression work item queued",
            payload={"reason": "threshold_or_hard_blocker_ineligible"},
        )


def _drain_kind(
    *,
    conn: sqlite3.Connection,
    repo: SqlitePreparationWorkItemRepository,
    stats: dict[str, Any],
    tenant_id: TenantId,
    kind: PreparationWorkItemKind,
    limit: int,
    processor: WorkItemProcessor,
) -> None:
    processed = 0
    while limit <= 0 or processed < limit:
        item = repo.claim_next(tenant_id=tenant_id, kind=kind)
        if item is None:
            return
        processed += 1
        stats["started"][kind.value] += 1
        _record_work_item_event(conn, item, "PreparationWorkItemStarted", f"{kind.value} work item started")
        try:
            result = processor(item)
        except Exception as exc:  # noqa: BLE001 - failed work item must stay durable
            log.exception("Preparation work item %s failed", item.item_id)
            repo.fail(tenant_id=tenant_id, item_id=item.item_id, error=str(exc))
            stats["failed"][kind.value] += 1
            stats["errors"][item.item_id] = str(exc)
            _record_work_item_event(
                conn,
                item,
                "PreparationWorkItemFailed",
                f"{kind.value} work item failed",
                level="error",
                payload={"error": str(exc)},
            )
            continue

        repo.complete(tenant_id=tenant_id, item_id=item.item_id)
        if result.get("skipped"):
            stats["skipped"][kind.value] += 1
        else:
            stats["completed"][kind.value] += 1
        _record_work_item_event(
            conn,
            item,
            "PreparationWorkItemCompleted",
            f"{kind.value} work item completed",
            payload=result,
        )


def _score_item(
    item: PreparationWorkItem,
    *,
    llm_model: str | None,
    tenant_id: TenantId,
) -> dict[str, Any]:
    from jobhunter.scoring.scorer import score_job_by_url

    outcome = score_job_by_url(str(item.job_id), llm_model=llm_model, tenant_id=tenant_id)
    if not outcome.ok:
        raise RuntimeError(outcome.error or "Scoring failed")
    return {"scoreVersion": outcome.score.version if outcome.score else None}


def _tailor_item(
    item: PreparationWorkItem,
    *,
    min_score: int,
    validation_mode: str,
    workers: int,
    llm_model: str | None,
    tailor_models: tuple[str, ...],
    tailor_judge_model: str | None,
    tailor_judge_min_score: float | None,
    tenant_id: TenantId,
) -> dict[str, Any]:
    from jobhunter.scoring.tailor import tailor_job_by_url

    result = tailor_job_by_url(
        str(item.job_id),
        min_score=min_score,
        validation_mode=validation_mode,
        workers=workers,
        llm_model=llm_model,
        tailor_models=tailor_models,
        tailor_judge_model=tailor_judge_model,
        tailor_judge_min_score=tailor_judge_min_score,
        tenant_id=tenant_id,
    )
    if result.get("status") in {"skipped", "not_eligible"}:
        return {"skipped": True, "reason": result.get("reason", "not_eligible")}
    if result.get("status") != "approved":
        raise RuntimeError(str(result.get("error") or f"Tailoring ended with status {result.get('status')}"))
    return {
        "materialsGeneration": getattr(result.get("materials"), "generation", None),
        "status": result.get("status"),
    }


def _suppress_item(
    item: PreparationWorkItem,
    *,
    conn: sqlite3.Connection,
    tenant_id: TenantId,
) -> dict[str, Any]:
    use_case = SuppressTailoredArtifactsUseCase(repository=SqliteMaterialsRepository(conn))
    outcome = use_case.execute(
        tenant_id=tenant_id,
        job_id=item.job_id,
        reason="threshold_or_hard_blocker_ineligible",
        suppressed_at=utc_now(),
    )
    return {
        "suppressed": outcome.suppressed,
        "skipped": not outcome.suppressed,
        "reason": "no_active_artifacts" if not outcome.suppressed else "threshold_or_hard_blocker_ineligible",
    }


def _current_scoring_policy_version(conn: sqlite3.Connection, tenant_id: TenantId) -> int:
    return SqliteScoringPolicyRepository(conn).get_current(tenant_id).version


def _current_tailoring_policy_version(conn: sqlite3.Connection, tenant_id: TenantId) -> int:
    policy = SqliteTailoringPolicyRepository(conn).get_current(tenant_id)
    return policy.version if policy is not None else 1


def _has_incomplete_item(
    conn: sqlite3.Connection,
    tenant_id: TenantId,
    job_id: JobId,
    kind: PreparationWorkItemKind,
    target_version: int,
    source_event_id: str,
) -> bool:
    row = conn.execute(
        """
        SELECT 1
        FROM preparation_work_items
        WHERE tenant_id = ?
          AND job_id = ?
          AND kind = ?
          AND target_version = ?
          AND source_event_id = ?
          AND state IN ('queued', 'running', 'failed')
        LIMIT 1
        """,
        (str(tenant_id), str(job_id), kind.value, int(target_version), str(source_event_id or "")),
    ).fetchone()
    return row is not None


def _retry_failed_item(
    conn: sqlite3.Connection,
    repo: SqlitePreparationWorkItemRepository,
    stats: dict[str, Any],
    tenant_id: TenantId,
    job_id: JobId,
    kind: PreparationWorkItemKind,
    target_version: int,
    source_event_id: str,
) -> bool:
    now = utc_now()
    row = conn.execute(
        """
        SELECT item_id
        FROM preparation_work_items
        WHERE tenant_id = ?
          AND job_id = ?
          AND kind = ?
          AND target_version = ?
          AND source_event_id = ?
          AND state = 'failed'
          AND available_at <= ?
        LIMIT 1
        """,
        (str(tenant_id), str(job_id), kind.value, int(target_version), str(source_event_id or ""), now),
    ).fetchone()
    if row is None:
        return False
    item_id = str(row["item_id"] if isinstance(row, sqlite3.Row) else row[0])
    item = repo.retry(tenant_id=tenant_id, item_id=item_id, available_at=now, retried_at=now)
    if item is None:
        return False
    stats["queued"][item.kind.value] += 1
    _record_work_item_event(
        conn,
        item,
        "PreparationWorkItemQueued",
        f"{kind.value} work item requeued",
        payload={"retry": True},
    )
    return True


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


def _jobs_needing_artifact_suppression(
    conn: sqlite3.Connection,
    *,
    min_score: int,
) -> list[tuple[JobId, str]]:
    rows = conn.execute(
        f"""
        SELECT jobs.url,
               jm.jm_generation AS materials_generation,
               jm.jm_tailored_path AS materials_tailored_path,
               jm.jm_cover_path AS materials_cover_path,
               jm.jm_resume_pdf_path AS materials_resume_pdf_path,
               jm.jm_cover_pdf_path AS materials_cover_pdf_path,
               jobs.tailored_resume_path AS legacy_tailored_path,
               jobs.cover_letter_path AS legacy_cover_path
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
    result: list[tuple[JobId, str]] = []
    for row in rows:
        record = dict(row) if isinstance(row, sqlite3.Row) else {
            "url": row[0],
            "materials_generation": row[1],
            "materials_tailored_path": row[2],
            "materials_cover_path": row[3],
            "materials_resume_pdf_path": row[4],
            "materials_cover_pdf_path": row[5],
            "legacy_tailored_path": row[6],
            "legacy_cover_path": row[7],
        }
        job_id = JobId(str(record["url"]))
        result.append((job_id, _artifact_suppression_source_event_id(record, min_score=min_score)))
    return result


def _artifact_suppression_source_event_id(record: dict[str, Any], *, min_score: int) -> str:
    generation = record.get("materials_generation")
    if generation is not None:
        paths = (
            record.get("materials_tailored_path") or "",
            record.get("materials_cover_path") or "",
            record.get("materials_resume_pdf_path") or "",
            record.get("materials_cover_pdf_path") or "",
        )
        return f"threshold:{min_score}:materials:g{generation}:{':'.join(paths)}"
    return (
        f"threshold:{min_score}:legacy:"
        f"{record.get('legacy_tailored_path') or ''}:"
        f"{record.get('legacy_cover_path') or ''}"
    )


def _record_work_item_event(
    conn: sqlite3.Connection,
    item: PreparationWorkItem,
    event_type: str,
    message: str,
    *,
    level: str = "info",
    payload: dict[str, Any] | None = None,
) -> None:
    event_payload = {
        "tenantId": str(item.tenant_id),
        "jobId": str(item.job_id),
        "itemId": item.item_id,
        "kind": item.kind.value,
        "targetVersion": item.target_version,
        "sourceEventId": item.source_event_id,
        **(payload or {}),
    }
    record_job_event(
        conn,
        str(item.job_id),
        _stage_for_kind(item.kind),
        event_type,
        level=level,
        message=message,
        payload=event_payload,
    )
    conn.commit()


def _stage_for_kind(kind: PreparationWorkItemKind) -> str:
    if kind is PreparationWorkItemKind.SCORE_JOB:
        return "score"
    return "tailor"


__all__ = ["drain_discovery_preparation"]
