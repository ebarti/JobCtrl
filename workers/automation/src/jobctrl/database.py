"""JobCtrl database layer: schema, migrations, stats, and connection helpers.

Single source of truth for the jobs table schema. All columns from every
pipeline stage are created up front so any stage can run independently
without migration ordering issues.

This module also owns the apply-agent observability tables used for
persistent run and event telemetry.
"""

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jobctrl.config import DB_PATH, DEFAULTS, migrate_legacy_job_tables

# Schema version stamped into the SQLite ``user_version`` header. The ensure_*
# helpers below are additive and idempotent, so this is a lightweight
# forward-incompatibility guard (refuse a DB written by a newer build), not a
# migration framework. Bump it only when the schema shape changes.
#
# v2 (Contact & Outreach): generic ``entity_kind``/``entity_ref`` columns on
# ``job_events`` so contact-only events carry honest identity without
# overloading ``job_url`` (outreach planner plan §10.1, owner decision 2b), plus
# the ninth-context canonical tables (``ensure_contact_tables``).
# v3 (Discovery execution lineage): immutable Temporal execution/job membership
# and the idempotently filled preparation work plan used by Operations.
SCHEMA_VERSION = 3


class IncompatibleSchemaVersionError(RuntimeError):
    """Raised when the database was written by a newer build than this code."""


# Thread-local connection storage — each thread gets its own connection
# (required for SQLite thread safety with parallel workers)
_local = threading.local()


