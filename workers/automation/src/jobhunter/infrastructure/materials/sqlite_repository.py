"""SqliteMaterialsRepository — local-mode adapter for the Materials context.

Persists :class:`MaterialsSet` aggregates to the ``job_materials`` +
``job_materials_artifacts`` tables created by
:func:`database.ensure_materials_tables`. Generation invariants are
enforced at save time: a fresh aggregate must carry
``generation = current_max + 1`` (or ``1`` when none exists). Saving the
*same* generation again is allowed and overwrites the row — that's how
use cases append cover letters / PDFs to an existing generation.

Local-mode treats ``job_id`` as the legacy ``jobs.url`` primary key. When
the cloud cutover (Phase 9) introduces stable system-generated ``JobId``
values, the adapter swaps the column without touching the port.

See ddd-target.md §7.1 / §7.2 (per-aggregate repository, schema decoupling).
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

from jobhunter.database import ensure_tailoring_policy_tables
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.materials.aggregate import MaterialsSet
from jobhunter.domain.materials.entities import Artifact
from jobhunter.domain.materials.policy import TailoringPolicy
from jobhunter.domain.materials.value_objects import (
    ArtifactStatus,
    ArtifactType,
    JudgeVerdict,
    RenderFormat,
    ValidationResult,
)
from jobhunter.domain.tenant import LOCAL_TENANT, TenantId


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class MaterialsGenerationConflict(ValueError):
    """Raised when ``save`` is given a non-monotonic generation.

    Carries the expected next generation so the caller can rebuild the
    aggregate via ``MaterialsSetFactory.next_generation`` instead of
    guessing.
    """

    def __init__(self, *, job_id: JobId, attempted: int, expected: int) -> None:
        self.job_id = job_id
        self.attempted = attempted
        self.expected = expected
        super().__init__(
            f"MaterialsSet generation conflict for job_id={job_id!r}: "
            f"got generation={attempted}, expected {expected} (or current=={attempted - 1})"
        )


# ---------------------------------------------------------------------------
# Repository adapter
# ---------------------------------------------------------------------------


class SqliteMaterialsRepository:
    """SQLite-backed implementation of ``MaterialsRepository``.

    A single ``sqlite3.Connection`` is held for the lifetime of the
    adapter; ``save`` commits eagerly so consumers see the row immediately.
    Tests inject their own connection via the constructor for isolation.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    def load(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        *,
        generation: int | None = None,
    ) -> MaterialsSet | None:
        if generation is None:
            row = self._conn.execute(
                """
                SELECT job_url, generation, status, created_at, updated_at,
                       last_validation_json, last_verdict_json, metadata_json
                FROM job_materials
                WHERE job_url = ? AND tenant_id = ?
                ORDER BY generation DESC
                LIMIT 1
                """,
                (str(job_id), str(tenant_id)),
            ).fetchone()
        else:
            row = self._conn.execute(
                """
                SELECT job_url, generation, status, created_at, updated_at,
                       last_validation_json, last_verdict_json, metadata_json
                FROM job_materials
                WHERE job_url = ? AND tenant_id = ? AND generation = ?
                """,
                (str(job_id), str(tenant_id), int(generation)),
            ).fetchone()
        if row is None:
            return None
        return self._row_to_materials(row, tenant_id)

    def list_pending_tailor(
        self,
        tenant_id: TenantId,
        *,
        min_score: int = 7,
        limit: int = 0,
        retailor: bool = False,
    ) -> list[JobId]:
        """Return job URLs ready for tailoring per §4.5 lifecycle.

        Eligibility:

          * ``full_description IS NOT NULL`` (enrichment done).
          * Latest score ``fit_score >= min_score``.
          * Either no MaterialsSet exists yet OR ``retailor=True``.

        ``retailor`` widens the predicate to include jobs whose latest
        generation already has an approved tailored resume — the use case
        will mint a new generation when it picks them up.
        """
        params: list[Any] = [str(tenant_id)]
        # Reuse the score subquery shape used elsewhere; keep it inline so
        # this adapter stays self-contained.
        score_join = (
            "LEFT JOIN ("
            "SELECT s.job_url AS sj_job_url, s.fit_score AS sj_fit_score, "
            "CASE WHEN json_valid(s.breakdown_json) "
            "THEN LOWER(COALESCE(CAST(json_extract(s.breakdown_json, '$.eligibility.status') AS TEXT), '')) "
            "ELSE '' END AS sj_eligibility_status, "
            "CASE WHEN json_valid(s.breakdown_json) "
            "THEN COALESCE("
            "json_array_length(s.breakdown_json, '$.eligibility.hard_blockers'), "
            "json_array_length(s.breakdown_json, '$.eligibility.hardBlockers'), "
            "json_array_length(s.breakdown_json, '$.eligibility.blockers'), "
            "0) ELSE 0 END AS sj_hard_blocker_count "
            "FROM job_scores s "
            "INNER JOIN ("
            "SELECT job_url, MAX(version) AS max_version FROM job_scores GROUP BY job_url"
            ") latest ON latest.job_url = s.job_url AND latest.max_version = s.version "
            "WHERE s.tenant_id = ?"
            ") sj ON sj.sj_job_url = j.url"
        )
        materials_join = (
            "LEFT JOIN ("
            "SELECT m.job_url AS mj_job_url, m.generation AS mj_gen, "
            "tr.status AS mj_resume_status "
            "FROM job_materials m "
            "INNER JOIN ("
            "SELECT job_url, MAX(generation) AS mg FROM job_materials GROUP BY job_url"
            ") latest ON latest.job_url = m.job_url AND latest.mg = m.generation "
            "LEFT JOIN job_materials_artifacts tr ON tr.job_url = m.job_url "
            "AND tr.generation = m.generation AND tr.artifact_type = 'tailored_resume' "
            "AND tr.status = 'approved' "
            "WHERE m.tenant_id = ?"
            ") mj ON mj.mj_job_url = j.url"
        )
        params.append(str(tenant_id))

        if retailor:
            where = (
                "j.full_description IS NOT NULL "
                "AND COALESCE(sj.sj_fit_score, j.fit_score) >= ? "
                "AND COALESCE(sj.sj_eligibility_status, '') != 'blocked' "
                "AND COALESCE(sj.sj_hard_blocker_count, 0) = 0"
            )
        else:
            where = (
                "j.full_description IS NOT NULL "
                "AND COALESCE(sj.sj_fit_score, j.fit_score) >= ? "
                "AND COALESCE(sj.sj_eligibility_status, '') != 'blocked' "
                "AND COALESCE(sj.sj_hard_blocker_count, 0) = 0 "
                "AND mj.mj_resume_status IS NULL"
            )
        params.append(int(min_score))
        sql = (
            f"SELECT j.url FROM jobs j {score_join} {materials_join} "
            f"WHERE {where} "
            "ORDER BY COALESCE(sj.sj_fit_score, j.fit_score) DESC, j.discovered_at DESC"
        )
        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [JobId(row[0]) for row in rows if row[0]]

    def list_pending_cover(
        self,
        tenant_id: TenantId,
        *,
        min_score: int = 7,
        limit: int = 0,
    ) -> list[JobId]:
        """Return job URLs whose latest generation has an approved
        tailored resume PDF but no approved cover letter."""
        params: list[Any] = [str(tenant_id)]
        score_join = (
            "LEFT JOIN ("
            "SELECT s.job_url AS sj_job_url, s.fit_score AS sj_fit_score, "
            "CASE WHEN json_valid(s.breakdown_json) "
            "THEN LOWER(COALESCE(CAST(json_extract(s.breakdown_json, '$.eligibility.status') AS TEXT), '')) "
            "ELSE '' END AS sj_eligibility_status, "
            "CASE WHEN json_valid(s.breakdown_json) "
            "THEN COALESCE("
            "json_array_length(s.breakdown_json, '$.eligibility.hard_blockers'), "
            "json_array_length(s.breakdown_json, '$.eligibility.hardBlockers'), "
            "json_array_length(s.breakdown_json, '$.eligibility.blockers'), "
            "0) ELSE 0 END AS sj_hard_blocker_count "
            "FROM job_scores s "
            "INNER JOIN ("
            "SELECT job_url, MAX(version) AS max_version FROM job_scores GROUP BY job_url"
            ") latest ON latest.job_url = s.job_url AND latest.max_version = s.version "
            "WHERE s.tenant_id = ?"
            ") sj ON sj.sj_job_url = j.url"
        )
        params.append(str(tenant_id))
        materials_join = (
            "INNER JOIN ("
            "SELECT m.job_url AS mj_job_url, m.generation AS mj_gen, "
            "tr.status AS mj_resume_status, rpdf.status AS mj_resume_pdf_status, "
            "cl.status AS mj_cover_status "
            "FROM job_materials m "
            "INNER JOIN ("
            "SELECT job_url, MAX(generation) AS mg FROM job_materials GROUP BY job_url"
            ") latest ON latest.job_url = m.job_url AND latest.mg = m.generation "
            "INNER JOIN job_materials_artifacts tr ON tr.job_url = m.job_url "
            "AND tr.generation = m.generation AND tr.artifact_type = 'tailored_resume' "
            "AND tr.status = 'approved' "
            "INNER JOIN job_materials_artifacts rpdf ON rpdf.job_url = m.job_url "
            "AND rpdf.generation = m.generation AND rpdf.artifact_type = 'resume_pdf' "
            "AND rpdf.status = 'approved' "
            "LEFT JOIN job_materials_artifacts cl ON cl.job_url = m.job_url "
            "AND cl.generation = m.generation AND cl.artifact_type = 'cover_letter' "
            "AND cl.status = 'approved' "
            "WHERE m.tenant_id = ?"
            ") mj ON mj.mj_job_url = j.url"
        )
        params.append(int(min_score))
        sql = (
            f"SELECT j.url FROM jobs j {score_join} {materials_join} "
            "WHERE COALESCE(sj.sj_fit_score, j.fit_score) >= ? "
            "AND COALESCE(sj.sj_eligibility_status, '') != 'blocked' "
            "AND COALESCE(sj.sj_hard_blocker_count, 0) = 0 "
            "AND mj.mj_cover_status IS NULL "
            "ORDER BY COALESCE(sj.sj_fit_score, j.fit_score) DESC, j.discovered_at DESC"
        )
        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [JobId(row[0]) for row in rows if row[0]]

    def list_pending_pdf(
        self,
        tenant_id: TenantId,
        *,
        limit: int = 0,
    ) -> list[JobId]:
        """Return job URLs whose latest generation has text artifacts but
        is missing one or more PDFs."""
        params: list[Any] = [str(tenant_id)]
        sql = (
            "SELECT m.job_url FROM job_materials m "
            "INNER JOIN ("
            "SELECT job_url, MAX(generation) AS mg FROM job_materials GROUP BY job_url"
            ") latest ON latest.job_url = m.job_url AND latest.mg = m.generation "
            "INNER JOIN job_materials_artifacts tr ON tr.job_url = m.job_url "
            "AND tr.generation = m.generation AND tr.status = 'approved' "
            "AND tr.artifact_type IN ('tailored_resume', 'cover_letter') "
            "LEFT JOIN job_materials_artifacts pdf ON pdf.job_url = m.job_url "
            "AND pdf.generation = m.generation AND pdf.status = 'approved' "
            "AND ((tr.artifact_type = 'tailored_resume' AND pdf.artifact_type = 'resume_pdf') "
            "  OR (tr.artifact_type = 'cover_letter' AND pdf.artifact_type = 'cover_letter_pdf')) "
            "WHERE m.tenant_id = ? AND pdf.path IS NULL "
            "GROUP BY m.job_url "
            "ORDER BY MAX(m.updated_at) DESC"
        )
        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [JobId(row[0]) for row in rows if row[0]]

    def list_by_status(
        self,
        tenant_id: TenantId,
        status: ArtifactStatus,
        *,
        limit: int = 0,
    ) -> list[MaterialsSet]:
        """Return latest-generation aggregates whose tailored resume
        artifact carries the requested status."""
        if not isinstance(status, ArtifactStatus):
            raise TypeError(
                f"list_by_status requires ArtifactStatus, got {type(status).__name__}"
            )
        params: list[Any] = [str(tenant_id), status.value]
        sql = (
            "SELECT m.job_url, m.generation, m.status, m.created_at, m.updated_at, "
            "m.last_validation_json, m.last_verdict_json, m.metadata_json "
            "FROM job_materials m "
            "INNER JOIN ("
            "SELECT job_url, MAX(generation) AS mg FROM job_materials GROUP BY job_url"
            ") latest ON latest.job_url = m.job_url AND latest.mg = m.generation "
            "INNER JOIN job_materials_artifacts tr ON tr.job_url = m.job_url "
            "AND tr.generation = m.generation AND tr.artifact_type = 'tailored_resume' "
            "AND tr.status = ? "
            "WHERE m.tenant_id = ? "
            "ORDER BY m.updated_at DESC"
        )
        # Param order in the WHERE: tr.status (status.value) then tenant_id
        params = [status.value, str(tenant_id)]
        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [self._row_to_materials(row, tenant_id) for row in rows]

    # ------------------------------------------------------------------
    # Write
    # ------------------------------------------------------------------

    def save(self, materials: MaterialsSet) -> None:
        latest = self._conn.execute(
            "SELECT COALESCE(MAX(generation), 0) AS g FROM job_materials "
            "WHERE job_url = ? AND tenant_id = ?",
            (str(materials.job_id), str(materials.tenant_id)),
        ).fetchone()
        current_max = int(latest[0] if latest else 0)
        # Allow either: append to current generation (re-save) OR mint
        # the next one. Anything else is a conflict.
        if materials.generation not in (current_max, current_max + 1):
            raise MaterialsGenerationConflict(
                job_id=materials.job_id,
                attempted=materials.generation,
                expected=current_max + 1,
            )

        # Upsert the parent row.
        self._conn.execute(
            """
            INSERT INTO job_materials (
                job_url, generation, tenant_id, status,
                created_at, updated_at,
                last_validation_json, last_verdict_json, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(job_url, generation) DO UPDATE SET
                status = excluded.status,
                updated_at = excluded.updated_at,
                last_validation_json = excluded.last_validation_json,
                last_verdict_json = excluded.last_verdict_json,
                metadata_json = excluded.metadata_json
            """,
            (
                str(materials.job_id),
                materials.generation,
                str(materials.tenant_id),
                materials.status,
                materials.created_at,
                materials.updated_at,
                _dumps(
                    materials.last_validation.to_dict() if materials.last_validation else None
                ),
                _dumps(
                    materials.last_verdict.to_dict() if materials.last_verdict else None
                ),
                _dumps(materials.metadata) if materials.metadata else None,
            ),
        )

        # Persist every present artifact slot. Slots that were dropped
        # between two saves of the same generation are left untouched —
        # use cases append, never delete.
        for artifact in materials.artifacts:
            self._upsert_artifact(materials, artifact)

        self._conn.commit()

    def suppress_active_artifacts(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        *,
        reason: str,
        suppressed_at: str,
    ) -> MaterialsSet | None:
        materials = self.load(tenant_id, job_id)
        if materials is None:
            return None
        suppressed = materials.suppress_active_artifacts(at=suppressed_at, reason=reason)
        self.save(suppressed)
        return suppressed

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _upsert_artifact(self, materials: MaterialsSet, artifact: Artifact) -> None:
        self._conn.execute(
            """
            INSERT INTO job_materials_artifacts (
                job_url, generation, artifact_type, artifact_id,
                status, path, render_format, size_bytes,
                metadata_json, created_at, superseded_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(job_url, generation, artifact_type) DO UPDATE SET
                artifact_id = excluded.artifact_id,
                status = excluded.status,
                path = excluded.path,
                render_format = excluded.render_format,
                size_bytes = excluded.size_bytes,
                metadata_json = excluded.metadata_json,
                created_at = excluded.created_at,
                superseded_at = excluded.superseded_at
            """,
            (
                str(materials.job_id),
                materials.generation,
                artifact.type.value,
                artifact.artifact_id,
                artifact.status.value,
                artifact.path,
                artifact.render_format.value,
                artifact.size_bytes,
                _dumps(artifact.metadata) if artifact.metadata else None,
                artifact.created_at,
                artifact.superseded_at,
            ),
        )

    def _row_to_materials(self, row: Any, tenant_id: TenantId) -> MaterialsSet:
        if isinstance(row, sqlite3.Row):
            job_url = row["job_url"]
            generation = row["generation"]
            status = row["status"]
            created_at = row["created_at"]
            updated_at = row["updated_at"]
            validation_json = row["last_validation_json"]
            verdict_json = row["last_verdict_json"]
            metadata_json = row["metadata_json"]
        else:
            (
                job_url,
                generation,
                status,
                created_at,
                updated_at,
                validation_json,
                verdict_json,
                metadata_json,
            ) = row

        artifact_rows = self._conn.execute(
            """
            SELECT artifact_type, artifact_id, status, path, render_format,
                   size_bytes, metadata_json, created_at, superseded_at
            FROM job_materials_artifacts
            WHERE job_url = ? AND generation = ?
            """,
            (str(job_url), int(generation)),
        ).fetchall()

        slot_kwargs: dict[str, Artifact | None] = {
            "tailored_resume": None,
            "cover_letter": None,
            "resume_pdf": None,
            "cover_letter_pdf": None,
        }
        slot_for_type = {
            ArtifactType.TAILORED_RESUME: "tailored_resume",
            ArtifactType.COVER_LETTER: "cover_letter",
            ArtifactType.RESUME_PDF: "resume_pdf",
            ArtifactType.COVER_LETTER_PDF: "cover_letter_pdf",
        }
        for art_row in artifact_rows:
            artifact = Artifact(
                artifact_id=str(art_row["artifact_id"]),
                type=ArtifactType(art_row["artifact_type"]),
                status=ArtifactStatus(art_row["status"]),
                path=str(art_row["path"]),
                render_format=RenderFormat(art_row["render_format"]),
                created_at=str(art_row["created_at"]),
                size_bytes=(
                    int(art_row["size_bytes"])
                    if art_row["size_bytes"] is not None
                    else None
                ),
                metadata=_loads(art_row["metadata_json"]) or {},
                superseded_at=(
                    str(art_row["superseded_at"]) if art_row["superseded_at"] else None
                ),
            )
            slot_kwargs[slot_for_type[artifact.type]] = artifact

        validation = ValidationResult.from_dict(_loads(validation_json)) if validation_json else None
        verdict = JudgeVerdict.from_dict(_loads(verdict_json))

        return MaterialsSet(
            tenant_id=tenant_id or LOCAL_TENANT,
            job_id=JobId(str(job_url)),
            generation=int(generation),
            status=str(status),
            created_at=str(created_at),
            updated_at=str(updated_at),
            tailored_resume=slot_kwargs["tailored_resume"],
            cover_letter=slot_kwargs["cover_letter"],
            resume_pdf=slot_kwargs["resume_pdf"],
            cover_letter_pdf=slot_kwargs["cover_letter_pdf"],
            last_validation=validation,
            last_verdict=verdict,
            metadata=_loads(metadata_json) or {},
        )


