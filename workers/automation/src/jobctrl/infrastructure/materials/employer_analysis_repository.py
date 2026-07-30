"""SqliteEmployerAnalysisRepository — local-mode adapter (Phase 1).

Persists :class:`EmployerAnalysis` aggregates to the canonical
``job_employer_analysis`` (+ ``_sub_analyses`` / ``_failures``) tables created
by :func:`database.ensure_employer_analysis_tables`. Mirrors
:class:`SqliteMaterialsRepository`: one connection per adapter, eager commit,
monotonic generation allocation, and supersede-not-destroy semantics (D-13).

The cache short-circuit (D-11/D-12) is served by :meth:`get_by_cache_key`,
which returns the latest analysis matching a snapshot+version cache key so a
re-tailor reuses the persisted record instead of re-reasoning.

The adapter persists tenant-scoped stable ``JobId`` references. During the
bounded schema-v15 compatibility window it translates stable IDs back to the
legacy physical URL key; historical URL inputs are resolved only at this
repository boundary.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from jobctrl.database import ensure_employer_analysis_tables
from jobctrl.domain.discovery.value_objects import PostingUrl
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
from jobctrl.infrastructure.discovery.sqlite_identity_resolver import (
    SqliteJobIdentityResolver,
)


class SqliteEmployerAnalysisRepository:
    """SQLite-backed implementation of ``EmployerAnalysisRepository``."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        # Idempotent — safe if init_db already ran; keeps test setup minimal.
        ensure_employer_analysis_tables(conn)
        self._reference_column = (
            "job_id"
            if "job_id"
            in {
                str(row[1])
                for row in conn.execute(
                    "PRAGMA table_info(job_employer_analysis)"
                ).fetchall()
            }
            else "job_url"
        )
        self._identity_resolver = SqliteJobIdentityResolver(conn)
        job_columns = {
            str(row[1])
            for row in conn.execute("PRAGMA table_info(jobs)").fetchall()
        }
        self._has_stable_identity = {
            "tenant_id",
            "job_id",
        }.issubset(job_columns)

    def _resolved_identity(
        self,
        tenant_id: TenantId,
        reference: JobId,
    ):
        if not self._has_stable_identity:
            return None
        raw_reference = str(reference or "").strip()
        if not raw_reference:
            raise ValueError("job_id must be non-empty")
        try:
            stable_candidate = canonical_job_id(raw_reference)
        except ValueError:
            stable_candidate = None
        identity = (
            self._identity_resolver.resolve_by_job_id(
                tenant_id,
                stable_candidate,
            )
            if stable_candidate is not None
            else None
        )
        if identity is None:
            identity = self._identity_resolver.resolve_by_posting_url(
                tenant_id,
                PostingUrl(raw_reference),
            )
        if identity is None:
            row = self._conn.execute(
                """
                SELECT job_id
                FROM jobs
                WHERE tenant_id = ? AND url = ?
                LIMIT 1
                """,
                (str(tenant_id), raw_reference),
            ).fetchone()
            if row is not None:
                identity = self._identity_resolver.resolve_by_job_id(
                    tenant_id,
                    JobId(str(row[0])),
                )
        return identity

    def _resolved_posting_url_identity(
        self,
        tenant_id: TenantId,
        posting_url: PostingUrl,
    ):
        """Resolve an explicitly URL-shaped input without UUID ambiguity."""
        if not self._has_stable_identity:
            return None
        raw_url = str(posting_url.value or "").strip()
        if not raw_url:
            raise ValueError("posting_url must be non-empty")
        direct = self._conn.execute(
            """
            SELECT job_id
            FROM jobs
            WHERE tenant_id = ? AND url = ?
            LIMIT 1
            """,
            (str(tenant_id), raw_url),
        ).fetchone()
        if direct is not None and str(direct[0] or "").strip():
            return self._identity_resolver.resolve_by_job_id(
                tenant_id,
                JobId(str(direct[0])),
            )
        return self._identity_resolver.resolve_by_posting_url(
            tenant_id,
            posting_url,
        )

    def _reference_for_read(
        self,
        tenant_id: TenantId,
        reference: JobId,
        *,
        posting_url_first: bool = False,
    ) -> tuple[str, JobId] | None:
        raw_reference = str(reference or "").strip()
        if not raw_reference:
            raise ValueError("job_id must be non-empty")
        identity = (
            self._resolved_posting_url_identity(
                tenant_id,
                PostingUrl(raw_reference),
            )
            if posting_url_first
            else self._resolved_identity(tenant_id, reference)
        )
        if self._reference_column == "job_id":
            if identity is None:
                return None
            return str(identity.job_id), identity.job_id
        if identity is not None:
            return identity.storage_url.value, identity.job_id
        return raw_reference, JobId(raw_reference)

    def _reference_for_write(
        self,
        tenant_id: TenantId,
        reference: JobId,
    ) -> tuple[str, JobId]:
        resolved = self._reference_for_read(tenant_id, reference)
        if resolved is None:
            raise ValueError(
                "no stable Job identity for employer-analysis reference: "
                f"{reference}"
            )
        return resolved

    # ------------------------------------------------------------------ read

    def load(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        *,
        generation: int | None = None,
    ) -> EmployerAnalysis | None:
        return self._load(
            tenant_id,
            job_id,
            generation=generation,
            posting_url_first=False,
        )

    def load_by_posting_url(
        self,
        tenant_id: TenantId,
        posting_url: PostingUrl,
        *,
        generation: int | None = None,
    ) -> EmployerAnalysis | None:
        """Load through the legacy URL projection boundary, URL-first."""
        return self._load(
            tenant_id,
            JobId(posting_url.value),
            generation=generation,
            posting_url_first=True,
        )

    def _load(
        self,
        tenant_id: TenantId,
        reference_input: JobId,
        *,
        generation: int | None,
        posting_url_first: bool,
    ) -> EmployerAnalysis | None:
        resolved = self._reference_for_read(
            tenant_id,
            reference_input,
            posting_url_first=posting_url_first,
        )
        if resolved is None:
            return None
        reference, stable_job_id = resolved
        predicate = (
            "tenant_id = ? AND job_id = ?"
            if self._reference_column == "job_id"
            else "tenant_id = ? AND job_url = ?"
        )
        if generation is None:
            row = self._conn.execute(
                f"""
                SELECT * FROM job_employer_analysis
                WHERE {predicate}
                ORDER BY generation DESC
                LIMIT 1
                """,
                (str(tenant_id), reference),
            ).fetchone()
        else:
            row = self._conn.execute(
                f"""
                SELECT * FROM job_employer_analysis
                WHERE {predicate} AND generation = ?
                """,
                (str(tenant_id), reference, int(generation)),
            ).fetchone()
        if row is None:
            return None
        return self._row_to_analysis(
            row,
            tenant_id,
            stable_job_id,
            reference=reference,
        )

    def get_by_cache_key(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        cache_key: str,
    ) -> EmployerAnalysis | None:
        resolved = self._reference_for_read(tenant_id, job_id)
        if resolved is None:
            return None
        reference, stable_job_id = resolved
        row = self._conn.execute(
            f"""
            SELECT * FROM job_employer_analysis
            WHERE tenant_id = ? AND {self._reference_column} = ?
              AND cache_key = ?
            ORDER BY generation DESC
            LIMIT 1
            """,
            (str(tenant_id), reference, cache_key),
        ).fetchone()
        if row is None:
            return None
        return self._row_to_analysis(
            row,
            tenant_id,
            stable_job_id,
            reference=reference,
        )

    # ----------------------------------------------------------------- write

    def save(self, analysis: EmployerAnalysis) -> None:
        """Persist a new generation, superseding prior ones (D-13).

        Generation allocation is monotonic per ``(tenant, job)``: the aggregate
        already carries the generation the use case minted; saving the same
        generation again overwrites the canonical row + replaces its child rows.
        Prior generations are NEVER deleted — they remain audit history.
        """
        tenant = str(analysis.tenant_id)
        reference, _stable_job_id = self._reference_for_write(
            analysis.tenant_id,
            analysis.job_id,
        )
        generation = analysis.generation
        canonical = analysis.canonical
        conflict_columns = (
            "tenant_id, job_id, generation"
            if self._reference_column == "job_id"
            else "job_url, generation"
        )

        self._conn.execute(
            f"""
            INSERT INTO job_employer_analysis (
                tenant_id, {self._reference_column}, generation,
                snapshot_hash, prompt_version,
                sdk_set_version, cache_key, role_framing, inferred_seniority,
                ideal_candidate_narrative, requirements_json, keywords_json,
                agreement_json, eeo_screen_json, legs_attempted, legs_succeeded,
                created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT({conflict_columns}) DO UPDATE SET
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
                reference,
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
            f"""
            DELETE FROM job_employer_analysis_sub_analyses
            WHERE tenant_id = ? AND {self._reference_column} = ?
              AND generation = ?
            """,
            (tenant, reference, generation),
        )
        for draft in analysis.sub_analyses:
            self._conn.execute(
                f"""
                INSERT INTO job_employer_analysis_sub_analyses (
                    tenant_id, {self._reference_column}, generation,
                    model_id, analysis_json
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    tenant,
                    reference,
                    generation,
                    draft.model_id,
                    json.dumps(draft.model_dump(exclude={"model_id"}), ensure_ascii=False),
                ),
            )

        self._conn.execute(
            f"""
            DELETE FROM job_employer_analysis_failures
            WHERE tenant_id = ? AND {self._reference_column} = ?
              AND generation = ?
            """,
            (tenant, reference, generation),
        )
        for failure in analysis.failures:
            self._conn.execute(
                f"""
                INSERT INTO job_employer_analysis_failures (
                    tenant_id, {self._reference_column}, generation,
                    model_id, error, raw_output
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    tenant,
                    reference,
                    generation,
                    failure.model_id,
                    failure.error,
                    failure.raw_output,
                ),
            )

        self._conn.commit()

    def next_generation(self, tenant_id: TenantId, job_id: JobId) -> int:
        """Return the next generation to write for ``(tenant, job)`` (>= 1)."""
        resolved = self._reference_for_read(tenant_id, job_id)
        if resolved is None:
            return 1
        reference, _stable_job_id = resolved
        row = self._conn.execute(
            f"""
            SELECT MAX(generation) FROM job_employer_analysis
            WHERE tenant_id = ? AND {self._reference_column} = ?
            """,
            (str(tenant_id), reference),
        ).fetchone()
        current = row[0] if row is not None else None
        return int(current) + 1 if current is not None else 1

    # --------------------------------------------------------------- mapping

    def _row_to_analysis(
        self,
        row: sqlite3.Row,
        tenant_id: TenantId,
        job_id: JobId,
        *,
        reference: str,
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
            f"""
            SELECT model_id, analysis_json FROM job_employer_analysis_sub_analyses
            WHERE tenant_id = ? AND {self._reference_column} = ?
              AND generation = ?
            ORDER BY model_id
            """,
            (str(tenant_id), reference, generation),
        ).fetchall()
        sub_analyses = tuple(
            JobAnalysisDraft(model_id=sub["model_id"], **json.loads(sub["analysis_json"]))
            for sub in sub_rows
        )
        failure_rows = self._conn.execute(
            f"""
            SELECT model_id, error, raw_output FROM job_employer_analysis_failures
            WHERE tenant_id = ? AND {self._reference_column} = ?
              AND generation = ?
            ORDER BY model_id
            """,
            (str(tenant_id), reference, generation),
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
