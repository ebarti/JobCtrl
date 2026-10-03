"""Temporal activity adapter for Interview Preparation generation."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from temporalio import activity
from temporalio.exceptions import ApplicationError

from jobctrl.database import get_connection
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.interview import GenerateInterviewPrepUseCase
from jobctrl.domain.interview.evidence import InterviewEvidenceSnapshot
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.interview.catalog import InterviewSelectionError, load_interview_catalog, validate_interview_selection
from jobctrl.domain.interview.preparation import choose_questions, job_context_snapshot, normalize_selection, plan_evidence
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.interview import SqliteInterviewPrepRepository
from jobctrl.infrastructure.llm import LlmAdapter, get_llm_adapter
from jobctrl.infrastructure.materials.sqlite_repository import SqliteMaterialsRepository
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
    selection: dict[str, Any] | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "job_id", canonical_job_id(str(self.job_id)))
        object.__setattr__(self, "selection", normalize_selection(self.selection))


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
    try:
        return await run_blocking_with_heartbeat(
            lambda: generate_interview_prep_by_job_id(
                payload.job_id,
                tenant_id=TenantId(payload.tenant_id or LOCAL_TENANT),
                llm_model=payload.llm_model,
                origin_run_id=origin_run_id,
                **({"selection": payload.selection} if payload.selection else {}),
            ),
            starting_message="interview-prep starting",
            progress_message="interview-prep still running",
            activity_name="generate_interview_prep",
        )
    except InterviewSelectionError as exc:
        raise ApplicationError(str(exc), type=exc.code, non_retryable=True) from exc


def generate_interview_prep_by_job_id(
    job_id: JobId,
    *,
    tenant_id: TenantId = LOCAL_TENANT,
    llm_model: str | None = DEFAULT_PIPELINE_LLM_MODEL_SPEC,
    origin_run_id: str = "",
    selection: dict[str, Any] | None = None,
) -> GenerateInterviewPrepActivityOutput:
    conn = get_connection()
    stable_job_id = canonical_job_id(str(job_id))
    job = SqlitePreparationTargetReader(conn).load(tenant_id, stable_job_id)
    if job is None:
        raise ValueError(f"unknown or inactive jobId: {stable_job_id}")

    repository = SqliteInterviewPrepRepository(conn)
    if origin_run_id:
        existing = repository.find_completed_for_run(tenant_id, stable_job_id, origin_run_id)
        if existing is not None:
            return GenerateInterviewPrepActivityOutput(status="failed" if existing.status == "failed" else "accepted",
                                                       job_id=stable_job_id, generation=existing.generation,
                                                       item_count=len(existing.items))
    catalog = load_interview_catalog()
    selection = normalize_selection(selection)
    if "selectedQuestionIds" in selection:
        validate_interview_selection(selection["selectedQuestionIds"], catalog_binding=selection.get("catalogBinding"), catalog=catalog)
    ProjectionBuilder(conn_factory=lambda: conn, tenant_id=tenant_id).refresh()
    profile_snapshot = get_profile_repository().load_snapshot(tenant_id)
    employer_context, fit_context, requirements = _load_employer_and_fit_context(
        conn, tenant_id, stable_job_id, profile_snapshot.version,
        current_job_hash=job_context_snapshot(job)["snapshotHash"],
    )
    cards, checked_selection = choose_questions(catalog, selection, requirements)
    if profile_snapshot.tenant_id != tenant_id:
        raise ValueError("profile snapshot belongs to another tenant")
    canonical_evidence = _load_canonical_evidence(conn, tenant_id, profile_snapshot)
    plan_evidence(cards, profile_snapshot, checked_selection, requirements, canonical_evidence=canonical_evidence)
    llm = LlmAdapter(default_model=llm_model) if llm_model else get_llm_adapter()
    use_case = GenerateInterviewPrepUseCase(
        repository=repository,
        llm=llm,
        publisher=InterviewPrepEventRecorder(conn),
        catalog=catalog,
    )
    outcome = use_case.execute(
        tenant_id=tenant_id,
        job=job,
        profile_snapshot=profile_snapshot,
        canonical_evidence=canonical_evidence,
        evidence_entries=_load_evidence_entries(conn, tenant_id, stable_job_id),
        evidence_gaps=_load_evidence_gaps(conn, tenant_id, stable_job_id),
        requirements=requirements,
        employer_context=employer_context,
        fit_context=fit_context,
        selection_input=selection,
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


def _load_canonical_evidence(
    conn: sqlite3.Connection, tenant_id: TenantId, profile: ProfileSnapshot,
) -> InterviewEvidenceSnapshot:
    """Fence the exact tenant/default-profile canonical rows, never display fallback."""
    if profile.tenant_id != tenant_id or profile.profile_id != "default":
        raise InterviewSelectionError("invalid_evidence_selection")
    conn.execute("SAVEPOINT interview_evidence_read")
    try:
        current = conn.execute(
            "SELECT version FROM candidate_profiles WHERE tenant_id=? AND profile_id='default'",
            (str(tenant_id),),
        ).fetchone()
        if current is None or current["version"] != profile.version:
            raise InterviewSelectionError("evidence_profile_changed")
        rows = conn.execute(
            """SELECT evidence_id,source_text,scope,action,outcome,metrics_json,tools_json,tags_json,
                      user_confirmed,evidence_strength
               FROM candidate_profile_achievement_evidence
               WHERE tenant_id=? AND profile_id='default'
               ORDER BY entry_id,evidence_index""", (str(tenant_id),),
        ).fetchall()
        result = InterviewEvidenceSnapshot.from_canonical_rows(
            tenant_id=tenant_id, profile_id="default", profile_version=profile.version,
            rows=[dict(row) for row in rows],
        )
    finally:
        conn.execute("RELEASE SAVEPOINT interview_evidence_read")
    return result


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



def _load_employer_and_fit_context(
    conn: sqlite3.Connection,
    tenant_id: TenantId,
    job_id: JobId,
    profile_version: int,
    *, current_job_hash: str | None = None,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None, tuple[dict[str, Any], ...]]:
    """Read current target requirements; stale fit never supplies personal facts."""
    analysis = conn.execute(
        """
        SELECT generation, snapshot_hash, prompt_version, role_framing,
               inferred_seniority, requirements_json
        FROM job_employer_analysis
        WHERE tenant_id = ? AND job_id = ? ORDER BY generation DESC LIMIT 1
        """,
        (str(tenant_id), str(job_id)),
    ).fetchone()
    report = conn.execute(
        """
        SELECT score_version, employer_analysis_generation, profile_snapshot_version,
               scoring_policy_version, formula_version, created_at
        FROM job_requirement_fit_reports
        WHERE tenant_id = ? AND job_id = ? ORDER BY score_version DESC LIMIT 1
        """,
        (str(tenant_id), str(job_id)),
    ).fetchone()
    employer_context = None
    requirements: list[dict[str, Any]] = []
    if analysis is not None and (current_job_hash is None or analysis["snapshot_hash"] == current_job_hash):
        employer_context = {
            "generation": analysis["generation"], "snapshotHash": analysis["snapshot_hash"],
            "promptVersion": analysis["prompt_version"], "roleFraming": analysis["role_framing"],
            "inferredSeniority": analysis["inferred_seniority"],
        }
        raw_requirements = json.loads(analysis["requirements_json"] or "[]")
        if not isinstance(raw_requirements, list):
            raise ValueError("invalid saved employer requirements")
        for raw in raw_requirements[:20]:
            if not isinstance(raw, dict):
                raise ValueError("invalid saved employer requirement")
            if any(len(str(raw.get(key) or "")) > 3000 for key in ("id", "text", "evidence_span")):
                raise ValueError("employer requirement exceeds preparation budget")
            requirements.append({
                "requirementId": raw.get("id"), "requirementText": raw.get("text"),
                "tier": raw.get("tier"), "weight": raw.get("weight"),
                "sourceExcerpt": raw.get("evidence_span"), "evidenceIds": [],
            })
        if len(str(analysis["role_framing"])) > 4000 or len(str(analysis["inferred_seniority"])) > 500:
            raise ValueError("employer framing exceeds preparation budget")
        employer_context["requirements"] = requirements
        employer_context["unusedRequirementCount"] = max(0, len(raw_requirements) - len(requirements))
    fit_context = None
    if report is not None:
        current = (employer_context is not None
                   and report["employer_analysis_generation"] == analysis["generation"]
                   and report["profile_snapshot_version"] == profile_version)
        fit_context = {
            "scoreVersion": report["score_version"],
            "employerAnalysisGeneration": report["employer_analysis_generation"],
            "profileSnapshotVersion": report["profile_snapshot_version"],
            "scoringPolicyVersion": report["scoring_policy_version"],
            "formulaVersion": report["formula_version"], "createdAt": report["created_at"],
            "status": "current" if current else "stale_excluded",
        }
        if current:
            fit_items = conn.execute(
                """
                SELECT requirement_id, requirement_text, fit_json
                FROM job_requirement_fit_items
                WHERE tenant_id = ? AND job_id = ? AND score_version = ?
                ORDER BY position, requirement_id
                """,
                (str(tenant_id), str(job_id), report["score_version"]),
            ).fetchall()
            for requirement in requirements:
                matching = [row for row in fit_items
                            if row["requirement_id"] == requirement["requirementId"]
                            and " ".join(row["requirement_text"].split())
                            == " ".join(str(requirement["requirementText"] or "").split())]
                if len(matching) == 1:
                    fit = _load_json(matching[0]["fit_json"])
                    requirement["fitKind"] = fit.get("kind")
                    requirement["evidenceIds"] = fit.get("evidenceIds", [])
                else:
                    requirement["fitStatus"] = "source_identity_mismatch"
    return employer_context, fit_context, tuple(requirements)

def _load_accepted_materials(
    conn: sqlite3.Connection,
    tenant_id: TenantId,
    job_id: JobId,
) -> tuple[dict[str, Any], ...]:
    materials = SqliteMaterialsRepository(conn).load_current_approved(tenant_id, job_id)
    if materials is None or materials.tailored_resume is None:
        return ()
    artifact_path = Path(materials.tailored_resume.path)
    unavailable = ({"inputWarning": "Current approved resume is unavailable as a preparation input."},)
    if not artifact_path.is_absolute():
        return unavailable
    try:
        if any(part.is_symlink() for part in (artifact_path, *artifact_path.parents)):
            return unavailable
        with artifact_path.open("rb") as material_file:
            raw_bytes = material_file.read(1_048_577)
    except OSError:
        return unavailable
    if len(raw_bytes) > 1_048_576:
        return ({"inputWarning": "Current approved resume exceeds the preparation input byte budget."},)
    material_sha256 = hashlib.sha256(raw_bytes).hexdigest()
    rows = conn.execute(
        """
        SELECT bullet_id, artifact_id, generation, evidence_ids_json,
               requirement_ids_json, generated_text, position
        FROM job_bullet_provenance
        WHERE tenant_id = ? AND job_id = ? AND generation = ? AND artifact_id = ?
        ORDER BY position, bullet_id
        LIMIT 20
        """,
        (str(tenant_id), str(job_id), materials.generation,
         materials.tailored_resume.artifact_id),
    ).fetchall()
    result = tuple(
        {
            "bulletId": row["bullet_id"],
            "artifactId": row["artifact_id"],
            "generation": row["generation"],
            "evidenceIds": _load_json_list(row["evidence_ids_json"]),
            "requirementIds": _load_json_list(row["requirement_ids_json"]),
            "generatedText": row["generated_text"],
            "materialSha256": material_sha256,
        }
        for row in rows
    )

    return result or ({"artifactId": materials.tailored_resume.artifact_id, "generation": materials.generation,
                       "materialSha256": material_sha256},)


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