def get_connection(db_path: Path | str | None = None) -> sqlite3.Connection:
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
            return conn
        except sqlite3.ProgrammingError:
            pass

    conn = sqlite3.connect(path, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=10000")
    conn.row_factory = sqlite3.Row
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


def _ensure_schema_version(conn: sqlite3.Connection) -> int:
    """Stamp ``PRAGMA user_version`` as a lightweight schema guard.

    Databases created before this guard report ``user_version == 0`` and are
    adopted by stamping ``SCHEMA_VERSION``; an equal version is a no-op. A
    database whose version is newer than this build fails closed with
    ``IncompatibleSchemaVersionError`` -- the caller (``init_db``) invokes this
    before any table creation or migration, so a stale build never runs its
    potentially destructive ``ensure_*`` migrations against a forward-migrated
    file, and is never silently downgraded.
    """
    current = int(conn.execute("PRAGMA user_version").fetchone()[0])
    if current > SCHEMA_VERSION:
        raise IncompatibleSchemaVersionError(
            f"database was written by a newer JobCtrl build "
            f"(schema version {current} > code schema version {SCHEMA_VERSION}); "
            f"upgrade JobCtrl or restore a compatible backup ('jobctrl backup')."
        )
    if current < SCHEMA_VERSION:
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        conn.commit()
    return SCHEMA_VERSION


def init_db(db_path: Path | str | None = None) -> sqlite3.Connection:
    """Create the full jobs table with all columns from every pipeline stage.

    This is idempotent -- safe to call on every startup. Uses CREATE TABLE IF NOT EXISTS
    so it won't destroy existing data.

    Schema columns by stage:
      - Discovery:  url, title, company, salary, description, location, site, strategy, discovered_at
      - Enrichment: full_description, application_url, detail_scraped_at, detail_error
      - Scoring:    fit_score, score_reasoning, scored_at
      - Tailoring:  tailored_resume_path, tailored_at, tailor_attempts
      - Cover:      cover_letter_path, cover_letter_at, cover_attempts
      - Apply:      applied_at, apply_status, apply_error, apply_attempts,
                   agent_id, last_attempted_at, apply_duration_ms, apply_task_id,
                   verification_confidence

    Args:
        db_path: Override the default DB_PATH.

    Returns:
        sqlite3.Connection with the schema initialized.
    """
    path = db_path or DB_PATH

    # Ensure parent directory exists
    Path(path).parent.mkdir(parents=True, exist_ok=True)

    conn = get_connection(path)
    _ensure_schema_version(conn)
    migrate_legacy_job_tables(conn)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS llm_spend (
            day           TEXT PRIMARY KEY,
            input_tokens  INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            estimated_usd REAL NOT NULL DEFAULT 0
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS jobs (
            -- Discovery stage (smart_extract / job_search)
            url                   TEXT PRIMARY KEY,
            title                 TEXT,
            company               TEXT,
            salary                TEXT,
            description           TEXT,
            location              TEXT,
            site                  TEXT,
            strategy              TEXT,
            discovered_at         TEXT,

            -- Enrichment stage (detail_scraper)
            full_description      TEXT,
            application_url       TEXT,
            detail_scraped_at     TEXT,
            detail_error          TEXT,

            -- Scoring stage (job_scorer)
            fit_score             INTEGER,
            score_reasoning       TEXT,
            scored_at             TEXT,

            -- Tailoring stage (resume tailor)
            tailored_resume_path  TEXT,
            tailored_at           TEXT,
            tailor_attempts       INTEGER DEFAULT 0,

            -- Cover letter stage
            cover_letter_path     TEXT,
            cover_letter_at       TEXT,
            cover_attempts        INTEGER DEFAULT 0,

            -- Application stage
            applied_at            TEXT,
            apply_status          TEXT,
            apply_error           TEXT,
            apply_attempts        INTEGER DEFAULT 0,
            agent_id              TEXT,
            last_attempted_at     TEXT,
            apply_duration_ms     INTEGER,
            apply_task_id         TEXT,
            verification_confidence TEXT
        )
    """)
    conn.commit()

    # Run migrations for any columns added after initial schema
    ensure_columns(conn)
    ensure_posted_compensation_tables(conn)
    ensure_market_compensation_tables(conn)
    ensure_state_tables(conn)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS application_review_decisions (
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            decision_id         TEXT PRIMARY KEY,
            job_key             TEXT NOT NULL,
            decision            TEXT NOT NULL,
            reason              TEXT,
            decided_by          TEXT,
            decided_at          TEXT NOT NULL,
            materials_generation INTEGER,
            profile_version     INTEGER,
            application_url     TEXT,
            partial_override_run_id TEXT,
            email_recipient TEXT,
            email_attachment_artifact_id TEXT
        )
    """)
    ensure_application_review_decision_columns(conn)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_application_review_decisions_job
        ON application_review_decisions(tenant_id, job_key, decided_at DESC)
    """)
    ensure_profile_tables(conn)
    ensure_score_tables(conn)
    ensure_tailoring_policy_tables(conn)
    ensure_materials_tables(conn)
    ensure_resume_template_tables(conn)
    ensure_employer_analysis_tables(conn)
    ensure_bullet_provenance_tables(conn)
    ensure_interview_prep_tables(conn)
    ensure_preparation_work_item_tables(conn)
    ensure_enrichment_tables(conn)
    ensure_posting_snapshot_tables(conn)
    ensure_discovery_run_tables(conn)
    ensure_operational_metric_tables(conn)
    ensure_source_observation_tables(conn)
    ensure_discovery_execution_tables(conn)
    ensure_discovery_control_tables(conn)
    ensure_discovery_settings_tables(conn)
    ensure_contact_tables(conn)
    ensure_projection_tables_in_db(conn)
    drop_legacy_apply_runs_tables(conn)

    return conn


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


def ensure_contact_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create the Contact & Outreach (ninth bounded context) canonical tables.

    These are the write-side aggregate tables for the outreach planner
    (contacts, contact attributes with provenance, supervised research tasks and
    their proposed candidates, outreach threads, generation-versioned drafts, and
    user-attested send logs). Phase 0 creates the shells; later phases fill them.

    Sensitivity: attribute *values* live only in ``contact_attributes.value_json``
    (canonical write side), never in ``job_events`` payloads, projections, logs,
    or telemetry (outreach planner plan §6; CLAUDE.md sensitive-data rule). Every
    stored attribute carries inspectable provenance columns (INV-2). There is no
    send transport anywhere in this schema — ``outreach_send_logs`` records only a
    user-attested fact that the user sent an approved draft (INV-1).
    """
    if conn is None:
        conn = get_connection()

    conn.execute("""
        CREATE TABLE IF NOT EXISTS contacts (
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            contact_id          TEXT NOT NULL,
            employer            TEXT,
            job_url             TEXT,
            role                TEXT NOT NULL DEFAULT 'other',
            created_at          TEXT NOT NULL,
            updated_at          TEXT NOT NULL,
            deleted_at          TEXT,
            PRIMARY KEY (tenant_id, contact_id)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS contact_attributes (
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            attribute_id        TEXT NOT NULL,
            contact_id          TEXT NOT NULL,
            attribute_kind      TEXT NOT NULL,
            value_json          TEXT,
            source_kind         TEXT NOT NULL,
            source_ref          TEXT NOT NULL,
            capture_method      TEXT NOT NULL,
            confidence          REAL NOT NULL DEFAULT 0,
            user_confirmed      INTEGER NOT NULL DEFAULT 0,
            recorded_at         TEXT NOT NULL,
            PRIMARY KEY (tenant_id, attribute_id)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS contact_research_tasks (
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            task_id             TEXT NOT NULL,
            employer            TEXT,
            job_url             TEXT,
            status              TEXT NOT NULL DEFAULT 'queued',
            source_attempts_json TEXT NOT NULL DEFAULT '[]',
            started_at          TEXT,
            updated_at          TEXT NOT NULL,
            needs_review_at     TEXT,
            completed_at        TEXT,
            failed_at           TEXT,
            error_class         TEXT,
            PRIMARY KEY (tenant_id, task_id)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS contact_candidates (
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            candidate_id        TEXT NOT NULL,
            task_id             TEXT NOT NULL,
            role                TEXT NOT NULL DEFAULT 'other',
            attributes_json     TEXT,
            source_kind         TEXT NOT NULL,
            source_ref          TEXT NOT NULL,
            capture_method      TEXT NOT NULL,
            confidence          REAL NOT NULL DEFAULT 0,
            status              TEXT NOT NULL DEFAULT 'needs_review',
            proposed_at         TEXT NOT NULL,
            confirmed_contact_id TEXT,
            confirmed_at        TEXT,
            PRIMARY KEY (tenant_id, candidate_id)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS outreach_threads (
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            thread_id           TEXT NOT NULL,
            contact_id          TEXT NOT NULL,
            job_url             TEXT,
            created_at          TEXT NOT NULL,
            updated_at          TEXT NOT NULL,
            follow_up_due_at    TEXT,
            follow_up_basis     TEXT,
            follow_up_state     TEXT NOT NULL DEFAULT 'none',
            PRIMARY KEY (tenant_id, thread_id)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS outreach_drafts (
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            draft_id            TEXT NOT NULL,
            thread_id           TEXT NOT NULL,
            generation          INTEGER NOT NULL DEFAULT 1,
            kind                TEXT NOT NULL,
            status              TEXT NOT NULL DEFAULT 'candidate',
            body_text           TEXT,
            gate_results_json   TEXT,
            provenance_json     TEXT,
            created_at          TEXT NOT NULL,
            approved_at         TEXT,
            rejected_at         TEXT,
            reason              TEXT,
            PRIMARY KEY (tenant_id, draft_id)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS outreach_send_logs (
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            send_log_id         TEXT NOT NULL,
            thread_id           TEXT NOT NULL,
            draft_id            TEXT NOT NULL,
            channel             TEXT NOT NULL,
            sent_at             TEXT NOT NULL,
            logged_at           TEXT NOT NULL,
            PRIMARY KEY (tenant_id, send_log_id)
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_contacts_lookup
        ON contacts(tenant_id, employer, job_url)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_contact_attributes_contact
        ON contact_attributes(tenant_id, contact_id)
    """)
    # Provenance of the search itself (§4.2): which allowed source was tried and
    # its first-class outcome (robots/rate-limit/budget/rejected/manual-capture).
    # Forward-migration guard so a Phase-0/1 database gains the column in place.
    research_columns = {
        row[1] for row in conn.execute("PRAGMA table_info(contact_research_tasks)").fetchall()
    }
    if "source_attempts_json" not in research_columns:
        conn.execute(
            "ALTER TABLE contact_research_tasks ADD COLUMN source_attempts_json TEXT NOT NULL DEFAULT '[]'"
        )
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_contact_candidates_task
        ON contact_candidates(tenant_id, task_id, status)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_outreach_threads_contact
        ON outreach_threads(tenant_id, contact_id)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_outreach_drafts_thread
        ON outreach_drafts(tenant_id, thread_id, generation DESC)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_outreach_send_logs_thread
        ON outreach_send_logs(tenant_id, thread_id)
    """)
    conn.commit()
    return [
        "contacts",
        "contact_attributes",
        "contact_research_tasks",
        "contact_candidates",
        "outreach_threads",
        "outreach_drafts",
        "outreach_send_logs",
    ]


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


def ensure_posted_compensation_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create canonical posted compensation fact storage.

    The legacy ``jobs.salary`` column remains the raw compatibility fallback.
    This table stores deterministic parser output separately so downstream
    read models can distinguish raw posting text from normalized facts.
    """
    if conn is None:
        conn = get_connection()

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS job_posted_compensation_facts (
            tenant_id                    TEXT NOT NULL DEFAULT 'local',
            job_url                      TEXT NOT NULL,
            source_field                 TEXT NOT NULL DEFAULT 'jobs.salary',
            source_text                  TEXT,
            legacy_raw_salary            TEXT,
            parse_state                  TEXT NOT NULL,
            currency                     TEXT,
            period                       TEXT NOT NULL DEFAULT 'unknown',
            component                    TEXT NOT NULL DEFAULT 'unknown',
            minimum_amount               INTEGER,
            maximum_amount               INTEGER,
            annualized_minimum_amount    INTEGER,
            annualized_maximum_amount    INTEGER,
            annualization_assumption     TEXT,
            confidence                   TEXT NOT NULL DEFAULT 'none',
            warnings_json                TEXT NOT NULL DEFAULT '[]',
            parser_version               TEXT NOT NULL,
            source_hash                  TEXT NOT NULL,
            parsed_at                    TEXT NOT NULL,
            PRIMARY KEY (tenant_id, job_url),
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_posted_compensation_parse_state
        ON job_posted_compensation_facts (tenant_id, parse_state)
        """
    )
    conn.commit()
    return []


def ensure_market_compensation_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create canonical company-role reported compensation estimate storage."""
    if conn is None:
        conn = get_connection()

    existing_table = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'job_market_compensation_estimates'"
    ).fetchone()
    if existing_table is not None and "total_compensation" not in str(existing_table["sql"]):
        conn.execute("DROP TABLE IF EXISTS job_market_compensation_estimates_public_legacy")
        conn.execute(
            "ALTER TABLE job_market_compensation_estimates "
            "RENAME TO job_market_compensation_estimates_public_legacy"
        )
        conn.commit()
        existing_table = None

    rebuild_table: str | None = None
    if existing_table is not None and "market_baseline_fallback" not in str(existing_table["sql"]):
        rebuild_table = "job_market_compensation_estimates_scope_legacy"
        conn.execute(f"DROP TABLE IF EXISTS {rebuild_table}")
        conn.execute(f"ALTER TABLE job_market_compensation_estimates RENAME TO {rebuild_table}")
        conn.commit()

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS job_market_compensation_estimates (
            tenant_id                         TEXT NOT NULL DEFAULT 'local',
            job_url                           TEXT NOT NULL,
            estimate_state                    TEXT NOT NULL CHECK (
                estimate_state IN ('unsupported', 'source_unavailable', 'insufficient_evidence', 'estimated_range')
            ),
            currency                          TEXT,
            period                            TEXT NOT NULL DEFAULT 'year' CHECK (period IN ('year', 'month')),
            component                         TEXT NOT NULL DEFAULT 'total_compensation' CHECK (
                component IN ('base_salary', 'total_compensation')
            ),
            minimum_amount                    INTEGER,
            maximum_amount                    INTEGER,
            confidence_interval_minimum_amount INTEGER,
            confidence_interval_maximum_amount INTEGER,
            confidence_band                   TEXT NOT NULL DEFAULT 'none' CHECK (
                confidence_band IN ('none', 'low', 'medium', 'high')
            ),
            confidence_score                  REAL NOT NULL DEFAULT 0,
            source_count                      INTEGER NOT NULL DEFAULT 0,
            sample_count                      INTEGER,
            aggregate_bucket                  TEXT,
            geography_scope                   TEXT,
            occupation_code                   TEXT,
            occupation_label                  TEXT,
            seniority_label                   TEXT,
            source_snapshot_json              TEXT NOT NULL DEFAULT '[]',
            factor_reasons_json               TEXT NOT NULL DEFAULT '[]',
            selected_evidence_json            TEXT NOT NULL DEFAULT '[]',
            insufficient_reasons_json         TEXT NOT NULL DEFAULT '[]',
            unsupported_reasons_json          TEXT NOT NULL DEFAULT '[]',
            source_unavailable_reasons_json   TEXT NOT NULL DEFAULT '[]',
            warnings_json                     TEXT NOT NULL DEFAULT '[]',
            estimator_version                 TEXT NOT NULL,
            estimated_at                      TEXT NOT NULL,
            company_name                      TEXT,
            normalized_company                TEXT,
            role_title                        TEXT,
            normalized_role                   TEXT,
            company_tier                      TEXT NOT NULL DEFAULT 'unknown' CHECK (
                company_tier IN ('tier_1_local', 'tier_2_ambitious', 'tier_3_top_of_market', 'unknown')
            ),
            match_scope                       TEXT NOT NULL DEFAULT 'none' CHECK (
                match_scope IN (
                    'exact_company_role',
                    'same_location_role_fallback',
                    'company_adjacent_role',
                    'tier_role_fallback',
                    'market_baseline_fallback',
                    'none'
                )
            ),
            PRIMARY KEY (tenant_id, job_url),
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        )
        """
    )
    if rebuild_table is not None:
        old_cols = {row[1] for row in conn.execute(f"PRAGMA table_info({rebuild_table})").fetchall()}
        new_cols = [row[1] for row in conn.execute("PRAGMA table_info(job_market_compensation_estimates)").fetchall()]
        copied_cols = [col for col in new_cols if col in old_cols]
        if copied_cols:
            col_sql = ", ".join(copied_cols)
            conn.execute(
                f"INSERT OR REPLACE INTO job_market_compensation_estimates ({col_sql}) SELECT {col_sql} FROM {rebuild_table}"
            )
        conn.execute(f"DROP TABLE IF EXISTS {rebuild_table}")
    existing = {row[1] for row in conn.execute("PRAGMA table_info(job_market_compensation_estimates)").fetchall()}
    added = []
    for col, dtype in {
        "confidence_interval_minimum_amount": "INTEGER",
        "confidence_interval_maximum_amount": "INTEGER",
        "selected_evidence_json": "TEXT NOT NULL DEFAULT '[]'",
        "company_name": "TEXT",
        "normalized_company": "TEXT",
        "role_title": "TEXT",
        "normalized_role": "TEXT",
        "company_tier": "TEXT NOT NULL DEFAULT 'unknown'",
        "match_scope": "TEXT NOT NULL DEFAULT 'none'",
    }.items():
        if col not in existing:
            conn.execute(f"ALTER TABLE job_market_compensation_estimates ADD COLUMN {col} {dtype}")
            added.append(col)
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_market_compensation_state
        ON job_market_compensation_estimates (tenant_id, estimate_state)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_market_compensation_company_role
        ON job_market_compensation_estimates (tenant_id, normalized_company, normalized_role)
        """
    )
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
    # Forward-migrate: add version column if missing (existing databases)
    existing_cols = {row[1] for row in conn.execute("PRAGMA table_info(job_stage_states)").fetchall()}
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
    # backfill fires once for any pre-DDD job that has zero stage rows
    # AND legacy column data; after it runs, those jobs look identical
    # to jobs created through the post-DDD pipeline.
    _backfill_legacy_stage_states(conn)
    from jobctrl.state import reconcile_dependency_blockers

    reconcile_dependency_blockers(conn)
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
    _ensure_candidate_profile_columns(conn)
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


