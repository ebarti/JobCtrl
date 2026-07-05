"""SQLite-backed Interview Preparation repository."""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from jobhunter.database import ensure_interview_prep_tables
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.interview import (
    InterviewPrep,
    InterviewPrepGateAudit,
    InterviewPrepItem,
)
from jobhunter.domain.tenant import TenantId


class SqliteInterviewPrepRepository:
    """Persist generation-versioned interview prep canonical rows.

    Accepted generations supersede prior accepted generations for the same job.
    Failed generations are still written, but they never touch the last accepted
    generation's items.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        ensure_interview_prep_tables(conn)

    def next_generation(self, tenant_id: TenantId, job_id: JobId) -> int:
        row = self._conn.execute(
            """
            SELECT MAX(generation) FROM job_interview_prep
            WHERE tenant_id = ? AND job_url = ?
            """,
            (str(tenant_id), str(job_id)),
        ).fetchone()
        current = row[0] if row is not None else None
        return int(current or 0) + 1

    def save(self, prep: InterviewPrep, *, tenant_id: TenantId) -> None:
        job_url = str(prep.job_key)
        tenant = str(tenant_id)
        if prep.status == "accepted":
            self._conn.execute(
                """
                UPDATE job_interview_prep
                   SET status = 'superseded'
                 WHERE tenant_id = ?
                   AND job_url = ?
                   AND status = 'accepted'
                   AND generation < ?
                """,
                (tenant, job_url, prep.generation),
            )
        self._conn.execute(
            """
            INSERT INTO job_interview_prep (
                job_url, generation, tenant_id, status, model, generated_at,
                gate_status, fabrication_findings_json, grounding_findings_json,
                judge_verdict, warnings_json, failure_reason
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(job_url, generation) DO UPDATE SET
                tenant_id = excluded.tenant_id,
                status = excluded.status,
                model = excluded.model,
                generated_at = excluded.generated_at,
                gate_status = excluded.gate_status,
                fabrication_findings_json = excluded.fabrication_findings_json,
                grounding_findings_json = excluded.grounding_findings_json,
                judge_verdict = excluded.judge_verdict,
                warnings_json = excluded.warnings_json,
                failure_reason = excluded.failure_reason
            """,
            (
                job_url,
                prep.generation,
                tenant,
                prep.status,
                prep.model,
                prep.generated_at,
                prep.gate_audit.status,
                _dump(prep.gate_audit.fabrication_findings),
                _dump(prep.gate_audit.grounding_findings),
                prep.gate_audit.judge_verdict,
                _dump(prep.gate_audit.warnings),
                "" if prep.status == "accepted" else _failure_reason(prep.gate_audit),
            ),
        )
        self._conn.execute(
            """
            DELETE FROM job_interview_prep_items
            WHERE tenant_id = ? AND job_url = ? AND generation = ?
            """,
            (tenant, job_url, prep.generation),
        )
        for position, item in enumerate(prep.items):
            self._conn.execute(
                """
                INSERT INTO job_interview_prep_items (
                    job_url, generation, item_id, tenant_id, kind, title,
                    generated_text, evidence_ids_json, requirement_ids_json,
                    source_text_json, transform_type, control,
                    grounding_audit_json, warnings_json, position
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job_url,
                    prep.generation,
                    item.item_id,
                    tenant,
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
                ),
            )
        self._conn.commit()

    def load_latest(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        *,
        status: str | None = "accepted",
    ) -> InterviewPrep | None:
        params: list[Any] = [str(tenant_id), str(job_id)]
        status_filter = ""
        if status is not None:
            status_filter = "AND status = ?"
            params.append(status)
        row = self._conn.execute(
            f"""
            SELECT * FROM job_interview_prep
            WHERE tenant_id = ? AND job_url = ? {status_filter}
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
        row = self._conn.execute(
            """
            SELECT * FROM job_interview_prep
            WHERE tenant_id = ? AND job_url = ? AND generation = ?
            """,
            (str(tenant_id), str(job_id), int(generation)),
        ).fetchone()
        if row is None:
            return None
        return self._row_to_prep(row, tenant_id)

    def _row_to_prep(self, row: sqlite3.Row, tenant_id: TenantId) -> InterviewPrep:
        item_rows = self._conn.execute(
            """
            SELECT * FROM job_interview_prep_items
            WHERE tenant_id = ? AND job_url = ? AND generation = ?
            ORDER BY position, item_id
            """,
            (str(tenant_id), row["job_url"], int(row["generation"])),
        ).fetchall()
        gate = InterviewPrepGateAudit(
            status=row["gate_status"],
            fabrication_findings=tuple(_load_list(row["fabrication_findings_json"])),
            grounding_findings=tuple(_load_list(row["grounding_findings_json"])),
            judge_verdict=row["judge_verdict"],
            warnings=tuple(_load_list(row["warnings_json"])),
        )
        return InterviewPrep(
            job_key=str(row["job_url"]),
            generation=int(row["generation"]),
            status=str(row["status"]),  # type: ignore[arg-type]
            generated_at=str(row["generated_at"]),
            model=row["model"],
            gate_audit=gate,
            items=tuple(_row_to_item(item) for item in item_rows),
        )


def _row_to_item(row: sqlite3.Row) -> InterviewPrepItem:
    return InterviewPrepItem(
        item_id=str(row["item_id"]),
        kind=str(row["kind"]),  # type: ignore[arg-type]
        title=str(row["title"]),
        generated_text=str(row["generated_text"]),
        evidence_ids=tuple(_load_list(row["evidence_ids_json"])),
        requirement_ids=tuple(_load_list(row["requirement_ids_json"])),
        source_text=tuple(_load_list(row["source_text_json"])),
        transform_type=str(row["transform_type"]),
        control=str(row["control"]),
        grounding_audit=tuple(_load_list(row["grounding_audit_json"])),
        warnings=tuple(_load_list(row["warnings_json"])),
        position=int(row["position"] or 0),
    )


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


__all__ = ["SqliteInterviewPrepRepository"]