# ---------------------------------------------------------------------------
# JSON helpers
# ---------------------------------------------------------------------------


def _dumps(value: Any) -> str | None:
    if value is None:
        return None
    return json.dumps(value, sort_keys=True)


def _loads(value: str | None) -> dict | None:
    if not value:
        return None
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


class SqliteTailoringPolicyRepository:
    """SQLite-backed current policy adapter for the Materials context."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        ensure_tailoring_policy_tables(conn)

    def get_current(self, tenant_id: TenantId) -> TailoringPolicy | None:
        row = self._conn.execute(
            """
            SELECT tenant_id, version, prompt_version, schema_version,
                   judge_schema_version, prompt_fingerprint, config_fingerprint,
                   profile_policy_fingerprint, custom_prompt_fingerprint,
                   generator_settings_json, judge_settings_json,
                   runtime_settings_json, rollback_of_version, rollback_reason,
                   created_at, created_from_event_id
            FROM tailoring_policies
            WHERE tenant_id = ?
            ORDER BY version DESC
            LIMIT 1
            """,
            (str(tenant_id),),
        ).fetchone()
        if row is None:
            return None
        return self._row_to_policy(row)

    def save(self, policy: TailoringPolicy) -> None:
        self._insert(policy)
        self._conn.commit()

    def _insert(self, policy: TailoringPolicy) -> None:
        self._conn.execute(
            """
            INSERT INTO tailoring_policies (
                tenant_id, version, prompt_version, schema_version,
                judge_schema_version, prompt_fingerprint, config_fingerprint,
                profile_policy_fingerprint, custom_prompt_fingerprint,
                generator_settings_json, judge_settings_json,
                runtime_settings_json, rollback_of_version, rollback_reason,
                created_at, created_from_event_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(policy.tenant_id),
                policy.version,
                policy.prompt_version,
                policy.schema_version,
                policy.judge_schema_version,
                policy.prompt_fingerprint,
                policy.config_fingerprint,
                policy.profile_policy_fingerprint,
                policy.custom_prompt_fingerprint,
                json.dumps(policy.generator_settings, sort_keys=True),
                json.dumps(policy.judge_settings, sort_keys=True),
                json.dumps(policy.runtime_settings, sort_keys=True),
                policy.rollback_of_version,
                policy.rollback_reason,
                policy.created_at or _utc_now(),
                policy.created_from_event_id,
            ),
        )

    def resolve_current(self, candidate: TailoringPolicy) -> TailoringPolicy:
        self._conn.execute("BEGIN IMMEDIATE")
        try:
            current = self.get_current(candidate.tenant_id)
            if current is not None and current.same_config_as(candidate):
                self._conn.commit()
                return current

            next_version = 1 if current is None else current.version + 1
            policy = TailoringPolicy(
                tenant_id=candidate.tenant_id,
                version=next_version,
                prompt_version=candidate.prompt_version,
                schema_version=candidate.schema_version,
                judge_schema_version=candidate.judge_schema_version,
                prompt_fingerprint=candidate.prompt_fingerprint,
                config_fingerprint=candidate.config_fingerprint,
                profile_policy_fingerprint=candidate.profile_policy_fingerprint,
                custom_prompt_fingerprint=candidate.custom_prompt_fingerprint,
                generator_settings=candidate.generator_settings,
                judge_settings=candidate.judge_settings,
                runtime_settings=candidate.runtime_settings,
                rollback_of_version=candidate.rollback_of_version,
                rollback_reason=candidate.rollback_reason,
                created_at=candidate.created_at or _utc_now(),
                created_from_event_id=candidate.created_from_event_id,
            )
            self._insert(policy)
            self._conn.commit()
            return policy
        except Exception:
            self._conn.rollback()
            raise

    @staticmethod
    def _row_to_policy(row: Any) -> TailoringPolicy:
        return TailoringPolicy.from_persistence(
            tenant_id=TenantId(str(_row_value(row, "tenant_id", 0))),
            version=int(_row_value(row, "version", 1)),
            prompt_version=str(_row_value(row, "prompt_version", 2)),
            schema_version=str(_row_value(row, "schema_version", 3)),
            judge_schema_version=str(_row_value(row, "judge_schema_version", 4)),
            prompt_fingerprint=str(_row_value(row, "prompt_fingerprint", 5)),
            config_fingerprint=str(_row_value(row, "config_fingerprint", 6)),
            profile_policy_fingerprint=str(_row_value(row, "profile_policy_fingerprint", 7)),
            custom_prompt_fingerprint=str(_row_value(row, "custom_prompt_fingerprint", 8)),
            generator_settings=_loads(_row_value(row, "generator_settings_json", 9)) or {},
            judge_settings=_loads(_row_value(row, "judge_settings_json", 10)) or {},
            runtime_settings=_loads(_row_value(row, "runtime_settings_json", 11)) or {},
            rollback_of_version=_row_value(row, "rollback_of_version", 12),
            rollback_reason=str(_row_value(row, "rollback_reason", 13) or ""),
            created_at=str(_row_value(row, "created_at", 14)),
            created_from_event_id=_row_value(row, "created_from_event_id", 15),
        )


def _row_value(row: Any, name: str, index: int) -> Any:
    if isinstance(row, sqlite3.Row):
        return row[name]
    return row[index]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
