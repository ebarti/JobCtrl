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

from jobctrl.database import ensure_bullet_provenance_tables
from jobctrl.domain.discovery.value_objects import PostingUrl
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.materials.coverage_audit import KeywordCoverage
from jobctrl.domain.materials.provenance import BulletProvenance, BulletProvenanceSet
from jobctrl.domain.materials.voice import VoicePassRecord
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.discovery.sqlite_identity_resolver import (
    SqliteJobIdentityResolver,
)
from jobctrl.infrastructure.materials.unit_of_work import SqliteUnitOfWork


class SqliteBulletProvenanceRepository:
    """SQLite-backed implementation of ``BulletProvenanceRepository``.

    When a :class:`SqliteUnitOfWork` is supplied and active, ``save`` stages its
    writes and defers the commit to the unit of work, so an accepted generation's
    provenance commits in the same transaction as the artifact it explains.
    """

    def __init__(
        self,
        conn: sqlite3.Connection,
        *,
        unit_of_work: SqliteUnitOfWork | None = None,
    ) -> None:
        self._conn = conn
        self._unit_of_work = unit_of_work
        self._identity_resolver = SqliteJobIdentityResolver(conn)
        # Idempotent — safe if init_db already ran; keeps test setup minimal.
        ensure_bullet_provenance_tables(conn)

    def _resolve_job_id(
        self,
        tenant_id: TenantId,
        reference: JobId,
    ) -> JobId | None:
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
        return identity.job_id if identity is not None else None

    # ------------------------------------------------------------------ read

    def load(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        *,
        generation: int | None = None,
    ) -> BulletProvenanceSet | None:
        stable_job_id = self._resolve_job_id(tenant_id, job_id)
        if stable_job_id is None:
            return None
        if generation is None:
            gen_row = self._conn.execute(
                """
                SELECT MAX(generation) FROM job_bullet_provenance
                WHERE tenant_id = ? AND job_id = ?
                """,
                (str(tenant_id), str(stable_job_id)),
            ).fetchone()
            current = gen_row[0] if gen_row is not None else None
            if current is None:
                return None
            generation = int(current)

        rows = self._conn.execute(
            """
            SELECT * FROM job_bullet_provenance
            WHERE tenant_id = ? AND job_id = ? AND generation = ?
            ORDER BY position, bullet_id
            """,
            (str(tenant_id), str(stable_job_id), int(generation)),
        ).fetchall()
        if not rows:
            return None

        bullets = tuple(self._row_to_bullet(row) for row in rows)
        first = rows[0]
        # Phase 3: coverage + voice are set-level facts denormalised onto every row;
        # read them off the first row (``_row_value`` tolerates a pre-Phase-3 row
        # that predates the columns). ``from_read_model`` / ``from_dict`` return
        # None when the stored value is absent/empty.
        coverage = KeywordCoverage.from_read_model(
            _load_json(_row_value(first, "coverage_json"))
        )
        voice = VoicePassRecord.from_dict(_load_json(_row_value(first, "voice_json")))
        return BulletProvenanceSet(
            tenant_id=tenant_id,
            job_id=stable_job_id,
            generation=int(generation),
            artifact_id=str(first["artifact_id"]),
            bullets=bullets,
            coverage=coverage,
            voice=voice,
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

        stable_job_id = self._resolve_job_id(
            provenance.tenant_id,
            provenance.job_id,
        )
        if stable_job_id is None:
            raise ValueError(
                "no stable Job identity for bullet provenance "
                f"reference: {provenance.job_id}"
            )
        tenant = str(provenance.tenant_id)
        generation = provenance.generation

        # Phase 3: the set-level coverage + voice audit, serialised once and
        # denormalised onto every row of the generation (read back off any row).
        coverage_json = _dump_json(provenance.coverage_to_read_model())
        voice_json = _dump_json(provenance.voice_to_read_model())

        self._conn.execute(
            "DELETE FROM job_bullet_provenance "
            "WHERE tenant_id = ? AND job_id = ? AND generation = ?",
            (tenant, str(stable_job_id), generation),
        )
        for position, bullet in enumerate(provenance.bullets):
            self._conn.execute(
                """
                INSERT INTO job_bullet_provenance (
                    tenant_id, job_id, generation, bullet_id, artifact_id,
                    section, source_id, evidence_ids_json, requirement_ids_json,
                    matched_keywords_json, transform_type, control, rationale,
                    generated_text, position, created_at, coverage_json, voice_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    tenant,
                    str(stable_job_id),
                    generation,
                    bullet.bullet_id,
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
                    coverage_json,
                    voice_json,
                ),
            )
        self._commit()

    def _commit(self) -> None:
        """Commit now, unless an active unit of work owns the transaction."""
        if self._unit_of_work is None or not self._unit_of_work.active:
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


def _dump_json(value: dict | None) -> str | None:
    """Serialise a set-level read shape to JSON, or NULL when absent."""
    return json.dumps(value, ensure_ascii=False) if value is not None else None


def _row_value(row: sqlite3.Row, column: str) -> str | None:
    """Read an optional column, tolerating a row that predates it (pre-Phase-3)."""
    try:
        return row[column]
    except (IndexError, KeyError):
        return None


def _load_json(value: str | None) -> dict | None:
    """Parse a stored JSON object, returning None on absence/parse failure."""
    if not value:
        return None
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


__all__ = ["SqliteBulletProvenanceRepository"]