_PROFILE_COLUMN_MIGRATIONS: dict[str, str] = {
    "experience_target_track": "TEXT NOT NULL DEFAULT ''",
    "experience_target_seniority_floor": "TEXT NOT NULL DEFAULT ''",
    "experience_target_functions": "TEXT NOT NULL DEFAULT ''",
    "experience_target_specializations": "TEXT NOT NULL DEFAULT ''",
    "experience_target_locations": "TEXT NOT NULL DEFAULT ''",
    "experience_target_work_models": "TEXT NOT NULL DEFAULT ''",
    "tailoring_claim_mode": "TEXT NOT NULL DEFAULT 'evidence_reframing'",
    "tailoring_auto_approvable_claim_modes_json": "TEXT NOT NULL DEFAULT '[\"verified_only\",\"evidence_reframing\"]'",
    "tailoring_allow_adjacent_achievement_drafts": "INTEGER NOT NULL DEFAULT 0",
    "revision_min_fit_score": "INTEGER NOT NULL DEFAULT 8",
    "revision_must_have_coverage": "REAL NOT NULL DEFAULT 0.85",
    "revision_max_attempts": "INTEGER NOT NULL DEFAULT 1",
}


def _ensure_candidate_profile_columns(conn: sqlite3.Connection) -> None:
    existing_cols = {row[1] for row in conn.execute("PRAGMA table_info(candidate_profiles)").fetchall()}
    for column, definition in _PROFILE_COLUMN_MIGRATIONS.items():
        if column not in existing_cols:
            conn.execute(f"ALTER TABLE candidate_profiles ADD COLUMN {column} {definition}")


