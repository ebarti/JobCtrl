"""SQLite adapters for the Materials context.

``SqliteMaterialsRepository`` persists :class:`MaterialsSet` aggregates to the
exact-v7 tenant-scoped ``job_materials`` and ``job_materials_artifacts`` tables.
Generation invariants are enforced atomically at save time: a fresh aggregate
must carry ``generation = current_max + 1`` (or ``1`` when none exists).
Saving the *same* generation again is allowed only when its collision-resistant
lineage token matches the persisted aggregate — that's how use cases append
cover letters / PDFs without letting a stale concurrent creator replace the
winning generation.

Internal aggregate identity is the stable tenant-scoped ``JobId``. URLs are
external locators and are not accepted by the aggregate persistence methods.

See ddd-target.md §7.1 / §7.2 (per-aggregate repository, schema decoupling).
"""

from __future__ import annotations

import hashlib
import json
import math
import sqlite3
from datetime import datetime, timezone
from typing import Any

from jobctrl.database import effective_tailoring_min_score, ensure_tailoring_policy_tables
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.materials.aggregate import MaterialsSet
from jobctrl.domain.materials.entities import Artifact
from jobctrl.domain.materials.policy import (
    TailoringPolicy,
    TailoringPolicyChangedError,
    TailoringPolicyRollbackReason,
)
from jobctrl.domain.operations.learning import (
    LearningRecommendationDecision,
    LearningRecommendationReview,
    TailoringRuleEffect,
)
from jobctrl.domain.materials.value_objects import (
    ArtifactStatus,
    ArtifactType,
    JudgeVerdict,
    RenderFormat,
    ValidationResult,
)
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.materials.unit_of_work import SqliteUnitOfWork

_LINEAGE_KEY = "__jobctrl_materials_lineage_id"


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
            f"got generation={attempted}, expected existing generation or next generation={expected}"
        )


class LearningRecommendationReviewError(ValueError):
    """Raised when an explicit recommendation decision cannot be applied."""


class TailoringPolicyRevisionError(ValueError):
    """Raised when a requested policy history operation is not valid."""


# ---------------------------------------------------------------------------
# Repository adapter
# ---------------------------------------------------------------------------


