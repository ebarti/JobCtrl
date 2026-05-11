"""SQLite adapter for the Operations read-model projections (Phase 9 / S-32).

The store owns the schema for the five projection tables defined in
``domain/operations/projections.py`` and provides upsert + query
helpers used by ``ProjectionBuilder`` and the test fixtures.

Table layout (all keyed by ``tenant_id`` to support the future
multi-tenant rollout per ddd-target.md §9):

* ``job_list_projections``    — denormalised row per job
* ``dashboard_projections``   — singleton per tenant
* ``job_detail_projections``  — full detail row per job
* ``artifact_list_projections`` — denormalised artifact rows
* ``apply_run_projections``   — apply-run telemetry per run

Schemas are intentionally narrow — every column corresponds to a field
on the matching projection dataclass.  ``payload_json`` style overflow
columns are used for nested lists (stages, events, funnel) which keeps
the table flat enough to query with simple SELECT statements from the
TS read-model.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Iterable

from jobhunter.domain.operations.projections import (
    ApplyRunProjection,
    ArtifactListProjection,
    DashboardProjection,
    JobDetailProjection,
    JobListProjection,
)


PROJECTION_TABLES: tuple[str, ...] = (
    "job_list_projections",
    "dashboard_projections",
    "job_detail_projections",
    "artifact_list_projections",
    "apply_run_projections",
)

SCORE_EVIDENCE_COLUMNS: tuple[tuple[str, str, str], ...] = (
    ("job_list_projections", "score_breakdown_json", "TEXT"),
    ("job_list_projections", "score_keywords_json", "TEXT NOT NULL DEFAULT '[]'"),
    ("job_list_projections", "score_version", "INTEGER"),
    ("job_list_projections", "scored_at", "TEXT"),
    ("job_detail_projections", "score_breakdown_json", "TEXT"),
    ("job_detail_projections", "score_keywords_json", "TEXT NOT NULL DEFAULT '[]'"),
    ("job_detail_projections", "score_version", "INTEGER"),
    ("job_detail_projections", "scored_at", "TEXT"),
)


def ensure_projection_tables(conn: sqlite3.Connection) -> list[str]:
    """Create the projection tables if they do not exist (idempotent)."""

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS job_list_projections (
            tenant_id              TEXT NOT NULL DEFAULT 'local',
            job_id                 TEXT NOT NULL,
            title                  TEXT NOT NULL DEFAULT '',
            employer               TEXT NOT NULL DEFAULT '',
            source                 TEXT NOT NULL DEFAULT '',
            strategy               TEXT NOT NULL DEFAULT '',
            location               TEXT NOT NULL DEFAULT '',
            salary                 TEXT NOT NULL DEFAULT '',
            application_url        TEXT,
            discovered_at          TEXT,
            description            TEXT NOT NULL DEFAULT '',
            full_description       TEXT NOT NULL DEFAULT '',
            fit_score              INTEGER,
            score_breakdown_json   TEXT,
            score_keywords_json    TEXT NOT NULL DEFAULT '[]',
            score_reasoning        TEXT NOT NULL DEFAULT '',
            score_version          INTEGER,
            scored_at              TEXT,
            current_stage          TEXT NOT NULL DEFAULT 'discover',
            current_state          TEXT NOT NULL DEFAULT 'pending',
            current_error_code     TEXT,
            current_error_message  TEXT,
            current_next_action    TEXT,
            has_resume             INTEGER NOT NULL DEFAULT 0,
            has_cover_letter       INTEGER NOT NULL DEFAULT 0,
            has_pdf                INTEGER NOT NULL DEFAULT 0,
            apply_status           TEXT,
            applied_at             TEXT,
            artifact_count         INTEGER NOT NULL DEFAULT 0,
            deleted_at             TEXT,
            last_updated_at        TEXT,
            PRIMARY KEY (tenant_id, job_id)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_list_projections_stage_state
        ON job_list_projections(tenant_id, current_stage, current_state)
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dashboard_projections (
            tenant_id              TEXT PRIMARY KEY,
            total_jobs             INTEGER NOT NULL DEFAULT 0,
            failures               INTEGER NOT NULL DEFAULT 0,
            blocked                INTEGER NOT NULL DEFAULT 0,
            ready                  INTEGER NOT NULL DEFAULT 0,
            applied                INTEGER NOT NULL DEFAULT 0,
            dry_runs               INTEGER NOT NULL DEFAULT 0,
            funnel_json            TEXT NOT NULL DEFAULT '[]',
            by_source_json         TEXT NOT NULL DEFAULT '[]',
            score_distribution_json TEXT NOT NULL DEFAULT '[]',
            generated_at           TEXT NOT NULL DEFAULT ''
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS job_detail_projections (
            tenant_id              TEXT NOT NULL DEFAULT 'local',
            job_id                 TEXT NOT NULL,
            description_preview    TEXT NOT NULL DEFAULT '',
            score_breakdown_json   TEXT,
            score_keywords_json    TEXT NOT NULL DEFAULT '[]',
            score_reasoning        TEXT NOT NULL DEFAULT '',
            score_version          INTEGER,
            scored_at              TEXT,
            stages_json            TEXT NOT NULL DEFAULT '[]',
            last_updated_at        TEXT,
            PRIMARY KEY (tenant_id, job_id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS artifact_list_projections (
            artifact_id            TEXT PRIMARY KEY,
            tenant_id              TEXT NOT NULL DEFAULT 'local',
            job_id                 TEXT NOT NULL,
            job_title              TEXT NOT NULL DEFAULT '',
            job_employer           TEXT NOT NULL DEFAULT '',
            artifact_type          TEXT NOT NULL DEFAULT '',
            status                 TEXT NOT NULL DEFAULT '',
            local_path             TEXT NOT NULL DEFAULT '',
            size_bytes             INTEGER,
            created_at             TEXT,
            generation             INTEGER
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_artifact_list_projections_job
        ON artifact_list_projections(tenant_id, job_id)
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS apply_run_projections (
            run_id                 TEXT PRIMARY KEY,
            tenant_id              TEXT NOT NULL DEFAULT 'local',
            job_id                 TEXT NOT NULL,
            job_title              TEXT NOT NULL DEFAULT '',
            job_employer           TEXT NOT NULL DEFAULT '',
            status                 TEXT NOT NULL DEFAULT '',
            result                 TEXT,
            dry_run                INTEGER NOT NULL DEFAULT 0,
            worker_id              INTEGER,
            model                  TEXT,
            started_at             TEXT,
            finished_at            TEXT,
            duration_ms            INTEGER,
            events_json            TEXT NOT NULL DEFAULT '[]'
        )
        """
    )
    score_evidence_schema_changed = False
    for table_name, column_name, definition in SCORE_EVIDENCE_COLUMNS:
        score_evidence_schema_changed = (
            _ensure_column(conn, table_name, column_name, definition)
            or score_evidence_schema_changed
        )
    if score_evidence_schema_changed:
        # Projection rows are fully derived; resetting them lets the next
        # refresh rebuild migrated rows from canonical job_scores evidence.
        _reset_score_evidence_projections(conn)
    conn.commit()
    return list(PROJECTION_TABLES)


