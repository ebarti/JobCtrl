"""JobCtrl database layer: schema, migrations, stats, and connection helpers.

Single source of truth for the jobs table schema. All columns from every
pipeline stage are created up front so any stage can run independently
without migration ordering issues.

This module also owns the apply-agent observability tables used for
persistent run and event telemetry.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jobctrl.config import DB_PATH, DEFAULTS
from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V7_MANIFEST,
    SchemaManifestError,
    assert_exact_manifest,
    schema_dump,
)
from jobctrl.scoring.eligibility_sql import (
    register_score_eligibility_sql,
    score_eligible_for_downstream_sql,
)

# Schema version stamped into the SQLite ``user_version`` header. Runtime opens
# only this exact schema and refuses databases written by newer code. The only
# supported upgrade is the explicit stopped-runtime v6-to-v7 cutover.
#
# v2 (Contact & Outreach): generic ``entity_kind``/``entity_ref`` columns on
# ``job_events`` so contact-only events carry honest identity without
# overloading job identity (outreach planner plan §10.1, owner decision 2b).
# v3 (Discovery execution lineage): immutable Temporal execution/job membership
# and the idempotently filled preparation work plan used by Operations.
# v4 (JobStreaming durability): immutable search units, fenced provider
# checkpoints, and idempotent accepted-job receipts.
# v5 (JobStreaming consumption ordering): the provider checkpoint revision that
# must be acknowledged before a requested cursor reset can be applied, plus
# replay-idempotent receipts for caller-filtered provider results.
# v6 (repeat-application prevention): evidence-bound confirmations,
# one-attempt consumption, and immutable protection audit records.
# v7 replaces URL-shaped storage identity with canonical ``(tenant_id,
# job_id)`` keys. Posting URLs remain unique locators, never aggregate identity.
SCHEMA_VERSION = 7


class IncompatibleSchemaVersionError(RuntimeError):
    """Raised when the database was written by a newer build than this code."""


class SchemaMigrationRequiredError(RuntimeError):
    """Raised when a stopped-runtime v6 cutover has not been run."""


# Thread-local connection storage — each thread gets its own connection
# (required for SQLite thread safety with parallel workers)
_local = threading.local()


def get_connection(
    db_path: Path | str | None = None,
    *,
    enable_wal: bool = True,
) -> sqlite3.Connection:
    """Get a thread-local cached SQLite connection with WAL mode enabled.

    Each thread gets its own connection (required for SQLite thread safety).
    Connections are cached and reused within the same thread.

    Args:
        db_path: Override the default DB_PATH. Useful for testing.

    Returns:
        sqlite3.Connection configured with WAL mode and row factory.
    """
    path = str(db_path or DB_PATH)

    if not hasattr(_local, "connections"):
        _local.connections = {}

    conn = _local.connections.get(path)
    if conn is not None:
        try:
            conn.execute("SELECT 1")
            register_score_eligibility_sql(conn)
            return conn
        except sqlite3.ProgrammingError:
            pass

    conn = sqlite3.connect(path, timeout=30)
    if enable_wal:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=10000")
    conn.row_factory = sqlite3.Row
    register_score_eligibility_sql(conn)
    _local.connections[path] = conn
    return conn


def close_connection(db_path: Path | str | None = None) -> None:
    """Close the cached connection for the current thread."""
    path = str(db_path or DB_PATH)
    if hasattr(_local, "connections"):
        conn = _local.connections.pop(path, None)
        if conn is not None:
            conn.close()


def backup_database(
    output: Path | str | None = None,
    *,
    db_path: Path | str | None = None,
) -> Path:
    """Write a consistent snapshot of the live database with ``VACUUM INTO``.

    ``VACUUM INTO`` copies a transactionally consistent view of the database
    even while the app is running under WAL, and always emits a standalone
    single-file database (no ``-wal`` / ``-shm`` sidecars) that can be copied
    over ``jobctrl.db`` to restore. Nothing is ever deleted.

    Args:
        output: Destination file, or an existing directory to place a
            timestamped file into. Defaults to a timestamped file under a
            ``backups/`` directory next to the source database.
        db_path: Override the source database path (defaults to ``DB_PATH``).

    Returns:
        The path the backup was written to.
    """
    source = Path(db_path or DB_PATH)
    if not source.exists():
        raise FileNotFoundError(f"No database to back up at {source}")

    destination = _resolve_backup_destination(source, output)
    if destination.exists():
        raise FileExistsError(f"Backup destination already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)

    src = sqlite3.connect(source)
    try:
        # Match the app's lock-wait budget so a backup taken during transient
        # DDL waits briefly instead of failing on "database is locked".
        src.execute("PRAGMA busy_timeout=10000")
        src.execute("VACUUM INTO ?", (str(destination),))
    finally:
        src.close()
    return destination


def _resolve_backup_destination(source: Path, output: Path | str | None) -> Path:
    if output is not None:
        candidate = Path(output).expanduser()
        if not candidate.is_dir():
            return candidate
        target_dir = candidate
    else:
        target_dir = source.parent / "backups"
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return target_dir / f"jobctrl-{timestamp}.db"


def _assert_schema_version_supported(
    conn: sqlite3.Connection,
    *,
    supported_version: int = SCHEMA_VERSION,
) -> int:
    """Refuse a database written by a newer build before schema writes."""
    current = int(conn.execute("PRAGMA user_version").fetchone()[0])
    if current > supported_version:
        raise IncompatibleSchemaVersionError(
            f"database was written by a newer JobCtrl build "
            f"(schema version {current} > code schema version {supported_version}); "
            f"upgrade JobCtrl or restore a compatible backup ('jobctrl backup')."
        )
    return current


def create_exact_v7_database(
    db_path: Path | str | None = None,
) -> sqlite3.Connection:
    """Create a brand-new database directly from the exact v7 schema."""
    path = Path(db_path or DB_PATH)
    if path.exists():
        raise FileExistsError(
            f"exact v7 creation requires a missing database path, found {path}"
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = get_connection(path)
    try:
        if schema_dump(conn):
            raise SchemaManifestError("fresh v7 creation found pre-existing schema")

        from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema

        create_exact_v7_schema(conn)
        conn.commit()
        return conn
    except BaseException:
        close_connection(path)
        for created_path in (
            path,
            Path(f"{path}-wal"),
            Path(f"{path}-shm"),
            Path(f"{path}-journal"),
        ):
            created_path.unlink(missing_ok=True)
        raise


def open_exact_v7_database(
    db_path: Path | str | None = None,
) -> sqlite3.Connection:
    """Open an existing exact-v7 database without performing any writes."""
    path = Path(db_path or DB_PATH)
    if not path.exists():
        raise FileNotFoundError(f"No database to open at {path}")
    conn = get_connection(path, enable_wal=False)
    current_version = _assert_schema_version_supported(conn)
    if current_version == 6:
        raise SchemaMigrationRequiredError(
            "JobCtrl database is schema v6. Run `jobctrl update` so the native "
            "lifecycle can stop JobCtrl, verify quiescence, create the paired "
            "backup, and activate schema v7 before starting the runtime."
        )
    if current_version != SCHEMA_VERSION:
        raise SchemaMigrationRequiredError(
            "JobCtrl can only open the exact schema v7 at runtime; "
            f"found schema version {current_version}."
        )
    assert_exact_manifest(conn, EXACT_V7_MANIFEST)
    return conn


def init_db(db_path: Path | str | None = None) -> sqlite3.Connection:
    """Create a missing v7 database or read-only validate an existing one."""
    path = Path(db_path or DB_PATH)
    if not path.exists():
        return create_exact_v7_database(path)
    return open_exact_v7_database(path)


def ensure_projection_tables_in_db(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create the Operations / Read-Side projection tables (Phase 9 / S-32).

    Defers to ``infrastructure.projections.sqlite_projection_store`` so the
    schema lives next to its adapter; ``init_db`` calls it as part of the
    standard startup migrations.  The import is local to keep
    ``database.py`` free of infrastructure imports at module-load time.
    """
    if conn is None:
        conn = get_connection()

    from jobctrl.infrastructure.projections.sqlite_projection_store import (
        ensure_projection_tables,
    )

    return ensure_projection_tables(conn)


def ensure_discovery_run_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create Discovery-owned scheduled run persistence tables."""
    if conn is None:
        conn = get_connection()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS discovery_runs (
            tenant_id              TEXT NOT NULL DEFAULT 'local',
            run_id                 TEXT NOT NULL,
            source_ids_json        TEXT NOT NULL DEFAULT '[]',
            profile_snapshot_id    TEXT,
            status                 TEXT NOT NULL,
            counts_json            TEXT NOT NULL DEFAULT '{}',
            progress_json          TEXT NOT NULL DEFAULT '{}',
            error_classes_json     TEXT NOT NULL DEFAULT '[]',
            started_at             TEXT NOT NULL,
            updated_at             TEXT,
            completed_at           TEXT,
            failed_at              TEXT,
            workflow_id            TEXT,
            PRIMARY KEY (tenant_id, run_id)
        )
        """
    )
    existing_cols = {row[1] for row in conn.execute("PRAGMA table_info(discovery_runs)").fetchall()}
    if "progress_json" not in existing_cols:
        conn.execute("ALTER TABLE discovery_runs ADD COLUMN progress_json TEXT NOT NULL DEFAULT '{}'")
    if "updated_at" not in existing_cols:
        conn.execute("ALTER TABLE discovery_runs ADD COLUMN updated_at TEXT")
    if "workflow_id" not in existing_cols:
        conn.execute("ALTER TABLE discovery_runs ADD COLUMN workflow_id TEXT")
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_discovery_runs_started
        ON discovery_runs(tenant_id, started_at DESC)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_discovery_runs_status
        ON discovery_runs(tenant_id, status, started_at DESC)
        """
    )
    conn.commit()
    return ["discovery_runs"]


def ensure_operational_metric_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create Operations-owned append-only attempt metric tables."""
    if conn is None:
        conn = get_connection()

    from jobctrl.operational_metrics import ensure_operational_metric_tables as ensure_tables

    return ensure_tables(conn)


# Complete column registry: column_name -> SQL type with optional default.
# This is the single source of truth. Adding a column here is all that's needed
# for it to appear in both new databases and migrated ones.
_ALL_COLUMNS: dict[str, str] = {
    # Discovery
    "url": "TEXT PRIMARY KEY",
    "title": "TEXT",
    "company": "TEXT",
    "salary": "TEXT",
    "description": "TEXT",
    "location": "TEXT",
    "site": "TEXT",
    "strategy": "TEXT",
    "discovered_at": "TEXT",
    # Enrichment
    "full_description": "TEXT",
    "application_url": "TEXT",
    "detail_scraped_at": "TEXT",
    "detail_error": "TEXT",
    # Scoring
    "fit_score": "INTEGER",
    "score_reasoning": "TEXT",
    "scored_at": "TEXT",
    # Tailoring
    "tailored_resume_path": "TEXT",
    "tailored_at": "TEXT",
    "tailor_attempts": "INTEGER DEFAULT 0",
    # Cover letter
    "cover_letter_path": "TEXT",
    "cover_letter_at": "TEXT",
    "cover_attempts": "INTEGER DEFAULT 0",
    # Application
    "applied_at": "TEXT",
    "apply_status": "TEXT",
    "apply_error": "TEXT",
    "apply_attempts": "INTEGER DEFAULT 0",
    "agent_id": "TEXT",
    "last_attempted_at": "TEXT",
    "apply_duration_ms": "INTEGER",
    "apply_task_id": "TEXT",
    "verification_confidence": "TEXT",
}


def ensure_columns(conn: sqlite3.Connection | None = None) -> list[str]:
    """Add any missing columns to the jobs table (forward migration).

    Reads the current table schema via PRAGMA table_info and compares against
    the full column registry. Any missing columns are added with ALTER TABLE.

    This makes it safe to upgrade the database from any previous version --
    columns are only added, never removed or renamed.

    Args:
        conn: Database connection. Uses get_connection() if None.

    Returns:
        List of column names that were added (empty if schema was already current).
    """
    if conn is None:
        conn = get_connection()

    existing = {row[1] for row in conn.execute("PRAGMA table_info(jobs)").fetchall()}
    added = []

    for col, dtype in _ALL_COLUMNS.items():
        if col not in existing:
            # PRIMARY KEY columns can't be added via ALTER TABLE, but url
            # is always created with the table itself so this is safe
            if "PRIMARY KEY" in dtype:
                continue
            conn.execute(f"ALTER TABLE jobs ADD COLUMN {col} {dtype}")
            added.append(col)

    if added:
        conn.commit()

    return added


def ensure_application_review_decision_columns(
    conn: sqlite3.Connection | None = None,
) -> list[str]:
    """Add approval-binding columns to application_review_decisions."""
    if conn is None:
        conn = get_connection()

    existing = {
        row[1]
        for row in conn.execute(
            "PRAGMA table_info(application_review_decisions)"
        ).fetchall()
    }
    additions = {
        "materials_generation": "INTEGER",
        "profile_version": "INTEGER",
        "application_url": "TEXT",
        "partial_override_run_id": "TEXT",
        "email_recipient": "TEXT",
        "email_attachment_artifact_id": "TEXT",
    }
    added: list[str] = []
    for column, definition in additions.items():
        if column not in existing:
            conn.execute(
                f"ALTER TABLE application_review_decisions ADD COLUMN {column} {definition}"
            )
            added.append(column)
    conn.commit()
    return added


