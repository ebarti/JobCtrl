"""SqliteEmployerAnalysisRepository — local-mode adapter (Phase 1).

Persists :class:`EmployerAnalysis` aggregates to the canonical
``job_employer_analysis`` (+ ``_sub_analyses`` / ``_failures``) tables created
by :func:`database.ensure_employer_analysis_tables`. Mirrors
:class:`SqliteMaterialsRepository`: one connection per adapter, eager commit,
monotonic generation allocation, and supersede-not-destroy semantics (D-13).

The cache short-circuit (D-11/D-12) is served by :meth:`get_by_cache_key`,
which returns the latest analysis matching a snapshot+version cache key so a
re-tailor reuses the persisted record instead of re-reasoning.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from jobctl.database import ensure_employer_analysis_tables
from jobctl.domain.identifiers import JobId
from jobctl.domain.materials.analysis import (
    AnalysisAgreement,
    AnalysisFailure,
    EeoScreenHit,
    EmployerAnalysis,
    JobAnalysis,
    JobAnalysisDraft,
)
from jobctl.domain.tenant import TenantId


class SqliteEmployerAnalysisRepository:
    """SQLite-backed implementation of ``EmployerAnalysisRepository``."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        # Idempotent — safe if init_db already ran; keeps test setup minimal.
        ensure_employer_analysis_tables(conn)

    # ------------------------------------------------------------------ read

    def load(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        *,
        generation: int | None = None,
    ) -> EmployerAnalysis | None:
        if generation is None:
            row = self._conn.execute(
                """
                SELECT * FROM job_employer_analysis
                WHERE job_url = ? AND tenant_id = ?
                ORDER BY generation DESC
                LIMIT 1
                """,
                (str(job_id), str(tenant_id)),
            ).fetchone()
        else:
            row = self._conn.execute(
                """
                SELECT * FROM job_employer_analysis
                WHERE job_url = ? AND tenant_id = ? AND generation = ?
                """,
                (str(job_id), str(tenant_id), int(generation)),
            ).fetchone()
        if row is None:
            return None
        return self._row_to_analysis(row, tenant_id, job_id)

    def get_by_cache_key(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        cache_key: str,
    ) -> EmployerAnalysis | None:
        row = self._conn.execute(
            """
            SELECT * FROM job_employer_analysis
            WHERE job_url = ? AND tenant_id = ? AND cache_key = ?
            ORDER BY generation DESC
            LIMIT 1
            """,
            (str(job_id), str(tenant_id), cache_key),
        ).fetchone()
        if row is None:
            return None
        return self._row_to_analysis(row, tenant_id, job_id)

    # ----------------------------------------------------------------- write

    def save(self, analysis: EmployerAnalysis) -> None:
        """Persist a new generation, superseding prior ones (D-13).

        Generation allocation is monotonic per ``(tenant, job)``: the aggregate
        already carries the generation the use case minted; saving the same
        generation again overwrites the canonical row + replaces its child rows.
        Prior generations are NEVER deleted — they remain audit history.
        """
        job_url = str(analysis.job_id)
        tenant = str(analysis.tenant_id)
        generation = analysis.generation
        canonical = analysis.canonical

        self._conn.execute(
            """
            INSERT INTO job_employer_analysis (
                job_url, generation, tenant_id, snapshot_hash, prompt_version,
                sdk_set_version, cache_key, role_framing, inferred_seniority,
                ideal_candidate_narrative, requirements_json, keywords_json,
                agreement_json, eeo_screen_json, legs_attempted, legs_succeeded,
                created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(job_url, generation) DO UPDATE SET
                snapshot_hash             = excluded.snapshot_hash,
                prompt_version            = excluded.prompt_version,
                sdk_set_version           = excluded.sdk_set_version,
                cache_key                 = excluded.cache_key,
                role_framing              = excluded.role_framing,
                inferred_seniority        = excluded.inferred_seniority,
                ideal_candidate_narrative = excluded.ideal_candidate_narrative,
                requirements_json         = excluded.requirements_json,
                keywords_json             = excluded.keywords_json,
                agreement_json            = excluded.agreement_json,
                eeo_screen_json           = excluded.eeo_screen_json,
                legs_attempted            = excluded.legs_attempted,
                legs_succeeded            = excluded.legs_succeeded,
                created_at                = excluded.created_at
            """,
            (
                job_url,
                generation,
                tenant,
                analysis.snapshot_hash,
                analysis.prompt_version,
                analysis.sdk_set_version,
                analysis.cache_key,
                canonical.role_framing,
                canonical.inferred_seniority,
                canonical.ideal_candidate_narrative,
                json.dumps([req.model_dump() for req in canonical.requirements], ensure_ascii=False),
                json.dumps([kw.model_dump() for kw in canonical.keywords], ensure_ascii=False),
                json.dumps(analysis.agreement.to_dict(), ensure_ascii=False),
                json.dumps(
                    [hit.to_dict() for hit in analysis.eeo_screen_hits], ensure_ascii=False
                ),
                analysis.legs_attempted,
                analysis.legs_succeeded,
                analysis.created_at,
            ),
        )

        # Replace child rows for this generation (idempotent re-save).
        self._conn.execute(
            "DELETE FROM job_employer_analysis_sub_analyses WHERE job_url = ? AND generation = ?",
            (job_url, generation),
        )
        for draft in analysis.sub_analyses:
            self._conn.execute(
                """
                INSERT INTO job_employer_analysis_sub_analyses (
                    job_url, generation, model_id, tenant_id, analysis_json
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    job_url,
                    generation,
                    draft.model_id,
                    tenant,
                    json.dumps(draft.model_dump(exclude={"model_id"}), ensure_ascii=False),
                ),
            )

        self._conn.execute(
            "DELETE FROM job_employer_analysis_failures WHERE job_url = ? AND generation = ?",
            (job_url, generation),
        )
        for failure in analysis.failures:
            self._conn.execute(
                """
                INSERT INTO job_employer_analysis_failures (
                    job_url, generation, model_id, tenant_id, error, raw_output
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (job_url, generation, failure.model_id, tenant, failure.error, failure.raw_output),
            )

        self._conn.commit()

    def next_generation(self, tenant_id: TenantId, job_id: JobId) -> int:
        """Return the next generation to write for ``(tenant, job)`` (>= 1)."""
        row = self._conn.execute(
            """
            SELECT MAX(generation) FROM job_employer_analysis
            WHERE job_url = ? AND tenant_id = ?
            """,
            (str(job_id), str(tenant_id)),
        ).fetchone()
        current = row[0] if row is not None else None
        return int(current) + 1 if current is not None else 1

    # --------------------------------------------------------------- mapping

    def _row_to_analysis(
        self,
        row: sqlite3.Row,
        tenant_id: TenantId,
        job_id: JobId,
    ) -> EmployerAnalysis:
        generation = int(row["generation"])
        canonical = JobAnalysis(
            role_framing=row["role_framing"],
            inferred_seniority=row["inferred_seniority"],
            ideal_candidate_narrative=row["ideal_candidate_narrative"],
            requirements=json.loads(row["requirements_json"]),
            keywords=json.loads(row["keywords_json"]),
        )
        sub_rows = self._conn.execute(
            """
            SELECT model_id, analysis_json FROM job_employer_analysis_sub_analyses
            WHERE job_url = ? AND generation = ?
            ORDER BY model_id
            """,
            (str(job_id), generation),
        ).fetchall()
        sub_analyses = tuple(
            JobAnalysisDraft(model_id=sub["model_id"], **json.loads(sub["analysis_json"]))
            for sub in sub_rows
        )
        failure_rows = self._conn.execute(
            """
            SELECT model_id, error, raw_output FROM job_employer_analysis_failures
            WHERE job_url = ? AND generation = ?
            ORDER BY model_id
            """,
            (str(job_id), generation),
        ).fetchall()
        failures = tuple(
            AnalysisFailure(
                model_id=f["model_id"],
                error=f["error"],
                raw_output=f["raw_output"],
            )
            for f in failure_rows
        )
        eeo_screen_hits = tuple(
            EeoScreenHit.from_dict(item)
            for item in _json_list(_row_get(row, "eeo_screen_json"))
        )
        return EmployerAnalysis(
            tenant_id=tenant_id,
            job_id=job_id,
            generation=generation,
            snapshot_hash=row["snapshot_hash"],
            prompt_version=row["prompt_version"],
            sdk_set_version=row["sdk_set_version"],
            canonical=canonical,
            sub_analyses=sub_analyses,
            failures=failures,
            agreement=AnalysisAgreement.from_dict(_json_or_empty(row["agreement_json"])),
            legs_attempted=int(row["legs_attempted"]),
            eeo_screen_hits=eeo_screen_hits,
            created_at=row["created_at"],
        )


def _json_or_empty(value: Any) -> dict[str, Any]:
    if not value:
        return {}
    parsed = json.loads(value)
    return parsed if isinstance(parsed, dict) else {}


def _json_list(value: Any) -> list[dict[str, Any]]:
    if not value:
        return []
    parsed = json.loads(value)
    return [item for item in parsed if isinstance(item, dict)] if isinstance(parsed, list) else []


def _row_get(row: sqlite3.Row, key: str) -> Any:
    """Read a column from a sqlite3.Row, tolerating its absence on older rows."""
    return row[key] if key in row.keys() else None


__all__ = ["SqliteEmployerAnalysisRepository"]