def _backfill_legacy_stage_states(conn: sqlite3.Connection) -> None:
    """Insert ``job_stage_states`` rows derived from legacy ``jobs`` columns.

    Idempotent.  Only inserts rows for ``(job_url, stage)`` pairs that do
    not already exist — so jobs with explicit per-stage rows from the
    post-DDD pipeline are untouched.  The backfill mirrors the legacy
    derivation that used to live in ``read-model.ts::deriveLegacyStates``
    and ``state.derive_legacy_stage_states``:

    * discover  — succeeded if the job exists at all
    * enrich    — succeeded if ``full_description`` / ``detail_scraped_at`` set,
                  failed if ``detail_error`` set, otherwise pending
    * score     — succeeded if ``fit_score`` set, otherwise pending (or
                  blocked if enrich has not completed)
    * tailor    — succeeded if ``tailored_resume_path`` set, otherwise
                  pending (or blocked / exhausted by upstream + attempts)
    * cover     — succeeded if ``cover_letter_path`` set, otherwise pending
    * apply     — succeeded if ``applied_at`` set or ``apply_status='applied'``,
                  failed if ``apply_error`` set, otherwise pending / blocked

    The backfill skips jobs that ALREADY have any ``job_stage_states``
    rows — those came from the post-DDD pipeline and the per-aggregate
    repositories own their canonical state.
    """
    # Find legacy jobs (any row in ``jobs``) that have NO existing stage
    # rows.  This is the universe to backfill.
    legacy_jobs = conn.execute(
        """
        SELECT j.url, j.discovered_at, j.full_description, j.detail_scraped_at,
               j.detail_error, j.fit_score, j.scored_at,
               j.tailored_resume_path, j.tailored_at, j.tailor_attempts,
               j.cover_letter_path, j.cover_letter_at, j.cover_attempts,
               j.applied_at, j.apply_status, j.apply_error
        FROM jobs j
        LEFT JOIN job_stage_states jss ON jss.job_url = j.url
        GROUP BY j.url
        HAVING COUNT(jss.stage) = 0
        """
    ).fetchall()
    if not legacy_jobs:
        return

    now = datetime.now(timezone.utc).isoformat()
    max_attempts = {"discover": 1, "enrich": 3, "score": 3, "tailor": 5, "cover": 5, "apply": 3}

    def _insert(
        job_url: str,
        stage: str,
        state: str,
        *,
        attempt_count: int = 0,
        error_code: str | None = None,
        error_message: str | None = None,
        started_at: str | None = None,
        finished_at: str | None = None,
    ) -> None:
        conn.execute(
            """
            INSERT OR IGNORE INTO job_stage_states (
                job_url, stage, state, attempt_count, max_attempts,
                started_at, updated_at, finished_at, duration_ms,
                error_code, error_message, retryable, blocked_by_json,
                next_action, metadata_json, version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, 0)
            """,
            (
                job_url,
                stage,
                state,
                attempt_count,
                max_attempts.get(stage),
                started_at,
                now,
                finished_at,
                error_code,
                error_message,
                0 if state == "blocked" else 1,
            ),
        )

    for row in legacy_jobs:
        url = row["url"] if isinstance(row, sqlite3.Row) else row[0]
        if not url:
            continue
        discovered_at = row["discovered_at"] if isinstance(row, sqlite3.Row) else row[1]
        full_description = row["full_description"] if isinstance(row, sqlite3.Row) else row[2]
        detail_scraped_at = row["detail_scraped_at"] if isinstance(row, sqlite3.Row) else row[3]
        detail_error = row["detail_error"] if isinstance(row, sqlite3.Row) else row[4]
        fit_score = row["fit_score"] if isinstance(row, sqlite3.Row) else row[5]
        tailored_resume_path = row["tailored_resume_path"] if isinstance(row, sqlite3.Row) else row[7]
        tailor_attempts = row["tailor_attempts"] if isinstance(row, sqlite3.Row) else row[9]
        cover_letter_path = row["cover_letter_path"] if isinstance(row, sqlite3.Row) else row[10]
        cover_attempts = row["cover_attempts"] if isinstance(row, sqlite3.Row) else row[12]
        applied_at = row["applied_at"] if isinstance(row, sqlite3.Row) else row[13]
        apply_status = row["apply_status"] if isinstance(row, sqlite3.Row) else row[14]
        apply_error = row["apply_error"] if isinstance(row, sqlite3.Row) else row[15]

        # discover — always succeeded if the row exists.
        _insert(url, "discover", "succeeded", attempt_count=1, finished_at=discovered_at or now)

        # enrich
        has_enrichment = bool(full_description) or bool(detail_scraped_at)
        if detail_error and not has_enrichment:
            _insert(url, "enrich", "failed", error_code="LEGACY_DETAIL_ERROR", error_message=str(detail_error))
            enrich_succeeded = False
        elif has_enrichment:
            _insert(url, "enrich", "succeeded", finished_at=detail_scraped_at or now)
            enrich_succeeded = True
        else:
            _insert(url, "enrich", "pending")
            enrich_succeeded = False

        # score
        has_score = fit_score is not None
        if has_score:
            _insert(url, "score", "succeeded", finished_at=now)
            score_succeeded = True
        elif not enrich_succeeded:
            _insert(url, "score", "blocked", error_code="BLOCKED", error_message="Enrichment has not completed.")
            score_succeeded = False
        else:
            _insert(url, "score", "pending")
            score_succeeded = False

        # tailor
        has_tailor = bool(tailored_resume_path)
        attempts = int(tailor_attempts or 0)
        if has_tailor:
            _insert(url, "tailor", "succeeded", attempt_count=attempts, finished_at=now)
            tailor_succeeded = True
        elif not score_succeeded:
            _insert(url, "tailor", "blocked", error_code="BLOCKED", error_message="score has not completed.")
            tailor_succeeded = False
        elif attempts >= max_attempts["tailor"]:
            _insert(
                url,
                "tailor",
                "exhausted",
                attempt_count=attempts,
                error_code="EXHAUSTED",
                error_message="tailor attempts exhausted.",
            )
            tailor_succeeded = False
        else:
            _insert(url, "tailor", "pending", attempt_count=attempts)
            tailor_succeeded = False

        # cover
        has_cover = bool(cover_letter_path)
        c_attempts = int(cover_attempts or 0)
        if has_cover:
            _insert(url, "cover", "succeeded", attempt_count=c_attempts, finished_at=now)
        elif not tailor_succeeded:
            _insert(url, "cover", "blocked", error_code="BLOCKED", error_message="tailor has not completed.")
        elif c_attempts >= max_attempts["cover"]:
            _insert(
                url,
                "cover",
                "exhausted",
                attempt_count=c_attempts,
                error_code="EXHAUSTED",
                error_message="cover attempts exhausted.",
            )
        else:
            _insert(url, "cover", "pending", attempt_count=c_attempts)

        # apply
        if applied_at or (apply_status and str(apply_status).lower() == "applied"):
            _insert(url, "apply", "succeeded", finished_at=applied_at or now)
        elif apply_status and str(apply_status).lower() == "in_progress":
            _insert(url, "apply", "running")
        elif apply_error:
            _insert(url, "apply", "failed", error_code="LEGACY_APPLY_ERROR", error_message=str(apply_error))
        elif not tailor_succeeded:
            _insert(url, "apply", "blocked", error_code="BLOCKED", error_message="Materials are not ready.")
        else:
            _insert(url, "apply", "pending")


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

    import hashlib

    theme = {
        "pageSize": "a4",
        "fontFamily": "sans",
        "fontScale": 1,
        "density": "balanced",
        "marginMm": {"top": 16.5, "right": 17.5, "bottom": 18, "left": 17.5},
        "headerLayout": "centered",
        "sectionHeadingStyle": "rule",
        "alignment": "justified",
        "bulletSpacing": "normal",
        "accentColor": "#111111",
        "sectionOrder": ["summary", "experience", "education", "skills"],
        "hiddenSections": [],
    }
    layout: dict[str, object] = {}
    content_hash = hashlib.sha256(
        json.dumps([theme, layout], separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        """
        INSERT OR IGNORE INTO resume_templates (
            tenant_id, template_id, display_name, status, built_in, created_at, updated_at
        ) VALUES ('local', 'built_in:modern-html', 'Modern HTML', 'active', 1, ?, ?)
        """,
        (now, now),
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO resume_template_versions (
            tenant_id, version_id, template_id, version_number, display_name, status,
            theme_json, layout_json, content_hash, created_at
        ) VALUES ('local', 'built_in:modern-html:v1', 'built_in:modern-html', 1,
                  'Modern HTML', 'active', ?, ?, ?, ?)
        """,
        (
            json.dumps(theme, sort_keys=True),
            json.dumps(layout, sort_keys=True),
            content_hash,
            now,
        ),
    )
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
    # observation row using its legacy URL / site / discovered_at.
    backfilled = conn.execute("SELECT COUNT(*) FROM job_source_observations").fetchone()[0]
    if backfilled == 0:
        legacy_jobs = conn.execute("SELECT url, site, strategy, discovered_at FROM jobs").fetchall()
        if legacy_jobs:
            now = datetime.now(timezone.utc).isoformat()
            for row in legacy_jobs:
                _backfill_one_observation_row(conn, row, now)

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


def _backfill_one_observation_row(
    conn: sqlite3.Connection,
    row: sqlite3.Row,
    now: str,
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

    url = row["url"] if isinstance(row, sqlite3.Row) else row[0]
    site = (row["site"] if isinstance(row, sqlite3.Row) else row[1]) or "unknown"
    discovered_at = (row["discovered_at"] if isinstance(row, sqlite3.Row) else row[3]) or now
    if not url:
        return
    source_native_id = url  # fall back to the URL when we have nothing better
    source_observation_id = f"backfill:{url}"
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
# job_enrichments read fragments — used by every selector / stat that
# previously read bare ``jobs.full_description`` / ``jobs.application_url``
# / ``jobs.detail_scraped_at`` / ``jobs.detail_error``. After Phase 7 the
# canonical enrichment fields live in ``job_enrichments``; the legacy
# ``jobs.*`` columns stay as a read-only fallback for un-backfilled rows.
# Use these COALESCE expressions everywhere the old code read bare columns
# so the worker queue selectors see new repository writes immediately and
# don't starve.
# ---------------------------------------------------------------------------

_ENRICHMENT_JOIN: str = (
    "LEFT JOIN job_enrichments je ON je.job_url = jobs.url "
    "LEFT JOIN job_stage_states jss_enrich "
    "ON jss_enrich.job_url = jobs.url AND jss_enrich.stage = 'enrich'"
)

_EFFECTIVE_FULL_DESCRIPTION: str = "COALESCE(je.full_description, jobs.full_description)"
_EFFECTIVE_APPLICATION_URL: str = "COALESCE(je.application_url, jobs.application_url)"
_EFFECTIVE_APPLY_TARGET_URL: str = (
    f"COALESCE(NULLIF({_EFFECTIVE_APPLICATION_URL}, ''), jobs.url)"
)
_EFFECTIVE_DETAIL_SCRAPED_AT: str = "COALESCE(je.enriched_at, jobs.detail_scraped_at)"
# Per §7.1 the canonical "this job has been enriched" predicate is the
# aggregate's terminal status; un-backfilled rows fall back to the legacy
# detail_scraped_at column.
_ENRICHMENT_DONE: str = "(je.current_status = 'enriched' OR jobs.detail_scraped_at IS NOT NULL)"
# Phase 7 (S-26 round-1 review M3): the aggregate status is the primary
# enrichment signal, but the live local DB can contain historical jobs with
# legacy description columns and a canonical ``job_stage_states.enrich =
# succeeded`` row before a ``job_enrichments`` aggregate exists. Those rows
# must not be re-picked by runners, because the state machine correctly
# rejects succeeded -> running. A reset clears the stage row back to pending,
# so retries still work even when legacy detail columns remain populated.
_ENRICHMENT_PENDING: str = (
    "(je.job_url IS NULL OR je.current_status = 'pending') "
    "AND COALESCE(jss_enrich.state, CASE WHEN jobs.detail_scraped_at IS NOT NULL THEN 'succeeded' ELSE 'pending' END) = 'pending'"
)

# Closed/removed posting states are Enrichment-owned facts, not user
# tombstones. Work queues treat them as non-actionable while leaving the
# rows available for the Jobs > closed tab and future rediscovery.
_CLOSED_ACTIVE_STATES_SQL = "'closed', 'expired', 'removed', 'location_incompatible'"
_ACTIVE_STATE_JOIN: str = (
    "LEFT JOIN posting_snapshot_sets pss "
    "ON pss.tenant_id = 'local' AND pss.job_url = jobs.url"
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
# job_materials read fragments — used by the queue selectors that
# previously read bare ``jobs.tailored_resume_path`` / ``cover_letter_path``.
# After Phase 6 the canonical artifact paths live in ``job_materials_artifacts``
# (latest generation per ``job_url``); the legacy ``jobs.*_path`` columns
# stay as read-only fallback for historical rows that have no canonical
# materials row. Once ``job_materials`` exists, approved artifacts are the
# only active paths; suppressed artifacts must not fall through to legacy
# columns left populated by the backfill.
# ---------------------------------------------------------------------------

# LEFT JOIN that surfaces the latest generation's tailored-resume and
# cover-letter artifact paths under fixed aliases.
_LATEST_MATERIALS_JOIN: str = (
    "LEFT JOIN ("
    "SELECT history.job_url AS jm_job_url, latest.max_generation AS jm_generation, "
    "m.status AS jm_status, "
    "tr.path AS jm_tailored_path, tr.created_at AS jm_tailored_at, "
    "cl.path AS jm_cover_path, cl.created_at AS jm_cover_at, "
    "rpdf.path AS jm_resume_pdf_path, rpdf.artifact_id AS jm_resume_pdf_artifact_id, "
    "cpdf.path AS jm_cover_pdf_path "
    "FROM (SELECT DISTINCT job_url FROM job_materials) history "
    "LEFT JOIN ("
    "SELECT job_url, MAX(generation) AS max_generation "
    "FROM job_materials_artifacts "
    "WHERE status = 'approved' "
    "AND artifact_type IN ('tailored_resume', 'cover_letter', 'resume_pdf', 'cover_letter_pdf') "
    "GROUP BY job_url"
    ") latest ON latest.job_url = history.job_url "
    "LEFT JOIN job_materials m "
    "ON m.job_url = history.job_url AND m.generation = latest.max_generation "
    "LEFT JOIN job_materials_artifacts tr "
    "ON tr.job_url = history.job_url AND tr.generation = latest.max_generation "
    "AND tr.artifact_type = 'tailored_resume' AND tr.status = 'approved' "
    "LEFT JOIN job_materials_artifacts cl "
    "ON cl.job_url = history.job_url AND cl.generation = latest.max_generation "
    "AND cl.artifact_type = 'cover_letter' AND cl.status = 'approved' "
    "LEFT JOIN job_materials_artifacts rpdf "
    "ON rpdf.job_url = history.job_url AND rpdf.generation = latest.max_generation "
    "AND rpdf.artifact_type = 'resume_pdf' AND rpdf.status = 'approved' "
    "LEFT JOIN job_materials_artifacts cpdf "
    "ON cpdf.job_url = history.job_url AND cpdf.generation = latest.max_generation "
    "AND cpdf.artifact_type = 'cover_letter_pdf' AND cpdf.status = 'approved'"
    ") jm ON jm.jm_job_url = jobs.url"
)

_EFFECTIVE_TAILOR_PATH: str = (
    "CASE WHEN jm.jm_job_url IS NOT NULL THEN jm.jm_tailored_path "
    "ELSE jobs.tailored_resume_path END"
)
_EFFECTIVE_COVER_PATH: str = (
    "CASE WHEN jm.jm_job_url IS NOT NULL THEN jm.jm_cover_path "
    "ELSE jobs.cover_letter_path END"
)
_READY_TAILORED_RESUME_WITH_PDF: str = (
    "((jm.jm_job_url IS NOT NULL "
    "AND jm.jm_tailored_path IS NOT NULL AND jm.jm_tailored_path != '' "
    "AND jm.jm_resume_pdf_path IS NOT NULL AND jm.jm_resume_pdf_path != '') "
    "OR (jm.jm_job_url IS NULL "
    "AND jobs.tailored_resume_path IS NOT NULL AND jobs.tailored_resume_path != ''))"
)


# ---------------------------------------------------------------------------
# job_stage_states attempt-counter read fragments — round-2 review H1.
# After Phase 6 the new tailor / cover use cases never bump
# ``jobs.tailor_attempts`` / ``jobs.cover_attempts``; the canonical attempt
# counter advances on ``job_stage_states.attempt_count``. The bare-column
# ``< 5`` predicate the queue selectors used would let exhausted jobs back
# in indefinitely. ``_LATEST_STAGE_ATTEMPTS_JOIN`` surfaces the per-stage
# attempt count + state so selectors can:
#   * exclude tailor/cover jobs whose stage state is ``exhausted``
#   * fall back to the legacy ``jobs.tailor_attempts`` / ``cover_attempts``
#     for un-migrated rows.
# ---------------------------------------------------------------------------

_LATEST_STAGE_ATTEMPTS_JOIN: str = (
    "LEFT JOIN ("
    "SELECT job_url AS jss_t_job_url, attempt_count AS jss_t_attempts, state AS jss_t_state "
    "FROM job_stage_states WHERE stage = 'tailor'"
    ") jss_t ON jss_t.jss_t_job_url = jobs.url "
    "LEFT JOIN ("
    "SELECT job_url AS jss_c_job_url, attempt_count AS jss_c_attempts, state AS jss_c_state "
    "FROM job_stage_states WHERE stage = 'cover'"
    ") jss_c ON jss_c.jss_c_job_url = jobs.url"
)

# COALESCE picks the canonical (job_stage_states) counter first, falling
# back to the legacy column for un-migrated rows. ``state = 'exhausted'``
# is the new exhaustion signal — tested separately below.
_EFFECTIVE_TAILOR_ATTEMPTS: str = "COALESCE(jss_t.jss_t_attempts, jobs.tailor_attempts, 0)"
_EFFECTIVE_COVER_ATTEMPTS: str = "COALESCE(jss_c.jss_c_attempts, jobs.cover_attempts, 0)"
_TAILOR_NOT_EXHAUSTED: str = "(jss_t.jss_t_state IS NULL OR jss_t.jss_t_state != 'exhausted')"
_COVER_NOT_EXHAUSTED: str = "(jss_c.jss_c_state IS NULL OR jss_c.jss_c_state != 'exhausted')"


# Stale-score guard for downstream stages. Legacy rows can have a pending
# score-stage row while their usable score still lives only in
# ``jobs.fit_score``; those remain eligible unless explicitly stale or
# carrying an unresolved marker. Once the usable score comes from
# ``job_scores``, downstream work requires a succeeded score-stage row.
_SCORE_DOWNSTREAM_STATE_JOIN: str = (
    "LEFT JOIN ("
    "SELECT job_url AS jss_s_job_url, state AS jss_s_state, "
    "attempt_count AS jss_s_attempts "
    "FROM job_stage_states WHERE stage = 'score'"
    ") jss_s ON jss_s.jss_s_job_url = jobs.url "
    "LEFT JOIN ("
    "SELECT DISTINCT job_url AS jss_stale_job_url "
    "FROM job_score_staleness WHERE resolved = 0"
    ") jss_stale ON jss_stale.jss_stale_job_url = jobs.url"
)
_SCORE_CURRENT_FOR_DOWNSTREAM: str = (
    "(jss_stale.jss_stale_job_url IS NULL "
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
# job_scores read fragments — used by every selector / stat that previously
# read bare ``jobs.fit_score``. After Phase 5 the canonical fit score lives
# in ``job_scores`` (latest version per ``job_url``); the legacy
# ``jobs.fit_score`` column stays as a read-only fallback for historical
# rows that were never re-scored. ``_EFFECTIVE_FIT_SCORE`` is the COALESCE
# expression every WHERE / ORDER BY / aggregate query should use instead of
# bare ``fit_score`` so the worker queue selectors see new scores
# immediately and don't re-pick already-scored jobs forever (round-1
# review B1).
# ---------------------------------------------------------------------------

_LATEST_SCORE_JOIN: str = (
    "LEFT JOIN ("
    "SELECT s.job_url AS js_job_url, s.fit_score AS js_fit_score, "
    "CASE WHEN json_valid(s.breakdown_json) "
    "THEN LOWER(COALESCE(CAST(json_extract(s.breakdown_json, '$.eligibility.status') AS TEXT), '')) "
    "ELSE '' END AS js_eligibility_status, "
    "CASE WHEN json_valid(s.breakdown_json) "
    "THEN COALESCE("
    "json_array_length(s.breakdown_json, '$.eligibility.hard_blockers'), "
    "json_array_length(s.breakdown_json, '$.eligibility.hardBlockers'), "
    "json_array_length(s.breakdown_json, '$.eligibility.blockers'), "
    "0) ELSE 0 END AS js_hard_blocker_count "
    "FROM job_scores s "
    "INNER JOIN ("
    "SELECT job_url, MAX(version) AS max_version FROM job_scores GROUP BY job_url"
    ") latest ON latest.job_url = s.job_url AND latest.max_version = s.version"
    ") js ON js.js_job_url = jobs.url"
)

_EFFECTIVE_FIT_SCORE: str = "COALESCE(js.js_fit_score, jobs.fit_score)"
_SCORE_ELIGIBLE_FOR_DOWNSTREAM: str = (
    "(COALESCE(js.js_eligibility_status, '') != 'blocked' AND COALESCE(js.js_hard_blocker_count, 0) = 0)"
)


# ---------------------------------------------------------------------------
# Apply read-side (PR 4 of the Temporal stack). The bespoke
# ``apply_runs`` table is gone; ``apply_run_projections`` (built from
# ``job_events`` by the projection builder) is the canonical apply
# lifecycle row. This LEFT JOIN promotes the latest projection row's
# status / finished_at into the legacy column slots so queue selectors
# (``pending_apply``, ``applied``) and ``get_stats`` see new writes
# without re-deriving from events at every read site.
# ---------------------------------------------------------------------------

# Tie-break by run_id when two apply runs share the same ``started_at``.
_LATEST_APPLY_RUN_JOIN: str = (
    "LEFT JOIN ("
    "SELECT ar.job_id AS ar_job_url, ar.status AS ar_status, "
    "ar.result AS ar_result, ar.finished_at AS ar_finished_at, "
    "ar.started_at AS ar_started_at, ar.run_id AS ar_run_id "
    "FROM apply_run_projections ar "
    "WHERE ar.run_id = ("
    "SELECT run_id FROM apply_run_projections ar_inner "
    "WHERE ar_inner.job_id = ar.job_id "
    "ORDER BY ar_inner.started_at DESC, ar_inner.run_id DESC "
    "LIMIT 1"
    ")"
    ") ar ON ar.ar_job_url = jobs.url"
)

# Applied = any apply run with status='succeeded' for the job (we
# COALESCE with the legacy column so historical rows stay visible).
_EFFECTIVE_APPLIED_AT: str = "CASE WHEN ar.ar_status = 'succeeded' THEN ar.ar_finished_at ELSE jobs.applied_at END"

# Apply status string suitable for read-model consumption — collapses
# ``starting`` / ``in_progress`` into the historical ``in_progress``
# label so callers needn't relearn the labels.
_EFFECTIVE_APPLY_STATUS: str = (
    "COALESCE("
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
    "ELSE NULL END, "
    "jobs.apply_status)"
)


_FEEDBACK_ORDERED_STAGES = frozenset({"scored", "pending_tailor", "pending_cover", "pending_apply"})
LOW_FIT_TAILORING_MAX_SCORE = 5
MIN_TAILORING_FIT_SCORE = LOW_FIT_TAILORING_MAX_SCORE + 1


def effective_tailoring_min_score(min_score: int | None = None) -> int:
    """Return the default-safe floor for material-generation eligibility."""
    if min_score is None:
        return 7
    return max(MIN_TAILORING_FIT_SCORE, int(min_score))


def _order_rows_by_feedback(
    conn: sqlite3.Connection,
    rows: list[sqlite3.Row],
) -> list[sqlite3.Row]:
    """Order score-backed selector rows using local feedback signals."""
    if len(rows) < 2:
        return rows

    row_keys = set(rows[0].keys())
    base_scores: dict[str, float] = {}
    for row in rows:
        raw_score = row["js_fit_score"] if "js_fit_score" in row_keys else None
        if raw_score is None:
            raw_score = row["fit_score"] if "fit_score" in row_keys else None
        if raw_score is None:
            continue
        try:
            base_scores[str(row["url"])] = float(raw_score)
        except (TypeError, ValueError):
            continue

    if len(base_scores) < 2:
        return rows

    from jobctrl.infrastructure.scoring import collect_feedback_signals, rank_jobs_with_feedback

    signals = collect_feedback_signals(conn)
    if not signals:
        return rows

    ranked = rank_jobs_with_feedback(base_scores, signals)
    rank_index = {item.job_id: index for index, item in enumerate(ranked)}
    original_index = {str(row["url"]): index for index, row in enumerate(rows)}
    fallback_index = len(rank_index)
    return sorted(
        rows,
        key=lambda row: (
            rank_index.get(str(row["url"]), fallback_index),
            original_index[str(row["url"])],
        ),
    )


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

    stats: dict = {}

    # Total jobs
    stats["total"] = conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]

    # By site breakdown
    rows = conn.execute("SELECT site, COUNT(*) as cnt FROM jobs GROUP BY site ORDER BY cnt DESC").fetchall()
    stats["by_site"] = [(row[0], row[1]) for row in rows]

    # Enrichment stage — Phase 7 (S-26): read through the
    # ``job_enrichments`` join so dashboard counts reflect new
    # JobEnrichment writes (jobs.full_description / jobs.application_url
    # are NULL on the new path).
    stats["pending_detail"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_ENRICHMENT_JOIN} WHERE {_ENRICHMENT_PENDING}"
    ).fetchone()[0]

    stats["with_description"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_ENRICHMENT_JOIN} WHERE {_EFFECTIVE_FULL_DESCRIPTION} IS NOT NULL"
    ).fetchone()[0]

    stats["detail_errors"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_ENRICHMENT_JOIN} "
        f"WHERE je.current_status = 'failed' OR jobs.detail_error IS NOT NULL"
    ).fetchone()[0]

    # Scoring stage — round-1 review B2: read through the same job_scores
    # LEFT JOIN that the worker queue selectors use, so dashboard stats
    # reflect new scores written through ScoreRepository (jobs.fit_score is
    # now NULL on the new path).
    stats["scored"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_LATEST_SCORE_JOIN} WHERE {_EFFECTIVE_FIT_SCORE} IS NOT NULL"
    ).fetchone()[0]

    stats["unscored"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_LATEST_SCORE_JOIN} {_ENRICHMENT_JOIN} "
        f"WHERE {_EFFECTIVE_FULL_DESCRIPTION} IS NOT NULL "
        f"AND {_EFFECTIVE_FIT_SCORE} IS NULL"
    ).fetchone()[0]

    # Score distribution — group by the effective score so legacy and new
    # rows fold into the same buckets.
    dist_rows = conn.execute(
        f"SELECT {_EFFECTIVE_FIT_SCORE} AS effective_score, COUNT(*) AS cnt "
        f"FROM jobs {_LATEST_SCORE_JOIN} "
        f"WHERE {_EFFECTIVE_FIT_SCORE} IS NOT NULL "
        f"GROUP BY effective_score ORDER BY effective_score DESC"
    ).fetchall()
    stats["score_distribution"] = [(row[0], row[1]) for row in dist_rows]

    # Tailoring + cover letter stages — round-2 review B2: read through the
    # same materials + stage-attempts joins the worker queue selectors use,
    # so dashboard counts reflect new MaterialsSet writes (jobs.*_path is
    # NULL on the new path) AND honour the new attempt-counter / exhaustion
    # signal that lives in ``job_stage_states``. Without these joins the
    # dashboard would freeze at the backfill snapshot value.
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

    # Application stage (PR 4) — read through the ``apply_run_projections``
    # join so dashboard counts reflect lifecycle events (jobs.applied_at /
    # apply_status / apply_error are NULL on the new write path).
    stats["applied"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_LATEST_APPLY_RUN_JOIN} {_ACTIVE_STATE_JOIN} "
        f"WHERE {_EFFECTIVE_APPLIED_AT} IS NOT NULL "
        f"AND {_NOT_CLOSED_ACTIVE_STATE}"
    ).fetchone()[0]

    stats["apply_errors"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_LATEST_APPLY_RUN_JOIN} {_ACTIVE_STATE_JOIN} "
        f"WHERE (ar.ar_status IN ('failed', 'captcha', 'login_issue', 'expired') "
        f"OR jobs.apply_error IS NOT NULL) "
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
        "WHERE jss_active.job_url = jobs.url "
        "AND jss_active.stage = 'apply' "
        "AND jss_active.state IN ('running', 'succeeded')"
        ")",
        "COALESCE(("
        "SELECT jss_a.attempt_count FROM job_stage_states jss_a "
        "WHERE jss_a.job_url = jobs.url AND jss_a.stage = 'apply' LIMIT 1"
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
    if je_full is not None:
        record["full_description"] = je_full
    if je_app is not None:
        record["application_url"] = je_app
    if je_at is not None:
        record["detail_scraped_at"] = je_at
    # PR 4 of the Temporal stack: promote ``apply_run_projections``
    # columns into the legacy column slots.
    record.pop("ar_status", None)
    record.pop("ar_finished_at", None)
    ar_applied = record.pop("effective_applied_at", None)
    ar_status = record.pop("effective_apply_status", None)
    ar_run_id = record.pop("ar_run_id", None)
    if ar_applied is not None:
        record["applied_at"] = ar_applied
    if ar_status is not None:
        record["apply_status"] = ar_status
    if ar_run_id is not None:
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
    if stage in ("pending_tailor", "pending_cover"):
        min_score = effective_tailoring_min_score(min_score)

    # Round-1 review B1: every predicate that historically read bare
    # ``fit_score`` now reads through ``_EFFECTIVE_FIT_SCORE`` (COALESCE
    # over the latest job_scores row + legacy column). New scores written
    # via ``ScoreRepository.save`` leave ``jobs.fit_score`` NULL, so without
    # this LEFT JOIN ``pending_score`` would loop forever and
    # ``pending_tailor`` / ``pending_cover`` would starve.
    #
    # Phase 6 (S-20) extends the same pattern to the Materials Generation
    # context: ``_EFFECTIVE_TAILOR_PATH`` / ``_EFFECTIVE_COVER_PATH`` read
    # through the latest ``job_materials_artifacts`` generation, with the
    # legacy ``jobs.tailored_resume_path`` / ``jobs.cover_letter_path``
    # columns as a read-only fallback for un-backfilled rows. New tailor
    # / cover writes go ONLY to ``job_materials`` (no-strangler) so this
    # join is what keeps the pipeline observable.
    # Round-2 review H1: drop the bare ``tailor_attempts < 5`` /
    # ``cover_attempts < 5`` predicates. New code never bumps those columns;
    # the canonical attempt + exhaustion signals live in
    # ``job_stage_states`` (state='exhausted' when the runner gives up).
    # We exclude exhausted jobs via ``_TAILOR_NOT_EXHAUSTED`` /
    # ``_COVER_NOT_EXHAUSTED`` and fold the legacy ``tailor_attempts`` /
    # ``cover_attempts`` columns through ``_EFFECTIVE_*_ATTEMPTS`` so
    # un-migrated rows that never got a ``job_stage_states`` row still
    # honour the legacy ≥ 5 cap.
    # Phase 7 (S-26): every predicate that historically read bare
    # ``full_description`` / ``application_url`` / ``detail_scraped_at``
    # / ``detail_error`` now reads through the ``_EFFECTIVE_*`` COALESCE
    # expressions backed by the ``job_enrichments`` table. New
    # enrichment writes target ``job_enrichments`` only (no-strangler);
    # without this join ``pending_score`` would loop forever (description
    # column stays NULL on the new path) and ``pending_detail`` would
    # double-pick already-enriched jobs.
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
        f"jm.jm_job_url AS jm_job_url, "
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
    feedback_ordered = stage in _FEEDBACK_ORDERED_STAGES
    if limit > 0 and not feedback_ordered:
        query += " LIMIT ?"
        params.append(limit)

    rows = conn.execute(query, params).fetchall()
    if feedback_ordered:
        rows = _order_rows_by_feedback(conn, rows)
        if limit > 0:
            rows = rows[:limit]

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
        if js_value is not None:
            record["fit_score"] = js_value
        jm_job_url = record.pop("jm_job_url", None)
        jm_tailored = record.pop("jm_tailored_path", None)
        jm_tailored_at = record.pop("jm_tailored_at", None)
        jm_cover = record.pop("jm_cover_path", None)
        jm_cover_at = record.pop("jm_cover_at", None)
        if jm_job_url is not None:
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
        if je_full is not None:
            record["full_description"] = je_full
        if je_app is not None:
            record["application_url"] = je_app
        if je_at is not None:
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
        if ar_applied is not None:
            record["applied_at"] = ar_applied
        if ar_status is not None:
            record["apply_status"] = ar_status
        if ar_run_id is not None:
            record["apply_task_id"] = ar_run_id
        out.append(record)
    return out