class SqliteMaterialsRepository:
    """SQLite-backed implementation of ``MaterialsRepository``.

    A single ``sqlite3.Connection`` is held for the lifetime of the
    adapter; ``save`` commits eagerly so consumers see the row immediately.
    Tests inject their own connection via the constructor for isolation.

    When a :class:`SqliteUnitOfWork` is supplied and active, ``save`` stages
    its writes and defers the commit to the unit of work, so a multi-write
    persist block (e.g. the tailor generation flip) commits atomically.
    """

    def __init__(
        self,
        conn: sqlite3.Connection,
        *,
        unit_of_work: SqliteUnitOfWork | None = None,
    ) -> None:
        self._conn = conn
        self._unit_of_work = unit_of_work

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
        stable_job_id = canonical_job_id(str(job_id))
        if generation is None:
            row = self._conn.execute(
                """
                SELECT job_id, generation, status, created_at, updated_at,
                       last_validation_json, last_verdict_json, metadata_json
                FROM job_materials
                WHERE tenant_id = ? AND job_id = ?
                ORDER BY generation DESC
                LIMIT 1
                """,
                (str(tenant_id), str(stable_job_id)),
            ).fetchone()
        else:
            row = self._conn.execute(
                """
                SELECT job_id, generation, status, created_at, updated_at,
                       last_validation_json, last_verdict_json, metadata_json
                FROM job_materials
                WHERE tenant_id = ? AND job_id = ? AND generation = ?
                """,
                (str(tenant_id), str(stable_job_id), int(generation)),
            ).fetchone()
        if row is None:
            return None
        return self._row_to_materials(row, tenant_id)

    def load_current_approved(
        self,
        tenant_id: TenantId,
        job_id: JobId,
    ) -> MaterialsSet | None:
        """Return the newest generation with an approved tailored resume.

        Re-tailoring writes rejected generations for audit. Those generations
        are history, not the current reviewable artifact, so downstream stages
        such as cover/PDF generation need this approved-material view instead of
        the raw latest generation.
        """
        stable_job_id = canonical_job_id(str(job_id))
        row = self._conn.execute(
            """
            SELECT m.job_id, m.generation, m.status, m.created_at, m.updated_at,
                   m.last_validation_json, m.last_verdict_json, m.metadata_json
            FROM job_materials m
            INNER JOIN (
                SELECT tenant_id, job_id, MAX(generation) AS generation
                FROM job_materials_artifacts
                WHERE tenant_id = ?
                  AND job_id = ?
                  AND artifact_type = 'tailored_resume'
                  AND status = 'approved'
                GROUP BY tenant_id, job_id
            ) current
              ON current.tenant_id = m.tenant_id
             AND current.job_id = m.job_id
             AND current.generation = m.generation
            WHERE m.tenant_id = ? AND m.job_id = ?
            """,
            (
                str(tenant_id),
                str(stable_job_id),
                str(tenant_id),
                str(stable_job_id),
            ),
        ).fetchone()
        if row is None:
            return None
        return self._row_to_materials(row, tenant_id)

    def resolve_effective_resume_template(
        self,
        tenant_id: TenantId,
        job_id: JobId,
    ) -> dict[str, Any]:
        """Return the effective resume template for ``job_id``.

        This is an infrastructure convenience used by local render wiring. It
        mirrors the TypeScript API resolution order: per-job override, profile
        default, built-in default.
        """
        stable_job_id = canonical_job_id(str(job_id))
        assignment = self._conn.execute(
            """
            SELECT template_id, version_id
              FROM job_resume_template_assignments
             WHERE tenant_id = ? AND job_id = ?
            """,
            (str(tenant_id), str(stable_job_id)),
        ).fetchone()
        if assignment is not None:
            resolved = self._template_by_id(
                tenant_id,
                str(assignment["template_id"]),
                str(assignment["version_id"]),
                "job_override",
            )
            if resolved:
                return resolved
        default = self._conn.execute(
            """
            SELECT template_id, version_id
              FROM resume_template_defaults
             WHERE tenant_id = ? AND profile_id = 'default'
            """,
            (str(tenant_id),),
        ).fetchone()
        if default is not None:
            resolved = self._template_by_id(
                tenant_id,
                str(default["template_id"]),
                str(default["version_id"]),
                "profile_default",
            )
            if resolved:
                return resolved
        resolved = self._template_by_id(
            tenant_id,
            "built_in:modern-html",
            "built_in:modern-html:v1",
            "built_in",
        )
        if resolved:
            return resolved
        raise RuntimeError("Built-in resume template seed is missing.")

    def list_pending_tailor(
        self,
        tenant_id: TenantId,
        *,
        min_score: int = 7,
        limit: int = 0,
        retailor: bool = False,
    ) -> list[JobId]:
        """Return JobIds ready for tailoring per §4.5 lifecycle.

        Eligibility:

          * ``full_description IS NOT NULL`` (enrichment done).
          * Latest score ``fit_score >= min_score``.
          * Either no approved tailored resume exists yet OR ``retailor=True``.

        ``retailor`` widens the predicate to include jobs that already have an
        approved tailored resume in any active generation — the use case
        will mint a new generation when it picks them up.
        """
        min_score = effective_tailoring_min_score(min_score)
        where = (
            "AND approved_resumes.job_id IS NULL "
            if not retailor
            else ""
        )
        sql = (
            "WITH latest_scores AS ("
            "SELECT tenant_id, job_id, MAX(version) AS version "
            "FROM job_scores WHERE tenant_id = ? "
            "GROUP BY tenant_id, job_id"
            "), scored_jobs AS ("
            "SELECT s.tenant_id, s.job_id, s.fit_score, "
            "CASE WHEN json_valid(s.breakdown_json) "
            "THEN LOWER(COALESCE(CAST(json_extract(s.breakdown_json, '$.eligibility.status') AS TEXT), '')) "
            "ELSE '' END AS eligibility_status, "
            "CASE WHEN json_valid(s.breakdown_json) "
            "THEN COALESCE("
            "json_array_length(s.breakdown_json, '$.eligibility.hard_blockers'), "
            "json_array_length(s.breakdown_json, '$.eligibility.hardBlockers'), "
            "json_array_length(s.breakdown_json, '$.eligibility.blockers'), "
            "0) ELSE 0 END AS hard_blocker_count "
            "FROM job_scores s "
            "INNER JOIN latest_scores latest "
            "ON latest.tenant_id = s.tenant_id "
            "AND latest.job_id = s.job_id "
            "AND latest.version = s.version"
            "), approved_resumes AS ("
            "SELECT DISTINCT m.tenant_id, m.job_id "
            "FROM job_materials m "
            "INNER JOIN job_materials_artifacts tr "
            "ON tr.tenant_id = m.tenant_id "
            "AND tr.job_id = m.job_id "
            "AND tr.generation = m.generation "
            "AND tr.artifact_type = 'tailored_resume' "
            "AND tr.status = 'approved' "
            "WHERE m.tenant_id = ?"
            ") "
            "SELECT j.job_id "
            "FROM jobs j "
            "INNER JOIN job_enrichments e "
            "ON e.tenant_id = j.tenant_id AND e.job_id = j.job_id "
            "INNER JOIN scored_jobs s "
            "ON s.tenant_id = j.tenant_id AND s.job_id = j.job_id "
            "LEFT JOIN approved_resumes "
            "ON approved_resumes.tenant_id = j.tenant_id "
            "AND approved_resumes.job_id = j.job_id "
            "WHERE j.tenant_id = ? "
            "AND e.full_description IS NOT NULL "
            "AND s.fit_score >= ? "
            "AND s.eligibility_status != 'blocked' "
            "AND s.hard_blocker_count = 0 "
            f"{where}"
            "ORDER BY s.fit_score DESC, j.discovered_at DESC"
        )
        params: list[Any] = [str(tenant_id), str(tenant_id), str(tenant_id), int(min_score)]
        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [canonical_job_id(str(row[0])) for row in rows]

    def list_pending_cover(
        self,
        tenant_id: TenantId,
        *,
        min_score: int = 7,
        limit: int = 0,
    ) -> list[JobId]:
        """Return JobIds whose current approved generation has an approved
        tailored resume PDF but no approved cover letter."""
        min_score = effective_tailoring_min_score(min_score)
        sql = (
            "WITH latest_scores AS ("
            "SELECT tenant_id, job_id, MAX(version) AS version "
            "FROM job_scores WHERE tenant_id = ? "
            "GROUP BY tenant_id, job_id"
            "), scored_jobs AS ("
            "SELECT s.tenant_id, s.job_id, s.fit_score, "
            "CASE WHEN json_valid(s.breakdown_json) "
            "THEN LOWER(COALESCE(CAST(json_extract(s.breakdown_json, '$.eligibility.status') AS TEXT), '')) "
            "ELSE '' END AS eligibility_status, "
            "CASE WHEN json_valid(s.breakdown_json) "
            "THEN COALESCE("
            "json_array_length(s.breakdown_json, '$.eligibility.hard_blockers'), "
            "json_array_length(s.breakdown_json, '$.eligibility.hardBlockers'), "
            "json_array_length(s.breakdown_json, '$.eligibility.blockers'), "
            "0) ELSE 0 END AS hard_blocker_count "
            "FROM job_scores s "
            "INNER JOIN latest_scores latest "
            "ON latest.tenant_id = s.tenant_id "
            "AND latest.job_id = s.job_id "
            "AND latest.version = s.version"
            "), approved_resume_generations AS ("
            "SELECT tenant_id, job_id, MAX(generation) AS generation "
            "FROM job_materials_artifacts "
            "WHERE tenant_id = ? "
            "AND artifact_type = 'tailored_resume' AND status = 'approved' "
            "GROUP BY tenant_id, job_id"
            ") "
            "SELECT j.job_id "
            "FROM jobs j "
            "INNER JOIN scored_jobs s "
            "ON s.tenant_id = j.tenant_id AND s.job_id = j.job_id "
            "INNER JOIN approved_resume_generations current "
            "ON current.tenant_id = j.tenant_id AND current.job_id = j.job_id "
            "INNER JOIN job_materials m "
            "ON m.tenant_id = current.tenant_id "
            "AND m.job_id = current.job_id "
            "AND m.generation = current.generation "
            "INNER JOIN job_materials_artifacts tr "
            "ON tr.tenant_id = m.tenant_id AND tr.job_id = m.job_id "
            "AND tr.generation = m.generation "
            "AND tr.artifact_type = 'tailored_resume' AND tr.status = 'approved' "
            "INNER JOIN job_materials_artifacts rpdf "
            "ON rpdf.tenant_id = m.tenant_id AND rpdf.job_id = m.job_id "
            "AND rpdf.generation = m.generation "
            "AND rpdf.artifact_type = 'resume_pdf' AND rpdf.status = 'approved' "
            "LEFT JOIN job_materials_artifacts cl "
            "ON cl.tenant_id = m.tenant_id AND cl.job_id = m.job_id "
            "AND cl.generation = m.generation "
            "AND cl.artifact_type = 'cover_letter' AND cl.status = 'approved' "
            "WHERE j.tenant_id = ? "
            "AND s.fit_score >= ? "
            "AND s.eligibility_status != 'blocked' "
            "AND s.hard_blocker_count = 0 "
            "AND cl.artifact_id IS NULL "
            "ORDER BY s.fit_score DESC, j.discovered_at DESC"
        )
        params: list[Any] = [str(tenant_id), str(tenant_id), str(tenant_id), int(min_score)]
        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [canonical_job_id(str(row[0])) for row in rows]

    def list_pending_pdf(
        self,
        tenant_id: TenantId,
        *,
        limit: int = 0,
    ) -> list[JobId]:
        """Return JobIds whose current approved generation has text artifacts but
        is missing one or more PDFs."""
        sql = (
            "WITH latest_text_generations AS ("
            "SELECT tenant_id, job_id, MAX(generation) AS generation "
            "FROM job_materials_artifacts "
            "WHERE tenant_id = ? AND status = 'approved' "
            "AND artifact_type IN ('tailored_resume', 'cover_letter') "
            "GROUP BY tenant_id, job_id"
            ") "
            "SELECT m.job_id FROM job_materials m "
            "INNER JOIN latest_text_generations latest "
            "ON latest.tenant_id = m.tenant_id "
            "AND latest.job_id = m.job_id "
            "AND latest.generation = m.generation "
            "INNER JOIN job_materials_artifacts tr "
            "ON tr.tenant_id = m.tenant_id AND tr.job_id = m.job_id "
            "AND tr.generation = m.generation AND tr.status = 'approved' "
            "AND tr.artifact_type IN ('tailored_resume', 'cover_letter') "
            "LEFT JOIN job_materials_artifacts pdf "
            "ON pdf.tenant_id = m.tenant_id AND pdf.job_id = m.job_id "
            "AND pdf.generation = m.generation AND pdf.status = 'approved' "
            "AND ((tr.artifact_type = 'tailored_resume' AND pdf.artifact_type = 'resume_pdf') "
            "  OR (tr.artifact_type = 'cover_letter' AND pdf.artifact_type = 'cover_letter_pdf')) "
            "WHERE m.tenant_id = ? AND pdf.path IS NULL "
            "GROUP BY m.tenant_id, m.job_id "
            "ORDER BY MAX(m.updated_at) DESC"
        )
        params: list[Any] = [str(tenant_id), str(tenant_id)]
        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [canonical_job_id(str(row[0])) for row in rows]

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
            raise TypeError(f"list_by_status requires ArtifactStatus, got {type(status).__name__}")
        sql = (
            "WITH latest_materials AS ("
            "SELECT tenant_id, job_id, MAX(generation) AS generation "
            "FROM job_materials WHERE tenant_id = ? "
            "GROUP BY tenant_id, job_id"
            ") "
            "SELECT m.job_id, m.generation, m.status, m.created_at, m.updated_at, "
            "m.last_validation_json, m.last_verdict_json, m.metadata_json "
            "FROM job_materials m "
            "INNER JOIN latest_materials latest "
            "ON latest.tenant_id = m.tenant_id "
            "AND latest.job_id = m.job_id "
            "AND latest.generation = m.generation "
            "INNER JOIN job_materials_artifacts tr "
            "ON tr.tenant_id = m.tenant_id AND tr.job_id = m.job_id "
            "AND tr.generation = m.generation AND tr.artifact_type = 'tailored_resume' "
            "AND tr.status = ? "
            "WHERE m.tenant_id = ? "
            "ORDER BY m.updated_at DESC"
        )
        params: list[Any] = [str(tenant_id), status.value, str(tenant_id)]
        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [self._row_to_materials(row, tenant_id) for row in rows]

    # ------------------------------------------------------------------
    # Write
    # ------------------------------------------------------------------

    def save(self, materials: MaterialsSet) -> None:
        stable_job_id = canonical_job_id(str(materials.job_id))
        savepoint = "materials_aggregate_save"
        self._conn.execute(f"SAVEPOINT {savepoint}")
        try:
            self._save_rows(materials, stable_job_id)
        except BaseException:
            self._conn.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
            self._conn.execute(f"RELEASE SAVEPOINT {savepoint}")
            raise
        else:
            self._conn.execute(f"RELEASE SAVEPOINT {savepoint}")

    def _save_rows(
        self,
        materials: MaterialsSet,
        job_id: JobId,
    ) -> None:
        # Insert the next generation or enrich an existing generation whose
        # collision-resistant lineage token matches. Keeping allocation and the
        # optimistic lineage check in one SQLite statement closes the stale
        # writer window between a separate SELECT and UPSERT.
        metadata_json = _dumps(
            {
                **dict(materials.metadata),
                _LINEAGE_KEY: materials.lineage_id,
            }
        )
        parent = self._conn.execute(
            """
            INSERT INTO job_materials (
                tenant_id, job_id, generation, status,
                created_at, updated_at,
                last_validation_json, last_verdict_json, metadata_json
            )
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE
                ? = (
                    SELECT COALESCE(MAX(generation), 0) + 1
                    FROM job_materials
                    WHERE tenant_id = ? AND job_id = ?
                )
                OR EXISTS (
                    SELECT 1
                    FROM job_materials
                    WHERE tenant_id = ?
                      AND job_id = ?
                      AND generation = ?
                      AND COALESCE(
                          json_extract(metadata_json, '$.__jobctrl_materials_lineage_id'),
                          ?
                      ) = ?
                )
            ON CONFLICT(tenant_id, job_id, generation) DO UPDATE SET
                status = excluded.status,
                updated_at = excluded.updated_at,
                last_validation_json = excluded.last_validation_json,
                last_verdict_json = excluded.last_verdict_json,
                metadata_json = excluded.metadata_json
            WHERE COALESCE(
                      json_extract(
                          job_materials.metadata_json,
                          '$.__jobctrl_materials_lineage_id'
                      ),
                      json_extract(
                          excluded.metadata_json,
                          '$.__jobctrl_materials_lineage_id'
                      )
                  ) = json_extract(
                      excluded.metadata_json,
                      '$.__jobctrl_materials_lineage_id'
                  )
            """,
            (
                str(materials.tenant_id),
                str(job_id),
                materials.generation,
                materials.status,
                materials.created_at,
                materials.updated_at,
                _dumps(materials.last_validation.to_dict() if materials.last_validation else None),
                _dumps(materials.last_verdict.to_dict() if materials.last_verdict else None),
                metadata_json,
                materials.generation,
                str(materials.tenant_id),
                str(job_id),
                str(materials.tenant_id),
                str(job_id),
                materials.generation,
                materials.lineage_id,
                materials.lineage_id,
            ),
        )
        if parent.rowcount == 0:
            latest = self._conn.execute(
                """
                SELECT COALESCE(MAX(generation), 0)
                FROM job_materials
                WHERE tenant_id = ? AND job_id = ?
                """,
                (str(materials.tenant_id), str(job_id)),
            ).fetchone()
            current_max = int(latest[0] if latest else 0)
            raise MaterialsGenerationConflict(
                job_id=job_id,
                attempted=materials.generation,
                expected=current_max + 1,
            )

        # Persist every present artifact slot. Slots that were dropped
        # between two saves of the same generation are left untouched —
        # use cases append, never delete.
        for artifact in materials.artifacts:
            self._upsert_artifact(materials, job_id, artifact)

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

    def _upsert_artifact(
        self,
        materials: MaterialsSet,
        job_id: JobId,
        artifact: Artifact,
    ) -> None:
        metadata, layout_boxes = _metadata_and_layout_boxes(artifact.metadata)
        previous = self._conn.execute(
            """
            SELECT artifact_id
            FROM job_materials_artifacts
            WHERE tenant_id = ? AND job_id = ?
              AND generation = ? AND artifact_type = ?
            """,
            (
                str(materials.tenant_id),
                str(job_id),
                materials.generation,
                artifact.type.value,
            ),
        ).fetchone()
        previous_artifact_id = str(previous["artifact_id"]) if previous is not None else None
        self._conn.execute(
            """
            INSERT INTO job_materials_artifacts (
                tenant_id, job_id, generation, artifact_type, artifact_id,
                status, path, render_format, size_bytes,
                metadata_json, created_at, superseded_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, job_id, generation, artifact_type) DO UPDATE SET
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
                str(materials.tenant_id),
                str(job_id),
                materials.generation,
                artifact.type.value,
                artifact.artifact_id,
                artifact.status.value,
                artifact.path,
                artifact.render_format.value,
                artifact.size_bytes,
                _dumps(metadata) if metadata else None,
                artifact.created_at,
                artifact.superseded_at,
            ),
        )
        self._replace_layout_boxes(
            materials,
            job_id,
            artifact,
            layout_boxes,
            previous_artifact_id=previous_artifact_id,
        )

    def _replace_layout_boxes(
        self,
        materials: MaterialsSet,
        job_id: JobId,
        artifact: Artifact,
        layout_boxes: list[dict[str, Any]],
        *,
        previous_artifact_id: str | None,
    ) -> None:
        artifact_ids = {artifact.artifact_id}
        if previous_artifact_id is not None:
            artifact_ids.add(previous_artifact_id)
        placeholders = ", ".join("?" for _ in artifact_ids)
        self._conn.execute(
            f"""
            DELETE FROM job_material_layout_boxes
            WHERE tenant_id = ? AND job_id = ?
              AND generation = ? AND artifact_id IN ({placeholders})
            """,
            (
                str(materials.tenant_id),
                str(job_id),
                materials.generation,
                *sorted(artifact_ids),
            ),
        )
        if not layout_boxes:
            return
        rows = [
            (
                str(materials.tenant_id),
                str(job_id),
                materials.generation,
                artifact.artifact_id,
                index,
                box["semantic_id"],
                box["page_number"],
                box.get("line_number"),
                box["text_excerpt"],
                box["left_pct"],
                box["top_pct"],
                box["width_pct"],
                box["height_pct"],
                _dumps(box.get("audit_target", {})) or "{}",
                artifact.created_at,
            )
            for index, box in enumerate(layout_boxes)
        ]
        self._conn.executemany(
            """
            INSERT INTO job_material_layout_boxes (
                tenant_id, job_id, generation, artifact_id, box_index,
                semantic_id, page_number, line_number, text_excerpt,
                left_pct, top_pct, width_pct, height_pct, audit_target_json,
                created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )

    def _template_by_id(
        self,
        tenant_id: TenantId,
        template_id: str,
        version_id: str,
        assignment_source: str,
    ) -> dict[str, Any] | None:
        row = self._conn.execute(
            """
            SELECT t.template_id, t.display_name AS template_name,
                   v.version_id, v.version_number, v.display_name,
                   v.theme_json, v.layout_json, v.content_hash
              FROM resume_templates t
              JOIN resume_template_versions v
                ON v.tenant_id = t.tenant_id
               AND v.template_id = t.template_id
             WHERE t.tenant_id = ?
               AND t.template_id = ?
               AND v.version_id = ?
             LIMIT 1
            """,
            (str(tenant_id), template_id, version_id),
        ).fetchone()
        if row is None:
            return None
        metadata = {
            "templateId": str(row["template_id"]),
            "templateVersionId": str(row["version_id"]),
            "templateVersionNumber": int(row["version_number"]),
            "templateName": str(row["display_name"] or row["template_name"]),
            "templateHash": str(row["content_hash"]),
            "assignmentSource": assignment_source,
        }
        return {
            "metadata": metadata,
            "theme": _loads(row["theme_json"]) or {},
            "layout": _loads(row["layout_json"]) or {},
        }

    def _row_to_materials(self, row: Any, tenant_id: TenantId) -> MaterialsSet:
        if isinstance(row, sqlite3.Row):
            job_id = canonical_job_id(str(row["job_id"]))
            generation = row["generation"]
            status = row["status"]
            created_at = row["created_at"]
            updated_at = row["updated_at"]
            validation_json = row["last_validation_json"]
            verdict_json = row["last_verdict_json"]
            metadata_json = row["metadata_json"]
        else:
            (
                raw_job_id,
                generation,
                status,
                created_at,
                updated_at,
                validation_json,
                verdict_json,
                metadata_json,
            ) = row
            job_id = canonical_job_id(str(raw_job_id))

        artifact_rows = self._conn.execute(
            """
            SELECT artifact_type, artifact_id, status, path, render_format,
                   size_bytes, metadata_json, created_at, superseded_at
            FROM job_materials_artifacts
            WHERE tenant_id = ? AND job_id = ? AND generation = ?
            """,
            (str(tenant_id), str(job_id), int(generation)),
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
                size_bytes=(int(art_row["size_bytes"]) if art_row["size_bytes"] is not None else None),
                metadata=_loads(art_row["metadata_json"]) or {},
                superseded_at=(str(art_row["superseded_at"]) if art_row["superseded_at"] else None),
            )
            slot_kwargs[slot_for_type[artifact.type]] = artifact

        validation = ValidationResult.from_dict(_loads(validation_json)) if validation_json else None
        verdict = JudgeVerdict.from_dict(_loads(verdict_json))

        metadata = _loads(metadata_json) or {}
        lineage_id = str(metadata.pop(_LINEAGE_KEY, "")) or None
        return MaterialsSet(
            tenant_id=tenant_id or LOCAL_TENANT,
            job_id=job_id,
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
            metadata=metadata,
            **({"lineage_id": lineage_id} if lineage_id is not None else {}),
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


def _metadata_and_layout_boxes(metadata: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    cleaned_metadata = dict(metadata or {})
    raw_boxes = cleaned_metadata.pop("layout_boxes", None)
    return cleaned_metadata, _layout_boxes(raw_boxes)


def _layout_boxes(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    boxes: list[dict[str, Any]] = []
    for raw in value:
        if not isinstance(raw, dict):
            continue
        semantic_id = " ".join(str(raw.get("semantic_id", "")).split())
        text_excerpt = " ".join(str(raw.get("text_excerpt", "")).split())
        page_number = _positive_int(raw.get("page_number"))
        line_number = _nullable_int(raw.get("line_number"))
        left_pct = _bounded_float(raw.get("left_pct"))
        top_pct = _bounded_float(raw.get("top_pct"))
        width_pct = _bounded_float(raw.get("width_pct"))
        height_pct = _bounded_float(raw.get("height_pct"))
        if (
            not semantic_id
            or not text_excerpt
            or page_number is None
            or left_pct is None
            or top_pct is None
            or width_pct is None
            or height_pct is None
        ):
            continue
        boxes.append(
            {
                "semantic_id": semantic_id[:160],
                "page_number": page_number,
                "line_number": line_number,
                "text_excerpt": text_excerpt[:500],
                "left_pct": left_pct,
                "top_pct": top_pct,
                "width_pct": width_pct,
                "height_pct": height_pct,
                "audit_target": raw.get("audit_target") if isinstance(raw.get("audit_target"), dict) else {},
            }
        )
    return boxes


def _positive_int(value: Any) -> int | None:
    parsed = _nullable_int(value)
    return parsed if parsed is not None and parsed > 0 else None


def _nullable_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed


def _bounded_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(parsed) or parsed < 0:
        return None
    return min(100.0, parsed)


class SqliteLearningRecommendationReviewRepository:
    """Atomically link explicit decisions to Materials policy revisions."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        ensure_tailoring_policy_tables(conn)

    def review(
        self,
        tenant_id: TenantId,
        *,
        recommendation_id: str,
        decision: LearningRecommendationDecision,
        reviewed_at: str,
    ) -> LearningRecommendationReview:
        recommendation_id = str(recommendation_id or "").strip()
        reviewed_at = str(reviewed_at or "").strip()
        if not recommendation_id:
            raise LearningRecommendationReviewError(
                "recommendation_id must not be empty"
            )
        if decision not in {"accepted", "rejected"}:
            raise LearningRecommendationReviewError(
                "decision must be accepted or rejected"
            )
        if not reviewed_at:
            raise LearningRecommendationReviewError("reviewed_at must not be empty")

        policy_repository = (
            SqliteTailoringPolicyRepository(self._conn)
            if decision == "accepted"
            else None
        )
        self._conn.execute("BEGIN IMMEDIATE")
        try:
            recommendation = self._conn.execute(
                """
                SELECT signal_kind, rule_key, rule_value, allowlist_version
                FROM learning_recommendations
                WHERE tenant_id = ? AND recommendation_id = ?
                """,
                (str(tenant_id), recommendation_id),
            ).fetchone()
            if recommendation is None:
                raise LearningRecommendationReviewError(
                    "learning recommendation does not exist for tenant"
                )

            prior_reviews = tuple(
                self._review_from_row(row)
                for row in self._conn.execute(
                    """
                    SELECT tenant_id, review_id, recommendation_id, revision,
                           decision, policy_version, reviewed_at
                    FROM learning_recommendation_reviews
                    WHERE tenant_id = ? AND recommendation_id = ?
                    ORDER BY revision
                    """,
                    (str(tenant_id), recommendation_id),
                ).fetchall()
            )
            accepted = next(
                (review for review in prior_reviews if review.decision == "accepted"),
                None,
            )
            if accepted is not None:
                if decision == "accepted":
                    self._conn.commit()
                    return accepted
                raise LearningRecommendationReviewError(
                    "accepted learning recommendation is terminal"
                )
            replay = next(
                (review for review in prior_reviews if review.decision == decision),
                None,
            )
            if replay is not None:
                self._conn.commit()
                return replay

            tombstoned = self._conn.execute(
                """
                SELECT 1
                FROM learning_recommendation_tombstones
                WHERE tenant_id = ? AND recommendation_id = ?
                LIMIT 1
                """,
                (str(tenant_id), recommendation_id),
            ).fetchone()
            if tombstoned is not None:
                raise LearningRecommendationReviewError(
                    "tombstoned learning recommendation cannot be reviewed"
                )

            revision = len(prior_reviews) + 1
            policy_version: int | None = None
            if decision == "accepted":
                effect = TailoringRuleEffect(
                    signal_kind=str(_row_value(recommendation, "signal_kind", 0)),
                    rule_key=str(_row_value(recommendation, "rule_key", 1)),
                    rule_value=str(_row_value(recommendation, "rule_value", 2)),
                    allowlist_version=int(
                        _row_value(recommendation, "allowlist_version", 3)
                    ),
                )
                assert policy_repository is not None
                current = policy_repository.get_current(tenant_id)
                if current is None:
                    raise LearningRecommendationReviewError(
                        "acceptance requires an initialized tailoring policy"
                    )
                policy = current.with_learned_tailoring_rule(
                    rule_key=effect.rule_key,
                    rule_value=effect.rule_value,
                    version=current.version + 1,
                    created_at=reviewed_at,
                )
                policy_repository._insert(policy)
                policy_version = policy.version

            review = LearningRecommendationReview(
                tenant_id=tenant_id,
                review_id=_learning_recommendation_review_id(
                    tenant_id=tenant_id,
                    recommendation_id=recommendation_id,
                    decision=decision,
                ),
                recommendation_id=recommendation_id,
                revision=revision,
                decision=decision,
                policy_version=policy_version,
                reviewed_at=reviewed_at,
            )
            self._conn.execute(
                """
                INSERT INTO learning_recommendation_reviews (
                    tenant_id, review_id, recommendation_id, revision,
                    decision, context, policy_kind, policy_version, reviewed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(review.tenant_id),
                    review.review_id,
                    review.recommendation_id,
                    review.revision,
                    review.decision,
                    review.context,
                    review.policy_kind,
                    review.policy_version,
                    review.reviewed_at,
                ),
            )
            self._conn.commit()
            return review
        except Exception:
            self._conn.rollback()
            raise

    @staticmethod
    def _review_from_row(row: Any) -> LearningRecommendationReview:
        raw_policy_version = _row_value(row, "policy_version", 5)
        return LearningRecommendationReview(
            tenant_id=TenantId(str(_row_value(row, "tenant_id", 0))),
            review_id=str(_row_value(row, "review_id", 1)),
            recommendation_id=str(_row_value(row, "recommendation_id", 2)),
            revision=int(_row_value(row, "revision", 3)),
            decision=str(_row_value(row, "decision", 4)),
            policy_version=(
                None if raw_policy_version is None else int(raw_policy_version)
            ),
            reviewed_at=str(_row_value(row, "reviewed_at", 6)),
        )


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

    def get_version(self, tenant_id: TenantId, version: int) -> TailoringPolicy | None:
        row = self._conn.execute(
            """
            SELECT tenant_id, version, prompt_version, schema_version,
                   judge_schema_version, prompt_fingerprint, config_fingerprint,
                   profile_policy_fingerprint, custom_prompt_fingerprint,
                   generator_settings_json, judge_settings_json,
                   runtime_settings_json, rollback_of_version, rollback_reason,
                   created_at, created_from_event_id
            FROM tailoring_policies
            WHERE tenant_id = ? AND version = ?
            """,
            (str(tenant_id), version),
        ).fetchone()
        if row is None:
            return None
        return self._row_to_policy(row)

    def list_history(
        self,
        tenant_id: TenantId,
        *,
        limit: int = 100,
    ) -> list[TailoringPolicy]:
        if limit < 1 or limit > 100:
            raise TailoringPolicyRevisionError("policy history limit must be between 1 and 100")
        rows = self._conn.execute(
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
            LIMIT ?
            """,
            (str(tenant_id), limit),
        ).fetchall()
        return [self._row_to_policy(row) for row in rows]

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

    def resolve_current(
        self,
        candidate: TailoringPolicy,
        *,
        expected_current_version: int | None = None,
    ) -> TailoringPolicy:
        self._conn.execute("BEGIN IMMEDIATE")
        try:
            current = self.get_current(candidate.tenant_id)
            actual_current_version = 0 if current is None else current.version
            if (
                expected_current_version is not None
                and actual_current_version != expected_current_version
            ):
                raise TailoringPolicyChangedError(
                    "tailoring policy advanced before artifact persistence"
                )
            if current is not None and current.learned_tailoring_rules.rules:
                candidate = candidate.with_learned_tailoring_rules(
                    current.learned_tailoring_rules,
                    created_at=candidate.created_at,
                )
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

    def rollback_to(
        self,
        tenant_id: TenantId,
        *,
        target_version: int,
        reason: TailoringPolicyRollbackReason,
        rolled_back_at: str,
    ) -> TailoringPolicy:
        if reason != "user_requested":
            raise TailoringPolicyRevisionError("unsupported tailoring policy rollback reason")
        if not str(rolled_back_at or "").strip():
            raise TailoringPolicyRevisionError("rolled_back_at must not be empty")

        self._conn.execute("BEGIN IMMEDIATE")
        try:
            current = self.get_current(tenant_id)
            if current is None:
                raise TailoringPolicyRevisionError("tailoring policy is not initialized")
            target = self.get_version(tenant_id, target_version)
            if target is None:
                raise TailoringPolicyRevisionError(
                    "target tailoring policy version does not exist for tenant"
                )
            if (
                current.rollback_of_version == target.version
                and current.same_config_as(target)
            ):
                self._conn.commit()
                return current
            if target.version >= current.version:
                raise TailoringPolicyRevisionError(
                    "rollback target must precede the current tailoring policy"
                )

            rollback = TailoringPolicy(
                tenant_id=tenant_id,
                version=current.version + 1,
                prompt_version=target.prompt_version,
                schema_version=target.schema_version,
                judge_schema_version=target.judge_schema_version,
                prompt_fingerprint=target.prompt_fingerprint,
                config_fingerprint=target.config_fingerprint,
                profile_policy_fingerprint=target.profile_policy_fingerprint,
                custom_prompt_fingerprint=target.custom_prompt_fingerprint,
                generator_settings=target.generator_settings,
                judge_settings=target.judge_settings,
                runtime_settings=target.runtime_settings,
                rollback_of_version=target.version,
                rollback_reason=reason,
                created_at=rolled_back_at,
                created_from_event_id=None,
            )
            self._insert(rollback)
            self._conn.commit()
            return rollback
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


def _learning_recommendation_review_id(
    *,
    tenant_id: TenantId,
    recommendation_id: str,
    decision: LearningRecommendationDecision,
) -> str:
    payload = f"{tenant_id}\0{recommendation_id}\0{decision}".encode()
    return f"learning-recommendation-review:{hashlib.sha256(payload).hexdigest()}"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
