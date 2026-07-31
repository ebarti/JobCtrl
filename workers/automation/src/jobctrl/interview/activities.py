"""Temporal activity adapter for Interview Preparation generation."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from typing import Any

from temporalio import activity

from jobctrl.database import get_connection
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.interview import GenerateInterviewPrepUseCase
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.interview import SqliteInterviewPrepRepository
from jobctrl.infrastructure.llm import LlmAdapter, get_llm_adapter
from jobctrl.infrastructure.preparation import SqlitePreparationTargetReader
from jobctrl.infrastructure.profile import get_profile_repository
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
from jobctrl.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC
from jobctrl.state import record_job_event


@dataclass(frozen=True)
class GenerateInterviewPrepActivityInput:
    tenant_id: str
    job_id: JobId
    llm_model: str = DEFAULT_PIPELINE_LLM_MODEL_SPEC

    def __post_init__(self) -> None:
        object.__setattr__(self, "job_id", canonical_job_id(str(self.job_id)))


@dataclass(frozen=True)
class GenerateInterviewPrepActivityOutput:
    status: str
    job_id: JobId
    generation: int
    item_count: int
    errors: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "job_id", canonical_job_id(str(self.job_id)))

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "jobId": str(self.job_id),
            "generation": self.generation,
            "itemCount": self.item_count,
            "errors": list(self.errors),
        }


@activity.defn(name="generate_interview_prep")
async def generate_interview_prep_activity(
    payload: GenerateInterviewPrepActivityInput,
) -> GenerateInterviewPrepActivityOutput:
    from jobctrl.infrastructure.temporal.run_in_activity import run_blocking_with_heartbeat

    # Generation is a blocking DB + projection-refresh + two-LLM-call runner.
    # Offloading it to the worker thread pool keeps heartbeats flowing (so a
    # long generation never trips the heartbeat timeout) and stops it from
    # starving the shared event loop. ``workflow_run_id`` makes a retried
    # attempt reuse this run's already-generated prep instead of re-spending.
    origin_run_id = activity.info().workflow_run_id
    return await run_blocking_with_heartbeat(
        lambda: generate_interview_prep_by_job_id(
            payload.job_id,
            tenant_id=TenantId(payload.tenant_id or LOCAL_TENANT),
            llm_model=payload.llm_model,
            origin_run_id=origin_run_id,
        ),
        starting_message="interview-prep starting",
        progress_message="interview-prep still running",
        activity_name="generate_interview_prep",
    )


def generate_interview_prep_by_job_id(
    job_id: JobId,
    *,
    tenant_id: TenantId = LOCAL_TENANT,
    llm_model: str | None = DEFAULT_PIPELINE_LLM_MODEL_SPEC,
    origin_run_id: str = "",
) -> GenerateInterviewPrepActivityOutput:
    conn = get_connection()
    stable_job_id = canonical_job_id(str(job_id))
    job = SqlitePreparationTargetReader(conn).load(tenant_id, stable_job_id)
    if job is None:
        raise ValueError(f"unknown or inactive jobId: {stable_job_id}")

    ProjectionBuilder(conn_factory=lambda: conn, tenant_id=tenant_id).refresh()
    profile_snapshot = get_profile_repository().load_snapshot(tenant_id)
    llm = LlmAdapter(default_model=llm_model) if llm_model else get_llm_adapter()
    repository = SqliteInterviewPrepRepository(conn)
    use_case = GenerateInterviewPrepUseCase(
        repository=repository,
        llm=llm,
        publisher=InterviewPrepEventRecorder(conn),
    )
    outcome = use_case.execute(
        tenant_id=tenant_id,
        job=job,
        profile_snapshot=profile_snapshot,
        evidence_entries=_load_evidence_entries(conn, tenant_id, stable_job_id),
        evidence_gaps=_load_evidence_gaps(conn, tenant_id, stable_job_id),
        requirements=_load_requirements(conn, tenant_id, stable_job_id),
        accepted_materials=_load_accepted_materials(conn, tenant_id, stable_job_id),
        model=llm_model,
        origin_run_id=origin_run_id,
    )
    return GenerateInterviewPrepActivityOutput(
        status=outcome.status,
        job_id=stable_job_id,
        generation=outcome.prep.generation,
        item_count=len(outcome.prep.items),
        errors=outcome.errors,
    )


class InterviewPrepEventRecorder:
    """Persist safe InterviewPrep events into ``job_events``."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def publish(self, event) -> None:  # noqa: ANN001 - DomainEvent duck type
        event_type = getattr(event, "event_type", "")
        if event_type not in {"InterviewPrepGenerated", "InterviewPrepFailed"}:
            return
        payload = dict(getattr(event, "payload", {}) or {})
        raw_job_id = payload.get("job_id")
        if not raw_job_id:
            return
        job_id = canonical_job_id(str(raw_job_id))
        generation = payload.get("generation")
        if event_type == "InterviewPrepGenerated":
            message = f"Interview prep generation {generation} accepted"
            safe_payload = {
                "generation": generation,
                "item_count": payload.get("item_count"),
                "itemCount": payload.get("item_count"),
                "generated_at": payload.get("generated_at"),
                "generatedAt": payload.get("generated_at"),
            }
        else:
            message = f"Interview prep generation {generation} failed"
            safe_payload = {
                "generation": generation,
                "failed_at": payload.get("failed_at"),
                "failedAt": payload.get("failed_at"),
                "reason_count": payload.get("reason_count"),
                "reasonCount": payload.get("reason_count"),
            }
        record_job_event(
            self._conn,
            job_id,
            "interview_prep",
            event_type,
            tenant_id=event.tenant_id,
            message=message,
            payload=safe_payload,
        )
        self._conn.commit()

    def subscribe(self, event_type, handler):  # noqa: ANN001 - protocol completeness
        raise NotImplementedError("InterviewPrepEventRecorder is publish-only")