def _ensure_column(
    conn: sqlite3.Connection,
    table_name: str,
    column_name: str,
    definition: str,
) -> bool:
    columns = {
        row["name"] if isinstance(row, sqlite3.Row) else row[1]
        for row in conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    }
    if column_name not in columns:
        conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {definition}")
        return True
    return False


def _reset_score_evidence_projections(conn: sqlite3.Connection) -> None:
    conn.execute("DELETE FROM job_list_projections")
    conn.execute("DELETE FROM job_detail_projections")


class SqliteProjectionStore:
    """SQLite-backed adapter for the ``ReadModelStore`` port (§5.8)."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        ensure_projection_tables(conn)

    # ----------------------------------------------------------- write side

    def upsert_job_list(self, projection: JobListProjection) -> None:
        self._conn.execute(
            """
            INSERT INTO job_list_projections (
                tenant_id, job_id, title, employer, source, strategy, location,
                salary, application_url, discovered_at, description,
                full_description, fit_score, score_breakdown_json,
                score_keywords_json, score_reasoning, score_version, scored_at,
                current_stage, current_state, current_error_code,
                current_error_message, current_next_action, has_resume,
                has_cover_letter, has_pdf, apply_status, applied_at,
                artifact_count, deleted_at,
                last_updated_at
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            )
            ON CONFLICT(tenant_id, job_id) DO UPDATE SET
                title                 = excluded.title,
                employer              = excluded.employer,
                source                = excluded.source,
                strategy              = excluded.strategy,
                location              = excluded.location,
                salary                = excluded.salary,
                application_url       = excluded.application_url,
                discovered_at         = excluded.discovered_at,
                description           = excluded.description,
                full_description      = excluded.full_description,
                fit_score             = excluded.fit_score,
                score_breakdown_json  = excluded.score_breakdown_json,
                score_keywords_json   = excluded.score_keywords_json,
                score_reasoning       = excluded.score_reasoning,
                score_version         = excluded.score_version,
                scored_at             = excluded.scored_at,
                current_stage         = excluded.current_stage,
                current_state         = excluded.current_state,
                current_error_code    = excluded.current_error_code,
                current_error_message = excluded.current_error_message,
                current_next_action   = excluded.current_next_action,
                has_resume            = excluded.has_resume,
                has_cover_letter      = excluded.has_cover_letter,
                has_pdf               = excluded.has_pdf,
                apply_status          = excluded.apply_status,
                applied_at            = excluded.applied_at,
                artifact_count        = excluded.artifact_count,
                deleted_at            = excluded.deleted_at,
                last_updated_at       = excluded.last_updated_at
            """,
            (
                str(projection.tenant_id),
                projection.job_id,
                projection.title,
                projection.employer,
                projection.source,
                projection.strategy,
                projection.location,
                projection.salary,
                projection.application_url,
                projection.discovered_at,
                projection.description,
                projection.full_description,
                projection.fit_score,
                projection.score_breakdown_json,
                projection.score_keywords_json,
                projection.score_reasoning,
                projection.score_version,
                projection.scored_at,
                projection.current_stage,
                projection.current_state,
                projection.current_error_code,
                projection.current_error_message,
                projection.current_next_action,
                1 if projection.has_resume else 0,
                1 if projection.has_cover_letter else 0,
                1 if projection.has_pdf else 0,
                projection.apply_status,
                projection.applied_at,
                projection.artifact_count,
                projection.deleted_at,
                projection.last_updated_at,
            ),
        )

    def delete_job_list(self, tenant_id: str, job_id: str) -> None:
        self._conn.execute(
            "DELETE FROM job_list_projections WHERE tenant_id = ? AND job_id = ?",
            (tenant_id, job_id),
        )

    def upsert_dashboard(self, projection: DashboardProjection) -> None:
        self._conn.execute(
            """
            INSERT INTO dashboard_projections (
                tenant_id, total_jobs, failures, blocked, ready, applied,
                dry_runs, funnel_json, by_source_json, score_distribution_json,
                generated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id) DO UPDATE SET
                total_jobs              = excluded.total_jobs,
                failures                = excluded.failures,
                blocked                 = excluded.blocked,
                ready                   = excluded.ready,
                applied                 = excluded.applied,
                dry_runs                = excluded.dry_runs,
                funnel_json             = excluded.funnel_json,
                by_source_json          = excluded.by_source_json,
                score_distribution_json = excluded.score_distribution_json,
                generated_at            = excluded.generated_at
            """,
            (
                str(projection.tenant_id),
                projection.total_jobs,
                projection.failures,
                projection.blocked,
                projection.ready,
                projection.applied,
                projection.dry_runs,
                json.dumps(
                    [
                        {
                            "stage": stage.stage,
                            "total": stage.total,
                            "succeeded": stage.succeeded,
                            "running": stage.running,
                            "pending": stage.pending,
                            "blocked": stage.blocked,
                            "failed": stage.failed,
                        }
                        for stage in projection.funnel
                    ]
                ),
                json.dumps([list(item) for item in projection.by_source]),
                json.dumps([list(item) for item in projection.score_distribution]),
                projection.generated_at,
            ),
        )

    def upsert_job_detail(self, projection: JobDetailProjection) -> None:
        self._conn.execute(
            """
            INSERT INTO job_detail_projections (
                tenant_id, job_id, description_preview, score_breakdown_json,
                score_keywords_json, score_reasoning, score_version, scored_at,
                stages_json, last_updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, job_id) DO UPDATE SET
                description_preview  = excluded.description_preview,
                score_breakdown_json = excluded.score_breakdown_json,
                score_keywords_json  = excluded.score_keywords_json,
                score_reasoning      = excluded.score_reasoning,
                score_version        = excluded.score_version,
                scored_at            = excluded.scored_at,
                stages_json          = excluded.stages_json,
                last_updated_at      = excluded.last_updated_at
            """,
            (
                str(projection.tenant_id),
                projection.job_id,
                projection.description_preview,
                projection.score_breakdown_json,
                projection.score_keywords_json,
                projection.score_reasoning,
                projection.score_version,
                projection.scored_at,
                json.dumps(
                    [
                        {
                            "stage": stage.stage,
                            "state": stage.state,
                            "attempt_count": stage.attempt_count,
                            "max_attempts": stage.max_attempts,
                            "started_at": stage.started_at,
                            "updated_at": stage.updated_at,
                            "finished_at": stage.finished_at,
                            "duration_ms": stage.duration_ms,
                            "error_code": stage.error_code,
                            "error_message": stage.error_message,
                            "retryable": stage.retryable,
                            "blocked_by": list(stage.blocked_by),
                            "next_action": stage.next_action,
                        }
                        for stage in projection.stages
                    ]
                ),
                projection.last_updated_at,
            ),
        )

    def upsert_artifact(self, projection: ArtifactListProjection) -> None:
        self._conn.execute(
            """
            INSERT INTO artifact_list_projections (
                artifact_id, tenant_id, job_id, job_title, job_employer,
                artifact_type, status, local_path, size_bytes, created_at,
                generation
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(artifact_id) DO UPDATE SET
                job_id        = excluded.job_id,
                job_title     = excluded.job_title,
                job_employer  = excluded.job_employer,
                artifact_type = excluded.artifact_type,
                status        = excluded.status,
                local_path    = excluded.local_path,
                size_bytes    = excluded.size_bytes,
                created_at    = excluded.created_at,
                generation    = excluded.generation
            """,
            (
                projection.artifact_id,
                str(projection.tenant_id),
                projection.job_id,
                projection.job_title,
                projection.job_employer,
                projection.artifact_type,
                projection.status,
                projection.local_path,
                projection.size_bytes,
                projection.created_at,
                projection.generation,
            ),
        )

    def replace_artifacts_for_job(
        self,
        tenant_id: str,
        job_id: str,
        projections: Iterable[ArtifactListProjection],
    ) -> None:
        """Idempotently replace the artifact set for one job."""
        self._conn.execute(
            "DELETE FROM artifact_list_projections WHERE tenant_id = ? AND job_id = ?",
            (tenant_id, job_id),
        )
        for projection in projections:
            self.upsert_artifact(projection)

    def upsert_apply_run(self, projection: ApplyRunProjection) -> None:
        self._conn.execute(
            """
            INSERT INTO apply_run_projections (
                run_id, tenant_id, job_id, job_title, job_employer, status,
                result, dry_run, worker_id, model, started_at, finished_at,
                duration_ms, events_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id) DO UPDATE SET
                tenant_id    = excluded.tenant_id,
                job_id       = excluded.job_id,
                job_title    = excluded.job_title,
                job_employer = excluded.job_employer,
                status       = excluded.status,
                result       = excluded.result,
                dry_run      = excluded.dry_run,
                worker_id    = excluded.worker_id,
                model        = excluded.model,
                started_at   = excluded.started_at,
                finished_at  = excluded.finished_at,
                duration_ms  = excluded.duration_ms,
                events_json  = excluded.events_json
            """,
            (
                projection.run_id,
                str(projection.tenant_id),
                projection.job_id,
                projection.job_title,
                projection.job_employer,
                projection.status,
                projection.result,
                1 if projection.dry_run else 0,
                projection.worker_id,
                projection.model,
                projection.started_at,
                projection.finished_at,
                projection.duration_ms,
                json.dumps(list(projection.events)),
            ),
        )

    # ------------------------------------------------------------ read side

    def count_job_list(self, tenant_id: str) -> int:
        row = self._conn.execute(
            "SELECT COUNT(*) FROM job_list_projections WHERE tenant_id = ?",
            (tenant_id,),
        ).fetchone()
        return int(row[0] if row else 0)

    def fetch_job_list(self, tenant_id: str) -> list[sqlite3.Row]:
        return list(
            self._conn.execute(
                "SELECT * FROM job_list_projections WHERE tenant_id = ? ORDER BY job_id",
                (tenant_id,),
            ).fetchall()
        )

    def fetch_dashboard(self, tenant_id: str) -> sqlite3.Row | None:
        return self._conn.execute(
            "SELECT * FROM dashboard_projections WHERE tenant_id = ?",
            (tenant_id,),
        ).fetchone()

    def fetch_job_detail(self, tenant_id: str, job_id: str) -> sqlite3.Row | None:
        return self._conn.execute(
            """
            SELECT * FROM job_detail_projections
            WHERE tenant_id = ? AND job_id = ?
            """,
            (tenant_id, job_id),
        ).fetchone()

    def fetch_artifacts(self, tenant_id: str) -> list[sqlite3.Row]:
        return list(
            self._conn.execute(
                "SELECT * FROM artifact_list_projections WHERE tenant_id = ?",
                (tenant_id,),
            ).fetchall()
        )

    def fetch_apply_runs(self, tenant_id: str) -> list[sqlite3.Row]:
        return list(
            self._conn.execute(
                """
                SELECT * FROM apply_run_projections
                WHERE tenant_id = ?
                ORDER BY started_at DESC
                """,
                (tenant_id,),
            ).fetchall()
        )

    def commit(self) -> None:
        self._conn.commit()
