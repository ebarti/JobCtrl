"""Exact-v7 SQLite adapter for employer-analysis aggregates.

Persists :class:`EmployerAnalysis` aggregates to the canonical
``job_employer_analysis`` (+ ``_sub_analyses`` / ``_failures``) tables.
The database lifecycle owns schema creation and migration; this runtime
repository requires the exact-v7 tenant-scoped ``JobId`` shape.

The cache short-circuit (D-11/D-12) is served by :meth:`get_by_cache_key`,
which returns the latest analysis matching a snapshot+version cache key so a
re-tailor reuses the persisted record instead of re-reasoning.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.materials.analysis import (
    AnalysisAgreement,
    AnalysisFailure,
    EeoScreenHit,
    EmployerAnalysis,
    JobAnalysis,
    JobAnalysisDraft,
)
from jobctrl.domain.tenant import TenantId


class SqliteEmployerAnalysisRepository:
    """SQLite-backed implementation of ``EmployerAnalysisRepository``."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    # ------------------------------------------------------------------ read

    def load(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        *,
        generation: int | None = None,
    ) -> EmployerAnalysis | None:
        stable_job_id = canonical_job_id(str(job_id))
        if generation is None:
            row = self._conn.execute(
                """
                SELECT * FROM job_employer_analysis
                WHERE tenant_id = ? AND job_id = ?
                ORDER BY generation DESC
                LIMIT 1
                """,
                (str(tenant_id), str(stable_job_id)),
            ).fetchone()
        else:
            row = self._conn.execute(
                """
                SELECT * FROM job_employer_analysis
                WHERE tenant_id = ? AND job_id = ? AND generation = ?
                """,
                (str(tenant_id), str(stable_job_id), int(generation)),
            ).fetchone()
        if row is None:
            return None
        return self._row_to_analysis(row, tenant_id, stable_job_id)

    def get_by_cache_key(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        cache_key: str,
    ) -> EmployerAnalysis | None:
        stable_job_id = canonical_job_id(str(job_id))
        row = self._conn.execute(
            """
            SELECT * FROM job_employer_analysis
            WHERE tenant_id = ? AND job_id = ? AND cache_key = ?
            ORDER BY generation DESC
            LIMIT 1
            """,
            (str(tenant_id), str(stable_job_id), cache_key),
        ).fetchone()
        if row is None:
            return None
        return self._row_to_analysis(row, tenant_id, stable_job_id)

    # ----------------------------------------------------------------- write

    def save(self, analysis: EmployerAnalysis) -> None:
        """Persist a new generation, superseding prior ones (D-13).

        Generation allocation is monotonic per ``(tenant, job)``: the aggregate
        already carries the generation the use case minted; saving the same
        generation again overwrites the canonical row + replaces its child rows.
        Prior generations are NEVER deleted — they remain audit history.
        """
        job_id = canonical_job_id(str(analysis.job_id))
        savepoint = "employer_analysis_aggregate_save"
        self._conn.execute(f"SAVEPOINT {savepoint}")
        try:
            self._save_rows(analysis, job_id)
        except BaseException:
            self._conn.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
            self._conn.execute(f"RELEASE SAVEPOINT {savepoint}")
            raise
        else:
            self._conn.execute(f"RELEASE SAVEPOINT {savepoint}")

    def _save_rows(
        self,
        analysis: EmployerAnalysis,
        job_id: JobId,
    ) -> None:
        tenant = str(analysis.tenant_id)
        generation = analysis.generation
        canonical = analysis.canonical

        self._conn.execute(
            """
            INSERT INTO job_employer_analysis (
                tenant_id, job_id, generation, snapshot_hash, prompt_version,
                sdk_set_version, cache_key, role_framing, inferred_seniority,
                ideal_candidate_narrative, requirements_json, keywords_json,
                agreement_json, eeo_screen_json, legs_attempted, legs_succeeded,
                created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, job_id, generation) DO UPDATE SET
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
                tenant,
                str(job_id),
                generation,
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
                json.dumps([hit.to_dict() for hit in analysis.eeo_screen_hits], ensure_ascii=False),
                analysis.legs_attempted,
                analysis.legs_succeeded,
                analysis.created_at,
            ),
        )

        # Replace child rows for this generation (idempotent re-save).
        self._conn.execute(
            "DELETE FROM job_employer_analysis_sub_analyses WHERE tenant_id = ? AND job_id = ? AND generation = ?",
            (tenant, str(job_id), generation),
        )
        for draft in analysis.sub_analyses:
            self._conn.execute(
                """
                INSERT INTO job_employer_analysis_sub_analyses (
                    tenant_id, job_id, generation, model_id, analysis_json
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    tenant,
                    str(job_id),
                    generation,
                    draft.model_id,
                    json.dumps(draft.model_dump(exclude={"model_id"}), ensure_ascii=False),
                ),
            )

        self._conn.execute(
            "DELETE FROM job_employer_analysis_failures WHERE tenant_id = ? AND job_id = ? AND generation = ?",
            (tenant, str(job_id), generation),
        )
        for failure in analysis.failures:
            self._conn.execute(
                """
                INSERT INTO job_employer_analysis_failures (
                    tenant_id, job_id, generation, model_id, error, raw_output
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    tenant,
                    str(job_id),
                    generation,
                    failure.model_id,
                    failure.error,
                    failure.raw_output,
                ),
            )

    def next_generation(self, tenant_id: TenantId, job_id: JobId) -> int:
        """Return the next generation to write for ``(tenant, job)`` (>= 1)."""
        stable_job_id = canonical_job_id(str(job_id))
        row = self._conn.execute(
            """
            SELECT MAX(generation) FROM job_employer_analysis
            WHERE tenant_id = ? AND job_id = ?
            """,
            (str(tenant_id), str(stable_job_id)),
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
            WHERE tenant_id = ? AND job_id = ? AND generation = ?
            ORDER BY model_id
            """,
            (str(tenant_id), str(job_id), generation),
        ).fetchall()
        sub_analyses = tuple(
            JobAnalysisDraft(model_id=sub["model_id"], **json.loads(sub["analysis_json"])) for sub in sub_rows
        )
        failure_rows = self._conn.execute(
            """
            SELECT model_id, error, raw_output FROM job_employer_analysis_failures
            WHERE tenant_id = ? AND job_id = ? AND generation = ?
            ORDER BY model_id
            """,
            (str(tenant_id), str(job_id), generation),
        ).fetchall()
        failures = tuple(
            AnalysisFailure(
                model_id=f["model_id"],
                error=f["error"],
                raw_output=f["raw_output"],
            )
            for f in failure_rows
        )
        eeo_screen_hits = tuple(EeoScreenHit.from_dict(item) for item in _json_list(row["eeo_screen_json"]))
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


__all__ = ["SqliteEmployerAnalysisRepository"]