def drop_legacy_apply_runs_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Drop the legacy bespoke apply-runs tables.

    Per PR 4 of the Temporal stack: the Temporal workflow run is the
    canonical record of an apply lifecycle; ``apply_run_projections``
    (sourced from ``job_events``) is the read-side. Both ``apply_runs``
    and ``apply_run_events`` are removed in a one-shot migration. Single
    user, no production data — wipe accepted per ``feedback_no_strangler``.
    """
    if conn is None:
        conn = get_connection()
    conn.execute("DROP TABLE IF EXISTS apply_run_events")
    conn.execute("DROP TABLE IF EXISTS apply_runs")
    conn.commit()
    return ["apply_runs", "apply_run_events"]


def ensure_state_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create normalized per-job state tables if they do not exist.

    The legacy ``jobs`` columns remain in place for compatibility, but these
    tables give the pipeline a durable source of truth for state, events, and
    artifacts that can be inspected without reverse-engineering nullable
    columns or generated files.
    """
    if conn is None:
        conn = get_connection()

    conn.execute("""
        CREATE TABLE IF NOT EXISTS job_stage_states (
            job_url             TEXT NOT NULL,
            stage               TEXT NOT NULL,
            state               TEXT NOT NULL DEFAULT 'pending',
            attempt_count       INTEGER DEFAULT 0,
            max_attempts        INTEGER,
            started_at          TEXT,
            updated_at          TEXT NOT NULL,
            finished_at         TEXT,
            duration_ms         INTEGER,
            error_code          TEXT,
            error_message       TEXT,
            retryable           INTEGER DEFAULT 1,
            blocked_by_json     TEXT,
            next_action         TEXT,
            metadata_json       TEXT,
            version             INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (job_url, stage),
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        )
    """)
    # Forward-migrate columns added after the initial normalized stage table.
    # This is deliberately additive: existing lifecycle rows and application
    # facts are preserved while API-seeded or older local databases become
    # writable by the authoritative worker state transition.
    existing_cols = {row[1] for row in conn.execute("PRAGMA table_info(job_stage_states)").fetchall()}
    if "metadata_json" not in existing_cols:
        conn.execute("ALTER TABLE job_stage_states ADD COLUMN metadata_json TEXT")
    if "version" not in existing_cols:
        conn.execute("ALTER TABLE job_stage_states ADD COLUMN version INTEGER NOT NULL DEFAULT 0")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS job_events (
            event_id            INTEGER PRIMARY KEY AUTOINCREMENT,
            job_url             TEXT,
            stage               TEXT,
            event_type          TEXT NOT NULL,
            level               TEXT NOT NULL DEFAULT 'info',
            message             TEXT,
            occurred_at         TEXT NOT NULL,
            payload_json        TEXT,
            entity_kind         TEXT,
            entity_ref          TEXT,
            idempotency_key     TEXT,
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        )
    """)
    # Forward-migrate (schema v2): the generic entity_kind/entity_ref columns
    # let contact-only events (which have no job_url) carry honest identity
    # without overloading job_url — outreach planner plan §10.1, decision 2b.
    event_cols = {row[1] for row in conn.execute("PRAGMA table_info(job_events)").fetchall()}
    if "entity_kind" not in event_cols:
        conn.execute("ALTER TABLE job_events ADD COLUMN entity_kind TEXT")
    if "entity_ref" not in event_cols:
        conn.execute("ALTER TABLE job_events ADD COLUMN entity_ref TEXT")
    if "idempotency_key" not in event_cols:
        conn.execute("ALTER TABLE job_events ADD COLUMN idempotency_key TEXT")
    conn.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_job_events_idempotency_key
        ON job_events(idempotency_key)
        WHERE idempotency_key IS NOT NULL
        """
    )
    conn.execute("""
        CREATE TABLE IF NOT EXISTS job_artifacts (
            artifact_id         INTEGER PRIMARY KEY AUTOINCREMENT,
            job_url             TEXT NOT NULL,
            stage               TEXT NOT NULL,
            artifact_type       TEXT NOT NULL,
            status              TEXT NOT NULL DEFAULT 'candidate',
            path                TEXT NOT NULL,
            created_at          TEXT NOT NULL,
            size_bytes          INTEGER,
            metadata_json       TEXT,
            UNIQUE(job_url, stage, artifact_type, path),
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_job_stage_states_stage_state
        ON job_stage_states(stage, state, updated_at DESC)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_job_stage_states_job
        ON job_stage_states(job_url, stage)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_job_events_job_time
        ON job_events(job_url, occurred_at DESC, event_id DESC)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_job_events_stage_time
        ON job_events(stage, occurred_at DESC, event_id DESC)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_job_events_entity
        ON job_events(entity_kind, entity_ref, occurred_at DESC, event_id DESC)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_job_artifacts_job_stage
        ON job_artifacts(job_url, stage, status)
    """)
    # Event-watermark tracking — used by Phase 9 projection builders to
    # remember the last event_id they consumed.  The row exists per
    # projection name and is updated atomically as events are processed.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS event_watermarks (
            projection_name     TEXT PRIMARY KEY,
            last_event_id       INTEGER NOT NULL DEFAULT 0,
            updated_at          TEXT NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS digest_state (
            tenant_id              TEXT PRIMARY KEY DEFAULT 'local',
            last_acknowledged_at   TEXT,
            updated_at             TEXT NOT NULL
        )
    """)
    # S-09 / round-1 review M1: one-shot snake_case → PascalCase rename
    # over historical `job_events` rows.  The CASE expression is exhaustive
    # for every snake_case event_type the worker has emitted; rows that
    # are already PascalCase fall through the ELSE branch unchanged, so
    # this is idempotent and safe to re-run on every startup.
    conn.execute("""
        UPDATE job_events SET event_type = CASE event_type
            WHEN 'stage_started'      THEN 'StageStarted'
            WHEN 'stage_succeeded'    THEN 'StageCompleted'
            WHEN 'stage_completed'    THEN 'StageCompleted'
            WHEN 'stage_failed'       THEN 'StageFailed'
            WHEN 'stage_exhausted'    THEN 'StageExhausted'
            WHEN 'stage_blocked'      THEN 'StageBlocked'
            WHEN 'stage_skipped'      THEN 'StageSkipped'
            WHEN 'stage_reset'        THEN 'StageReset'
            WHEN 'stage_canceled'     THEN 'StageCanceled'
            WHEN 'retry_requested'    THEN 'StageReset'
            WHEN 'mark_applied'       THEN 'ApplicationManuallyMarked'
            WHEN 'mark_skipped'       THEN 'StageSkipped'
            WHEN 'cancel_requested'   THEN 'StageCanceled'
            WHEN 'dry_run_completed'  THEN 'DryRunCompleted'
            WHEN 'lock_released'      THEN 'LockReleased'
            WHEN 'job_deleted'        THEN 'JobDeleted'
            WHEN 'job_restored'       THEN 'JobRestored'
            WHEN 'action_started'     THEN 'ActionStarted'
            WHEN 'action_succeeded'   THEN 'ActionSucceeded'
            WHEN 'action_failed'      THEN 'ActionFailed'
            ELSE event_type
        END
        WHERE event_type IN (
            'stage_started','stage_succeeded','stage_completed','stage_failed',
            'stage_exhausted','stage_blocked','stage_skipped','stage_reset',
            'stage_canceled','retry_requested','mark_applied','mark_skipped',
            'cancel_requested','dry_run_completed','lock_released',
            'job_deleted','job_restored',
            'action_started','action_succeeded','action_failed'
        )
    """)
    # Phase 9 / S-32 (round-1 review M1): one-shot backfill from legacy
    # ``jobs`` columns into ``job_stage_states``.  Per the no-strangler
    # directive, the read-side projection refreshers (TS + Python) must
    # NOT carry a "derive stage state from legacy columns" compat shim
    # — the canonical source has to be ``job_stage_states``.  This
    from jobctrl.state import (
        reconcile_dependency_blockers,
        reconcile_tailor_terminal_dependents,
    )

    reconcile_dependency_blockers(conn)
    reconcile_tailor_terminal_dependents(conn)
    conn.commit()
    return ["job_stage_states", "job_events", "job_artifacts", "event_watermarks", "digest_state"]


def ensure_profile_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create normalized Candidate Profile tables.

    The canonical profile source now lives in relational rows. The schema
    deliberately has no raw profile/style blob escape hatch: aggregate value
    objects live as typed columns on ``candidate_profiles``; repeatable child
    entities and rule lists live in child tables.
    """
    if conn is None:
        conn = get_connection()

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS candidate_profiles (
            tenant_id                         TEXT NOT NULL DEFAULT 'local',
            profile_id                        TEXT NOT NULL DEFAULT 'default',
            personal_full_name                TEXT NOT NULL DEFAULT '',
            personal_preferred_name           TEXT NOT NULL DEFAULT '',
            personal_email                    TEXT NOT NULL DEFAULT '',
            personal_phone                    TEXT NOT NULL DEFAULT '',
            personal_address                  TEXT NOT NULL DEFAULT '',
            personal_city                     TEXT NOT NULL DEFAULT '',
            personal_province_state           TEXT NOT NULL DEFAULT '',
            personal_country                  TEXT NOT NULL DEFAULT '',
            personal_postal_code              TEXT NOT NULL DEFAULT '',
            personal_linkedin_url             TEXT NOT NULL DEFAULT '',
            personal_github_url               TEXT NOT NULL DEFAULT '',
            personal_portfolio_url            TEXT NOT NULL DEFAULT '',
            personal_website_url              TEXT NOT NULL DEFAULT '',
            personal_password                 TEXT NOT NULL DEFAULT '',
            work_legally_authorized_to_work   TEXT NOT NULL DEFAULT '',
            work_require_sponsorship          TEXT NOT NULL DEFAULT '',
            work_work_permit_type             TEXT NOT NULL DEFAULT '',
            compensation_salary_expectation   TEXT NOT NULL DEFAULT '',
            compensation_salary_currency      TEXT NOT NULL DEFAULT 'USD',
            compensation_salary_range_min     TEXT NOT NULL DEFAULT '',
            compensation_salary_range_max     TEXT NOT NULL DEFAULT '',
            compensation_currency_note        TEXT NOT NULL DEFAULT '',
            experience_years_total            TEXT NOT NULL DEFAULT '',
            experience_education_level        TEXT NOT NULL DEFAULT '',
            experience_current_job_title      TEXT NOT NULL DEFAULT '',
            experience_current_company        TEXT NOT NULL DEFAULT '',
            experience_target_role            TEXT NOT NULL DEFAULT '',
            experience_target_track           TEXT NOT NULL DEFAULT '',
            experience_target_seniority_floor TEXT NOT NULL DEFAULT '',
            experience_target_functions       TEXT NOT NULL DEFAULT '',
            experience_target_specializations TEXT NOT NULL DEFAULT '',
            experience_target_locations       TEXT NOT NULL DEFAULT '',
            experience_target_work_models     TEXT NOT NULL DEFAULT '',
            availability_earliest_start_date  TEXT NOT NULL DEFAULT '',
            availability_full_time            TEXT NOT NULL DEFAULT '',
            availability_contract             TEXT NOT NULL DEFAULT '',
            eeo_gender                        TEXT NOT NULL DEFAULT 'Decline to self-identify',
            eeo_race_ethnicity                TEXT NOT NULL DEFAULT 'Decline to self-identify',
            eeo_veteran_status                TEXT NOT NULL DEFAULT 'Decline to self-identify',
            eeo_disability_status             TEXT NOT NULL DEFAULT 'Decline to self-identify',
            resume_baseline_text              TEXT NOT NULL DEFAULT '',
            tailoring_mode                    TEXT NOT NULL DEFAULT 'balanced',
            tailoring_allow_title_reframing   INTEGER NOT NULL DEFAULT 0,
            tailoring_allow_achievement_rewriting INTEGER NOT NULL DEFAULT 1,
            tailoring_allow_skill_reordering  INTEGER NOT NULL DEFAULT 1,
            tailoring_allow_summary_rewrite   INTEGER NOT NULL DEFAULT 1,
            tailoring_allow_minor_inference   INTEGER NOT NULL DEFAULT 0,
            tailoring_claim_mode              TEXT NOT NULL DEFAULT 'evidence_reframing',
            tailoring_auto_approvable_claim_modes_json TEXT NOT NULL DEFAULT '["verified_only","evidence_reframing"]',
            tailoring_allow_adjacent_achievement_drafts INTEGER NOT NULL DEFAULT 0,
            writing_tone                      TEXT NOT NULL DEFAULT 'direct',
            writing_bullet_style              TEXT NOT NULL DEFAULT 'balanced',
            writing_verbosity                 TEXT NOT NULL DEFAULT 'balanced',
            writing_keyword_density           TEXT NOT NULL DEFAULT 'natural',
            writing_avoid_first_person        INTEGER NOT NULL DEFAULT 1,
            max_experience_bullets            INTEGER NOT NULL DEFAULT 4,
            custom_tailoring_prompt           TEXT NOT NULL DEFAULT '',
            revision_min_fit_score            INTEGER NOT NULL DEFAULT 8,
            revision_must_have_coverage       REAL NOT NULL DEFAULT 0.85,
            revision_max_attempts             INTEGER NOT NULL DEFAULT 1,
            resume_style_document_font_size   TEXT NOT NULL DEFAULT '11pt',
            resume_style_paper_size           TEXT NOT NULL DEFAULT 'a4paper',
            resume_style_font_family          TEXT NOT NULL DEFAULT 'sans',
            resume_style_moderncv_style       TEXT NOT NULL DEFAULT 'banking',
            resume_style_moderncv_color       TEXT NOT NULL DEFAULT 'black',
            resume_style_page_scale           REAL NOT NULL DEFAULT 0.85,
            resume_style_hints_column_width_cm REAL NOT NULL DEFAULT 3.0,
            resume_style_body_alignment       TEXT NOT NULL DEFAULT 'justified',
            resume_template_text              TEXT NOT NULL DEFAULT '',
            version                           INTEGER NOT NULL DEFAULT 1,
            updated_at                        TEXT NOT NULL,
            PRIMARY KEY (tenant_id, profile_id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS candidate_profile_experience_entries (
            tenant_id       TEXT NOT NULL,
            profile_id      TEXT NOT NULL,
            entry_id        TEXT NOT NULL,
            position_index  INTEGER NOT NULL,
            date_range      TEXT NOT NULL DEFAULT '',
            title           TEXT NOT NULL DEFAULT '',
            company         TEXT NOT NULL DEFAULT '',
            location        TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (tenant_id, profile_id, entry_id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS candidate_profile_experience_bullets (
            tenant_id       TEXT NOT NULL,
            profile_id      TEXT NOT NULL,
            entry_id        TEXT NOT NULL,
            bullet_index    INTEGER NOT NULL,
            bullet_text     TEXT NOT NULL,
            PRIMARY KEY (tenant_id, profile_id, entry_id, bullet_index)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS candidate_profile_achievement_evidence (
            tenant_id       TEXT NOT NULL,
            profile_id      TEXT NOT NULL,
            entry_id        TEXT NOT NULL,
            evidence_index  INTEGER NOT NULL,
            evidence_id     TEXT NOT NULL DEFAULT '',
            source_text     TEXT NOT NULL DEFAULT '',
            scope           TEXT NOT NULL DEFAULT '',
            action          TEXT NOT NULL DEFAULT '',
            tools_json      TEXT NOT NULL DEFAULT '[]',
            metrics_json    TEXT NOT NULL DEFAULT '[]',
            outcome         TEXT NOT NULL DEFAULT '',
            seniority_signal TEXT NOT NULL DEFAULT '',
            evidence_strength TEXT NOT NULL DEFAULT 'supported',
            claim_confidence REAL NOT NULL DEFAULT 0,
            user_confirmed  INTEGER NOT NULL DEFAULT 0,
            tags_json       TEXT NOT NULL DEFAULT '[]',
            PRIMARY KEY (tenant_id, profile_id, entry_id, evidence_index)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS candidate_profile_education_entries (
            tenant_id       TEXT NOT NULL,
            profile_id      TEXT NOT NULL,
            entry_id        TEXT NOT NULL,
            position_index  INTEGER NOT NULL,
            date            TEXT NOT NULL DEFAULT '',
            degree          TEXT NOT NULL DEFAULT '',
            institution     TEXT NOT NULL DEFAULT '',
            location        TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (tenant_id, profile_id, entry_id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS candidate_profile_skill_categories (
            tenant_id       TEXT NOT NULL,
            profile_id      TEXT NOT NULL,
            category_id     TEXT NOT NULL,
            position_index  INTEGER NOT NULL,
            label           TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (tenant_id, profile_id, category_id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS candidate_profile_skill_items (
            tenant_id       TEXT NOT NULL,
            profile_id      TEXT NOT NULL,
            category_id     TEXT NOT NULL,
            item_index      INTEGER NOT NULL,
            item_text       TEXT NOT NULL,
            PRIMARY KEY (tenant_id, profile_id, category_id, item_index)
        )
        """
    )

    for table, column in (
        ("candidate_profile_required_experience_entries", "entry_id"),
        ("candidate_profile_required_education_entries", "entry_id"),
        ("candidate_profile_required_skill_categories", "category_id"),
    ):
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {table} (
                tenant_id       TEXT NOT NULL,
                profile_id      TEXT NOT NULL,
                position_index  INTEGER NOT NULL,
                {column}        TEXT NOT NULL,
                PRIMARY KEY (tenant_id, profile_id, position_index)
            )
            """
        )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS candidate_profile_required_bullets (
            tenant_id       TEXT NOT NULL,
            profile_id      TEXT NOT NULL,
            entry_id        TEXT NOT NULL,
            bullet_index    INTEGER NOT NULL,
            bullet_text     TEXT NOT NULL,
            PRIMARY KEY (tenant_id, profile_id, entry_id, bullet_index)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS candidate_profile_required_skills (
            tenant_id       TEXT NOT NULL,
            profile_id      TEXT NOT NULL,
            category_id     TEXT NOT NULL,
            skill_index     INTEGER NOT NULL,
            skill_text      TEXT NOT NULL,
            PRIMARY KEY (tenant_id, profile_id, category_id, skill_index)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS candidate_profile_resume_constraint_metrics (
            tenant_id       TEXT NOT NULL,
            profile_id      TEXT NOT NULL,
            metric_index    INTEGER NOT NULL,
            metric_text     TEXT NOT NULL,
            PRIMARY KEY (tenant_id, profile_id, metric_index)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_candidate_profile_experience_order
        ON candidate_profile_experience_entries(tenant_id, profile_id, position_index)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_candidate_profile_education_order
        ON candidate_profile_education_entries(tenant_id, profile_id, position_index)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_candidate_profile_skill_order
        ON candidate_profile_skill_categories(tenant_id, profile_id, position_index)
        """
    )
    conn.commit()
    return [
        "candidate_profiles",
        "candidate_profile_experience_entries",
        "candidate_profile_experience_bullets",
        "candidate_profile_achievement_evidence",
        "candidate_profile_education_entries",
        "candidate_profile_skill_categories",
        "candidate_profile_skill_items",
        "candidate_profile_required_experience_entries",
        "candidate_profile_required_education_entries",
        "candidate_profile_required_skill_categories",
        "candidate_profile_required_bullets",
        "candidate_profile_required_skills",
        "candidate_profile_resume_constraint_metrics",
    ]


def ensure_score_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create the per-job ``job_scores`` table and run its one-shot backfill.

    See ddd-target.md §7.2. The table is the persistence side of the
    Phase-5 ``JobScore`` aggregate; the legacy ``jobs.fit_score`` /
    ``jobs.score_reasoning`` / ``jobs.scored_at`` columns remain in the
    schema as a read-only fallback for historical rows but new scoring
    writes target this table only (no-strangler directive).

    Backfill is **idempotent**: it only fires when ``job_scores`` is empty
    AND ``jobs.fit_score`` has values. Each backfilled row becomes
    ``version = 1`` with ``breakdown_json = {"reasoning":
    jobs.score_reasoning, "legacy": true}`` so consumers can tell
    machine-generated rows apart from migrated ones.
    """
    if conn is None:
        conn = get_connection()

    conn.execute("""
        CREATE TABLE IF NOT EXISTS job_scores (
            job_url             TEXT NOT NULL,
            version             INTEGER NOT NULL,
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            fit_score           INTEGER NOT NULL CHECK(fit_score BETWEEN 1 AND 10),
            breakdown_json      TEXT NOT NULL,
            keywords_json       TEXT NOT NULL,
            scored_at           TEXT NOT NULL,
            correction_json     TEXT,
            criteria_json       TEXT NOT NULL DEFAULT '{}',
            trace_json          TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY (job_url, version),
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        )
    """)
    existing_score_cols = {row[1] for row in conn.execute("PRAGMA table_info(job_scores)").fetchall()}
    if "criteria_json" not in existing_score_cols:
        conn.execute("ALTER TABLE job_scores ADD COLUMN criteria_json TEXT NOT NULL DEFAULT '{}'")
    if "trace_json" not in existing_score_cols:
        conn.execute("ALTER TABLE job_scores ADD COLUMN trace_json TEXT NOT NULL DEFAULT '{}'")
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_job_scores_tenant_score
        ON job_scores(tenant_id, fit_score DESC, scored_at DESC)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_job_scores_job_version
        ON job_scores(job_url, version DESC)
    """)
    ensure_scoring_policy_tables(conn)
    ensure_score_staleness_tables(conn)
    ensure_requirement_fit_tables(conn)

    # One-shot backfill from the legacy columns. Only fires when
    # job_scores has no rows AND there are jobs with a legacy fit_score.
    backfill_count = conn.execute("SELECT COUNT(*) FROM job_scores").fetchone()[0]
    if backfill_count == 0:
        legacy_rows = conn.execute(
            """
            SELECT url, fit_score, score_reasoning, scored_at
            FROM jobs
            WHERE fit_score IS NOT NULL
              AND fit_score BETWEEN 1 AND 10
            """
        ).fetchall()
        if legacy_rows:
            now = datetime.now(timezone.utc).isoformat()
            for row in legacy_rows:
                url = row["url"] if isinstance(row, sqlite3.Row) else row[0]
                fit = row["fit_score"] if isinstance(row, sqlite3.Row) else row[1]
                reasoning = row["score_reasoning"] if isinstance(row, sqlite3.Row) else row[2]
                scored_at = row["scored_at"] if isinstance(row, sqlite3.Row) else row[3]
                breakdown_json = json.dumps(
                    {
                        "technical_fit": 0,
                        "experience_fit": 0,
                        "role_fit": 0,
                        "reasoning": reasoning or "",
                        "legacy": True,
                    },
                    sort_keys=True,
                )
                # Sentinel keyword keeps the canonical "MatchedKeywords is
                # non-empty" invariant (round-1 review M1) intact for
                # backfilled rows that pre-date keyword extraction.
                keywords_json = json.dumps(["legacy"])
                conn.execute(
                    """
                    INSERT OR IGNORE INTO job_scores (
                        job_url, version, tenant_id, fit_score,
                        breakdown_json, keywords_json, scored_at, correction_json,
                        criteria_json, trace_json
                    ) VALUES (?, 1, 'local', ?, ?, ?, ?, NULL, ?, ?)
                    """,
                    (
                        url,
                        int(fit),
                        breakdown_json,
                        keywords_json,
                        scored_at or now,
                        json.dumps({}, sort_keys=True),
                        json.dumps(
                            {
                                "prompt_version": "legacy",
                                "schema_version": "legacy",
                                "model": "legacy",
                                "parser_warnings": ["legacy_backfill"],
                                "correction_history": [],
                            },
                            sort_keys=True,
                        ),
                    ),
                )

    conn.commit()
    return [
        "job_scores",
        "scoring_policies",
        "job_score_staleness",
        "job_requirement_fit_reports",
        "job_requirement_fit_items",
    ]


def ensure_requirement_fit_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create canonical requirement-fit report persistence tables.

    The report belongs to the Scoring context and is keyed by a score version.
    Item rows preserve the requirement-level status, evidence, score
    contribution, and tailoring directive that downstream tailoring and review
    surfaces will consume in later phases.
    """
    if conn is None:
        conn = get_connection()

    conn.execute("""
        CREATE TABLE IF NOT EXISTS job_requirement_fit_reports (
            job_url                       TEXT NOT NULL,
            score_version                 INTEGER NOT NULL,
            tenant_id                     TEXT NOT NULL DEFAULT 'local',
            employer_analysis_generation  INTEGER NOT NULL,
            profile_snapshot_version      INTEGER NOT NULL,
            scoring_policy_version        INTEGER NOT NULL,
            formula_version               TEXT NOT NULL,
            resolved_fit_score            INTEGER CHECK(
                resolved_fit_score IS NULL
                OR resolved_fit_score BETWEEN 1 AND 10
            ),
            fit_band                      TEXT NOT NULL,
            confidence                    TEXT NOT NULL,
            summary_json                  TEXT NOT NULL DEFAULT '{}',
            created_at                    TEXT NOT NULL,
            PRIMARY KEY (job_url, score_version, tenant_id),
            FOREIGN KEY (job_url, score_version)
                REFERENCES job_scores(job_url, version) ON DELETE CASCADE
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS job_requirement_fit_items (
            job_url                 TEXT NOT NULL,
            score_version           INTEGER NOT NULL,
            tenant_id               TEXT NOT NULL DEFAULT 'local',
            requirement_id          TEXT NOT NULL,
            requirement_text        TEXT NOT NULL,
            tier                    TEXT NOT NULL CHECK(tier IN ('must_have', 'nice_to_have')),
            weight                  REAL NOT NULL CHECK(weight >= 0 AND weight <= 1),
            job_evidence_span       TEXT NOT NULL,
            fit_json                TEXT NOT NULL,
            contribution_json       TEXT NOT NULL,
            tailoring_json          TEXT NOT NULL,
            artifact_coverage_json  TEXT,
            position                INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (job_url, score_version, tenant_id, requirement_id),
            FOREIGN KEY (job_url, score_version, tenant_id)
                REFERENCES job_requirement_fit_reports(job_url, score_version, tenant_id)
                ON DELETE CASCADE
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_requirement_fit_reports_tenant_job
        ON job_requirement_fit_reports(tenant_id, job_url, score_version DESC)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_requirement_fit_items_requirement
        ON job_requirement_fit_items(tenant_id, requirement_id)
    """)
    conn.commit()
    return ["job_requirement_fit_reports", "job_requirement_fit_items"]


def ensure_scoring_policy_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create scoring-policy persistence tables.

    The current policy lives outside ``job_scores`` so score rows can keep
    an immutable trace of which policy version resolved them.
    """
    if conn is None:
        conn = get_connection()

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS scoring_policies (
            tenant_id              TEXT NOT NULL,
            version                INTEGER NOT NULL,
            rubric_json            TEXT NOT NULL,
            anchors_json           TEXT NOT NULL DEFAULT '[]',
            created_at             TEXT NOT NULL,
            created_from_event_id  INTEGER,
            PRIMARY KEY (tenant_id, version)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_scoring_policies_current
        ON scoring_policies(tenant_id, version DESC)
        """
    )
    conn.commit()
    return ["scoring_policies"]


def ensure_score_staleness_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create score-staleness markers used after scoring-policy changes."""
    if conn is None:
        conn = get_connection()

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS job_score_staleness (
            tenant_id                 TEXT NOT NULL DEFAULT 'local',
            job_url                   TEXT NOT NULL,
            stale_reason              TEXT NOT NULL,
            old_policy_id             TEXT NOT NULL DEFAULT '',
            old_policy_version        INTEGER NOT NULL,
            new_policy_id             TEXT NOT NULL DEFAULT '',
            new_policy_version        INTEGER NOT NULL,
            marked_at                 TEXT NOT NULL,
            resolved                  INTEGER NOT NULL DEFAULT 0,
            resolved_at               TEXT,
            resolved_by_score_version INTEGER,
            PRIMARY KEY (
                tenant_id, job_url, stale_reason,
                old_policy_version, new_policy_version
            ),
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_score_staleness_unresolved
        ON job_score_staleness(tenant_id, resolved, marked_at DESC)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_score_staleness_job
        ON job_score_staleness(tenant_id, job_url, resolved)
        """
    )
    conn.commit()
    return ["job_score_staleness"]


def ensure_tailoring_policy_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create Materials-owned tailoring-policy version persistence."""
    if conn is None:
        conn = get_connection()

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS tailoring_policies (
            tenant_id                   TEXT NOT NULL,
            version                     INTEGER NOT NULL,
            prompt_version              TEXT NOT NULL,
            schema_version              TEXT NOT NULL,
            judge_schema_version        TEXT NOT NULL,
            prompt_fingerprint          TEXT NOT NULL,
            config_fingerprint          TEXT NOT NULL,
            profile_policy_fingerprint  TEXT NOT NULL,
            custom_prompt_fingerprint   TEXT NOT NULL,
            generator_settings_json     TEXT NOT NULL DEFAULT '{}',
            judge_settings_json         TEXT NOT NULL DEFAULT '{}',
            runtime_settings_json       TEXT NOT NULL DEFAULT '{}',
            rollback_of_version         INTEGER,
            rollback_reason             TEXT NOT NULL DEFAULT '',
            created_at                  TEXT NOT NULL,
            created_from_event_id       INTEGER,
            PRIMARY KEY (tenant_id, version)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_tailoring_policies_current
        ON tailoring_policies(tenant_id, version DESC)
        """
    )
    conn.commit()
    return ["tailoring_policies"]


def ensure_preparation_work_item_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create Pipeline/Preparation durable work-item persistence tables."""
    if conn is None:
        conn = get_connection()

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS preparation_work_items (
            item_id          TEXT NOT NULL PRIMARY KEY,
            tenant_id        TEXT NOT NULL DEFAULT 'local',
            job_id           TEXT NOT NULL,
            kind             TEXT NOT NULL,
            target_version   INTEGER NOT NULL,
            source_event_id  TEXT NOT NULL DEFAULT '',
            state            TEXT NOT NULL,
            idempotency_key  TEXT NOT NULL,
            attempts         INTEGER NOT NULL DEFAULT 0,
            last_error       TEXT NOT NULL DEFAULT '',
            created_at       TEXT NOT NULL,
            updated_at       TEXT NOT NULL,
            available_at     TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_preparation_work_items_idempotency
        ON preparation_work_items(tenant_id, idempotency_key)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_preparation_work_items_claim
        ON preparation_work_items(tenant_id, state, kind, available_at)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_preparation_work_items_job_target
        ON preparation_work_items(tenant_id, job_id, kind, target_version)
        """
    )
    conn.commit()
    return ["preparation_work_items"]


def ensure_materials_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create the per-job ``job_materials`` tables and run their backfill.

    See ddd-target.md §4.5 / §7.2. Two tables form the persistence side
    of the Phase-6 :class:`MaterialsSet` aggregate:

      * ``job_materials`` — one row per ``(job_url, generation)`` aggregate.
      * ``job_materials_artifacts`` — one row per artifact slot per
        aggregate (``tailored_resume``, ``cover_letter``, ``resume_pdf``,
        ``cover_letter_pdf``).
      * ``job_material_layout_boxes`` — generation-time PDF audit layout boxes
        for rendered resume PDFs, keyed to the artifact they describe.

    The legacy ``jobs.tailored_resume_path`` / ``jobs.cover_letter_path``
    columns remain in the schema as a read-only fallback for historical
    rows, but new tailoring/cover writes target these tables only
    (no-strangler directive).

    Backfill is **idempotent**: it only fires when ``job_materials`` is
    empty AND ``jobs.tailored_resume_path`` has values. Each backfilled
    row becomes ``generation = 1`` with status ``cover_letter_ready`` (or
    ``resume_approved`` if no cover letter exists) so consumers see the
    expected lifecycle. ``size_bytes`` is captured from ``os.stat`` if
    the on-disk file is still present.
    """
    if conn is None:
        conn = get_connection()

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS job_materials (
            job_url             TEXT NOT NULL,
            generation          INTEGER NOT NULL,
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            status              TEXT NOT NULL,
            created_at          TEXT NOT NULL,
            updated_at          TEXT NOT NULL,
            last_validation_json TEXT,
            last_verdict_json    TEXT,
            metadata_json       TEXT,
            PRIMARY KEY (job_url, generation),
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS job_materials_artifacts (
            job_url             TEXT NOT NULL,
            generation          INTEGER NOT NULL,
            artifact_type       TEXT NOT NULL,
            artifact_id         TEXT NOT NULL,
            status              TEXT NOT NULL,
            path                TEXT NOT NULL,
            render_format       TEXT NOT NULL,
            size_bytes          INTEGER,
            metadata_json       TEXT,
            created_at          TEXT NOT NULL,
            superseded_at       TEXT,
            PRIMARY KEY (job_url, generation, artifact_type),
            FOREIGN KEY (job_url, generation) REFERENCES job_materials(job_url, generation)
                ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS job_material_layout_boxes (
            job_url             TEXT NOT NULL,
            generation          INTEGER NOT NULL,
            artifact_id         TEXT NOT NULL,
            box_index           INTEGER NOT NULL,
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            semantic_id         TEXT NOT NULL,
            page_number         INTEGER NOT NULL,
            line_number         INTEGER,
            text_excerpt        TEXT NOT NULL,
            left_pct            REAL NOT NULL,
            top_pct             REAL NOT NULL,
            width_pct           REAL NOT NULL,
            height_pct          REAL NOT NULL,
            audit_target_json   TEXT NOT NULL DEFAULT '{}',
            created_at          TEXT NOT NULL,
            PRIMARY KEY (job_url, generation, artifact_id, box_index),
            FOREIGN KEY (job_url, generation) REFERENCES job_materials(job_url, generation)
                ON DELETE CASCADE
        )
        """
    )
    # Indexes for the queue selectors (mirror the §7.2 read fragments).
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_materials_tenant_job_gen
        ON job_materials(tenant_id, job_url, generation DESC)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_materials_artifacts_status
        ON job_materials_artifacts(artifact_type, status, created_at DESC)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_material_layout_boxes_artifact
        ON job_material_layout_boxes(tenant_id, artifact_id, page_number, box_index)
        """
    )

    # Idempotent backfill from the legacy ``jobs`` columns. Fires only
    # when ``job_materials`` is empty.
    backfill_count = conn.execute("SELECT COUNT(*) FROM job_materials").fetchone()[0]
    if backfill_count == 0:
        legacy_rows = conn.execute(
            """
            SELECT url, tailored_resume_path, tailored_at,
                   cover_letter_path, cover_letter_at
            FROM jobs
            WHERE tailored_resume_path IS NOT NULL
              AND tailored_resume_path != ''
            """
        ).fetchall()
        if legacy_rows:
            now = datetime.now(timezone.utc).isoformat()
            for row in legacy_rows:
                _backfill_one_materials_row(conn, row, now)

    conn.commit()
    return ["job_materials", "job_materials_artifacts", "job_material_layout_boxes"]


def ensure_resume_template_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create local resume-template configuration tables.

    Templates are style/layout records only. Generated materials snapshot the
    effective template metadata in ``job_materials.metadata_json`` and artifact
    metadata; the rows here remain mutable configuration, not artifact history.
    """
    if conn is None:
        conn = get_connection()

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS resume_templates (
            tenant_id    TEXT NOT NULL DEFAULT 'local',
            template_id  TEXT NOT NULL,
            display_name TEXT NOT NULL,
            status       TEXT NOT NULL DEFAULT 'active',
            built_in     INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL,
            PRIMARY KEY (tenant_id, template_id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS resume_template_versions (
            tenant_id      TEXT NOT NULL DEFAULT 'local',
            version_id     TEXT NOT NULL,
            template_id    TEXT NOT NULL,
            version_number INTEGER NOT NULL,
            display_name   TEXT NOT NULL,
            status         TEXT NOT NULL DEFAULT 'active',
            theme_json     TEXT NOT NULL,
            layout_json    TEXT NOT NULL DEFAULT '{}',
            content_hash   TEXT NOT NULL,
            created_at     TEXT NOT NULL,
            PRIMARY KEY (tenant_id, version_id),
            UNIQUE (tenant_id, template_id, version_number)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_resume_template_versions_template
        ON resume_template_versions(tenant_id, template_id, version_number DESC)
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS resume_template_defaults (
            tenant_id   TEXT NOT NULL DEFAULT 'local',
            profile_id  TEXT NOT NULL DEFAULT 'default',
            template_id TEXT NOT NULL,
            version_id  TEXT NOT NULL,
            updated_at  TEXT NOT NULL,
            PRIMARY KEY (tenant_id, profile_id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS job_resume_template_assignments (
            tenant_id   TEXT NOT NULL DEFAULT 'local',
            job_url     TEXT NOT NULL,
            template_id TEXT NOT NULL,
            version_id  TEXT NOT NULL,
            updated_at  TEXT NOT NULL,
            PRIMARY KEY (tenant_id, job_url)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_resume_template_assignments_template
        ON job_resume_template_assignments(tenant_id, template_id, version_id)
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS resume_template_refresh_attempts (
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            attempt_id          TEXT NOT NULL,
            job_url             TEXT NOT NULL,
            status              TEXT NOT NULL,
            from_generation     INTEGER,
            to_generation       INTEGER,
            template_id         TEXT,
            template_version_id TEXT,
            template_hash       TEXT,
            error_message       TEXT,
            metadata_json       TEXT NOT NULL DEFAULT '{}',
            created_at          TEXT NOT NULL,
            completed_at        TEXT,
            PRIMARY KEY (tenant_id, attempt_id)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_resume_template_refresh_attempts_job
        ON resume_template_refresh_attempts(tenant_id, job_url, created_at DESC)
        """
    )

    from jobctrl.infrastructure.migrations.resume_template_seed import (
        seed_builtin_resume_template,
    )

    now = datetime.now(timezone.utc).isoformat()
    seed_builtin_resume_template(conn, created_at=now)
    conn.commit()
    return [
        "resume_templates",
        "resume_template_versions",
        "resume_template_defaults",
        "job_resume_template_assignments",
        "resume_template_refresh_attempts",
    ]


def _backfill_one_materials_row(
    conn: sqlite3.Connection,
    row: sqlite3.Row,
    now: str,
) -> None:
    """Backfill one legacy job into the new ``job_materials`` shape.

    The lifecycle status is derived from which legacy artifacts exist:
    ``resume_approved`` if only a tailored resume, ``cover_letter_ready``
    if a cover letter exists too, ``complete`` if a sibling PDF exists
    for both. Backfilled artifacts carry ``status = approved`` (the
    legacy column was never populated unless the artifact was accepted).
    """
    import os
    import uuid as _uuid

    url = row["url"]
    tailor_path = row["tailored_resume_path"]
    tailor_at = row["tailored_at"] or now
    cover_path = row["cover_letter_path"]
    cover_at = row["cover_letter_at"] or now

    status = "resume_approved"
    if cover_path:
        status = "cover_letter_ready"

    # Detect sibling PDFs from the legacy convention (foo.txt → foo.pdf).
    def _sibling_pdf(path: str | None) -> str | None:
        if not path:
            return None
        if "." in path.rsplit("/", 1)[-1]:
            base = path.rsplit(".", 1)[0]
        else:
            base = path
        candidate = f"{base}.pdf"
        return candidate if os.path.exists(candidate) else None

    resume_pdf = _sibling_pdf(tailor_path)
    cover_pdf = _sibling_pdf(cover_path)

    if resume_pdf and cover_pdf and cover_path:
        status = "complete"

    conn.execute(
        """
        INSERT OR IGNORE INTO job_materials (
            job_url, generation, tenant_id, status,
            created_at, updated_at,
            last_validation_json, last_verdict_json, metadata_json
        ) VALUES (?, 1, 'local', ?, ?, ?, NULL, NULL, ?)
        """,
        (
            url,
            status,
            tailor_at,
            cover_at if cover_path else tailor_at,
            json.dumps({"backfilled": True}, sort_keys=True),
        ),
    )

    def _size(path: str | None) -> int | None:
        if not path:
            return None
        try:
            return os.path.getsize(path) if os.path.exists(path) else None
        except OSError:
            return None

    artifacts: list[tuple[str, str, str, int | None, str]] = []
    if tailor_path:
        artifacts.append(("tailored_resume", tailor_path, "text", _size(tailor_path), tailor_at))
    if resume_pdf:
        artifacts.append(("resume_pdf", resume_pdf, "latex_pdf", _size(resume_pdf), tailor_at))
    if cover_path:
        artifacts.append(("cover_letter", cover_path, "text", _size(cover_path), cover_at))
    if cover_pdf:
        artifacts.append(("cover_letter_pdf", cover_pdf, "html_pdf", _size(cover_pdf), cover_at))

    for artifact_type, path, render_format, size, created in artifacts:
        conn.execute(
            """
            INSERT OR IGNORE INTO job_materials_artifacts (
                job_url, generation, artifact_type, artifact_id,
                status, path, render_format, size_bytes,
                metadata_json, created_at, superseded_at
            ) VALUES (?, 1, ?, ?, 'approved', ?, ?, ?, ?, ?, NULL)
            """,
            (
                url,
                artifact_type,
                _uuid.uuid4().hex,
                path,
                render_format,
                size,
                json.dumps({"backfilled": True}, sort_keys=True),
                created,
            ),
        )


def ensure_employer_analysis_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create the canonical employer-analysis tables (Phase 1).

    The persisted "ideal candidate" analysis that replaces ``_extract_job_keywords``
    and drives downstream tailoring. Per D-09 the analysis is stored as CANONICAL
    ROWS — never inside an artifact ``metadata_json`` blob:

      * ``job_employer_analysis`` — one row per ``(job_url, generation)``. Holds
        the reconciled canonical analysis (role framing / seniority / narrative
        / requirements / keywords as structured columns + JSON arrays), the
        snapshot+version cache key (D-11/D-12), the cross-model agreement signal,
        and the ``legs_attempted`` / ``legs_succeeded`` ensemble-completeness
        counters (D-08).
      * ``job_employer_analysis_sub_analyses`` — one row per per-model draft that
        contributed to the canonical record (D-08 audit trail).
      * ``job_employer_analysis_failures`` — one row per leg that errored /
        timed out / returned malformed output, so a degraded ensemble is
        surfaced, never silently dropped (D-08 / failure mode #2).

    Generation-versioned like ``job_materials`` (D-13): a forced/failed
    re-analyze writes a higher generation; prior generations are retained as
    audit history (never deleted). No backfill — analyses are produced fresh by
    the ensemble; legacy jobs simply have none until their next tailor.
    """
    if conn is None:
        conn = get_connection()

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS job_employer_analysis (
            job_url               TEXT NOT NULL,
            generation            INTEGER NOT NULL,
            tenant_id             TEXT NOT NULL DEFAULT 'local',
            snapshot_hash         TEXT NOT NULL,
            prompt_version        TEXT NOT NULL,
            sdk_set_version       TEXT NOT NULL,
            cache_key             TEXT NOT NULL,
            role_framing          TEXT NOT NULL DEFAULT '',
            inferred_seniority    TEXT NOT NULL DEFAULT '',
            ideal_candidate_narrative TEXT NOT NULL DEFAULT '',
            requirements_json     TEXT NOT NULL DEFAULT '[]',
            keywords_json         TEXT NOT NULL DEFAULT '[]',
            agreement_json        TEXT NOT NULL DEFAULT '{}',
            eeo_screen_json       TEXT NOT NULL DEFAULT '[]',
            legs_attempted        INTEGER NOT NULL,
            legs_succeeded        INTEGER NOT NULL,
            created_at            TEXT NOT NULL,
            PRIMARY KEY (job_url, generation),
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        )
        """
    )
    # Audit column for the EEO red-flag screen (AI-SPEC §6 Dimension 9). Added
    # idempotently so a DB created before this column gains it without a rebuild.
    _analysis_cols = {
        row[1] for row in conn.execute("PRAGMA table_info(job_employer_analysis)").fetchall()
    }
    if "eeo_screen_json" not in _analysis_cols:
        conn.execute(
            "ALTER TABLE job_employer_analysis "
            "ADD COLUMN eeo_screen_json TEXT NOT NULL DEFAULT '[]'"
        )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS job_employer_analysis_sub_analyses (
            job_url               TEXT NOT NULL,
            generation            INTEGER NOT NULL,
            model_id              TEXT NOT NULL,
            tenant_id             TEXT NOT NULL DEFAULT 'local',
            analysis_json         TEXT NOT NULL,
            PRIMARY KEY (job_url, generation, model_id),
            FOREIGN KEY (job_url, generation)
                REFERENCES job_employer_analysis(job_url, generation) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS job_employer_analysis_failures (
            job_url               TEXT NOT NULL,
            generation            INTEGER NOT NULL,
            model_id              TEXT NOT NULL,
            tenant_id             TEXT NOT NULL DEFAULT 'local',
            error                 TEXT NOT NULL,
            raw_output            TEXT,
            PRIMARY KEY (job_url, generation, model_id),
            FOREIGN KEY (job_url, generation)
                REFERENCES job_employer_analysis(job_url, generation) ON DELETE CASCADE
        )
        """
    )
    # Selector for the snapshot+version cache short-circuit (D-11/D-12).
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_employer_analysis_cache_key
        ON job_employer_analysis(tenant_id, job_url, cache_key)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_employer_analysis_tenant_job_gen
        ON job_employer_analysis(tenant_id, job_url, generation DESC)
        """
    )
    conn.commit()
    return [
        "job_employer_analysis",
        "job_employer_analysis_sub_analyses",
        "job_employer_analysis_failures",
    ]


def ensure_bullet_provenance_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create the canonical per-bullet provenance table (Phase 2).

    Every generated resume bullet records one canonical row binding it to the
    profile evidence it derives from, the job requirement it serves (FK into the
    persisted employer analysis), the transform that produced it, and the granular
    control that governed it. Per the auditability discipline (Anti-Pattern 1) the
    audit data is stored as CANONICAL ROWS — never inside an artifact
    ``metadata_json`` blob:

      * ``job_bullet_provenance`` — one row per ``(job_url, generation, bullet_id)``.
        Bound to the ``job_materials`` generation it explains and to the specific
        ``artifact_id`` (the tailored resume) it was computed against. FK ids
        (``evidence_ids_json`` / ``requirement_ids_json``) reference real profile
        evidence + ``job_employer_analysis`` requirements — the builder rejects
        fabricated ids before a row is ever written (GROUND-05). ``generated_text``
        is the actual rendered line, the anchor for coverage (Anti-Pattern 2).

    Generation-versioned like ``job_materials`` (Anti-Pattern 4 / success
    criterion 5): a forced/failed re-tailor writes a higher generation; prior
    generations are retained as audit history (never deleted), so a failed refresh
    never destroys the last accepted generation's provenance.
    """
    if conn is None:
        conn = get_connection()

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS job_bullet_provenance (
            job_url             TEXT NOT NULL,
            generation          INTEGER NOT NULL,
            bullet_id           TEXT NOT NULL,
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            artifact_id         TEXT NOT NULL,
            section             TEXT NOT NULL,
            source_id           TEXT,
            evidence_ids_json   TEXT NOT NULL DEFAULT '[]',
            requirement_ids_json TEXT NOT NULL DEFAULT '[]',
            matched_keywords_json TEXT NOT NULL DEFAULT '[]',
            transform_type      TEXT NOT NULL,
            control             TEXT NOT NULL,
            rationale           TEXT NOT NULL DEFAULT '',
            generated_text      TEXT NOT NULL,
            position            INTEGER NOT NULL DEFAULT 0,
            created_at          TEXT NOT NULL,
            coverage_json       TEXT,
            voice_json          TEXT,
            PRIMARY KEY (job_url, generation, bullet_id),
            FOREIGN KEY (job_url, generation)
                REFERENCES job_materials(job_url, generation) ON DELETE CASCADE
        )
        """
    )
    # Phase 3: generation-time keyword coverage (GROUND-06) + voice-pass audit
    # (VOICE-02) are set-level facts stored alongside the bullets they were
    # computed against. They are denormalised onto every row of the generation
    # (like ``artifact_id`` / ``created_at``); the read path reads them off any
    # row of the set. Idempotent migration for tables created by Phase 2 before
    # these columns existed (single-user rip-and-replace, no compat shim).
    existing_cols = {
        row[1] for row in conn.execute("PRAGMA table_info(job_bullet_provenance)").fetchall()
    }
    if "coverage_json" not in existing_cols:
        conn.execute("ALTER TABLE job_bullet_provenance ADD COLUMN coverage_json TEXT")
    if "voice_json" not in existing_cols:
        conn.execute("ALTER TABLE job_bullet_provenance ADD COLUMN voice_json TEXT")
    # Selector for the read path: latest generation's rows for a job/artifact.
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_bullet_provenance_tenant_job_gen
        ON job_bullet_provenance(tenant_id, job_url, generation DESC)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_bullet_provenance_artifact
        ON job_bullet_provenance(tenant_id, artifact_id)
        """
    )
    conn.commit()
    return ["job_bullet_provenance"]


def ensure_interview_prep_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create Interview Preparation canonical generation tables.

    Interview prep is generated material, not a projection. Rows are versioned by
    ``(job_url, generation)`` so a failed regenerate can be audited without
    destroying the last accepted prep. Prompt/raw profile/job payloads are not
    stored here; rows keep only the accepted/failed gate audit and item
    provenance needed for later read-model projection.
    """
    if conn is None:
        conn = get_connection()

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS job_interview_prep (
            job_url                    TEXT NOT NULL,
            generation                 INTEGER NOT NULL,
            tenant_id                  TEXT NOT NULL DEFAULT 'local',
            status                     TEXT NOT NULL,
            model                      TEXT,
            generated_at               TEXT NOT NULL,
            gate_status                TEXT NOT NULL,
            fabrication_findings_json  TEXT NOT NULL DEFAULT '[]',
            grounding_findings_json    TEXT NOT NULL DEFAULT '[]',
            judge_verdict              TEXT,
            warnings_json              TEXT NOT NULL DEFAULT '[]',
            failure_reason             TEXT NOT NULL DEFAULT '',
            origin_run_id              TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (job_url, generation),
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        )
        """
    )
    prep_cols = {row[1] for row in conn.execute("PRAGMA table_info(job_interview_prep)").fetchall()}
    if "origin_run_id" not in prep_cols:
        conn.execute(
            "ALTER TABLE job_interview_prep ADD COLUMN origin_run_id TEXT NOT NULL DEFAULT ''"
        )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS job_interview_prep_items (
            job_url                    TEXT NOT NULL,
            generation                 INTEGER NOT NULL,
            item_id                    TEXT NOT NULL,
            tenant_id                  TEXT NOT NULL DEFAULT 'local',
            kind                       TEXT NOT NULL,
            title                      TEXT NOT NULL,
            generated_text             TEXT NOT NULL,
            evidence_ids_json          TEXT NOT NULL DEFAULT '[]',
            requirement_ids_json       TEXT NOT NULL DEFAULT '[]',
            source_text_json           TEXT NOT NULL DEFAULT '[]',
            transform_type             TEXT NOT NULL DEFAULT 'grounded_prep',
            control                    TEXT NOT NULL DEFAULT 'never_fabricate',
            grounding_audit_json       TEXT NOT NULL DEFAULT '[]',
            warnings_json              TEXT NOT NULL DEFAULT '[]',
            position                   INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (job_url, generation, item_id),
            FOREIGN KEY (job_url, generation)
                REFERENCES job_interview_prep(job_url, generation) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_interview_prep_tenant_job_gen
        ON job_interview_prep(tenant_id, job_url, generation DESC)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_interview_prep_tenant_status
        ON job_interview_prep(tenant_id, status, generated_at DESC)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_interview_prep_origin_run
        ON job_interview_prep(tenant_id, job_url, origin_run_id)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_interview_prep_items_tenant_kind
        ON job_interview_prep_items(tenant_id, kind, position)
        """
    )
    conn.commit()
    return ["job_interview_prep", "job_interview_prep_items"]


def ensure_enrichment_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create the per-job ``job_enrichments`` table and run its backfill.

    See ddd-target.md §4.2 / §7.2. The table is the persistence side
    of the Phase-7 :class:`JobEnrichment` aggregate. The legacy
    ``jobs.full_description`` / ``jobs.application_url`` /
    ``jobs.detail_scraped_at`` / ``jobs.detail_error`` columns remain
    in the schema as a read-only fallback for historical rows but
    new enrichment writes target this table only (no-strangler
    directive).

    Backfill is **idempotent**: it only fires when ``job_enrichments``
    is empty AND ``jobs.full_description`` has values. Each backfilled
    row becomes a single succeeded attempt at ``css_selectors`` tier
    so consumers see the expected attempt history shape.
    """
    if conn is None:
        conn = get_connection()

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS job_enrichments (
            job_url             TEXT PRIMARY KEY,
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            current_status      TEXT NOT NULL,
            full_description    TEXT,
            application_url     TEXT,
            enriched_at         TEXT,
            extraction_tier     TEXT,
            attempts_json       TEXT NOT NULL DEFAULT '[]',
            updated_at          TEXT NOT NULL,
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_enrichments_tenant_status
        ON job_enrichments(tenant_id, current_status, updated_at DESC)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_enrichments_enriched_at
        ON job_enrichments(enriched_at DESC)
        """
    )

    # Idempotent one-shot backfill from the legacy columns.
    backfill_count = conn.execute("SELECT COUNT(*) FROM job_enrichments").fetchone()[0]
    if backfill_count == 0:
        legacy_rows = conn.execute(
            """
            SELECT url, full_description, application_url,
                   detail_scraped_at, detail_error
            FROM jobs
            WHERE full_description IS NOT NULL
               OR application_url IS NOT NULL
               OR detail_scraped_at IS NOT NULL
               OR detail_error IS NOT NULL
            """
        ).fetchall()
        if legacy_rows:
            now = datetime.now(timezone.utc).isoformat()
            for row in legacy_rows:
                _backfill_one_enrichment_row(conn, row, now)

    conn.commit()
    return ["job_enrichments"]


def ensure_posting_snapshot_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create Enrichment-owned ``PostingSnapshotSet`` persistence.

    The aggregate is versioned as a JSON document during the local-first
    phase. Read models that need queueable duplicate/quarantine facts use
    dedicated Discovery control tables populated by the writer.
    """
    if conn is None:
        conn = get_connection()

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS posting_snapshot_sets (
            tenant_id                TEXT NOT NULL DEFAULT 'local',
            job_url                  TEXT NOT NULL,
            snapshot_set_json        TEXT NOT NULL,
            latest_snapshot_version  INTEGER NOT NULL DEFAULT 0,
            latest_active_state      TEXT NOT NULL DEFAULT 'unknown',
            latest_confidence        TEXT,
            latest_quarantine_reason TEXT,
            updated_at               TEXT NOT NULL,
            PRIMARY KEY (tenant_id, job_url),
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_posting_snapshot_sets_updated
        ON posting_snapshot_sets(tenant_id, updated_at DESC)
        """
    )
    # The latest snapshot's confidence + quarantine reason are promoted onto
    # the row so the read model can gate the tailoring queue and surface the
    # enrichment quality signal without parsing snapshot_set_json per read.
    existing_cols = {
        row[1] for row in conn.execute("PRAGMA table_info(posting_snapshot_sets)").fetchall()
    }
    added_quality_columns = False
    if "latest_confidence" not in existing_cols:
        conn.execute("ALTER TABLE posting_snapshot_sets ADD COLUMN latest_confidence TEXT")
        added_quality_columns = True
    if "latest_quarantine_reason" not in existing_cols:
        conn.execute(
            "ALTER TABLE posting_snapshot_sets ADD COLUMN latest_quarantine_reason TEXT"
        )
        added_quality_columns = True
    if added_quality_columns:
        _backfill_latest_snapshot_quality(conn)
    conn.commit()
    return ["posting_snapshot_sets"]


def _backfill_latest_snapshot_quality(conn: sqlite3.Connection) -> None:
    """Populate ``latest_confidence`` / ``latest_quarantine_reason`` from JSON.

    Runs once when the columns are first added so pre-existing snapshot rows
    carry the same quality signal new writes persist directly.
    """
    rows = conn.execute(
        "SELECT tenant_id, job_url, snapshot_set_json FROM posting_snapshot_sets"
    ).fetchall()
    for row in rows:
        raw_json = row["snapshot_set_json"] if isinstance(row, sqlite3.Row) else row[2]
        try:
            snapshots = (json.loads(raw_json) if raw_json else {}).get("snapshots") or []
        except (TypeError, ValueError):
            continue
        if not snapshots:
            continue
        latest = snapshots[-1]
        conn.execute(
            "UPDATE posting_snapshot_sets "
            "SET latest_confidence = ?, latest_quarantine_reason = ? "
            "WHERE tenant_id = ? AND job_url = ?",
            (
                latest.get("confidence"),
                latest.get("quarantine_reason"),
                row["tenant_id"] if isinstance(row, sqlite3.Row) else row[0],
                row["job_url"] if isinstance(row, sqlite3.Row) else row[1],
            ),
        )


def ensure_discovery_control_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create worker-writable Discovery control tables.

    These schemas intentionally mirror ``apps/api/src/discovery-controls.ts``
    so the local API/UI can show rows generated by Python workers, not just
    rows inserted through tests or manual API calls.
    """
    if conn is None:
        conn = get_connection()

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS source_registry_entries (
            tenant_id     TEXT NOT NULL DEFAULT 'local',
            source_id     TEXT NOT NULL,
            kind          TEXT NOT NULL,
            display_name  TEXT NOT NULL,
            owner         TEXT NOT NULL DEFAULT 'user',
            priority      TEXT NOT NULL DEFAULT 'standard',
            state         TEXT NOT NULL DEFAULT 'experimental',
            policy_id     TEXT NOT NULL,
            seed_url      TEXT,
            created_at    TEXT NOT NULL,
            updated_at    TEXT NOT NULL,
            PRIMARY KEY (tenant_id, source_id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS source_locator_candidates (
            tenant_id                TEXT NOT NULL DEFAULT 'local',
            candidate_id             TEXT NOT NULL,
            candidate_url            TEXT NOT NULL,
            source_kind              TEXT NOT NULL,
            confidence               REAL NOT NULL DEFAULT 0,
            detected_ats_kind        TEXT,
            employer_domain_matched  INTEGER NOT NULL DEFAULT 0,
            manual_action_reason     TEXT,
            discovered_at            TEXT NOT NULL,
            PRIMARY KEY (tenant_id, candidate_id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS discovery_quarantine_entries (
            tenant_id        TEXT NOT NULL DEFAULT 'local',
            job_id           TEXT NOT NULL,
            job_key          TEXT NOT NULL,
            title            TEXT NOT NULL DEFAULT '',
            company          TEXT NOT NULL DEFAULT '',
            source_id        TEXT NOT NULL,
            posting_url      TEXT,
            reason           TEXT NOT NULL,
            confidence       REAL,
            snapshot_version INTEGER,
            captured_at      TEXT,
            notice_text      TEXT,
            status           TEXT NOT NULL DEFAULT 'pending',
            decision_reason  TEXT,
            decided_at       TEXT,
            PRIMARY KEY (tenant_id, job_key)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS manual_capture_queue (
            tenant_id                     TEXT NOT NULL DEFAULT 'local',
            item_id                       TEXT NOT NULL,
            originating_url               TEXT NOT NULL,
            source_id                     TEXT,
            reason                        TEXT NOT NULL,
            retry_context_json            TEXT NOT NULL DEFAULT '{}',
            required_at                   TEXT NOT NULL,
            status                        TEXT NOT NULL DEFAULT 'pending',
            imported_at                   TEXT,
            dismissed_at                  TEXT,
            capture_mode                  TEXT,
            captured_url                  TEXT,
            content_sha256                TEXT,
            content_length                INTEGER,
            note                          TEXT,
            future_manual_action_required INTEGER NOT NULL DEFAULT 0,
            job_key                       TEXT,
            PRIMARY KEY (tenant_id, item_id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS discovery_feedback (
            tenant_id   TEXT NOT NULL DEFAULT 'local',
            feedback_id TEXT NOT NULL,
            job_key     TEXT NOT NULL,
            source_id   TEXT,
            kind        TEXT NOT NULL,
            note        TEXT,
            recorded_at TEXT NOT NULL,
            PRIMARY KEY (tenant_id, feedback_id)
        )
        """
    )
    conn.commit()
    return [
        "source_registry_entries",
        "source_locator_candidates",
        "discovery_quarantine_entries",
        "manual_capture_queue",
        "discovery_feedback",
    ]


def ensure_discovery_settings_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create database-backed user discovery runtime settings."""
    if conn is None:
        conn = get_connection()

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS discovery_settings (
            tenant_id          TEXT PRIMARY KEY,
            search_config_json TEXT NOT NULL,
            created_at         TEXT NOT NULL,
            updated_at         TEXT NOT NULL
        )
        """
    )
    conn.commit()
    return ["discovery_settings"]


def _backfill_one_enrichment_row(
    conn: sqlite3.Connection,
    row: sqlite3.Row,
    now: str,
) -> None:
    """Backfill one legacy job into the new ``job_enrichments`` shape.

    The lifecycle is derived from the legacy columns:

      * ``full_description`` set, no error  ⇒ ``enriched`` (single
        succeeded attempt at ``css_selectors`` tier — we don't know
        which tier originally succeeded, but ``css_selectors`` is the
        most common landing tier).
      * ``detail_error`` set, no description ⇒ ``failed`` (single
        failed attempt with the legacy error message).
      * Any other combination ⇒ ``pending`` (e.g. a row that has only
        ``application_url`` or only ``detail_scraped_at`` is treated
        as not-yet-enriched so the worker re-queues it).

    Backfilled rows carry the sentinel ``"backfilled": true`` flag
    inside the attempt JSON so consumers can tell migrated rows apart
    from machine-generated ones.
    """
    url = row["url"] if isinstance(row, sqlite3.Row) else row[0]
    full_description = row["full_description"] if isinstance(row, sqlite3.Row) else row[1]
    application_url = row["application_url"] if isinstance(row, sqlite3.Row) else row[2]
    detail_scraped_at = row["detail_scraped_at"] if isinstance(row, sqlite3.Row) else row[3]
    detail_error = row["detail_error"] if isinstance(row, sqlite3.Row) else row[4]

    enriched_at: str | None = None
    extraction_tier: str | None = None
    current_status: str
    attempts: list[dict]

    if full_description and not detail_error:
        current_status = "enriched"
        enriched_at = detail_scraped_at or now
        extraction_tier = "css_selectors"
        attempts = [
            {
                "attempt_number": 1,
                "extraction_tier": "css_selectors",
                "status": "succeeded",
                "started_at": detail_scraped_at or now,
                "finished_at": detail_scraped_at or now,
                "error": None,
                "backfilled": True,
            }
        ]
    elif detail_error and not full_description:
        current_status = "failed"
        attempts = [
            {
                "attempt_number": 1,
                "extraction_tier": "css_selectors",
                "status": "failed",
                "started_at": detail_scraped_at or now,
                "finished_at": detail_scraped_at or now,
                "error": {
                    "code": "LEGACY_DETAIL_ERROR",
                    "message": str(detail_error),
                    "retryable": True,
                },
                "backfilled": True,
            }
        ]
    else:
        current_status = "pending"
        attempts = []

    conn.execute(
        """
        INSERT OR IGNORE INTO job_enrichments (
            job_url, tenant_id, current_status, full_description,
            application_url, enriched_at, extraction_tier,
            attempts_json, updated_at
        ) VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            url,
            current_status,
            full_description if full_description else None,
            application_url if application_url else None,
            enriched_at,
            extraction_tier,
            json.dumps(attempts, sort_keys=True),
            detail_scraped_at or now,
        ),
    )


def ensure_source_observation_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create ``job_source_observations``, ``job_canonical_identities``, and ``job_duplicate_links``.

    See PR 2 of the Job Search Discovery RFC
    (`docs/plans/implemented/2026-05-12-job-search-discovery-rfc.md`).

    The migration is purely additive — the legacy ``jobs.url`` PRIMARY
    KEY remains the canonical posting URL during the compatibility
    window so ``load_by_url`` can resolve either a canonical URL or an
    observation URL without a coordinated cutover.

    Backfill is idempotent: if ``job_source_observations`` is empty AND
    the ``jobs`` table has rows, every existing job seeds exactly one
    observation row using its current ``url`` / ``site`` / ``strategy``
    / ``discovered_at`` so the source-quality projection sees its
    history without rerunning any scrape.
    """

    if conn is None:
        conn = get_connection()

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS job_source_observations (
            tenant_id                TEXT NOT NULL DEFAULT 'local',
            source_observation_id    TEXT NOT NULL,
            job_url                  TEXT NOT NULL,
            source_id                TEXT NOT NULL,
            source_native_id         TEXT NOT NULL,
            observed_url             TEXT NOT NULL,
            normalized_observed_url  TEXT NOT NULL,
            run_id                   TEXT NOT NULL DEFAULT '',
            observed_at              TEXT NOT NULL,
            PRIMARY KEY (tenant_id, source_observation_id),
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_job_source_observations_native
        ON job_source_observations(tenant_id, source_id, source_native_id)
        """
    )
    conn.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_job_source_observations_normalized_url
        ON job_source_observations(tenant_id, normalized_observed_url)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_source_observations_job
        ON job_source_observations(tenant_id, job_url)
        """
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS job_canonical_identities (
            tenant_id          TEXT NOT NULL DEFAULT 'local',
            job_url            TEXT NOT NULL,
            canonical_url      TEXT NOT NULL,
            ats_kind           TEXT NOT NULL,
            source_native_id   TEXT NOT NULL,
            confidence         REAL NOT NULL,
            resolved_at        TEXT NOT NULL,
            PRIMARY KEY (tenant_id, job_url),
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_canonical_identities_canonical_url
        ON job_canonical_identities(tenant_id, canonical_url)
        """
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS job_duplicate_links (
            tenant_id                              TEXT NOT NULL DEFAULT 'local',
            duplicate_link_id                      TEXT NOT NULL,
            surviving_job_id                       TEXT NOT NULL,
            superseded_job_or_observation_id       TEXT NOT NULL,
            reason                                 TEXT NOT NULL,
            confidence                             REAL NOT NULL,
            linked_at                              TEXT NOT NULL,
            PRIMARY KEY (tenant_id, duplicate_link_id)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_duplicate_links_surviving
        ON job_duplicate_links(tenant_id, surviving_job_id)
        """
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS job_rejected_duplicate_links (
            tenant_id       TEXT NOT NULL DEFAULT 'local',
            owner_job_url   TEXT NOT NULL,
            candidate_url   TEXT NOT NULL,
            reason          TEXT NOT NULL,
            rejected_at     TEXT NOT NULL,
            PRIMARY KEY (tenant_id, owner_job_url, candidate_url)
        )
        """
    )

    # Idempotent one-shot backfill: every existing jobs row gets one
    # observation row using the identity column owned by the active schema.
    # Exact v7 replaced ``job_url`` with canonical ``job_id``; this helper is
    # still called by discovery hygiene, so it must not reintroduce the retired
    # URL-shaped foreign key after cutover.
    backfilled = conn.execute("SELECT COUNT(*) FROM job_source_observations").fetchone()[0]
    if backfilled == 0:
        observation_columns = {
            str(row[1])
            for row in conn.execute(
                "PRAGMA table_info(job_source_observations)"
            ).fetchall()
        }
        identity_column = "job_id" if "job_id" in observation_columns else "job_url"
        if identity_column == "job_id":
            legacy_jobs = conn.execute(
                "SELECT tenant_id, job_id, url, site, strategy, discovered_at FROM jobs"
            ).fetchall()
        else:
            legacy_jobs = conn.execute(
                "SELECT url, site, strategy, discovered_at FROM jobs"
            ).fetchall()
        if legacy_jobs:
            now = datetime.now(timezone.utc).isoformat()
            for row in legacy_jobs:
                _backfill_one_observation_row(
                    conn,
                    row,
                    now,
                    identity_column=identity_column,
                )

    conn.commit()
    return [
        "job_source_observations",
        "job_canonical_identities",
        "job_duplicate_links",
        "job_rejected_duplicate_links",
    ]


def ensure_discovery_execution_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create the immutable Discover execution/job membership table.

    ``job_source_observations.run_id`` intentionally remains outside the key:
    repeated observations update that mutable source metadata, whereas this
    table preserves one row for every Temporal Discover execution that saw or
    selected the job.
    """

    if conn is None:
        conn = get_connection()

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS discovery_execution_jobs (
            tenant_id                TEXT NOT NULL,
            discover_workflow_id     TEXT NOT NULL,
            discover_run_id          TEXT NOT NULL,
            job_url                  TEXT NOT NULL,
            cohort_kind              TEXT NOT NULL
                CHECK (cohort_kind IN ('observed_this_run', 'existing_backlog')),
            source_family            TEXT,
            source_run_id            TEXT,
            preparation_workflow_id  TEXT,
            work_plan_state          TEXT NOT NULL DEFAULT 'pending'
                CHECK (work_plan_state IN ('pending', 'planned', 'not_eligible', 'failed')),
            required_steps_json      TEXT,
            work_plan_reason         TEXT,
            linked_at                TEXT NOT NULL,
            PRIMARY KEY (tenant_id, discover_workflow_id, discover_run_id, job_url),
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_discovery_execution_jobs_cohort
        ON discovery_execution_jobs(
            tenant_id, discover_workflow_id, discover_run_id, cohort_kind
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_discovery_execution_jobs_plan
        ON discovery_execution_jobs(
            tenant_id, discover_workflow_id, discover_run_id, work_plan_state
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_discovery_execution_jobs_job
        ON discovery_execution_jobs(tenant_id, job_url, linked_at)
        """
    )
    conn.commit()
    return ["discovery_execution_jobs"]


def ensure_discovery_search_unit_tables(
    conn: sqlite3.Connection | None = None,
) -> list[str]:
    """Create caller-owned JobStreaming plans, checkpoints, and receipts.

    A unit belongs to one exact Temporal Discover workflow/run. ``lease_epoch``
    is the fencing token: reclaiming an unfinished unit increments it, so an
    older activity attempt can no longer advance the checkpoint or accept a
    result. Provider checkpoint JSON remains opaque at this layer.
    """

    if conn is None:
        conn = get_connection()

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS discovery_search_units (
            tenant_id              TEXT NOT NULL,
            discover_workflow_id   TEXT NOT NULL,
            discover_run_id        TEXT NOT NULL,
            unit_id                TEXT NOT NULL,
            ordinal                INTEGER NOT NULL CHECK (ordinal >= 0),
            request_json           TEXT NOT NULL,
            request_fingerprint    TEXT NOT NULL,
            state                  TEXT NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending', 'running', 'completed', 'skipped', 'failed', 'canceled')),
            lease_owner            TEXT,
            lease_attempt          INTEGER NOT NULL DEFAULT 0 CHECK (lease_attempt >= 0),
            lease_epoch            INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
            recovery_count         INTEGER NOT NULL DEFAULT 0 CHECK (recovery_count >= 0),
            checkpoint_json        TEXT,
            checkpoint_revision    INTEGER CHECK (checkpoint_revision >= 0),
            last_error_code        TEXT,
            last_error_type        TEXT,
            last_error_retryable   INTEGER,
            reset_checkpoint       INTEGER NOT NULL DEFAULT 0 CHECK (reset_checkpoint IN (0, 1)),
            reset_checkpoint_after_revision INTEGER CHECK (reset_checkpoint_after_revision >= 0),
            created_at             TEXT NOT NULL,
            updated_at             TEXT NOT NULL,
            completed_at           TEXT,
            PRIMARY KEY (
                tenant_id, discover_workflow_id, discover_run_id, unit_id
            ),
            UNIQUE (
                tenant_id, discover_workflow_id, discover_run_id, ordinal
            ),
            CHECK (
                (checkpoint_json IS NULL AND checkpoint_revision IS NULL)
                OR (checkpoint_json IS NOT NULL AND checkpoint_revision IS NOT NULL)
            )
        )
        """
    )
    search_unit_columns = {
        str(row[1])
        for row in conn.execute(
            "PRAGMA table_info(discovery_search_units)"
        ).fetchall()
    }
    if "reset_checkpoint_after_revision" not in search_unit_columns:
        conn.execute(
            """
            ALTER TABLE discovery_search_units
            ADD COLUMN reset_checkpoint_after_revision INTEGER
                CHECK (reset_checkpoint_after_revision >= 0)
            """
        )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_discovery_search_units_state
        ON discovery_search_units(
            tenant_id, discover_workflow_id, discover_run_id, state, ordinal
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS discovery_search_unit_jobs (
            tenant_id              TEXT NOT NULL,
            discover_workflow_id   TEXT NOT NULL,
            discover_run_id        TEXT NOT NULL,
            unit_id                TEXT NOT NULL,
            job_url                TEXT NOT NULL,
            was_new                INTEGER NOT NULL CHECK (was_new IN (0, 1)),
            accepted_at            TEXT NOT NULL,
            PRIMARY KEY (
                tenant_id, discover_workflow_id, discover_run_id, unit_id, job_url
            ),
            FOREIGN KEY (
                tenant_id, discover_workflow_id, discover_run_id, unit_id
            ) REFERENCES discovery_search_units(
                tenant_id, discover_workflow_id, discover_run_id, unit_id
            ) ON DELETE CASCADE,
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_discovery_search_unit_jobs_execution
        ON discovery_search_unit_jobs(
            tenant_id, discover_workflow_id, discover_run_id, was_new
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS discovery_search_unit_filtered_events (
            tenant_id              TEXT NOT NULL,
            discover_workflow_id   TEXT NOT NULL,
            discover_run_id        TEXT NOT NULL,
            unit_id                TEXT NOT NULL,
            provider_event_key_hash TEXT NOT NULL
                CHECK (length(provider_event_key_hash) = 64),
            filtered_at            TEXT NOT NULL,
            PRIMARY KEY (
                tenant_id, discover_workflow_id, discover_run_id,
                unit_id, provider_event_key_hash
            ),
            FOREIGN KEY (
                tenant_id, discover_workflow_id, discover_run_id, unit_id
            ) REFERENCES discovery_search_units(
                tenant_id, discover_workflow_id, discover_run_id, unit_id
            ) ON DELETE CASCADE
        ) WITHOUT ROWID
        """
    )
    conn.commit()
    return [
        "discovery_search_units",
        "discovery_search_unit_jobs",
        "discovery_search_unit_filtered_events",
    ]


def _backfill_one_observation_row(
    conn: sqlite3.Connection,
    row: sqlite3.Row,
    now: str,
    *,
    identity_column: str = "job_url",
) -> None:
    """Backfill one legacy ``jobs`` row into ``job_source_observations``.

    The legacy schema stores the source as a free-form ``site`` string
    (e.g. ``"Greenhouse"`` for the Workday adapter, ``"linkedin"`` for
    JobSpy). This is the only identity we have for historical rows, so
    the backfill uses ``site`` as both the source-id and the
    source-native-id key. New scrapes will update the row with the
    real source-native-id once the canonical adapter resolves it.

    Backfilled rows carry the sentinel ``site=='backfill'`` run-id so
    Operations can filter them out of source-quality calculations
    (PR 4 will gate the projection on ``run_id != 'backfill'``).
    """
    from jobctrl.domain.discovery.identity import normalize_observed_url

    if identity_column == "job_id":
        tenant_id = row["tenant_id"] if isinstance(row, sqlite3.Row) else row[0]
        job_id = row["job_id"] if isinstance(row, sqlite3.Row) else row[1]
        url = row["url"] if isinstance(row, sqlite3.Row) else row[2]
        site = (row["site"] if isinstance(row, sqlite3.Row) else row[3]) or "unknown"
        discovered_at = (
            row["discovered_at"] if isinstance(row, sqlite3.Row) else row[5]
        ) or now
    else:
        tenant_id = "local"
        job_id = None
        url = row["url"] if isinstance(row, sqlite3.Row) else row[0]
        site = (row["site"] if isinstance(row, sqlite3.Row) else row[1]) or "unknown"
        discovered_at = (
            row["discovered_at"] if isinstance(row, sqlite3.Row) else row[3]
        ) or now
    if not url:
        return
    source_native_id = url  # fall back to the URL when we have nothing better
    source_observation_id = f"backfill:{url}"
    if identity_column == "job_id":
        conn.execute(
            """
            INSERT OR IGNORE INTO job_source_observations (
                tenant_id, source_observation_id, job_id, source_id,
                source_native_id, observed_url, normalized_observed_url,
                run_id, observed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'backfill', ?)
            """,
            (
                str(tenant_id),
                source_observation_id,
                str(job_id),
                str(site),
                str(source_native_id),
                url,
                normalize_observed_url(url),
                discovered_at,
            ),
        )
    else:
        conn.execute(
            """
            INSERT OR IGNORE INTO job_source_observations (
                tenant_id, source_observation_id, job_url, source_id,
                source_native_id, observed_url, normalized_observed_url,
                run_id, observed_at
            ) VALUES ('local', ?, ?, ?, ?, ?, ?, 'backfill', ?)
            """,
            (
                source_observation_id,
                url,
                str(site),
                str(source_native_id),
                url,
                normalize_observed_url(url),
                discovered_at,
            ),
        )


# ---------------------------------------------------------------------------
# job_enrichments read fragments — selectors and status counts derive
# enrichment only from the canonical aggregate. Retired wide ``jobs``
# columns must not affect v7 eligibility.
# ---------------------------------------------------------------------------

_ENRICHMENT_JOIN: str = (
    "LEFT JOIN job_enrichments je "
    "ON je.tenant_id = jobs.tenant_id AND je.job_id = jobs.job_id "
    "LEFT JOIN job_stage_states jss_enrich "
    "ON jss_enrich.tenant_id = jobs.tenant_id "
    "AND jss_enrich.job_id = jobs.job_id "
    "AND jss_enrich.stage = 'enrich'"
)

_EFFECTIVE_FULL_DESCRIPTION: str = "je.full_description"
_EFFECTIVE_APPLICATION_URL: str = "je.application_url"
_EFFECTIVE_APPLY_TARGET_URL: str = (
    f"COALESCE(NULLIF({_EFFECTIVE_APPLICATION_URL}, ''), jobs.url)"
)
_ENRICHMENT_PENDING: str = (
    "(je.job_id IS NULL OR je.current_status = 'pending') "
    "AND COALESCE(jss_enrich.state, 'pending') = 'pending'"
)
_ENRICHMENT_SELECTED_PENDING: str = (
    "(je.job_id IS NULL OR je.current_status = 'pending') "
    "AND COALESCE(jss_enrich.state, 'pending') IN ('pending', 'queued')"
)
_ENRICHMENT_RETRYABLE_ROBOTS_BLOCKED: str = (
    "(je.job_id IS NULL OR je.current_status = 'pending') "
    "AND jss_enrich.state = 'blocked' "
    "AND jss_enrich.error_code = 'ENRICH_ROBOTS_DISALLOWED' "
    "AND COALESCE(jss_enrich.retryable, 1) = 1"
)
_ENRICHMENT_RUNNABLE: str = (
    f"(({_ENRICHMENT_PENDING}) OR ({_ENRICHMENT_RETRYABLE_ROBOTS_BLOCKED}))"
)
_ENRICHMENT_SELECTED_RUNNABLE: str = (
    f"(({_ENRICHMENT_SELECTED_PENDING}) OR ({_ENRICHMENT_RETRYABLE_ROBOTS_BLOCKED}))"
)

# Closed/removed posting states are Enrichment-owned facts, not user
# tombstones. Work queues treat them as non-actionable while leaving the
# rows available for the Jobs > closed tab and future rediscovery.
_CLOSED_ACTIVE_STATES_SQL = "'closed', 'expired', 'removed', 'location_incompatible'"
_ACTIVE_STATE_JOIN: str = (
    "LEFT JOIN posting_snapshot_sets pss "
    "ON pss.tenant_id = jobs.tenant_id AND pss.job_id = jobs.job_id"
)
_NOT_CLOSED_ACTIVE_STATE: str = (
    f"(pss.latest_active_state IS NULL OR pss.latest_active_state NOT IN ({_CLOSED_ACTIVE_STATES_SQL}))"
)

# A posting whose latest content snapshot was quarantined as a LOW-confidence
# extraction is not trustworthy enough to spend the expensive, employer-facing
# tailoring / cover / apply steps on. It stays scoreable (cheap triage) and
# visible with its quality signal, so a quarantined job never vanishes from the
# funnel. Only a genuinely LOW-confidence quarantine is gated: a MEDIUM/HIGH
# snapshot missing its apply URL is quarantined for review but keeps
# ``latest_confidence`` above LOW, so a recoverable missing field never starves
# tailoring. An operator-overridden LOW snapshot carries reason 'none' and also
# passes. Reads through the ``pss`` alias exposed by ``_ACTIVE_STATE_JOIN``.
_ENRICHMENT_NOT_QUARANTINED: str = (
    "(pss.latest_confidence IS NULL "
    "OR pss.latest_confidence != 'low' "
    "OR pss.latest_quarantine_reason IS NULL "
    "OR pss.latest_quarantine_reason IN ('none', ''))"
)


# ---------------------------------------------------------------------------
# job_materials read fragments — queue selectors derive material readiness
# only from approved canonical artifacts.
# ---------------------------------------------------------------------------

# LEFT JOIN that surfaces the latest generation's tailored-resume and
# cover-letter artifact paths under fixed aliases.
_LATEST_MATERIALS_JOIN: str = (
    "LEFT JOIN ("
    "SELECT history.tenant_id AS jm_tenant_id, history.job_id AS jm_job_id, "
    "latest.max_generation AS jm_generation, "
    "m.status AS jm_status, "
    "tr.path AS jm_tailored_path, tr.created_at AS jm_tailored_at, "
    "cl.path AS jm_cover_path, cl.created_at AS jm_cover_at, "
    "rpdf.path AS jm_resume_pdf_path, rpdf.artifact_id AS jm_resume_pdf_artifact_id, "
    "cpdf.path AS jm_cover_pdf_path "
    "FROM (SELECT DISTINCT tenant_id, job_id FROM job_materials) history "
    "LEFT JOIN ("
    "SELECT tenant_id, job_id, MAX(generation) AS max_generation "
    "FROM job_materials_artifacts "
    "WHERE status = 'approved' "
    "AND artifact_type IN ('tailored_resume', 'cover_letter', 'resume_pdf', 'cover_letter_pdf') "
    "GROUP BY tenant_id, job_id"
    ") latest ON latest.tenant_id = history.tenant_id "
    "AND latest.job_id = history.job_id "
    "LEFT JOIN job_materials m "
    "ON m.tenant_id = history.tenant_id AND m.job_id = history.job_id "
    "AND m.generation = latest.max_generation "
    "LEFT JOIN job_materials_artifacts tr "
    "ON tr.tenant_id = history.tenant_id AND tr.job_id = history.job_id "
    "AND tr.generation = latest.max_generation "
    "AND tr.artifact_type = 'tailored_resume' AND tr.status = 'approved' "
    "LEFT JOIN job_materials_artifacts cl "
    "ON cl.tenant_id = history.tenant_id AND cl.job_id = history.job_id "
    "AND cl.generation = latest.max_generation "
    "AND cl.artifact_type = 'cover_letter' AND cl.status = 'approved' "
    "LEFT JOIN job_materials_artifacts rpdf "
    "ON rpdf.tenant_id = history.tenant_id AND rpdf.job_id = history.job_id "
    "AND rpdf.generation = latest.max_generation "
    "AND rpdf.artifact_type = 'resume_pdf' AND rpdf.status = 'approved' "
    "LEFT JOIN job_materials_artifacts cpdf "
    "ON cpdf.tenant_id = history.tenant_id AND cpdf.job_id = history.job_id "
    "AND cpdf.generation = latest.max_generation "
    "AND cpdf.artifact_type = 'cover_letter_pdf' AND cpdf.status = 'approved'"
    ") jm ON jm.jm_tenant_id = jobs.tenant_id AND jm.jm_job_id = jobs.job_id"
)

_EFFECTIVE_TAILOR_PATH: str = "jm.jm_tailored_path"
_EFFECTIVE_COVER_PATH: str = "jm.jm_cover_path"
_READY_TAILORED_RESUME_WITH_PDF: str = (
    "(jm.jm_tailored_path IS NOT NULL AND jm.jm_tailored_path != '' "
    "AND jm.jm_resume_pdf_path IS NOT NULL AND jm.jm_resume_pdf_path != '')"
)


# ---------------------------------------------------------------------------
# job_stage_states attempt-counter read fragments. Stage state is the only
# authority for retry limits and exhaustion.
# ---------------------------------------------------------------------------

_LATEST_STAGE_ATTEMPTS_JOIN: str = (
    "LEFT JOIN ("
    "SELECT tenant_id AS jss_t_tenant_id, job_id AS jss_t_job_id, "
    "attempt_count AS jss_t_attempts, state AS jss_t_state "
    "FROM job_stage_states WHERE stage = 'tailor'"
    ") jss_t ON jss_t.jss_t_tenant_id = jobs.tenant_id "
    "AND jss_t.jss_t_job_id = jobs.job_id "
    "LEFT JOIN ("
    "SELECT tenant_id AS jss_c_tenant_id, job_id AS jss_c_job_id, "
    "attempt_count AS jss_c_attempts, state AS jss_c_state "
    "FROM job_stage_states WHERE stage = 'cover'"
    ") jss_c ON jss_c.jss_c_tenant_id = jobs.tenant_id "
    "AND jss_c.jss_c_job_id = jobs.job_id"
)

_EFFECTIVE_TAILOR_ATTEMPTS: str = "COALESCE(jss_t.jss_t_attempts, 0)"
_EFFECTIVE_COVER_ATTEMPTS: str = "COALESCE(jss_c.jss_c_attempts, 0)"
_TAILOR_NOT_EXHAUSTED: str = "(jss_t.jss_t_state IS NULL OR jss_t.jss_t_state != 'exhausted')"
_COVER_NOT_EXHAUSTED: str = "(jss_c.jss_c_state IS NULL OR jss_c.jss_c_state != 'exhausted')"


# Stale-score guard for downstream stages.
_SCORE_DOWNSTREAM_STATE_JOIN: str = (
    "LEFT JOIN ("
    "SELECT tenant_id AS jss_s_tenant_id, job_id AS jss_s_job_id, "
    "state AS jss_s_state, "
    "attempt_count AS jss_s_attempts "
    "FROM job_stage_states WHERE stage = 'score'"
    ") jss_s ON jss_s.jss_s_tenant_id = jobs.tenant_id "
    "AND jss_s.jss_s_job_id = jobs.job_id "
    "LEFT JOIN ("
    "SELECT DISTINCT tenant_id AS jss_stale_tenant_id, job_id AS jss_stale_job_id "
    "FROM job_score_staleness WHERE resolved = 0"
    ") jss_stale ON jss_stale.jss_stale_tenant_id = jobs.tenant_id "
    "AND jss_stale.jss_stale_job_id = jobs.job_id"
)
_SCORE_CURRENT_FOR_DOWNSTREAM: str = (
    "(jss_stale.jss_stale_job_id IS NULL "
    "AND (jss_s.jss_s_state IS NULL "
    "OR jss_s.jss_s_state = 'succeeded' "
    "OR (js.js_fit_score IS NULL AND jss_s.jss_s_state != 'stale')))"
)
# Score has no legacy ``jobs.score_attempts`` column, so the canonical
# ``job_stage_states.attempt_count`` counter is the only source (default 0
# for un-scored rows). ``pending_score`` uses this to mirror the tailor /
# cover ``< 5`` cap so a permanently-failing job stops re-billing the LLM
# on every batch. Requires ``_SCORE_DOWNSTREAM_STATE_JOIN`` in the FROM.
_EFFECTIVE_SCORE_ATTEMPTS: str = "COALESCE(jss_s.jss_s_attempts, 0)"


# ---------------------------------------------------------------------------
# job_scores read fragments — selectors and status counts use the latest
# canonical score aggregate.
# ---------------------------------------------------------------------------

_LATEST_SCORE_JOIN: str = (
    "LEFT JOIN ("
    "SELECT s.tenant_id AS js_tenant_id, s.job_id AS js_job_id, "
    "s.fit_score AS js_fit_score, "
    f"{score_eligible_for_downstream_sql('s.breakdown_json')} AS js_eligible_for_downstream "
    "FROM job_scores s "
    "INNER JOIN ("
    "SELECT tenant_id, job_id, MAX(version) AS max_version "
    "FROM job_scores GROUP BY tenant_id, job_id"
    ") latest ON latest.tenant_id = s.tenant_id AND latest.job_id = s.job_id "
    "AND latest.max_version = s.version"
    ") js ON js.js_tenant_id = jobs.tenant_id AND js.js_job_id = jobs.job_id"
)

_EFFECTIVE_FIT_SCORE: str = "js.js_fit_score"
_SCORE_ELIGIBLE_FOR_DOWNSTREAM: str = "COALESCE(js.js_eligible_for_downstream, 0) = 1"


# ---------------------------------------------------------------------------
# Apply read-side. ``apply_run_projections`` is the canonical apply
# lifecycle row for selectors and status counts.
# ---------------------------------------------------------------------------

# Tie-break by run_id when two apply runs share the same ``started_at``.
_LATEST_APPLY_RUN_JOIN: str = (
    "LEFT JOIN ("
    "SELECT ar.tenant_id AS ar_tenant_id, ar.job_id AS ar_job_id, "
    "ar.status AS ar_status, "
    "ar.result AS ar_result, ar.finished_at AS ar_finished_at, "
    "ar.started_at AS ar_started_at, ar.run_id AS ar_run_id "
    "FROM apply_run_projections ar "
    "WHERE ar.run_id = ("
    "SELECT run_id FROM apply_run_projections ar_inner "
    "WHERE ar_inner.tenant_id = ar.tenant_id "
    "AND ar_inner.job_id = ar.job_id "
    "ORDER BY ar_inner.started_at DESC, ar_inner.run_id DESC "
    "LIMIT 1"
    ")"
    ") ar ON ar.ar_tenant_id = jobs.tenant_id AND ar.ar_job_id = jobs.job_id"
)

# Applied = any latest apply run with status='succeeded' for the job.
_EFFECTIVE_APPLIED_AT: str = "CASE WHEN ar.ar_status = 'succeeded' THEN ar.ar_finished_at END"

# Apply status string suitable for read-model consumption.
_EFFECTIVE_APPLY_STATUS: str = (
    "CASE ar.ar_status "
    "WHEN 'starting' THEN 'in_progress' "
    "WHEN 'in_progress' THEN 'in_progress' "
    "WHEN 'succeeded' THEN 'applied' "
    "WHEN 'failed' THEN 'failed' "
    "WHEN 'captcha' THEN 'captcha' "
    "WHEN 'login_issue' THEN 'login_issue' "
    "WHEN 'expired' THEN 'expired' "
    "WHEN 'manual' THEN 'manual' "
    "WHEN 'dry_run_complete' THEN 'dry_run' "
    "ELSE NULL END"
)


LOW_FIT_TAILORING_MAX_SCORE = 5
MIN_TAILORING_FIT_SCORE = LOW_FIT_TAILORING_MAX_SCORE + 1


def effective_tailoring_min_score(min_score: int | None = None) -> int:
    """Return the default-safe floor for material-generation eligibility."""
    if min_score is None:
        return 7
    return max(MIN_TAILORING_FIT_SCORE, int(min_score))


def get_stats(conn: sqlite3.Connection | None = None) -> dict:
    """Return job counts by pipeline stage.

    Provides a snapshot of how many jobs are at each stage, useful for
    dashboard display and pipeline progress tracking.

    Args:
        conn: Database connection. Uses get_connection() if None.

    Returns:
        Dictionary with keys:
            total, by_site, pending_detail, with_description,
            scored, unscored, tailored, untailored_eligible,
            with_cover_letter, applied, score_distribution
    """
    if conn is None:
        conn = get_connection()
    register_score_eligibility_sql(conn)

    stats: dict = {}

    # Total jobs
    stats["total"] = conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]

    # By site breakdown
    rows = conn.execute("SELECT site, COUNT(*) as cnt FROM jobs GROUP BY site ORDER BY cnt DESC").fetchall()
    stats["by_site"] = [(row[0], row[1]) for row in rows]

    # Enrichment stage — derive dashboard counts from JobEnrichment.
    stats["pending_detail"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_ENRICHMENT_JOIN} WHERE {_ENRICHMENT_PENDING}"
    ).fetchone()[0]

    stats["with_description"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_ENRICHMENT_JOIN} WHERE {_EFFECTIVE_FULL_DESCRIPTION} IS NOT NULL"
    ).fetchone()[0]

    stats["detail_errors"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_ENRICHMENT_JOIN} "
        "WHERE je.current_status = 'failed'"
    ).fetchone()[0]

    # Scoring stage — use the same canonical score join as worker queues.
    stats["scored"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_LATEST_SCORE_JOIN} WHERE {_EFFECTIVE_FIT_SCORE} IS NOT NULL"
    ).fetchone()[0]

    stats["unscored"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_LATEST_SCORE_JOIN} {_ENRICHMENT_JOIN} "
        f"WHERE {_EFFECTIVE_FULL_DESCRIPTION} IS NOT NULL "
        f"AND {_EFFECTIVE_FIT_SCORE} IS NULL"
    ).fetchone()[0]

    # Score distribution — group by the latest canonical score.
    dist_rows = conn.execute(
        f"SELECT {_EFFECTIVE_FIT_SCORE} AS effective_score, COUNT(*) AS cnt "
        f"FROM jobs {_LATEST_SCORE_JOIN} "
        f"WHERE {_EFFECTIVE_FIT_SCORE} IS NOT NULL "
        f"GROUP BY effective_score ORDER BY effective_score DESC"
    ).fetchall()
    stats["score_distribution"] = [(row[0], row[1]) for row in dist_rows]

    # Tailoring + cover letter stages — material status and attempt limits
    # come from canonical artifacts and job stage state.
    stats["tailored"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_LATEST_MATERIALS_JOIN} WHERE {_EFFECTIVE_TAILOR_PATH} IS NOT NULL"
    ).fetchone()[0]

    stats["untailored_eligible"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_LATEST_SCORE_JOIN} {_LATEST_MATERIALS_JOIN} "
        f"{_SCORE_DOWNSTREAM_STATE_JOIN} {_ENRICHMENT_JOIN} {_ACTIVE_STATE_JOIN} "
        f"WHERE {_EFFECTIVE_FIT_SCORE} >= 7 "
        f"AND {_SCORE_ELIGIBLE_FOR_DOWNSTREAM} "
        f"AND {_SCORE_CURRENT_FOR_DOWNSTREAM} "
        f"AND {_EFFECTIVE_FULL_DESCRIPTION} IS NOT NULL "
        f"AND {_EFFECTIVE_TAILOR_PATH} IS NULL "
        f"AND {_ENRICHMENT_NOT_QUARANTINED}"
    ).fetchone()[0]

    stats["tailor_exhausted"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_LATEST_MATERIALS_JOIN} {_LATEST_STAGE_ATTEMPTS_JOIN} "
        f"WHERE {_EFFECTIVE_TAILOR_PATH} IS NULL "
        f"AND ({_EFFECTIVE_TAILOR_ATTEMPTS} >= 5 OR jss_t.jss_t_state = 'exhausted')"
    ).fetchone()[0]

    stats["with_cover_letter"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_LATEST_MATERIALS_JOIN} WHERE {_EFFECTIVE_COVER_PATH} IS NOT NULL"
    ).fetchone()[0]

    stats["cover_exhausted"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_LATEST_MATERIALS_JOIN} {_LATEST_STAGE_ATTEMPTS_JOIN} "
        f"WHERE ({_EFFECTIVE_COVER_PATH} IS NULL OR {_EFFECTIVE_COVER_PATH} = '') "
        f"AND ({_EFFECTIVE_COVER_ATTEMPTS} >= 5 OR jss_c.jss_c_state = 'exhausted')"
    ).fetchone()[0]

    # Application stage — status comes from apply-run projections.
    stats["applied"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_LATEST_APPLY_RUN_JOIN} {_ACTIVE_STATE_JOIN} "
        f"WHERE {_EFFECTIVE_APPLIED_AT} IS NOT NULL "
        f"AND {_NOT_CLOSED_ACTIVE_STATE}"
    ).fetchone()[0]

    stats["apply_errors"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_LATEST_APPLY_RUN_JOIN} {_ACTIVE_STATE_JOIN} "
        "WHERE ar.ar_status IN ('failed', 'captcha', 'login_issue', 'expired') "
        f"AND {_NOT_CLOSED_ACTIVE_STATE}"
    ).fetchone()[0]

    stats["ready_to_apply"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_LATEST_SCORE_JOIN} {_LATEST_MATERIALS_JOIN} "
        f"{_SCORE_DOWNSTREAM_STATE_JOIN} {_ENRICHMENT_JOIN} {_LATEST_APPLY_RUN_JOIN} "
        f"{_ACTIVE_STATE_JOIN} "
        f"WHERE {_READY_TAILORED_RESUME_WITH_PDF} "
        f"AND {_EFFECTIVE_FIT_SCORE} >= 7 "
        f"AND {_SCORE_ELIGIBLE_FOR_DOWNSTREAM} "
        f"AND {_SCORE_CURRENT_FOR_DOWNSTREAM} "
        f"AND {_EFFECTIVE_APPLIED_AT} IS NULL "
        f"AND {_EFFECTIVE_APPLY_TARGET_URL} IS NOT NULL "
        f"AND {_EFFECTIVE_APPLY_TARGET_URL} != '' "
        f"AND {_NOT_CLOSED_ACTIVE_STATE} "
        f"AND {_ENRICHMENT_NOT_QUARANTINED}"
    ).fetchone()[0]

    return stats


def count_ready_to_apply(
    conn: sqlite3.Connection,
    *,
    min_score: int = 7,
    target_url: str | None = None,
) -> int:
    """Count jobs the apply runner can actually acquire.

    Apply can start from a direct application URL when enrichment found one,
    or from the posting URL and let the autonomous agent click through. Keep
    CLI/UI preflight aligned with the same canonical read model used by the
    queue selectors instead of the legacy ``jobs.*`` columns.
    """

    register_score_eligibility_sql(conn)
    where = [
        _READY_TAILORED_RESUME_WITH_PDF,
        f"{_EFFECTIVE_FIT_SCORE} >= ?",
        _SCORE_ELIGIBLE_FOR_DOWNSTREAM,
        _SCORE_CURRENT_FOR_DOWNSTREAM,
        f"{_EFFECTIVE_APPLIED_AT} IS NULL",
        f"{_EFFECTIVE_APPLY_TARGET_URL} IS NOT NULL",
        f"{_EFFECTIVE_APPLY_TARGET_URL} != ''",
        _NOT_CLOSED_ACTIVE_STATE,
        _ENRICHMENT_NOT_QUARANTINED,
        "NOT EXISTS ("
        "SELECT 1 FROM job_stage_states jss_active "
        "WHERE jss_active.tenant_id = jobs.tenant_id "
        "AND jss_active.job_id = jobs.job_id "
        "AND jss_active.stage = 'apply' "
        "AND jss_active.state IN ('running', 'succeeded')"
        ")",
        "COALESCE(("
        "SELECT jss_a.attempt_count FROM job_stage_states jss_a "
        "WHERE jss_a.tenant_id = jobs.tenant_id "
        "AND jss_a.job_id = jobs.job_id "
        "AND jss_a.stage = 'apply' LIMIT 1"
        "), 0) < ?",
        "(ar.ar_status IS NULL OR ar.ar_status NOT IN ('starting', 'in_progress'))",
    ]
    params: list[Any] = [min_score, DEFAULTS["max_apply_attempts"]]
    if target_url:
        like = f"%{target_url.split('?')[0].rstrip('/')}%"
        where.append(
            f"(jobs.url = ? OR {_EFFECTIVE_APPLICATION_URL} = ? "
            f"OR {_EFFECTIVE_APPLICATION_URL} LIKE ? OR jobs.url LIKE ?)"
        )
        params.extend([target_url, target_url, like, like])

    return int(
        conn.execute(
            f"SELECT COUNT(*) FROM jobs {_LATEST_SCORE_JOIN} {_LATEST_MATERIALS_JOIN} "
            f"{_SCORE_DOWNSTREAM_STATE_JOIN} {_ENRICHMENT_JOIN} {_LATEST_APPLY_RUN_JOIN} "
            f"{_ACTIVE_STATE_JOIN} "
            f"WHERE {' AND '.join(where)}",
            params,
        ).fetchone()[0]
    )


def store_jobs(conn: sqlite3.Connection, jobs: list[dict], site: str, strategy: str) -> tuple[int, int]:
    """Store discovered jobs, skipping duplicates by URL.

    Args:
        conn: Database connection.
        jobs: List of job dicts with keys: url, title, salary, description, location.
        site: Source site name (e.g. "RemoteOK", "Dice").
        strategy: Extraction strategy used (e.g. "json_ld", "api_response", "css_selectors").

    Returns:
        Tuple of (new_count, duplicate_count).
    """
    now = datetime.now(timezone.utc).isoformat()
    new = 0
    existing = 0

    for job in jobs:
        url = job.get("url")
        if not url:
            continue
        try:
            conn.execute(
                "INSERT INTO jobs (url, title, company, salary, description, location, site, strategy, discovered_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    url,
                    job.get("title"),
                    job.get("company"),
                    job.get("salary"),
                    job.get("description"),
                    job.get("location"),
                    site,
                    strategy,
                    now,
                ),
            )
            from jobctrl.state import ensure_job_stage_rows, record_job_event, set_stage_state

            ensure_job_stage_rows(conn, url, discovered_at=now)
            set_stage_state(
                conn,
                url,
                "discover",
                "succeeded",
                attempt_count=1,
                started_at=now,
                finished_at=now,
            )
            record_job_event(
                conn,
                url,
                "discover",
                "StageCompleted",
                message=f"Discovered via {site}:{strategy}",
                occurred_at=now,
            )
            new += 1
        except sqlite3.IntegrityError:
            company = str(job.get("company") or "").strip()
            if company:
                cursor = conn.execute(
                    "UPDATE jobs SET company = ? WHERE url = ? AND (company IS NULL OR company = '')",
                    (company, url),
                )
                if cursor.rowcount:
                    from jobctrl.state import record_job_event

                    record_job_event(
                        conn,
                        url,
                        "discover",
                        "JobMetadataUpdated",
                        message=f"Job company backfilled from {site}",
                        payload={"company": company, "source": site},
                        occurred_at=now,
                    )
            resurface_deleted_job(conn, url, resurfaced_at=now)
            existing += 1

    conn.commit()
    return new, existing


def resurface_deleted_job(conn: sqlite3.Connection, job_url: str, *, resurfaced_at: str) -> None:
    """Clear a temporary delete tombstone when Discovery sees a job again.

    Hidden jobs are tracked in a separate table and are intentionally not
    touched here, so a hidden job remains suppressed across discoveries.
    """
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS jobctrl_deleted_jobs (
            job_url TEXT PRIMARY KEY,
            deleted_at TEXT NOT NULL,
            reason TEXT,
            restored_at TEXT,
            FOREIGN KEY(job_url) REFERENCES jobs(url)
        )
        """
    )
    cursor = conn.execute(
        """
        UPDATE jobctrl_deleted_jobs
        SET restored_at = ?
        WHERE job_url = ?
          AND (restored_at IS NULL OR julianday(restored_at) <= julianday(deleted_at))
        """,
        (resurfaced_at, job_url),
    )
    if cursor.rowcount:
        from jobctrl.state import record_job_event

        record_job_event(
            conn,
            job_url,
            "discover",
            "JobRestored",
            message="Job resurfaced because discovery observed it again.",
            occurred_at=resurfaced_at,
            payload={"reason": "rediscovered"},
        )


def load_job_with_enrichment(
    conn: sqlite3.Connection,
    url: str,
) -> dict | None:
    """Load one job row with the canonical enrichment fields promoted.

    The legacy ``SELECT * FROM jobs WHERE url = ?`` reads NULL for
    ``full_description`` / ``application_url`` / ``detail_scraped_at``
    on the new write path. This helper LEFT JOINs ``job_enrichments``
    and ``apply_run_projections`` and promotes the joined values into
    the legacy column slots so callers (manual ``apply_jobs`` flow,
    ``apply/launcher`` snapshots) keep reading via the existing keys
    without an extra round-trip through the repository.

    Returns the row dict, or ``None`` if no job row exists for ``url``.
    """
    row = conn.execute(
        f"SELECT jobs.*, "
        f"je.full_description AS je_full_description, "
        f"je.application_url AS je_application_url, "
        f"je.enriched_at AS je_enriched_at, "
        f"je.current_status AS je_current_status, "
        f"je.extraction_tier AS je_extraction_tier, "
        f"pss.latest_confidence AS enrichment_confidence, "
        f"pss.latest_quarantine_reason AS enrichment_quarantine_reason, "
        f"ar.ar_status AS ar_status, "
        f"ar.ar_finished_at AS ar_finished_at, "
        f"ar.ar_run_id AS ar_run_id, "
        f"{_EFFECTIVE_APPLIED_AT} AS effective_applied_at, "
        f"{_EFFECTIVE_APPLY_STATUS} AS effective_apply_status "
        f"FROM jobs {_ENRICHMENT_JOIN} {_LATEST_APPLY_RUN_JOIN} {_ACTIVE_STATE_JOIN} "
        "WHERE jobs.url = ? LIMIT 1",
        (url,),
    ).fetchone()
    if row is None:
        return None
    record = dict(row)
    je_full = record.pop("je_full_description", None)
    je_app = record.pop("je_application_url", None)
    je_at = record.pop("je_enriched_at", None)
    record.pop("je_current_status", None)
    record.pop("je_extraction_tier", None)
    record["full_description"] = je_full
    record["application_url"] = je_app
    record["detail_scraped_at"] = je_at
    # PR 4 of the Temporal stack: promote ``apply_run_projections``
    # columns into the legacy column slots.
    record.pop("ar_status", None)
    record.pop("ar_finished_at", None)
    ar_applied = record.pop("effective_applied_at", None)
    ar_status = record.pop("effective_apply_status", None)
    ar_run_id = record.pop("ar_run_id", None)
    record["applied_at"] = ar_applied
    record["apply_status"] = ar_status
    record["apply_task_id"] = ar_run_id
    return record


def get_jobs_by_stage(
    conn: sqlite3.Connection | None = None,
    stage: str = "discovered",
    min_score: int | None = None,
    limit: int = 100,
    retailor: bool = False,
) -> list[dict]:
    """Fetch jobs filtered by pipeline stage.

    Args:
        conn: Database connection. Uses get_connection() if None.
        stage: One of "discovered", "pending_detail", "enriched", "pending_score",
            "scored", "pending_tailor", "pending_cover", "tailored",
            "pending_apply", "applied".
        min_score: Minimum fit_score filter (only relevant for scored+ stages).
        limit: Maximum number of rows to return.
        retailor: When True and stage is "pending_tailor", also include jobs that
            already have a tailored resume so they can be tailored again.

    Returns:
        List of job dicts.
    """
    if conn is None:
        conn = get_connection()
    register_score_eligibility_sql(conn)
    if stage in ("pending_tailor", "pending_cover"):
        min_score = effective_tailoring_min_score(min_score)

    # Queue predicates derive score, material, retry, enrichment, and apply
    # state only from their canonical v7 aggregate or projection.
    pending_tailor_where = (
        f"{_EFFECTIVE_FIT_SCORE} >= ? AND {_EFFECTIVE_FULL_DESCRIPTION} IS NOT NULL "
        f"AND {_SCORE_ELIGIBLE_FOR_DOWNSTREAM} "
        f"AND {_SCORE_CURRENT_FOR_DOWNSTREAM} "
        f"AND {_TAILOR_NOT_EXHAUSTED} "
        f"AND ({_EFFECTIVE_TAILOR_PATH} IS NOT NULL OR {_EFFECTIVE_TAILOR_ATTEMPTS} < 5) "
        f"AND {_NOT_CLOSED_ACTIVE_STATE} "
        f"AND {_ENRICHMENT_NOT_QUARANTINED}"
        if retailor
        else f"{_EFFECTIVE_FIT_SCORE} >= ? AND {_EFFECTIVE_FULL_DESCRIPTION} IS NOT NULL "
        f"AND {_SCORE_ELIGIBLE_FOR_DOWNSTREAM} "
        f"AND {_SCORE_CURRENT_FOR_DOWNSTREAM} "
        f"AND {_EFFECTIVE_TAILOR_PATH} IS NULL "
        f"AND {_TAILOR_NOT_EXHAUSTED} "
        f"AND {_EFFECTIVE_TAILOR_ATTEMPTS} < 5 "
        f"AND {_NOT_CLOSED_ACTIVE_STATE} "
        f"AND {_ENRICHMENT_NOT_QUARANTINED}"
    )

    conditions = {
        "discovered": _NOT_CLOSED_ACTIVE_STATE,
        "pending_detail": f"{_ENRICHMENT_PENDING} AND {_NOT_CLOSED_ACTIVE_STATE}",
        "enriched": f"{_EFFECTIVE_FULL_DESCRIPTION} IS NOT NULL AND {_NOT_CLOSED_ACTIVE_STATE}",
        "pending_score": (
            f"{_EFFECTIVE_FULL_DESCRIPTION} IS NOT NULL "
            f"AND {_EFFECTIVE_FIT_SCORE} IS NULL "
            f"AND {_EFFECTIVE_SCORE_ATTEMPTS} < 5 "
            f"AND {_NOT_CLOSED_ACTIVE_STATE}"
        ),
        "scored": f"{_EFFECTIVE_FIT_SCORE} IS NOT NULL AND {_NOT_CLOSED_ACTIVE_STATE}",
        "pending_tailor": pending_tailor_where,
        "pending_cover": (
            f"{_EFFECTIVE_FIT_SCORE} >= ? AND {_EFFECTIVE_FULL_DESCRIPTION} IS NOT NULL "
            f"AND {_SCORE_ELIGIBLE_FOR_DOWNSTREAM} "
            f"AND {_SCORE_CURRENT_FOR_DOWNSTREAM} "
            f"AND {_READY_TAILORED_RESUME_WITH_PDF} "
            f"AND ({_EFFECTIVE_COVER_PATH} IS NULL OR {_EFFECTIVE_COVER_PATH} = '') "
            f"AND {_COVER_NOT_EXHAUSTED} "
            f"AND {_EFFECTIVE_COVER_ATTEMPTS} < 5 "
            f"AND {_NOT_CLOSED_ACTIVE_STATE} "
            f"AND {_ENRICHMENT_NOT_QUARANTINED}"
        ),
        "pending_pdf": (
            f"(({_EFFECTIVE_TAILOR_PATH} IS NOT NULL AND jm.jm_resume_pdf_path IS NULL) "
            f"OR ({_EFFECTIVE_COVER_PATH} IS NOT NULL AND jm.jm_cover_pdf_path IS NULL)) "
            f"AND {_NOT_CLOSED_ACTIVE_STATE}"
        ),
        "tailored": f"{_EFFECTIVE_TAILOR_PATH} IS NOT NULL AND {_NOT_CLOSED_ACTIVE_STATE}",
        # PR 4 of the Temporal stack: pending_apply / applied read
        # through ``apply_run_projections`` so the new write path
        # (which leaves jobs.applied_at NULL) is visible.
        "pending_apply": (
            f"{_READY_TAILORED_RESUME_WITH_PDF} "
            f"AND {_EFFECTIVE_FIT_SCORE} >= ? "
            f"AND {_SCORE_ELIGIBLE_FOR_DOWNSTREAM} "
            f"AND {_SCORE_CURRENT_FOR_DOWNSTREAM} "
            f"AND {_EFFECTIVE_APPLIED_AT} IS NULL "
            f"AND {_EFFECTIVE_APPLY_TARGET_URL} IS NOT NULL "
            f"AND {_EFFECTIVE_APPLY_TARGET_URL} != '' "
            "AND (ar.ar_status IS NULL "
            "     OR ar.ar_status NOT IN ('starting', 'in_progress')) "
            f"AND {_NOT_CLOSED_ACTIVE_STATE} "
            f"AND {_ENRICHMENT_NOT_QUARANTINED}"
        ),
        "applied": f"{_EFFECTIVE_APPLIED_AT} IS NOT NULL AND {_NOT_CLOSED_ACTIVE_STATE}",
    }

    where = conditions.get(stage, "1=1")
    params: list = []

    if "?" in where and min_score is not None:
        params.append(min_score)
    elif "?" in where:
        params.append(7)  # default min_score

    # Optional post-filter — also routed through the join so it sees new
    # rows. Triggered by callers passing ``min_score=N`` for the
    # "scored / tailored / applied" stages.
    if min_score is not None and stage in ("scored", "tailored", "applied") and _EFFECTIVE_FIT_SCORE not in where:
        where += f" AND {_EFFECTIVE_FIT_SCORE} >= ?"
        params.append(min_score)

    # ``SELECT jobs.*`` keeps the legacy callers' "give me back a dict
    # shaped like the jobs row" contract; we additionally surface
    # ``js_fit_score`` so downstream readers (e.g. ``apply/launcher.py``)
    # can prefer the canonical score over the legacy column without an
    # extra round-trip.
    #
    # Phase 6 (S-20) does the same for materials artifact paths: the
    # ``jm_*`` aliases are promoted into the legacy
    # ``tailored_resume_path`` / ``cover_letter_path`` slots so untouched
    # consumers (apply launcher, pipeline.apply_jobs single-job flow) keep
    # picking up the latest generation's artifacts without an extra
    # round-trip through the repository.
    query = (
        f"SELECT jobs.*, js.js_fit_score AS js_fit_score, "
        f"jm.jm_job_id AS jm_job_id, "
        f"jm.jm_tailored_path AS jm_tailored_path, "
        f"jm.jm_tailored_at AS jm_tailored_at, "
        f"jm.jm_cover_path AS jm_cover_path, "
        f"jm.jm_cover_at AS jm_cover_at, "
        f"jm.jm_resume_pdf_path AS jm_resume_pdf_path, "
        f"jm.jm_cover_pdf_path AS jm_cover_pdf_path, "
        f"jm.jm_generation AS jm_generation, "
        f"jm.jm_status AS jm_status, "
        f"je.full_description AS je_full_description, "
        f"je.application_url AS je_application_url, "
        f"je.enriched_at AS je_enriched_at, "
        f"je.current_status AS je_current_status, "
        f"je.extraction_tier AS je_extraction_tier, "
        f"pss.latest_confidence AS enrichment_confidence, "
        f"pss.latest_quarantine_reason AS enrichment_quarantine_reason, "
        f"ar.ar_status AS ar_status, "
        f"ar.ar_finished_at AS ar_finished_at, "
        f"ar.ar_run_id AS ar_run_id, "
        f"{_EFFECTIVE_APPLIED_AT} AS effective_applied_at, "
        f"{_EFFECTIVE_APPLY_STATUS} AS effective_apply_status "
        f"FROM jobs {_LATEST_SCORE_JOIN} {_LATEST_MATERIALS_JOIN} "
        f"{_LATEST_STAGE_ATTEMPTS_JOIN} {_SCORE_DOWNSTREAM_STATE_JOIN} "
        f"{_ENRICHMENT_JOIN} {_LATEST_APPLY_RUN_JOIN} {_ACTIVE_STATE_JOIN} "
        f"WHERE {where} "
        f"ORDER BY {_EFFECTIVE_FIT_SCORE} DESC NULLS LAST, discovered_at DESC"
    )
    if limit > 0:
        query += " LIMIT ?"
        params.append(limit)

    rows = conn.execute(query, params).fetchall()

    # Convert sqlite3.Row objects to dicts. We promote ``js_fit_score``
    # into the legacy ``fit_score`` slot and ``jm_*_path`` into the
    # legacy ``tailored_resume_path`` / ``cover_letter_path`` slots so
    # downstream consumers that haven't been ported yet see the canonical
    # values rather than NULL.
    if not rows:
        return []
    columns = rows[0].keys()
    out: list[dict] = []
    for row in rows:
        record = dict(zip(columns, row))
        js_value = record.pop("js_fit_score", None)
        record["fit_score"] = js_value
        record.pop("jm_job_id", None)
        jm_tailored = record.pop("jm_tailored_path", None)
        jm_tailored_at = record.pop("jm_tailored_at", None)
        jm_cover = record.pop("jm_cover_path", None)
        jm_cover_at = record.pop("jm_cover_at", None)
        record["tailored_resume_path"] = jm_tailored
        record["tailored_at"] = jm_tailored_at
        record["cover_letter_path"] = jm_cover
        record["cover_letter_at"] = jm_cover_at
        # Phase 7 (S-26): promote enrichment fields from job_enrichments
        # into the legacy column slots so downstream consumers (apply,
        # scoring, tailor) that still read ``full_description`` /
        # ``application_url`` / ``detail_scraped_at`` see canonical values
        # without an extra repository round-trip.
        je_full = record.pop("je_full_description", None)
        je_app = record.pop("je_application_url", None)
        je_at = record.pop("je_enriched_at", None)
        record.pop("je_current_status", None)
        record.pop("je_extraction_tier", None)
        record["full_description"] = je_full
        record["application_url"] = je_app
        record["detail_scraped_at"] = je_at
        # PR 4 of the Temporal stack: promote ``apply_run_projections``
        # columns into the legacy column slots so consumers (TS
        # read-model, Rich dashboard, legacy CLI) that still read
        # ``applied_at`` / ``apply_status`` see canonical values written
        # by the projection builder.
        ar_applied = record.pop("effective_applied_at", None)
        ar_status = record.pop("effective_apply_status", None)
        record.pop("ar_status", None)
        record.pop("ar_finished_at", None)
        ar_run_id = record.pop("ar_run_id", None)
        record["applied_at"] = ar_applied
        record["apply_status"] = ar_status
        record["apply_task_id"] = ar_run_id
        out.append(record)
    return out
