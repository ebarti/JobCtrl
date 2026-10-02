"""SQLite-backed Interview Preparation repository."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.interview import (
    InterviewPrep,
    InterviewPrepGateAudit,
)
from jobctrl.domain.tenant import TenantId


class SqliteInterviewPrepRepository:
    """Persist generation-versioned interview prep canonical rows.

    Accepted generations supersede prior accepted generations for the same job.
    Failed generations are still written, but they never touch the last accepted
    generation's items.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def next_generation(self, tenant_id: TenantId, job_id: JobId) -> int:
        stable_job_id = canonical_job_id(str(job_id))
        row = self._conn.execute(
            """
            SELECT MAX(generation) FROM job_interview_prep
            WHERE tenant_id = ? AND job_id = ?
            """,
            (str(tenant_id), str(stable_job_id)),
        ).fetchone()
        current = row[0] if row is not None else None
        return int(current or 0) + 1

    def find_completed_for_run(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        origin_run_id: str,
    ) -> InterviewPrep | None:
        """Return the generation a prior attempt of ``origin_run_id`` completed.

        Only completed generations are persisted, so a matching row means this
        workflow run already generated (and spent) once. Retries reuse it
        instead of generating a second time.
        """
        if not origin_run_id:
            return None
        stable_job_id = canonical_job_id(str(job_id))
        row = self._conn.execute(
            """
            SELECT * FROM job_interview_prep
            WHERE tenant_id = ? AND job_id = ? AND origin_run_id = ?
            ORDER BY generation DESC
            LIMIT 1
            """,
            (str(tenant_id), str(stable_job_id), str(origin_run_id)),
        ).fetchone()
        if row is None:
            return None
        return self._row_to_prep(row, tenant_id)

    def _save_rows(
        self,
        prep: InterviewPrep,
        *,
        tenant_id: TenantId,
        origin_run_id: str = "",
    ) -> None:
        job_id = canonical_job_id(str(prep.job_id))
        tenant = str(tenant_id)
        if prep.status == "accepted":
            self._conn.execute(
                """
                UPDATE job_interview_prep
                   SET status = 'superseded'
                 WHERE tenant_id = ?
                   AND job_id = ?
                   AND status = 'accepted'
                   AND generation < ?
                """,
                (tenant, str(job_id), prep.generation),
            )
        self._conn.execute(
            """
            INSERT INTO job_interview_prep (
                tenant_id, job_id, generation, status, model, generated_at,
                gate_status, fabrication_findings_json, grounding_findings_json,
                judge_verdict, warnings_json, failure_reason, origin_run_id, generation_context_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, job_id, generation) DO UPDATE SET
                status = excluded.status,
                model = excluded.model,
                generated_at = excluded.generated_at,
                gate_status = excluded.gate_status,
                fabrication_findings_json = excluded.fabrication_findings_json,
                grounding_findings_json = excluded.grounding_findings_json,
                judge_verdict = excluded.judge_verdict,
                warnings_json = excluded.warnings_json,
                failure_reason = excluded.failure_reason,
                origin_run_id = excluded.origin_run_id,
                generation_context_json = excluded.generation_context_json
            """,
            (
                tenant,
                str(job_id),
                prep.generation,
                prep.status,
                prep.model,
                prep.generated_at,
                prep.gate_audit.status,
                _dump(prep.gate_audit.fabrication_findings),
                _dump(prep.gate_audit.grounding_findings),
                prep.gate_audit.judge_verdict,
                _dump(prep.gate_audit.warnings),
                "" if prep.status == "accepted" else _failure_reason(prep.gate_audit),
                str(origin_run_id or ""),
                _dump_object(prep.to_read_model().get("generationContext")),
            ),
        )
        self._conn.execute(
            """
            DELETE FROM job_interview_prep_items
            WHERE tenant_id = ? AND job_id = ? AND generation = ?
            """,
            (tenant, str(job_id), prep.generation),
        )
        for position, item in enumerate(prep.items):
            self._conn.execute(
                """
                INSERT INTO job_interview_prep_items (
                    tenant_id, job_id, generation, item_id, kind, title,
                    generated_text, evidence_ids_json, requirement_ids_json,
                    source_text_json, transform_type, control,
                    grounding_audit_json, warnings_json, position, question_metadata_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    tenant,
                    str(job_id),
                    prep.generation,
                    item.item_id,
                    item.kind,
                    item.title,
                    item.generated_text,
                    _dump(item.evidence_ids),
                    _dump(item.requirement_ids),
                    _dump(item.source_text),
                    item.transform_type,
                    item.control,
                    _dump(item.grounding_audit),
                    _dump(item.warnings),
                    position,
                    _dump_object(item.to_read_model().get("questionMetadata")),
                ),
            )

    def load_latest(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        *,
        status: str | None = "accepted",
    ) -> InterviewPrep | None:
        stable_job_id = canonical_job_id(str(job_id))
        params: list[Any] = [str(tenant_id), str(stable_job_id)]
        status_filter = ""
        if status is not None:
            status_filter = "AND status = ?"
            params.append(status)
        row = self._conn.execute(
            f"""
            SELECT * FROM job_interview_prep
            WHERE tenant_id = ? AND job_id = ? {status_filter}
            ORDER BY generation DESC
            LIMIT 1
            """,
            tuple(params),
        ).fetchone()
        if row is None:
            return None
        return self._row_to_prep(row, tenant_id)

    def load(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        *,
        generation: int,
    ) -> InterviewPrep | None:
        stable_job_id = canonical_job_id(str(job_id))
        row = self._conn.execute(
            """
            SELECT * FROM job_interview_prep
            WHERE tenant_id = ? AND job_id = ? AND generation = ?
            """,
            (str(tenant_id), str(stable_job_id), int(generation)),
        ).fetchone()
        if row is None:
            return None
        return self._row_to_prep(row, tenant_id)

    def _row_to_prep(self, row: sqlite3.Row, tenant_id: TenantId) -> InterviewPrep:
        return InterviewPrep.from_dict(self._row_to_read_model(row, tenant_id))

    def _row_to_read_model(self, row: sqlite3.Row, tenant_id: TenantId) -> dict[str, Any]:
        item_rows = self._conn.execute(
            "SELECT * FROM job_interview_prep_items WHERE tenant_id=? AND job_id=? AND generation=? ORDER BY position,item_id",
            (str(tenant_id), row["job_id"], int(row["generation"])),
        ).fetchall()
        context = _load_object(row["generation_context_json"])
        return {
            "jobId": row["job_id"],
            "generation": int(row["generation"]),
            "status": row["status"],
            "generatedAt": row["generated_at"],
            "model": row["model"],
            "generationContext": context,
            "staleReasons": [] if context is not None else ["legacy_unbound"],
            "gateAudit": {
                "status": row["gate_status"],
                "fabricationFindings": _load_list(row["fabrication_findings_json"]),
                "groundingFindings": _load_list(row["grounding_findings_json"]),
                "judgeVerdict": row["judge_verdict"],
                "warnings": _load_list(row["warnings_json"]),
            },
            "items": [_item_read_model(item) for item in item_rows],
        }

    def load_read_model(self, tenant_id: TenantId, job_id: JobId, *, generation: int) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT * FROM job_interview_prep WHERE tenant_id=? AND job_id=? AND generation=?",
            (str(tenant_id), str(canonical_job_id(str(job_id))), generation),
        ).fetchone()
        return None if row is None else self._row_to_read_model(row, tenant_id)

    def load_latest_read_model(self, tenant_id: TenantId, job_id: JobId) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT * FROM job_interview_prep WHERE tenant_id=? AND job_id=? AND status='accepted' ORDER BY generation DESC LIMIT 1",
            (str(tenant_id), str(canonical_job_id(str(job_id)))),
        ).fetchone()
        return None if row is None else self._row_to_read_model(row, tenant_id)

    def load_history(
        self, tenant_id: TenantId, job_id: JobId, *, limit: int = 20, offset: int = 0
    ) -> list[dict[str, Any]]:
        if not 1 <= limit <= 100 or offset < 0:
            raise ValueError("invalid interview history bounds")
        rows = self._conn.execute(
            "SELECT * FROM job_interview_prep WHERE tenant_id=? AND job_id=? ORDER BY generation DESC LIMIT ? OFFSET ?",
            (str(tenant_id), str(canonical_job_id(str(job_id))), limit, offset),
        ).fetchall()
        return [self._row_to_read_model(row, tenant_id) for row in rows]

    def save(self, prep: InterviewPrep, *, tenant_id: TenantId, origin_run_id: str = "") -> None:
        """One transaction preserves the last accepted generation on any failure."""
        self._conn.execute("SAVEPOINT interview_prep_save")
        try:
            stable_job_id = str(canonical_job_id(str(prep.job_id)))
            current = self._conn.execute(
                "SELECT MAX(generation) FROM job_interview_prep WHERE tenant_id=? AND job_id=?",
                (str(tenant_id), stable_job_id),
            ).fetchone()[0]
            if current is not None and prep.generation <= int(current):
                raise InterviewPrepGenerationConflictError()
            self._save_rows(prep, tenant_id=tenant_id, origin_run_id=origin_run_id)
            self._conn.execute("RELEASE SAVEPOINT interview_prep_save")
        except BaseException:
            self._conn.execute("ROLLBACK TO SAVEPOINT interview_prep_save")
            self._conn.execute("RELEASE SAVEPOINT interview_prep_save")
            raise

    def save_note(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        question_id: str,
        *,
        expected_revision: int,
        note_text: str,
        factual_support: str = "unverified_user_statement",
        source_generation: int | None = None,
        bindings: dict[str, Any] | None = None,
        updated_at: str | None = None,
    ) -> dict[str, Any]:
        """CAS user notes independently of generated items; edits carry no passed audit."""
        if not isinstance(question_id, str) or not 1 <= len(question_id) <= 100:
            raise ValueError("invalid interview question id")
        if type(expected_revision) is not int or expected_revision < 0:
            raise ValueError("invalid interview note revision")
        if not isinstance(note_text, str) or len(note_text) > 20000:
            raise ValueError("invalid interview note text")
        if factual_support not in {"unverified_user_statement", "needs_clarification", "hypothetical"}:
            raise ValueError("user notes cannot assert verified factual support")
        if source_generation is not None and (type(source_generation) is not int or source_generation < 1):
            raise ValueError("invalid interview source generation")
        key = (str(tenant_id), str(canonical_job_id(str(job_id))), question_id)
        revision = expected_revision + 1
        bindings_json = _dump_object(bindings)
        at = updated_at or datetime.now(timezone.utc).isoformat()
        values = (*key, revision, note_text, factual_support, "user_edited", source_generation, bindings_json, at)
        self._conn.execute("SAVEPOINT interview_note_save")
        try:
            if (
                source_generation is not None
                and self._conn.execute(
                    "SELECT 1 FROM job_interview_prep WHERE tenant_id=? AND job_id=? AND generation=?",
                    (*key[:2], source_generation),
                ).fetchone()
                is None
            ):
                raise ValueError("interview source generation does not belong to this job")
            if expected_revision == 0:
                changed = self._conn.execute(
                    "INSERT INTO job_interview_notes(tenant_id,job_id,question_id,revision,note_text,factual_support,edit_status,source_generation,bindings_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,job_id,question_id) DO NOTHING",
                    values,
                ).rowcount
            else:
                changed = self._conn.execute(
                    "UPDATE job_interview_notes SET revision=?,note_text=?,factual_support=?,edit_status=?,source_generation=?,bindings_json=?,updated_at=? WHERE tenant_id=? AND job_id=? AND question_id=? AND revision=?",
                    (*values[3:], *key, expected_revision),
                ).rowcount
            if changed != 1:
                raise InterviewNoteConflictError()
            self._conn.execute(
                "INSERT INTO job_interview_note_revisions(tenant_id,job_id,question_id,revision,note_text,factual_support,edit_status,source_generation,bindings_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                values,
            )
            row = self._conn.execute(
                "SELECT * FROM job_interview_notes WHERE tenant_id=? AND job_id=? AND question_id=?", key
            ).fetchone()
            result = _note_read_model(row)
            self._conn.execute("RELEASE SAVEPOINT interview_note_save")
            return result
        except BaseException:
            self._conn.execute("ROLLBACK TO SAVEPOINT interview_note_save")
            self._conn.execute("RELEASE SAVEPOINT interview_note_save")
            raise

    def load_note(self, tenant_id: TenantId, job_id: JobId, question_id: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT * FROM job_interview_notes WHERE tenant_id=? AND job_id=? AND question_id=?",
            (str(tenant_id), str(canonical_job_id(str(job_id))), question_id),
        ).fetchone()
        return None if row is None else _note_read_model(row)

    def list_notes(
        self, tenant_id: TenantId, job_id: JobId, *, limit: int = 20, offset: int = 0
    ) -> list[dict[str, Any]]:
        if not 1 <= limit <= 100 or offset < 0:
            raise ValueError("invalid interview note bounds")
        rows = self._conn.execute(
            "SELECT * FROM job_interview_notes WHERE tenant_id=? AND job_id=? ORDER BY question_id LIMIT ? OFFSET ?",
            (str(tenant_id), str(canonical_job_id(str(job_id))), limit, offset),
        ).fetchall()
        return [_note_read_model(row) for row in rows]

    def load_note_history(
        self, tenant_id: TenantId, job_id: JobId, question_id: str, *, limit: int = 20, offset: int = 0
    ) -> list[dict[str, Any]]:
        if not 1 <= limit <= 100 or offset < 0:
            raise ValueError("invalid interview note history bounds")
        rows = self._conn.execute(
            "SELECT * FROM job_interview_note_revisions WHERE tenant_id=? AND job_id=? AND question_id=? ORDER BY revision DESC LIMIT ? OFFSET ?",
            (str(tenant_id), str(canonical_job_id(str(job_id))), question_id, limit, offset),
        ).fetchall()
        return [_note_read_model(row) for row in rows]


class InterviewPrepGenerationConflictError(RuntimeError):
    def __init__(self) -> None:
        super().__init__("interview_prep_generation_conflict")


class InterviewNoteConflictError(RuntimeError):
    def __init__(self) -> None:
        super().__init__("interview_note_revision_conflict")


def _note_read_model(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "jobId": row["job_id"],
        "questionId": row["question_id"],
        "revision": row["revision"],
        "noteText": row["note_text"],
        "factualSupport": row["factual_support"],
        "editStatus": row["edit_status"],
        "sourceGeneration": row["source_generation"],
        "bindings": _load_object(row["bindings_json"]),
        "updatedAt": row["updated_at"],
    }


def _item_read_model(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "itemId": row["item_id"],
        "kind": row["kind"],
        "title": row["title"],
        "generatedText": row["generated_text"],
        "evidenceIds": _load_list(row["evidence_ids_json"]),
        "requirementIds": _load_list(row["requirement_ids_json"]),
        "sourceText": _load_list(row["source_text_json"]),
        "transformType": row["transform_type"],
        "control": row["control"],
        "groundingAudit": _load_list(row["grounding_audit_json"]),
        "warnings": _load_list(row["warnings_json"]),
        "position": int(row["position"] or 0),
        "questionMetadata": _load_object(row["question_metadata_json"]),
    }


def _dump_object(value: dict[str, Any] | None) -> str | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("interview metadata requires a JSON object")
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def _load_object(value: str | None) -> dict[str, Any] | None:
    if value is None:
        return None
    parsed = json.loads(value)
    if not isinstance(parsed, dict):
        raise ValueError("saved interview metadata requires a JSON object")
    return parsed


def _dump(values: tuple[str, ...] | list[str]) -> str:
    return json.dumps(list(values), ensure_ascii=False)


def _load_list(value: str | None) -> list[str]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return []
    if not isinstance(parsed, list):
        return []
    return [str(item) for item in parsed]


def _failure_reason(gate: InterviewPrepGateAudit) -> str:
    reasons = (*gate.fabrication_findings, *gate.grounding_findings, *gate.warnings)
    return "; ".join(reason for reason in reasons if reason)[:2000]


__all__ = ["SqliteInterviewPrepRepository", "InterviewNoteConflictError"]