def _load_evidence_entries(
    conn: sqlite3.Connection,
    tenant_id: TenantId,
    job_id: JobId,
) -> tuple[dict[str, Any], ...]:
    rows = _evidence_projection_rows(conn, tenant_id, "entry")
    entries = [_payload(row) for row in rows]
    entries = [entry for entry in entries if entry]
    entries.sort(key=lambda entry: _entry_rank(entry, job_id), reverse=True)
    return tuple(entries[:12])


def _load_evidence_gaps(
    conn: sqlite3.Connection,
    tenant_id: TenantId,
    job_id: JobId,
) -> tuple[dict[str, Any], ...]:
    rows = _evidence_projection_rows(conn, tenant_id, "gap")
    gaps = [_payload(row) for row in rows]
    job_gaps = [
        gap
        for gap in gaps
        if any(
            isinstance(ref, dict) and ref.get("jobId") == job_id
            for ref in gap.get("jobRefs", [])
        )
    ]
    return tuple(job_gaps[:12])


def _evidence_projection_rows(
    conn: sqlite3.Connection,
    tenant_id: TenantId,
    projection_kind: str,
) -> list[sqlite3.Row]:
    try:
        return list(
            conn.execute(
                """
                SELECT payload_json FROM evidence_usage_projections
                WHERE tenant_id = ? AND projection_kind = ?
                ORDER BY LOWER(title), projection_id
                """,
                (str(tenant_id), projection_kind),
            ).fetchall()
        )
    except sqlite3.OperationalError:
        return []


def _payload(row: sqlite3.Row) -> dict[str, Any]:
    try:
        parsed = json.loads(row["payload_json"] or "{}")
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _entry_rank(entry: dict[str, Any], job_id: JobId) -> tuple[int, int, int]:
    usages = [
        *(entry.get("resumeUsages") or ()),
        *(entry.get("requirementUsages") or ()),
        *(entry.get("coverageUsages") or ()),
    ]
    matching = sum(1 for usage in usages if isinstance(usage, dict) and usage.get("jobId") == job_id)
    confirmed = 1 if (entry.get("freshness") or {}).get("userConfirmed") else 0
    return (matching, len(usages), confirmed)


def _load_requirements(
    conn: sqlite3.Connection,
    tenant_id: TenantId,
    job_id: JobId,
) -> tuple[dict[str, Any], ...]:
    try:
        rows = conn.execute(
            """
            SELECT requirement_id, requirement_text, tier, weight, fit_json
            FROM job_requirement_fit_items
            WHERE tenant_id = ?
              AND job_id = ?
              AND score_version = (
                SELECT MAX(score_version)
                FROM job_requirement_fit_reports
                WHERE tenant_id = ? AND job_id = ?
              )
            ORDER BY position, requirement_id
            """,
            (str(tenant_id), str(job_id), str(tenant_id), str(job_id)),
        ).fetchall()
    except sqlite3.OperationalError:
        return ()
    requirements: list[dict[str, Any]] = []
    for row in rows:
        fit = _load_json(row["fit_json"])
        requirements.append(
            {
                "requirementId": row["requirement_id"],
                "requirementText": row["requirement_text"],
                "tier": row["tier"],
                "weight": row["weight"],
                "fitKind": fit.get("kind") if isinstance(fit, dict) else None,
                "evidenceIds": fit.get("evidenceIds", []) if isinstance(fit, dict) else [],
            }
        )
    return tuple(requirements)


def _load_accepted_materials(
    conn: sqlite3.Connection,
    tenant_id: TenantId,
    job_id: JobId,
) -> tuple[dict[str, Any], ...]:
    try:
        rows = conn.execute(
            """
            SELECT bullet_id, artifact_id, generation, evidence_ids_json,
                   requirement_ids_json, generated_text, position
            FROM job_bullet_provenance
            WHERE tenant_id = ?
              AND job_id = ?
              AND generation = (
                SELECT MAX(generation)
                FROM job_bullet_provenance
                WHERE tenant_id = ? AND job_id = ?
              )
            ORDER BY position, bullet_id
            """,
            (str(tenant_id), str(job_id), str(tenant_id), str(job_id)),
        ).fetchall()
    except sqlite3.OperationalError:
        return ()
    return tuple(
        {
            "bulletId": row["bullet_id"],
            "artifactId": row["artifact_id"],
            "generation": row["generation"],
            "evidenceIds": _load_json_list(row["evidence_ids_json"]),
            "requirementIds": _load_json_list(row["requirement_ids_json"]),
            "generatedText": row["generated_text"],
        }
        for row in rows
    )


def _load_json(value: str | None) -> dict[str, Any]:
    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _load_json_list(value: str | None) -> list[str]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return []
    if not isinstance(parsed, list):
        return []
    return [str(item) for item in parsed]


__all__ = [
    "GenerateInterviewPrepActivityInput",
    "GenerateInterviewPrepActivityOutput",
    "generate_interview_prep_activity",
    "generate_interview_prep_by_job_id",
]
