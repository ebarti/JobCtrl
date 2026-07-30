"""SQLite-backed Interview Preparation repository.

The adapter persists tenant-scoped stable ``JobId`` references. Until the
workflow/API identity cutover, URL-shaped ``JobId`` compatibility inputs are
resolved URL-first at this boundary so even UUID-shaped posting URLs bind to
their URL owner rather than an unrelated JobId.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from jobctrl.database import ensure_interview_prep_tables
from jobctrl.domain.discovery.value_objects import PostingUrl
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.interview import (
    InterviewPrep,
    InterviewPrepGateAudit,
    InterviewPrepItem,
)
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.discovery.sqlite_identity_resolver import (
    SqliteJobIdentityResolver,
)


class SqliteInterviewPrepRepository:
    """Persist generation-versioned interview prep canonical rows.

    Accepted generations supersede prior accepted generations for the same job.
    Failed generations are still written, but they never touch the last accepted
    generation's items.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        ensure_interview_prep_tables(conn)
        self._reference_column = (
            "job_id"
            if "job_id"
            in {
                str(row[1])
                for row in conn.execute(
                    "PRAGMA table_info(job_interview_prep)"
                ).fetchall()
            }
            else "job_url"
        )
        self._identity_resolver = SqliteJobIdentityResolver(conn)

    def _resolved_identity(
        self,
        tenant_id: TenantId,
        reference: JobId,
    ):
        """Resolve the current URL-shaped boundary before UUID interpretation."""
        raw_reference = str(reference or "").strip()
        if not raw_reference:
            raise ValueError("job_id must be non-empty")
        identity = self._identity_resolver.resolve_by_posting_url(
            tenant_id,
            PostingUrl(raw_reference),
        )
        if identity is not None:
            return identity
        direct = self._conn.execute(
            """
            SELECT job_id
            FROM jobs
            WHERE tenant_id = ? AND url = ?
            LIMIT 1
            """,
            (str(tenant_id), raw_reference),
        ).fetchone()
        if direct is not None and str(direct[0] or "").strip():
            identity = self._identity_resolver.resolve_by_job_id(
                tenant_id,
                JobId(str(direct[0])),
            )
            if identity is not None:
                return identity
        try:
            stable_candidate = canonical_job_id(raw_reference)
        except ValueError:
            return None
        return self._identity_resolver.resolve_by_job_id(
            tenant_id,
            stable_candidate,
        )

    def _reference_for_read(
        self,
        tenant_id: TenantId,
        reference: JobId,
    ) -> tuple[str, JobId] | None:
        raw_reference = str(reference or "").strip()
        identity = self._resolved_identity(tenant_id, reference)
        if identity is None:
            return None
        if self._reference_column == "job_id":
            return str(identity.job_id), identity.job_id
        exact = self._conn.execute(
            """
            SELECT 1
            FROM job_interview_prep
            WHERE tenant_id = ? AND job_url = ?
            LIMIT 1
            """,
            (str(tenant_id), raw_reference),
        ).fetchone()
        physical_reference = (
            raw_reference
            if exact is not None
            else identity.storage_url.value
        )
        return physical_reference, identity.job_id

    def _reference_for_write(
        self,
        tenant_id: TenantId,
        reference: JobId,
    ) -> tuple[str, JobId]:
        identity = self._resolved_identity(tenant_id, reference)
        if identity is None:
            raise ValueError(
                "no stable Job identity for interview-prep reference: "
                f"{reference}"
            )
        physical_reference = (
            str(identity.job_id)
            if self._reference_column == "job_id"
            else identity.storage_url.value
        )
        return physical_reference, identity.job_id

    def next_generation(self, tenant_id: TenantId, job_id: JobId) -> int:
        resolved = self._reference_for_read(tenant_id, job_id)
        if resolved is None:
            resolved = self._reference_for_write(tenant_id, job_id)
        reference, _stable_job_id = resolved
        row = self._conn.execute(
            f"""
            SELECT MAX(generation) FROM job_interview_prep
            WHERE tenant_id = ? AND {self._reference_column} = ?
            """,
            (str(tenant_id), reference),
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
        resolved = self._reference_for_read(tenant_id, job_id)
        if resolved is None:
            return None
        reference, _stable_job_id = resolved
        row = self._conn.execute(
            f"""
            SELECT * FROM job_interview_prep
            WHERE tenant_id = ? AND {self._reference_column} = ?
              AND origin_run_id = ?
            ORDER BY generation DESC
            LIMIT 1
            """,
            (str(tenant_id), reference, str(origin_run_id)),
        ).fetchone()
        if row is None:
            return None
        return self._row_to_prep(
            row,
            tenant_id,
            display_job_key=str(job_id),
            reference=reference,
        )

    def save(
        self,
        prep: InterviewPrep,
        *,
        tenant_id: TenantId,
        origin_run_id: str = "",
    ) -> None:
        tenant = str(tenant_id)
        reference, _stable_job_id = self._reference_for_write(
            tenant_id,
            JobId(str(prep.job_key)),
        )
        if prep.status == "accepted":
            self._conn.execute(
                f"""
                UPDATE job_interview_prep
                   SET status = 'superseded'
                 WHERE tenant_id = ?
                   AND {self._reference_column} = ?
                   AND status = 'accepted'
                   AND generation < ?
                """,
                (tenant, reference, prep.generation),
            )
        conflict_target = (
            f"tenant_id, {self._reference_column}, generation"
            if self._reference_column == "job_id"
            else f"{self._reference_column}, generation"
        )
        self._conn.execute(
            f"""
            INSERT INTO job_interview_prep (
                tenant_id, {self._reference_column}, generation,
                status, model, generated_at,
                gate_status, fabrication_findings_json, grounding_findings_json,
                judge_verdict, warnings_json, failure_reason, origin_run_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT({conflict_target}) DO UPDATE SET
                tenant_id = excluded.tenant_id,
                status = excluded.status,
                model = excluded.model,
                generated_at = excluded.generated_at,
                gate_status = excluded.gate_status,
                fabrication_findings_json = excluded.fabrication_findings_json,
                grounding_findings_json = excluded.grounding_findings_json,
                judge_verdict = excluded.judge_verdict,
                warnings_json = excluded.warnings_json,
                failure_reason = excluded.failure_reason,
                origin_run_id = excluded.origin_run_id
            """,
            (
                tenant,
                reference,
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
            ),
        )
        self._conn.execute(
            f"""
            DELETE FROM job_interview_prep_items
            WHERE tenant_id = ? AND {self._reference_column} = ?
              AND generation = ?
            """,
            (tenant, reference, prep.generation),
        )
        for position, item in enumerate(prep.items):
            self._conn.execute(
                f"""
                INSERT INTO job_interview_prep_items (
                    tenant_id, {self._reference_column}, generation,
                    item_id, kind, title,
                    generated_text, evidence_ids_json, requirement_ids_json,
                    source_text_json, transform_type, control,
                    grounding_audit_json, warnings_json, position
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    tenant,
                    reference,
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
        resolved = self._reference_for_read(tenant_id, job_id)
        if resolved is None:
            return None
        reference, _stable_job_id = resolved
        params: list[Any] = [str(tenant_id), reference]
        status_filter = ""
        if status is not None:
            status_filter = "AND status = ?"
            params.append(status)
        row = self._conn.execute(
            f"""
            SELECT * FROM job_interview_prep
            WHERE tenant_id = ?
              AND {self._reference_column} = ? {status_filter}
            ORDER BY generation DESC
            LIMIT 1
            """,
            tuple(params),
        ).fetchone()
        if row is None:
            return None
        return self._row_to_prep(
            row,
            tenant_id,
            display_job_key=str(job_id),
            reference=reference,
        )

    def load(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        *,
        generation: int,
    ) -> InterviewPrep | None:
        resolved = self._reference_for_read(tenant_id, job_id)
        if resolved is None:
            return None
        reference, _stable_job_id = resolved
        row = self._conn.execute(
            f"""
            SELECT * FROM job_interview_prep
            WHERE tenant_id = ? AND {self._reference_column} = ?
              AND generation = ?
            """,
            (str(tenant_id), reference, int(generation)),
        ).fetchone()
        if row is None:
            return None
        return self._row_to_prep(
            row,
            tenant_id,
            display_job_key=str(job_id),
            reference=reference,
        )

    def _row_to_prep(
        self,
        row: sqlite3.Row,
        tenant_id: TenantId,
        *,
        display_job_key: str,
        reference: str,
    ) -> InterviewPrep:
        item_rows = self._conn.execute(
            f"""
            SELECT * FROM job_interview_prep_items
            WHERE tenant_id = ? AND {self._reference_column} = ?
              AND generation = ?
            ORDER BY position, item_id
            """,
            (str(tenant_id), reference, int(row["generation"])),
        ).fetchall()
        gate = InterviewPrepGateAudit(
            status=row["gate_status"],
            fabrication_findings=tuple(_load_list(row["fabrication_findings_json"])),
            grounding_findings=tuple(_load_list(row["grounding_findings_json"])),
            judge_verdict=row["judge_verdict"],
            warnings=tuple(_load_list(row["warnings_json"])),
        )
        return InterviewPrep(
            job_key=display_job_key,
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
