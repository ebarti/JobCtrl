"""SqliteBulletProvenanceRepository — local-mode adapter (Phase 2).

Persists :class:`BulletProvenanceSet` to the canonical ``job_bullet_provenance``
table created by :func:`database.ensure_bullet_provenance_tables`. Mirrors
:class:`SqliteEmployerAnalysisRepository`: one connection per adapter, eager
commit, generation-versioned, supersede-not-destroy semantics (Anti-Pattern 4 /
success criterion 5).

A re-save of the SAME generation replaces that generation's rows (idempotent
mid-flow re-save); writing a HIGHER generation leaves prior generations intact as
audit history — a failed re-tailor never destroys the last accepted generation's
provenance.
"""

from __future__ import annotations

import json
import sqlite3

from jobhunter.database import ensure_bullet_provenance_tables
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.materials.provenance import BulletProvenance, BulletProvenanceSet
from jobhunter.domain.tenant import TenantId


class SqliteBulletProvenanceRepository:
    """SQLite-backed implementation of ``BulletProvenanceRepository``."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        # Idempotent — safe if init_db already ran; keeps test setup minimal.
        ensure_bullet_provenance_tables(conn)

    # ------------------------------------------------------------------ read

    def load(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        *,
        generation: int | None = None,
    ) -> BulletProvenanceSet | None:
        if generation is None:
            gen_row = self._conn.execute(
                """
                SELECT MAX(generation) FROM job_bullet_provenance
                WHERE job_url = ? AND tenant_id = ?
                """,
                (str(job_id), str(tenant_id)),
            ).fetchone()
            current = gen_row[0] if gen_row is not None else None
            if current is None:
                return None
            generation = int(current)

        rows = self._conn.execute(
            """
            SELECT * FROM job_bullet_provenance
            WHERE job_url = ? AND tenant_id = ? AND generation = ?
            ORDER BY position, bullet_id
            """,
            (str(job_id), str(tenant_id), int(generation)),
        ).fetchall()
        if not rows:
            return None

        bullets = tuple(self._row_to_bullet(row) for row in rows)
        first = rows[0]
        return BulletProvenanceSet(
            tenant_id=tenant_id,
            job_id=job_id,
            generation=int(generation),
            artifact_id=str(first["artifact_id"]),
            bullets=bullets,
            created_at=str(first["created_at"]),
        )

    # ----------------------------------------------------------------- write

    def save(self, provenance: BulletProvenanceSet) -> None:
        """Persist the rows for ``provenance.generation`` (idempotent re-save).

        Replaces only THIS generation's rows; prior generations are untouched
        (supersede-not-destroy). Saving an empty set is a no-op — a failed
        re-tailor that produced no accepted candidate writes no rows and leaves
        the last accepted generation intact.
        """
        if provenance.is_empty:
            return

        job_url = str(provenance.job_id)
        tenant = str(provenance.tenant_id)
        generation = provenance.generation

        self._conn.execute(
            "DELETE FROM job_bullet_provenance WHERE job_url = ? AND tenant_id = ? AND generation = ?",
            (job_url, tenant, generation),
        )
        for position, bullet in enumerate(provenance.bullets):
            self._conn.execute(
                """
                INSERT INTO job_bullet_provenance (
                    job_url, generation, bullet_id, tenant_id, artifact_id,
                    section, source_id, evidence_ids_json, requirement_ids_json,
                    matched_keywords_json, transform_type, control, rationale,
                    generated_text, position, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job_url,
                    generation,
                    bullet.bullet_id,
                    tenant,
                    provenance.artifact_id,
                    bullet.section,
                    bullet.source_id,
                    json.dumps(list(bullet.evidence_ids), ensure_ascii=False),
                    json.dumps(list(bullet.requirement_ids), ensure_ascii=False),
                    json.dumps(list(bullet.matched_keywords), ensure_ascii=False),
                    bullet.transform_type.value,
                    bullet.control.value,
                    bullet.rationale,
                    bullet.generated_text,
                    position,
                    provenance.created_at,
                ),
            )
        self._conn.commit()

    # --------------------------------------------------------------- mapping

    @staticmethod
    def _row_to_bullet(row: sqlite3.Row) -> BulletProvenance:
        return BulletProvenance.from_dict(
            {
                "bullet_id": row["bullet_id"],
                "section": row["section"],
                "source_id": row["source_id"],
                "evidence_ids": json.loads(row["evidence_ids_json"]),
                "requirement_ids": json.loads(row["requirement_ids_json"]),
                "matched_keywords": json.loads(row["matched_keywords_json"]),
                "transform_type": row["transform_type"],
                "control": row["control"],
                "rationale": row["rationale"],
                "generated_text": row["generated_text"],
            }
        )


__all__ = ["SqliteBulletProvenanceRepository"]
