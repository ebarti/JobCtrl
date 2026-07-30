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
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

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
# v4 (JobStreaming durability): immutable search units, fenced provider
# checkpoints, and idempotent accepted-job receipts.
# v5 (JobStreaming consumption ordering): the provider checkpoint revision that
# must be acknowledged before a requested cursor reset can be applied, plus
# replay-idempotent receipts for caller-filtered provider results.
# v6 (repeat-application prevention): evidence-bound confirmations,
# one-attempt consumption, and immutable protection audit records.
# v7 (stable job identity foundation): additive opaque job UUIDs, the
# tenant-scoped posting-URL alias map, and insert/update guards.
# v8 (discovery identity references): source observations, canonical identity,
# and duplicate-link authorities reference ``(tenant_id, job_id)`` rather than
# storing a posting URL as aggregate identity.
# v9 (execution and search receipts): Discover execution membership and
# accepted JobStreaming receipts reference the same stable identity.
# v10 (preparation references): the legacy preparation work-item ledger
# references ``(tenant_id, job_id)`` while preserving its opaque historical
# idempotency keys for the later quiescent workflow cutover.
# v11 (enrichment references): JobEnrichment and PostingSnapshotSet authorities
# reference ``(tenant_id, job_id)``; embedded snapshot aggregate identity and
# duplicate-candidate references are upcast in the same transaction.
# v12 (scoring references): score history, staleness markers, and requirement-fit
# authorities reference ``(tenant_id, job_id)`` with dependent score versions
# remapped atomically when multiple historical URL aliases collapse.
# v13 (stage-state references): the canonical per-stage lifecycle row references
# ``(tenant_id, job_id)``. Alias collisions keep the most recently updated
# lifecycle fact while preserving monotonic attempt and optimistic-lock counts.
# v14 (artifact registry references): generic per-job artifact registrations
# reference ``(tenant_id, job_id)``. Alias collisions retain one current row per
# registry key using the same last-write-wins rule as runtime artifact upserts.
# v15 (materials references): generated-material generations, their artifact
# slots, PDF layout audit boxes, and bullet provenance reference the stable Job
# aggregate. Alias histories are deterministically interleaved and renumbered
# together so no generation or dependent audit row is discarded.
# v16 (employer-analysis references): canonical employer-analysis generations
# plus their per-model drafts and failures reference the stable Job aggregate.
# Identity collapse preserves and deterministically renumbers complete histories.
# v17 (resume-template references): the mutable per-job assignment and every
# render-only refresh attempt reference the tenant-scoped stable Job aggregate.
# v18 (interview-preparation references): complete preparation histories and
# their child audit rows reference the stable Job aggregate. Any immutable
# application-outcome link to a preparation generation is remapped alongside
# alias-history renumbering while its legacy URL key remains unchanged.
# v19 (compensation references): canonical posted compensation facts and market
# estimates reference the stable Job aggregate. Alias collisions keep the
# newest recorded fact/estimate with a deterministic survivor tie-break.
# v20 (application-review references): every append-only Apply Review decision
# references the tenant-scoped stable Job aggregate. URL aliases, including
# UUID-shaped posting URLs, are resolved URL-first without collapsing history.
# v21 (application-outcome references): every reviewed application outcome
# references the tenant-scoped stable Job aggregate. Append-only history and
# immutable links to Interview Preparation generations remain exact.
# v22 (application-feedback candidate references): linked email evidence and
# pending/decided outcome suggestions reference the same tenant-scoped stable
# Job aggregate while preserving their evidence and decision links.
# v23 (repeat-application references): evidence-bound override and audit
# ownership moves to stable target/prior JobIds without rewriting the immutable
# URL-shaped evidence snapshot or its fingerprint.
# v24 (contact and contact-research references): optional application links on
# Contact and ContactResearchTask move to tenant-scoped stable JobIds. Contact
# facts, research candidates, and the URL-shaped public/read-model boundary stay
# unchanged. Job deletion is restricted so the explicit permanent-delete path
# can detach employer-linked records instead of silently erasing them.
# v25 (outreach references): optional application links on OutreachThread move
# to tenant-scoped stable JobIds. Draft and user-attested send histories remain
# keyed by the thread aggregate, while URL-shaped public/read-model values are
# resolved at the adapter boundary. Job deletion is restricted so the explicit
# permanent-delete path can detach preserved outreach history or purge threads
# whose job-only Contact is removed.
SCHEMA_VERSION = 25


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


def _assert_schema_version_supported(
    conn: sqlite3.Connection,
    *,
    supported_version: int = SCHEMA_VERSION,
) -> int:
    """Refuse a database written by a newer build before schema writes.

    Databases created before this guard report ``user_version == 0`` and are
    eligible for migration. A database whose version is newer than this build
    fails closed with ``IncompatibleSchemaVersionError``. Version stamping is
    deliberately owned by the versioned migration after its DDL, backfill, and
    verification succeed; a failed migration therefore remains retryable at
    the prior version.
    """
    current = int(conn.execute("PRAGMA user_version").fetchone()[0])
    if current > supported_version:
        raise IncompatibleSchemaVersionError(
            f"database was written by a newer JobCtrl build "
            f"(schema version {current} > code schema version {supported_version}); "
            f"upgrade JobCtrl or restore a compatible backup ('jobctrl backup')."
        )
    return current


def _schema_migrations() -> tuple[
    tuple[int, Callable[[sqlite3.Connection], list[str]]],
    ...,
]:
    """Return the ordered schema migrations known to this build."""
    return (
        (7, ensure_stable_job_identity_v7),
        (8, ensure_discovery_identity_references_v8),
        (9, ensure_execution_search_references_v9),
        (10, ensure_preparation_references_v10),
        (11, ensure_enrichment_snapshot_references_v11),
        (12, ensure_scoring_references_v12),
        (13, ensure_stage_state_references_v13),
        (14, ensure_artifact_registry_references_v14),
        (15, ensure_materials_references_v15),
        (16, ensure_employer_analysis_references_v16),
        (17, ensure_resume_template_references_v17),
        (18, ensure_interview_prep_references_v18),
        (19, ensure_compensation_references_v19),
        (20, ensure_application_review_references_v20),
        (21, ensure_application_outcome_references_v21),
        (22, ensure_application_feedback_candidate_references_v22),
        (23, ensure_repeat_application_references_v23),
        (24, ensure_contact_research_references_v24),
        (25, ensure_outreach_references_v25),
    )


def _assert_schema_migration_path(current_version: int) -> None:
    """Fail before schema writes when this build cannot reach its own version."""
    reachable_version = current_version
    for target_version, _migration in _schema_migrations():
        if current_version < target_version <= SCHEMA_VERSION:
            reachable_version = target_version
    if reachable_version != SCHEMA_VERSION:
        raise RuntimeError(
            "JobCtrl has no schema migration path from "
            f"version {current_version} to {SCHEMA_VERSION}"
        )


def _run_schema_migrations(conn: sqlite3.Connection) -> int:
    """Run ordered migrations and require each one to stamp its own version."""
    current_version = _assert_schema_version_supported(conn)
    _assert_schema_migration_path(current_version)
    for target_version, migration in _schema_migrations():
        if current_version >= target_version:
            continue
        migration(conn)
        observed_version = int(conn.execute("PRAGMA user_version").fetchone()[0])
        if observed_version != target_version:
            raise RuntimeError(
                f"schema migration {target_version} did not stamp its version"
            )
        current_version = observed_version
    return current_version


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
    current_version = _assert_schema_version_supported(conn)
    _assert_schema_migration_path(current_version)
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
            tenant_id             TEXT NOT NULL DEFAULT 'local',
            job_id                TEXT,
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
    if current_version >= _APPLICATION_REVIEW_REFERENCE_SCHEMA_VERSION:
        if not _table_columns(conn, "application_review_decisions"):
            _create_application_review_reference_table_v20(
                conn,
                table="application_review_decisions",
            )
    else:
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
    application_review_columns = _table_columns(
        conn,
        "application_review_decisions",
    )
    application_review_reference = (
        "job_id"
        if "job_id" in application_review_columns
        else "job_key"
    )
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_application_review_decisions_job
        ON application_review_decisions(
            tenant_id,
            %s,
            decided_at DESC
        )
    """ % application_review_reference)
    _ensure_application_outcome_table_for_version(
        conn,
        current_version=current_version,
    )
    _ensure_application_feedback_candidate_tables_for_version(
        conn,
        current_version=current_version,
    )
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
    from jobctrl.domain.apply.repeat_application import ensure_repeat_application_tables

    ensure_repeat_application_tables(conn)
    ensure_discovery_execution_tables(conn)
    ensure_discovery_search_unit_tables(conn)
    ensure_discovery_control_tables(conn)
    ensure_discovery_settings_tables(conn)
    ensure_contact_tables(conn)
    ensure_projection_tables_in_db(conn)
    drop_legacy_apply_runs_tables(conn)
    _run_schema_migrations(conn)

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


def _create_contacts_table_v24(
    conn: sqlite3.Connection,
    *,
    table: str,
    stable_reference: bool,
) -> None:
    reference_column = "job_id" if stable_reference else "job_url"
    foreign_key = (
        """,
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE RESTRICT"""
        if stable_reference
        else ""
    )
    conn.execute(
        f"""
        CREATE TABLE "{table}" (
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            contact_id          TEXT NOT NULL,
            employer            TEXT,
            {reference_column}  TEXT,
            role                TEXT NOT NULL DEFAULT 'other',
            created_at          TEXT NOT NULL,
            updated_at          TEXT NOT NULL,
            deleted_at          TEXT,
            PRIMARY KEY (tenant_id, contact_id)
            {foreign_key}
        )
        """
    )


def _create_contact_research_tasks_table_v24(
    conn: sqlite3.Connection,
    *,
    table: str,
    stable_reference: bool,
) -> None:
    reference_column = "job_id" if stable_reference else "job_url"
    foreign_key = (
        """,
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE RESTRICT"""
        if stable_reference
        else ""
    )
    conn.execute(
        f"""
        CREATE TABLE "{table}" (
            tenant_id            TEXT NOT NULL DEFAULT 'local',
            task_id              TEXT NOT NULL,
            employer             TEXT,
            {reference_column}   TEXT,
            status               TEXT NOT NULL DEFAULT 'queued',
            source_attempts_json TEXT NOT NULL DEFAULT '[]',
            started_at           TEXT,
            updated_at           TEXT NOT NULL,
            needs_review_at      TEXT,
            completed_at         TEXT,
            failed_at            TEXT,
            error_class          TEXT,
            PRIMARY KEY (tenant_id, task_id)
            {foreign_key}
        )
        """
    )


def _create_outreach_threads_table_v25(
    conn: sqlite3.Connection,
    *,
    table: str,
    stable_reference: bool,
) -> None:
    reference_column = "job_id" if stable_reference else "job_url"
    foreign_key = (
        """,
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE RESTRICT"""
        if stable_reference
        else ""
    )
    conn.execute(
        f"""
        CREATE TABLE "{table}" (
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            thread_id           TEXT NOT NULL,
            contact_id          TEXT NOT NULL,
            {reference_column}  TEXT,
            created_at          TEXT NOT NULL,
            updated_at          TEXT NOT NULL,
            follow_up_due_at    TEXT,
            follow_up_basis     TEXT,
            follow_up_state     TEXT NOT NULL DEFAULT 'none',
            PRIMARY KEY (tenant_id, thread_id)
            {foreign_key}
        )
        """
    )


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

    current_version = _assert_schema_version_supported(conn)
    stable_contact_references = (
        current_version >= _CONTACT_RESEARCH_REFERENCE_SCHEMA_VERSION
    )
    stable_outreach_references = (
        current_version >= _OUTREACH_REFERENCE_SCHEMA_VERSION
    )
    if not _table_columns(conn, "contacts"):
        _create_contacts_table_v24(
            conn,
            table="contacts",
            stable_reference=stable_contact_references,
        )
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
    if not _table_columns(conn, "contact_research_tasks"):
        _create_contact_research_tasks_table_v24(
            conn,
            table="contact_research_tasks",
            stable_reference=stable_contact_references,
        )
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
    if not _table_columns(conn, "outreach_threads"):
        _create_outreach_threads_table_v25(
            conn,
            table="outreach_threads",
            stable_reference=stable_outreach_references,
        )
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
    if stable_contact_references:
        if (
            "job_id" not in _table_columns(conn, "contacts")
            or "job_url" in _table_columns(conn, "contacts")
            or "job_id"
            not in _table_columns(conn, "contact_research_tasks")
            or "job_url"
            in _table_columns(conn, "contact_research_tasks")
        ):
            raise RuntimeError(
                "Schema v24 requires stable contact and "
                "contact-research JobId references."
            )
        _create_contact_reference_indexes_v24(conn)
    else:
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
    if (
        stable_contact_references
        and not _has_contact_research_reference_schema_v24(conn)
    ):
        raise RuntimeError(
            "Schema v24 requires stable contact and "
            "contact-research JobId references."
        )
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_contact_candidates_task
        ON contact_candidates(tenant_id, task_id, status)
    """)
    if stable_outreach_references:
        if (
            "job_id" not in _table_columns(conn, "outreach_threads")
            or "job_url" in _table_columns(conn, "outreach_threads")
        ):
            raise RuntimeError(
                "Schema v25 requires stable outreach-thread JobId references."
            )
        _create_outreach_reference_indexes_v25(conn)
        if not _has_outreach_reference_schema_v25(conn):
            raise RuntimeError(
                "Schema v25 requires stable outreach-thread JobId references."
            )
    else:
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


_STABLE_JOB_IDENTITY_TRIGGER_NAMES = (
    "jobs_stable_identity_validate_insert_v7",
    "jobs_stable_identity_validate_update_v7",
    "jobs_stable_identity_after_insert_v7",
    "jobs_stable_identity_after_url_update_v7",
    "jobs_stable_identity_after_delete_v7",
)

_STABLE_JOB_IDENTITY_SCHEMA_VERSION = 7

_SQLITE_UUID_EXPRESSION = """
    lower(hex(randomblob(4))) || '-' ||
    lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random() % 4) + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6)))
"""


def ensure_stable_job_identity_v7(
    conn: sqlite3.Connection | None = None,
) -> list[str]:
    """Apply the additive stable-JobId foundation and stamp schema v7.

    The legacy ``jobs.url`` primary key and URL-keyed authority tables remain in
    place during this phase. Every job gains one opaque UUID plus a
    tenant-scoped posting-URL alias. Triggers keep legacy raw INSERT paths
    compatible until their repositories move to explicit JobId writes.

    All v7 DDL, backfill, validation, and the ``user_version`` stamp live in one
    savepoint. A failure rolls the v7 work back and leaves the prior schema
    version retryable.
    """
    if conn is None:
        conn = get_connection()

    current = _assert_schema_version_supported(conn)
    if current >= _STABLE_JOB_IDENTITY_SCHEMA_VERSION:
        return []

    migration_timestamp = datetime.now(timezone.utc).isoformat()
    created: list[str] = []

    conn.execute("SAVEPOINT stable_job_identity_v7")
    try:
        before_count = int(
            conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
        )
        columns = {
            str(row[1])
            for row in conn.execute("PRAGMA table_info(jobs)").fetchall()
        }
        if "tenant_id" not in columns:
            conn.execute(
                "ALTER TABLE jobs ADD COLUMN tenant_id "
                "TEXT NOT NULL DEFAULT 'local'"
            )
            created.append("jobs.tenant_id")
        if "job_id" not in columns:
            conn.execute("ALTER TABLE jobs ADD COLUMN job_id TEXT")
            created.append("jobs.job_id")

        rows = conn.execute(
            "SELECT rowid, tenant_id, job_id FROM jobs ORDER BY rowid"
        ).fetchall()
        for row in rows:
            rowid = int(row[0])
            tenant_id = str(row[1] or "").strip() or "local"
            existing_job_id = str(row[2] or "").strip().lower()
            job_id = existing_job_id or str(uuid.uuid4())
            _validate_job_uuid(job_id)
            conn.execute(
                "UPDATE jobs SET tenant_id = ?, job_id = ? WHERE rowid = ?",
                (tenant_id, job_id, rowid),
            )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS job_identity_aliases (
                tenant_id   TEXT NOT NULL,
                alias_kind  TEXT NOT NULL,
                alias_value TEXT NOT NULL,
                job_id      TEXT NOT NULL,
                created_at  TEXT NOT NULL,
                retired_at  TEXT,
                PRIMARY KEY (tenant_id, alias_kind, alias_value),
                CHECK (alias_kind = 'posting_url')
            )
            """
        )
        created.append("job_identity_aliases")

        conflict = conn.execute(
            """
            SELECT a.tenant_id, a.alias_value, a.job_id, j.job_id
            FROM job_identity_aliases a
            JOIN jobs j
              ON j.tenant_id = a.tenant_id
             AND j.url = a.alias_value
            WHERE a.alias_kind = 'posting_url'
              AND a.job_id != j.job_id
            LIMIT 1
            """
        ).fetchone()
        if conflict is not None:
            raise RuntimeError(
                "stable JobId migration found a posting URL alias owned by "
                "a different job"
            )

        conn.execute(
            """
            INSERT INTO job_identity_aliases (
                tenant_id, alias_kind, alias_value, job_id, created_at, retired_at
            )
            SELECT
                tenant_id,
                'posting_url',
                url,
                job_id,
                COALESCE(NULLIF(discovered_at, ''), ?),
                NULL
            FROM jobs
            WHERE 1
            ON CONFLICT(tenant_id, alias_kind, alias_value) DO UPDATE SET
                retired_at = NULL
            WHERE job_identity_aliases.job_id = excluded.job_id
            """,
            (migration_timestamp,),
        )
        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_tenant_job_id
            ON jobs(tenant_id, job_id)
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_job_identity_aliases_job
            ON job_identity_aliases(tenant_id, job_id, alias_kind)
            """
        )
        _create_stable_job_identity_triggers(conn)
        _verify_stable_job_identity_v7(conn, expected_jobs=before_count)
        conn.execute(
            f"PRAGMA user_version = {_STABLE_JOB_IDENTITY_SCHEMA_VERSION}"
        )
        conn.execute("RELEASE SAVEPOINT stable_job_identity_v7")
        conn.commit()
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT stable_job_identity_v7")
        conn.execute("RELEASE SAVEPOINT stable_job_identity_v7")
        raise

    return created


def _create_stable_job_identity_triggers(conn: sqlite3.Connection) -> None:
    uuid_expression = " ".join(_SQLITE_UUID_EXPRESSION.split())
    conn.execute(
        """
        CREATE TRIGGER IF NOT EXISTS jobs_stable_identity_validate_insert_v7
        BEFORE INSERT ON jobs
        BEGIN
            SELECT CASE
              WHEN NEW.job_id IS NOT NULL
               AND (
                    NEW.job_id != trim(NEW.job_id)
                 OR NEW.job_id != lower(NEW.job_id)
                 OR length(NEW.job_id) != 36
                 OR substr(NEW.job_id, 9, 1) != '-'
                 OR substr(NEW.job_id, 14, 1) != '-'
                 OR substr(NEW.job_id, 19, 1) != '-'
                 OR substr(NEW.job_id, 24, 1) != '-'
                 OR length(replace(NEW.job_id, '-', '')) != 32
                 OR replace(NEW.job_id, '-', '') GLOB '*[^0-9a-f]*'
               )
              THEN RAISE(ABORT, 'jobs.job_id must be a canonical UUID')
            END;
            SELECT CASE
              WHEN NEW.tenant_id IS NULL
                OR trim(NEW.tenant_id) = ''
                OR NEW.tenant_id != trim(NEW.tenant_id)
              THEN RAISE(ABORT, 'jobs.tenant_id must be canonical')
            END;
        END
        """
    )
    conn.execute(
        """
        CREATE TRIGGER IF NOT EXISTS jobs_stable_identity_validate_update_v7
        BEFORE UPDATE OF job_id, tenant_id ON jobs
        BEGIN
            SELECT CASE
              WHEN OLD.job_id IS NOT NULL
               AND NEW.job_id IS NOT OLD.job_id
              THEN RAISE(ABORT, 'jobs.job_id is immutable')
            END;
            SELECT CASE
              WHEN NEW.tenant_id IS NOT OLD.tenant_id
              THEN RAISE(ABORT, 'jobs.tenant_id is immutable')
            END;
            SELECT CASE
              WHEN NEW.job_id IS NULL
                OR trim(NEW.job_id) = ''
                OR length(trim(NEW.job_id)) != 36
                OR substr(trim(NEW.job_id), 9, 1) != '-'
                OR substr(trim(NEW.job_id), 14, 1) != '-'
                OR substr(trim(NEW.job_id), 19, 1) != '-'
                OR substr(trim(NEW.job_id), 24, 1) != '-'
                OR length(replace(trim(NEW.job_id), '-', '')) != 32
                OR lower(replace(trim(NEW.job_id), '-', '')) GLOB '*[^0-9a-f]*'
              THEN RAISE(ABORT, 'jobs.job_id must be a UUID')
            END;
        END
        """
    )
    conn.execute(
        f"""
        CREATE TRIGGER IF NOT EXISTS jobs_stable_identity_after_insert_v7
        AFTER INSERT ON jobs
        BEGIN
            UPDATE jobs
            SET job_id = {uuid_expression}
            WHERE rowid = NEW.rowid
              AND NEW.job_id IS NULL;

            SELECT CASE
              WHEN EXISTS (
                SELECT 1
                FROM job_identity_aliases a
                JOIN jobs j ON j.rowid = NEW.rowid
                WHERE a.tenant_id = j.tenant_id
                  AND a.alias_kind = 'posting_url'
                  AND a.alias_value = j.url
                  AND a.job_id != j.job_id
              )
              THEN RAISE(ABORT, 'posting URL alias belongs to another job')
            END;

            INSERT INTO job_identity_aliases (
                tenant_id, alias_kind, alias_value, job_id, created_at, retired_at
            )
            SELECT
                tenant_id,
                'posting_url',
                url,
                job_id,
                COALESCE(
                    NULLIF(discovered_at, ''),
                    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                ),
                NULL
            FROM jobs
            WHERE rowid = NEW.rowid
            ON CONFLICT(tenant_id, alias_kind, alias_value) DO UPDATE SET
                retired_at = NULL
            WHERE job_identity_aliases.job_id = excluded.job_id;
        END
        """
    )
    conn.execute(
        """
        CREATE TRIGGER IF NOT EXISTS jobs_stable_identity_after_delete_v7
        AFTER DELETE ON jobs
        BEGIN
            DELETE FROM job_identity_aliases
            WHERE tenant_id = OLD.tenant_id
              AND job_id = OLD.job_id;
        END
        """
    )
    conn.execute(
        """
        CREATE TRIGGER IF NOT EXISTS jobs_stable_identity_after_url_update_v7
        AFTER UPDATE OF url ON jobs
        WHEN NEW.url != OLD.url
        BEGIN
            SELECT CASE
              WHEN EXISTS (
                SELECT 1
                FROM job_identity_aliases
                WHERE tenant_id = NEW.tenant_id
                  AND alias_kind = 'posting_url'
                  AND alias_value = NEW.url
                  AND job_id != NEW.job_id
              )
              THEN RAISE(ABORT, 'posting URL alias belongs to another job')
            END;

            INSERT INTO job_identity_aliases (
                tenant_id, alias_kind, alias_value, job_id, created_at, retired_at
            ) VALUES (
                NEW.tenant_id,
                'posting_url',
                NEW.url,
                NEW.job_id,
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                NULL
            )
            ON CONFLICT(tenant_id, alias_kind, alias_value) DO UPDATE SET
                retired_at = NULL
            WHERE job_identity_aliases.job_id = excluded.job_id;
        END
        """
    )


def _verify_stable_job_identity_v7(
    conn: sqlite3.Connection,
    *,
    expected_jobs: int | None = None,
) -> None:
    columns = {
        str(row[1])
        for row in conn.execute("PRAGMA table_info(jobs)").fetchall()
    }
    if not {"tenant_id", "job_id"}.issubset(columns):
        raise RuntimeError("stable JobId migration is missing jobs identity columns")

    rows = conn.execute(
        "SELECT tenant_id, job_id, url FROM jobs ORDER BY rowid"
    ).fetchall()
    if expected_jobs is not None and len(rows) != expected_jobs:
        raise RuntimeError("stable JobId migration changed the canonical job count")
    for row in rows:
        if not str(row[0] or "").strip():
            raise RuntimeError("stable JobId migration produced an empty tenant")
        _validate_job_uuid(str(row[1] or ""))

    duplicate = conn.execute(
        """
        SELECT tenant_id, job_id
        FROM jobs
        GROUP BY tenant_id, job_id
        HAVING COUNT(*) > 1
        LIMIT 1
        """
    ).fetchone()
    if duplicate is not None:
        raise RuntimeError("stable JobId migration produced duplicate job IDs")

    missing_storage_alias = conn.execute(
        """
        SELECT j.tenant_id, j.url
        FROM jobs j
        LEFT JOIN job_identity_aliases a
          ON a.tenant_id = j.tenant_id
         AND a.alias_kind = 'posting_url'
         AND a.alias_value = j.url
         AND a.job_id = j.job_id
        WHERE a.job_id IS NULL
        LIMIT 1
        """
    ).fetchone()
    if missing_storage_alias is not None:
        raise RuntimeError(
            "stable JobId migration left a job without its storage URL alias"
        )

    missing_active_alias = conn.execute(
        """
        SELECT j.tenant_id, j.job_id
        FROM jobs j
        LEFT JOIN job_identity_aliases a
          ON a.tenant_id = j.tenant_id
         AND a.alias_kind = 'posting_url'
         AND a.job_id = j.job_id
         AND a.retired_at IS NULL
        WHERE a.job_id IS NULL
        LIMIT 1
        """
    ).fetchone()
    if missing_active_alias is not None:
        raise RuntimeError(
            "stable JobId migration left a job without an active posting URL alias"
        )

    trigger_rows = conn.execute(
        """
        SELECT name
        FROM sqlite_master
        WHERE type = 'trigger'
          AND name IN (?, ?, ?, ?, ?)
        """,
        _STABLE_JOB_IDENTITY_TRIGGER_NAMES,
    ).fetchall()
    if {str(row[0]) for row in trigger_rows} != set(
        _STABLE_JOB_IDENTITY_TRIGGER_NAMES
    ):
        raise RuntimeError("stable JobId migration is missing identity triggers")

    foreign_key_error = conn.execute("PRAGMA foreign_key_check").fetchone()
    if foreign_key_error is not None:
        raise RuntimeError(
            "stable JobId migration found an existing foreign-key violation"
        )


def _validate_job_uuid(value: str) -> None:
    candidate = value.strip().lower()
    try:
        parsed = uuid.UUID(candidate)
    except (AttributeError, ValueError) as exc:
        raise RuntimeError("stable JobId migration found a non-UUID job_id") from exc
    if str(parsed) != candidate:
        raise RuntimeError("stable JobId migration found a non-canonical UUID")


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

    current_schema_version = int(
        conn.execute("PRAGMA user_version").fetchone()[0]
    )
    if current_schema_version >= _STAGE_STATE_REFERENCE_SCHEMA_VERSION:
        _create_job_stage_states_v13(conn)
    else:
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
    if current_schema_version >= _ARTIFACT_REGISTRY_REFERENCE_SCHEMA_VERSION:
        _create_job_artifacts_v14(conn)
    else:
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
    stage_reference = (
        "job_id" if "job_id" in existing_cols else "job_url"
    )
    tenant_prefix = "tenant_id, " if stage_reference == "job_id" else ""
    conn.execute(
        f"""
        CREATE INDEX IF NOT EXISTS idx_job_stage_states_job
        ON job_stage_states({tenant_prefix}{stage_reference}, stage)
        """
    )
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
    artifact_columns = _table_columns(conn, "job_artifacts")
    if "job_id" in artifact_columns:
        _create_job_artifact_indexes_v14(conn)
    else:
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
    stage_state_columns = _table_columns(conn, "job_stage_states")
    stable_stage_references = "job_id" in stage_state_columns
    stage_join = (
        "jss.tenant_id = j.tenant_id AND jss.job_id = j.job_id"
        if stable_stage_references
        else "jss.job_url = j.url"
    )
    legacy_jobs = conn.execute(
        f"""
        SELECT j.url, j.discovered_at, j.full_description, j.detail_scraped_at,
               j.detail_error, j.fit_score, j.scored_at,
               j.tailored_resume_path, j.tailored_at, j.tailor_attempts,
               j.cover_letter_path, j.cover_letter_at, j.cover_attempts,
               j.applied_at, j.apply_status, j.apply_error
        FROM jobs j
        LEFT JOIN job_stage_states jss ON {stage_join}
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
        if stable_stage_references:
            identity = conn.execute(
                """
                SELECT tenant_id, job_id
                FROM jobs
                WHERE url = ?
                LIMIT 1
                """,
                (job_url,),
            ).fetchone()
            if identity is None:
                raise RuntimeError(
                    "stage-state backfill could not resolve stable identity"
                )
            reference_columns = "tenant_id, job_id"
            reference_values: tuple[Any, ...] = (
                str(identity[0]),
                str(identity[1]),
            )
            reference_placeholders = "?, ?"
        else:
            reference_columns = "job_url"
            reference_values = (job_url,)
            reference_placeholders = "?"
        conn.execute(
            f"""
            INSERT OR IGNORE INTO job_stage_states (
                {reference_columns}, stage, state, attempt_count, max_attempts,
                started_at, updated_at, finished_at, duration_ms,
                error_code, error_message, retryable, blocked_by_json,
                next_action, metadata_json, version
            ) VALUES (
                {reference_placeholders}, ?, ?, ?, ?, ?, ?, ?, NULL,
                ?, ?, ?, NULL, NULL, NULL, 0
            )
            """,
            (
                *reference_values,
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

    current_version = int(conn.execute("PRAGMA user_version").fetchone()[0])
    if current_version >= _SCORING_REFERENCE_SCHEMA_VERSION:
        _create_job_scores_v12(conn)
    else:
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
        existing_score_cols = {
            row[1]
            for row in conn.execute(
                "PRAGMA table_info(job_scores)"
            ).fetchall()
        }
        if "criteria_json" not in existing_score_cols:
            conn.execute(
                "ALTER TABLE job_scores ADD COLUMN "
                "criteria_json TEXT NOT NULL DEFAULT '{}'"
            )
        if "trace_json" not in existing_score_cols:
            conn.execute(
                "ALTER TABLE job_scores ADD COLUMN "
                "trace_json TEXT NOT NULL DEFAULT '{}'"
            )
    _create_job_score_indexes(conn)
    ensure_scoring_policy_tables(conn)
    ensure_score_staleness_tables(conn)
    ensure_requirement_fit_tables(conn)

    # One-shot backfill from the legacy columns. Only fires when
    # job_scores has no rows AND there are jobs with a legacy fit_score.
    backfill_count = conn.execute("SELECT COUNT(*) FROM job_scores").fetchone()[0]
    if backfill_count == 0:
        jobs_columns = _table_columns(conn, "jobs")
        tenant_select = (
            "tenant_id" if "tenant_id" in jobs_columns else "'local'"
        )
        job_id_select = "job_id" if "job_id" in jobs_columns else "NULL"
        legacy_rows = conn.execute(
            f"""
            SELECT url, fit_score, score_reasoning, scored_at,
                   {tenant_select} AS tenant_id,
                   {job_id_select} AS job_id
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
                tenant_id = (
                    str(row["tenant_id"] or "local")
                    if isinstance(row, sqlite3.Row)
                    else str(row[4] or "local")
                )
                stable_job_id = (
                    str(row["job_id"] or "")
                    if isinstance(row, sqlite3.Row)
                    else str(row[5] or "")
                )
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
                reference_column = (
                    "job_id"
                    if "job_id" in _table_columns(conn, "job_scores")
                    else "job_url"
                )
                job_reference = (
                    stable_job_id if reference_column == "job_id" else str(url)
                )
                if not job_reference:
                    raise RuntimeError(
                        "score backfill requires stable JobId on schema v12"
                    )
                conn.execute(
                    f"""
                    INSERT OR IGNORE INTO job_scores (
                        {reference_column}, version, tenant_id, fit_score,
                        breakdown_json, keywords_json, scored_at, correction_json,
                        criteria_json, trace_json
                    ) VALUES (?, 1, ?, ?, ?, ?, ?, NULL, ?, ?)
                    """,
                    (
                        job_reference,
                        tenant_id,
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

    current_version = int(conn.execute("PRAGMA user_version").fetchone()[0])
    if current_version >= _SCORING_REFERENCE_SCHEMA_VERSION:
        _create_requirement_fit_tables_v12(conn)
    else:
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
                tier                    TEXT NOT NULL CHECK(
                    tier IN ('must_have', 'nice_to_have')
                ),
                weight                  REAL NOT NULL CHECK(
                    weight >= 0 AND weight <= 1
                ),
                job_evidence_span       TEXT NOT NULL,
                fit_json                TEXT NOT NULL,
                contribution_json       TEXT NOT NULL,
                tailoring_json          TEXT NOT NULL,
                artifact_coverage_json  TEXT,
                position                INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (
                    job_url, score_version, tenant_id, requirement_id
                ),
                FOREIGN KEY (job_url, score_version, tenant_id)
                    REFERENCES job_requirement_fit_reports(
                        job_url, score_version, tenant_id
                    )
                    ON DELETE CASCADE
            )
        """)
    _create_requirement_fit_indexes(conn)
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

    current_version = int(conn.execute("PRAGMA user_version").fetchone()[0])
    if current_version >= _SCORING_REFERENCE_SCHEMA_VERSION:
        _create_score_staleness_v12(conn)
    else:
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
    _create_score_staleness_indexes(conn)
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
    """Create the legacy Pipeline/Preparation work-item ledger.

    New databases use stable JobId references immediately. Existing schema-v9
    databases keep their URL-shaped ``job_id`` values until the versioned v10
    migration resolves and verifies every row transactionally.
    """
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
            available_at     TEXT NOT NULL,
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
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

      * ``job_materials`` — one row per tenant-scoped stable
        ``(job_id, generation)`` aggregate.
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

    current_schema_version = _assert_schema_version_supported(conn)
    if current_schema_version >= _MATERIALS_REFERENCE_SCHEMA_VERSION:
        _create_materials_tables_v15(conn)
        _create_materials_indexes_v15(conn)
    else:
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
                FOREIGN KEY (job_url, generation)
                    REFERENCES job_materials(job_url, generation)
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
                PRIMARY KEY (
                    job_url, generation, artifact_id, box_index
                ),
                FOREIGN KEY (job_url, generation)
                    REFERENCES job_materials(job_url, generation)
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
            ON job_materials_artifacts(
                artifact_type, status, created_at DESC
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_job_material_layout_boxes_artifact
            ON job_material_layout_boxes(
                tenant_id, artifact_id, page_number, box_index
            )
            """
        )

    _backfill_legacy_materials_if_empty(conn)

    conn.commit()
    return ["job_materials", "job_materials_artifacts", "job_material_layout_boxes"]


def _backfill_legacy_materials_if_empty(
    conn: sqlite3.Connection,
) -> None:
    """Backfill legacy paths once their owning job identity is available."""
    backfill_count = conn.execute("SELECT COUNT(*) FROM job_materials").fetchone()[0]
    if backfill_count != 0:
        return

    stable_schema = "job_id" in _table_columns(conn, "job_materials")
    jobs_columns = _table_columns(conn, "jobs")
    stable_jobs = {"tenant_id", "job_id"} <= jobs_columns
    if stable_schema and not stable_jobs:
        # A paired pre-v7 recovery snapshot can contain the newer material
        # table shape while the jobs authority has been restored to v6.
        # The ordered v15 migration retries this after stable identity exists.
        return

    legacy_rows = conn.execute(
        """
        SELECT tenant_id, job_id, url,
               tailored_resume_path, tailored_at,
               cover_letter_path, cover_letter_at
        FROM jobs
        WHERE tailored_resume_path IS NOT NULL
          AND tailored_resume_path != ''
        """
        if stable_schema
        else """
        SELECT 'local' AS tenant_id, NULL AS job_id, url,
               tailored_resume_path, tailored_at,
               cover_letter_path, cover_letter_at
        FROM jobs
        WHERE tailored_resume_path IS NOT NULL
          AND tailored_resume_path != ''
        """
    ).fetchall()
    if not legacy_rows:
        return

    now = datetime.now(timezone.utc).isoformat()
    for row in legacy_rows:
        _backfill_one_materials_row(conn, row, now)


_RESUME_TEMPLATE_REFERENCE_SCHEMA_VERSION = 17


def ensure_resume_template_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create local resume-template configuration tables.

    Templates are style/layout records only. Generated materials snapshot the
    effective template metadata in ``job_materials.metadata_json`` and artifact
    metadata; the rows here remain mutable configuration, not artifact history.
    """
    if conn is None:
        conn = get_connection()
    current_schema_version = _assert_schema_version_supported(conn)

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
    assignment_columns = _table_columns(
        conn,
        "job_resume_template_assignments",
    )
    assignment_reference = (
        "job_id"
        if "job_id" in assignment_columns
        or (
            not assignment_columns
            and current_schema_version
            >= _RESUME_TEMPLATE_REFERENCE_SCHEMA_VERSION
        )
        else "job_url"
    )
    assignment_foreign_key = (
        """,
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE"""
        if assignment_reference == "job_id"
        else ""
    )
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS job_resume_template_assignments (
            tenant_id   TEXT NOT NULL DEFAULT 'local',
            {assignment_reference} TEXT NOT NULL,
            template_id TEXT NOT NULL,
            version_id  TEXT NOT NULL,
            updated_at  TEXT NOT NULL,
            PRIMARY KEY (tenant_id, {assignment_reference})
            {assignment_foreign_key}
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_resume_template_assignments_template
        ON job_resume_template_assignments(tenant_id, template_id, version_id)
        """
    )
    refresh_columns = _table_columns(
        conn,
        "resume_template_refresh_attempts",
    )
    refresh_reference = (
        "job_id"
        if "job_id" in refresh_columns
        or (
            not refresh_columns
            and current_schema_version
            >= _RESUME_TEMPLATE_REFERENCE_SCHEMA_VERSION
        )
        else "job_url"
    )
    refresh_foreign_key = (
        """,
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE"""
        if refresh_reference == "job_id"
        else ""
    )
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS resume_template_refresh_attempts (
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            attempt_id          TEXT NOT NULL,
            {refresh_reference} TEXT NOT NULL,
            status              TEXT NOT NULL,
            from_generation     INTEGER,
            to_generation       INTEGER,
            template_id         TEXT,
            template_version_id TEXT,
            template_hash       TEXT,
            error_message       TEXT,
            metadata_json       TEXT NOT NULL DEFAULT '{{}}',
            created_at          TEXT NOT NULL,
            completed_at        TEXT,
            PRIMARY KEY (tenant_id, attempt_id)
            {refresh_foreign_key}
        )
        """
    )
    conn.execute(
        f"""
        CREATE INDEX IF NOT EXISTS idx_resume_template_refresh_attempts_job
        ON resume_template_refresh_attempts(
            tenant_id, {refresh_reference}, created_at DESC
        )
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

    tenant_id = str(row["tenant_id"] or "local")
    url = str(row["url"])
    job_id = str(row["job_id"] or "")
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

    stable_schema = "job_id" in _table_columns(conn, "job_materials")
    if stable_schema:
        _validate_job_uuid(job_id)
        conn.execute(
            """
            INSERT OR IGNORE INTO job_materials (
                tenant_id, job_id, generation, status,
                created_at, updated_at,
                last_validation_json, last_verdict_json, metadata_json
            ) VALUES (?, ?, 1, ?, ?, ?, NULL, NULL, ?)
            """,
            (
                tenant_id,
                job_id,
                status,
                tailor_at,
                cover_at if cover_path else tailor_at,
                json.dumps({"backfilled": True}, sort_keys=True),
            ),
        )
    else:
        conn.execute(
            """
            INSERT OR IGNORE INTO job_materials (
                job_url, generation, tenant_id, status,
                created_at, updated_at,
                last_validation_json, last_verdict_json, metadata_json
            ) VALUES (?, 1, ?, ?, ?, ?, NULL, NULL, ?)
            """,
            (
                url,
                tenant_id,
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
        if stable_schema:
            conn.execute(
                """
                INSERT OR IGNORE INTO job_materials_artifacts (
                    tenant_id, job_id, generation, artifact_type,
                    artifact_id, status, path, render_format, size_bytes,
                    metadata_json, created_at, superseded_at
                ) VALUES (?, ?, 1, ?, ?, 'approved', ?, ?, ?, ?, ?, NULL)
                """,
                (
                    tenant_id,
                    job_id,
                    artifact_type,
                    _uuid.uuid4().hex,
                    path,
                    render_format,
                    size,
                    json.dumps({"backfilled": True}, sort_keys=True),
                    created,
                ),
            )
        else:
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

      * ``job_employer_analysis`` — one row per tenant-scoped stable
        ``(job_id, generation)``. Holds the reconciled canonical analysis (role
        framing / seniority / narrative / requirements / keywords as structured
        columns + JSON arrays), the snapshot+version cache key (D-11/D-12), the
        cross-model agreement signal, and the ``legs_attempted`` /
        ``legs_succeeded`` ensemble-completeness counters (D-08).
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

    current_schema_version = _assert_schema_version_supported(conn)
    if (
        current_schema_version
        >= _EMPLOYER_ANALYSIS_REFERENCE_SCHEMA_VERSION
    ):
        _create_employer_analysis_tables_v16(conn)
        _create_employer_analysis_indexes_v16(conn)
        conn.commit()
        return list(_EMPLOYER_ANALYSIS_REFERENCE_TABLES)

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

      * ``job_bullet_provenance`` — one row per tenant-scoped stable
        ``(job_id, generation, bullet_id)``.
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

    current_schema_version = _assert_schema_version_supported(conn)
    if current_schema_version >= _MATERIALS_REFERENCE_SCHEMA_VERSION:
        _create_bullet_provenance_v15(conn)
    else:
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
                    REFERENCES job_materials(job_url, generation)
                    ON DELETE CASCADE
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
    reference_column = (
        "job_id"
        if "job_id" in _table_columns(conn, "job_bullet_provenance")
        else "job_url"
    )
    conn.execute(
        f"""
        CREATE INDEX IF NOT EXISTS idx_job_bullet_provenance_tenant_job_gen
        ON job_bullet_provenance(
            tenant_id, {reference_column}, generation DESC
        )
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


_INTERVIEW_PREP_REFERENCE_SCHEMA_VERSION = 18


def _create_interview_prep_tables(
    conn: sqlite3.Connection,
    *,
    prep_table: str,
    items_table: str,
    reference_column: str,
) -> None:
    stable_reference = reference_column == "job_id"
    parent_primary_key = (
        f"tenant_id, {reference_column}, generation"
        if stable_reference
        else f"{reference_column}, generation"
    )
    item_primary_key = (
        f"tenant_id, {reference_column}, generation, item_id"
        if stable_reference
        else f"{reference_column}, generation, item_id"
    )
    job_foreign_key = (
        f""",
            FOREIGN KEY (tenant_id, {reference_column})
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE"""
        if stable_reference
        else f""",
            FOREIGN KEY ({reference_column})
                REFERENCES jobs(url) ON DELETE CASCADE"""
    )
    parent_foreign_key = (
        f""",
            FOREIGN KEY (tenant_id, {reference_column}, generation)
                REFERENCES {prep_table}(
                    tenant_id, {reference_column}, generation
                ) ON DELETE CASCADE"""
        if stable_reference
        else f""",
            FOREIGN KEY ({reference_column}, generation)
                REFERENCES {prep_table}(
                    {reference_column}, generation
                ) ON DELETE CASCADE"""
    )
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {prep_table} (
            tenant_id                  TEXT NOT NULL DEFAULT 'local',
            {reference_column}         TEXT NOT NULL,
            generation                 INTEGER NOT NULL,
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
            PRIMARY KEY ({parent_primary_key})
            {job_foreign_key}
        )
        """
    )
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {items_table} (
            tenant_id                  TEXT NOT NULL DEFAULT 'local',
            {reference_column}         TEXT NOT NULL,
            generation                 INTEGER NOT NULL,
            item_id                    TEXT NOT NULL,
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
            PRIMARY KEY ({item_primary_key})
            {parent_foreign_key}
        )
        """
    )


def _create_interview_prep_indexes(
    conn: sqlite3.Connection,
    *,
    reference_column: str,
) -> None:
    conn.execute(
        f"""
        CREATE INDEX IF NOT EXISTS idx_job_interview_prep_tenant_job_gen
        ON job_interview_prep(
            tenant_id, {reference_column}, generation DESC
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_interview_prep_tenant_status
        ON job_interview_prep(tenant_id, status, generated_at DESC)
        """
    )
    conn.execute(
        f"""
        CREATE INDEX IF NOT EXISTS idx_job_interview_prep_origin_run
        ON job_interview_prep(
            tenant_id, {reference_column}, origin_run_id
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_interview_prep_items_tenant_kind
        ON job_interview_prep_items(tenant_id, kind, position)
        """
    )


def ensure_interview_prep_tables(
    conn: sqlite3.Connection | None = None,
) -> list[str]:
    """Create Interview Preparation canonical generation tables.

    Interview prep is generated material, not a projection. Rows are versioned by
    ``(job_url, generation)`` so a failed regenerate can be audited without
    destroying the last accepted prep. Prompt/raw profile/job payloads are not
    stored here; rows keep only the accepted/failed gate audit and item
    provenance needed for later read-model projection.
    """
    if conn is None:
        conn = get_connection()
    current_schema_version = _assert_schema_version_supported(conn)
    prep_columns = _table_columns(conn, "job_interview_prep")
    reference_column = (
        "job_id"
        if "job_id" in prep_columns
        or (
            not prep_columns
            and current_schema_version
            >= _INTERVIEW_PREP_REFERENCE_SCHEMA_VERSION
        )
        else "job_url"
    )
    _create_interview_prep_tables(
        conn,
        prep_table="job_interview_prep",
        items_table="job_interview_prep_items",
        reference_column=reference_column,
    )
    prep_cols = {row[1] for row in conn.execute("PRAGMA table_info(job_interview_prep)").fetchall()}
    if "origin_run_id" not in prep_cols:
        conn.execute(
            "ALTER TABLE job_interview_prep ADD COLUMN origin_run_id TEXT NOT NULL DEFAULT ''"
        )
    _create_interview_prep_indexes(
        conn,
        reference_column=reference_column,
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

    current_version = int(conn.execute("PRAGMA user_version").fetchone()[0])
    if current_version >= _ENRICHMENT_SNAPSHOT_REFERENCE_SCHEMA_VERSION:
        _create_job_enrichments_v11(conn)
    else:
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
    _create_job_enrichment_indexes(conn)

    # Idempotent one-shot backfill from the legacy columns.
    backfill_count = conn.execute("SELECT COUNT(*) FROM job_enrichments").fetchone()[0]
    if backfill_count == 0:
        job_columns = _table_columns(conn, "jobs")
        tenant_select = (
            "tenant_id" if "tenant_id" in job_columns else "'local' AS tenant_id"
        )
        job_id_select = (
            "job_id" if "job_id" in job_columns else "NULL AS job_id"
        )
        legacy_rows = conn.execute(
            f"""
            SELECT url, full_description, application_url,
                   detail_scraped_at, detail_error,
                   {tenant_select}, {job_id_select}
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

    current_version = int(conn.execute("PRAGMA user_version").fetchone()[0])
    if current_version >= _ENRICHMENT_SNAPSHOT_REFERENCE_SCHEMA_VERSION:
        _create_posting_snapshot_sets_v11(conn)
    else:
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
    _create_posting_snapshot_set_indexes(conn)
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
    reference_column = (
        "job_id"
        if "job_id" in _table_columns(conn, "posting_snapshot_sets")
        else "job_url"
    )
    rows = conn.execute(
        f"SELECT tenant_id, {reference_column}, snapshot_set_json "
        "FROM posting_snapshot_sets"
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
            f"WHERE tenant_id = ? AND {reference_column} = ?",
            (
                latest.get("confidence"),
                latest.get("quarantine_reason"),
                row["tenant_id"] if isinstance(row, sqlite3.Row) else row[0],
                row[reference_column] if isinstance(row, sqlite3.Row) else row[1],
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
    tenant_id = (
        str(row["tenant_id"] or "local")
        if isinstance(row, sqlite3.Row)
        else str(row[5] or "local")
    )
    stable_job_id = (
        str(row["job_id"] or "")
        if isinstance(row, sqlite3.Row)
        else str(row[6] or "")
    )

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

    reference_column = (
        "job_id" if "job_id" in _table_columns(conn, "job_enrichments") else "job_url"
    )
    job_reference = stable_job_id if reference_column == "job_id" else str(url)
    if not job_reference:
        raise RuntimeError(
            "enrichment backfill requires stable JobId on schema v11"
        )
    conn.execute(
        f"""
        INSERT OR IGNORE INTO job_enrichments (
            {reference_column}, tenant_id, current_status, full_description,
            application_url, enriched_at, extraction_tier,
            attempts_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            job_reference,
            tenant_id,
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

    These discovery-owned authorities use stable ``JobId`` references. The
    legacy ``jobs.url`` primary key remains compatibility storage for table
    families that have not yet completed their bounded migration.

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
            job_id                   TEXT NOT NULL,
            source_id                TEXT NOT NULL,
            source_native_id         TEXT NOT NULL,
            observed_url             TEXT NOT NULL,
            normalized_observed_url  TEXT NOT NULL,
            run_id                   TEXT NOT NULL DEFAULT '',
            observed_at              TEXT NOT NULL,
            PRIMARY KEY (tenant_id, source_observation_id),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
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
    observation_reference = (
        "job_id"
        if "job_id" in _table_columns(conn, "job_source_observations")
        else "job_url"
    )
    conn.execute(
        f"""
        CREATE INDEX IF NOT EXISTS idx_job_source_observations_job
        ON job_source_observations(tenant_id, {observation_reference})
        """
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS job_canonical_identities (
            tenant_id          TEXT NOT NULL DEFAULT 'local',
            job_id             TEXT NOT NULL,
            canonical_url      TEXT NOT NULL,
            ats_kind           TEXT NOT NULL,
            source_native_id   TEXT NOT NULL,
            confidence         REAL NOT NULL,
            resolved_at        TEXT NOT NULL,
            PRIMARY KEY (tenant_id, job_id),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
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
            PRIMARY KEY (tenant_id, duplicate_link_id),
            FOREIGN KEY (tenant_id, surviving_job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
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
            owner_job_id    TEXT NOT NULL,
            candidate_url   TEXT NOT NULL,
            reason          TEXT NOT NULL,
            rejected_at     TEXT NOT NULL,
            PRIMARY KEY (tenant_id, owner_job_id, candidate_url),
            FOREIGN KEY (tenant_id, owner_job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        )
        """
    )

    # Idempotent one-shot backfill: every existing jobs row gets one
    # observation row using its stable ID plus legacy URL / site / discovered_at.
    backfilled = conn.execute("SELECT COUNT(*) FROM job_source_observations").fetchone()[0]
    current_schema_version = int(
        conn.execute("PRAGMA user_version").fetchone()[0]
    )
    if (
        backfilled == 0
        and current_schema_version >= _DISCOVERY_IDENTITY_REFERENCE_SCHEMA_VERSION
    ):
        observation_columns = _table_columns(conn, "job_source_observations")
        job_columns = _table_columns(conn, "jobs")
        stable_schema = "job_id" in observation_columns
        stable_jobs_ready = {"tenant_id", "job_id"}.issubset(job_columns) and (
            int(
                conn.execute(
                    """
                    SELECT COUNT(*)
                    FROM jobs
                    WHERE tenant_id IS NULL OR trim(tenant_id) = ''
                       OR job_id IS NULL OR trim(job_id) = ''
                    """
                ).fetchone()[0]
            )
            == 0
        )
        legacy_jobs: list[sqlite3.Row] | list[tuple[Any, ...]] = []
        if not stable_schema:
            legacy_jobs = conn.execute(
                "SELECT url, site, strategy, discovered_at FROM jobs"
            ).fetchall()
        elif stable_jobs_ready:
            legacy_jobs = conn.execute(
                """
                SELECT url, site, strategy, discovered_at, tenant_id, job_id
                FROM jobs
                """
            ).fetchall()
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
            job_id                   TEXT NOT NULL,
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
            PRIMARY KEY (tenant_id, discover_workflow_id, discover_run_id, job_id),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
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
    execution_reference = (
        "job_id"
        if "job_id" in _table_columns(conn, "discovery_execution_jobs")
        else "job_url"
    )
    conn.execute(
        f"""
        CREATE INDEX IF NOT EXISTS idx_discovery_execution_jobs_job
        ON discovery_execution_jobs(tenant_id, {execution_reference}, linked_at)
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
            job_id                 TEXT NOT NULL,
            was_new                INTEGER NOT NULL CHECK (was_new IN (0, 1)),
            accepted_at            TEXT NOT NULL,
            PRIMARY KEY (
                tenant_id, discover_workflow_id, discover_run_id, unit_id, job_id
            ),
            FOREIGN KEY (
                tenant_id, discover_workflow_id, discover_run_id, unit_id
            ) REFERENCES discovery_search_units(
                tenant_id, discover_workflow_id, discover_run_id, unit_id
            ) ON DELETE CASCADE,
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
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
    observation_columns = _table_columns(conn, "job_source_observations")
    reference_column = "job_id" if "job_id" in observation_columns else "job_url"
    if reference_column == "job_id":
        if isinstance(row, sqlite3.Row):
            tenant_id = str(row["tenant_id"] or "").strip()
            job_reference = str(row["job_id"] or "").strip()
        else:
            tenant_id = str(row[4] or "").strip()
            job_reference = str(row[5] or "").strip()
        if not tenant_id or not job_reference:
            raise RuntimeError(
                "source-observation backfill requires a stable tenant and JobId"
            )
    else:
        tenant_id = "local"
        job_reference = str(url)
    source_native_id = url  # fall back to the URL when we have nothing better
    source_observation_id = f"backfill:{url}"
    conn.execute(
        f"""
        INSERT OR IGNORE INTO job_source_observations (
            tenant_id, source_observation_id, {reference_column}, source_id,
            source_native_id, observed_url, normalized_observed_url,
            run_id, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'backfill', ?)
        """,
        (
            tenant_id,
            source_observation_id,
            job_reference,
            str(site),
            str(source_native_id),
            url,
            normalize_observed_url(url),
            discovered_at,
        ),
    )


_DISCOVERY_IDENTITY_REFERENCE_SCHEMA_VERSION = 8
_DISCOVERY_IDENTITY_REFERENCE_TABLES = (
    "job_source_observations",
    "job_canonical_identities",
    "job_duplicate_links",
    "job_rejected_duplicate_links",
)


def ensure_discovery_identity_references_v8(
    conn: sqlite3.Connection | None = None,
) -> list[str]:
    """Move discovery-owned job references from posting URLs to stable IDs.

    Every old reference is resolved through the canonical jobs row or its
    tenant-scoped posting-URL aliases before any table is replaced. The four
    authority tables are rebuilt and verified in one savepoint; unresolved
    references, row-count drift, or any foreign-key error leaves schema v7
    untouched and retryable.
    """
    if conn is None:
        conn = get_connection()

    current = _assert_schema_version_supported(conn)
    if current >= _DISCOVERY_IDENTITY_REFERENCE_SCHEMA_VERSION:
        return []
    if current != _STABLE_JOB_IDENTITY_SCHEMA_VERSION:
        raise RuntimeError(
            "discovery identity migration requires stable JobId schema v7"
        )

    conn.execute("SAVEPOINT discovery_identity_references_v8")
    try:
        _verify_stable_job_identity_v7(conn)
        before_counts = {
            table: int(conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
            for table in _DISCOVERY_IDENTITY_REFERENCE_TABLES
        }

        if not _has_discovery_identity_reference_schema_v8(conn):
            source_reference = _legacy_or_stable_reference_column(
                conn,
                "job_source_observations",
                stable="job_id",
                legacy="job_url",
            )
            canonical_reference = _legacy_or_stable_reference_column(
                conn,
                "job_canonical_identities",
                stable="job_id",
                legacy="job_url",
            )
            rejected_reference = _legacy_or_stable_reference_column(
                conn,
                "job_rejected_duplicate_links",
                stable="owner_job_id",
                legacy="owner_job_url",
            )
            reference_columns = {
                "job_source_observations": source_reference,
                "job_canonical_identities": canonical_reference,
                "job_duplicate_links": "surviving_job_id",
                "job_rejected_duplicate_links": rejected_reference,
            }
            for table, reference_column in reference_columns.items():
                unresolved = conn.execute(
                    f"""
                    SELECT {reference_column}
                    FROM {table} AS source
                    WHERE {_resolved_job_id_sql("source", reference_column)}
                          IS NULL
                    LIMIT 1
                    """
                ).fetchone()
                if unresolved is not None:
                    raise RuntimeError(
                        "discovery identity migration could not resolve "
                        f"{table}.{reference_column}={unresolved[0]!r}"
                    )

            _create_discovery_identity_v8_rebuild_tables(conn)
            conn.execute(
                f"""
                INSERT INTO job_source_observations_v8 (
                    tenant_id, source_observation_id, job_id, source_id,
                    source_native_id, observed_url, normalized_observed_url,
                    run_id, observed_at
                )
                SELECT
                    source.tenant_id,
                    source.source_observation_id,
                    {_resolved_job_id_sql("source", source_reference)},
                    source.source_id,
                    source.source_native_id,
                    source.observed_url,
                    source.normalized_observed_url,
                    source.run_id,
                    source.observed_at
                FROM job_source_observations AS source
                """
            )
            conn.execute(
                f"""
                INSERT INTO job_canonical_identities_v8 (
                    tenant_id, job_id, canonical_url, ats_kind,
                    source_native_id, confidence, resolved_at
                )
                SELECT
                    source.tenant_id,
                    {_resolved_job_id_sql("source", canonical_reference)},
                    source.canonical_url,
                    source.ats_kind,
                    source.source_native_id,
                    source.confidence,
                    source.resolved_at
                FROM job_canonical_identities AS source
                """
            )
            conn.execute(
                f"""
                INSERT INTO job_duplicate_links_v8 (
                    tenant_id, duplicate_link_id, surviving_job_id,
                    superseded_job_or_observation_id, reason, confidence,
                    linked_at
                )
                SELECT
                    source.tenant_id,
                    source.duplicate_link_id,
                    {_resolved_job_id_sql("source", "surviving_job_id")},
                    source.superseded_job_or_observation_id,
                    source.reason,
                    source.confidence,
                    source.linked_at
                FROM job_duplicate_links AS source
                """
            )
            conn.execute(
                f"""
                INSERT INTO job_rejected_duplicate_links_v8 (
                    tenant_id, owner_job_id, candidate_url, reason, rejected_at
                )
                SELECT
                    source.tenant_id,
                    {_resolved_job_id_sql("source", rejected_reference)},
                    source.candidate_url,
                    source.reason,
                    source.rejected_at
                FROM job_rejected_duplicate_links AS source
                """
            )

            for table in _DISCOVERY_IDENTITY_REFERENCE_TABLES:
                conn.execute(f'DROP TABLE "{table}"')
                conn.execute(f'ALTER TABLE "{table}_v8" RENAME TO "{table}"')
            _create_discovery_identity_v8_indexes(conn)

        if before_counts["job_source_observations"] == 0:
            now = datetime.now(timezone.utc).isoformat()
            jobs = conn.execute(
                """
                SELECT url, site, strategy, discovered_at, tenant_id, job_id
                FROM jobs
                """
            ).fetchall()
            for row in jobs:
                _backfill_one_observation_row(conn, row, now)

        expected_counts = dict(before_counts)
        if before_counts["job_source_observations"] == 0:
            expected_counts["job_source_observations"] = int(
                conn.execute(
                    "SELECT COUNT(*) FROM job_source_observations"
                ).fetchone()[0]
            )
        _verify_discovery_identity_references_v8(
            conn,
            expected_counts=expected_counts,
        )
        conn.execute(
            f"PRAGMA user_version = "
            f"{_DISCOVERY_IDENTITY_REFERENCE_SCHEMA_VERSION}"
        )
        conn.execute("RELEASE SAVEPOINT discovery_identity_references_v8")
        conn.commit()
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT discovery_identity_references_v8")
        conn.execute("RELEASE SAVEPOINT discovery_identity_references_v8")
        raise

    return list(_DISCOVERY_IDENTITY_REFERENCE_TABLES)


def reassign_discovery_identity_references(
    conn: sqlite3.Connection,
    *,
    losing_job_url: str,
    surviving_job_url: str,
) -> None:
    """Re-home discovery authority rows before a legacy URL collision merge.

    URL normalization still merges duplicate legacy ``jobs`` rows in place.
    Because Python's compatibility connections do not yet enforce SQLite
    foreign-key actions globally, the merge must explicitly preserve the
    losing aggregate's discovery evidence under the surviving stable JobId
    before deleting the losing row.
    """
    conn.execute("SAVEPOINT reassign_discovery_identity_references")
    try:
        _reassign_discovery_identity_references(
            conn,
            losing_job_url=losing_job_url,
            surviving_job_url=surviving_job_url,
        )
        conn.execute("RELEASE SAVEPOINT reassign_discovery_identity_references")
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT reassign_discovery_identity_references")
        conn.execute("RELEASE SAVEPOINT reassign_discovery_identity_references")
        raise


def _reassign_discovery_identity_references(
    conn: sqlite3.Connection,
    *,
    losing_job_url: str,
    surviving_job_url: str,
) -> None:
    if losing_job_url == surviving_job_url:
        return
    identities = conn.execute(
        """
        SELECT url, tenant_id, job_id
        FROM jobs
        WHERE url IN (?, ?)
        """,
        (losing_job_url, surviving_job_url),
    ).fetchall()
    by_url = {
        str(row["url"] if isinstance(row, sqlite3.Row) else row[0]): (
            str(row["tenant_id"] if isinstance(row, sqlite3.Row) else row[1]),
            str(row["job_id"] if isinstance(row, sqlite3.Row) else row[2]),
        )
        for row in identities
    }
    losing_identity = by_url.get(losing_job_url)
    surviving_identity = by_url.get(surviving_job_url)
    if losing_identity is None or surviving_identity is None:
        raise RuntimeError(
            "URL collision merge requires both losing and surviving jobs"
        )
    losing_tenant, losing_job_id = losing_identity
    surviving_tenant, surviving_job_id = surviving_identity
    if losing_tenant != surviving_tenant:
        raise RuntimeError(
            "URL collision merge cannot cross tenant boundaries"
        )
    if not losing_job_id or not surviving_job_id:
        raise RuntimeError(
            "URL collision merge requires stable JobIds"
        )

    tenant_id = losing_tenant
    conn.execute(
        """
        UPDATE job_source_observations
        SET job_id = ?
        WHERE tenant_id = ? AND job_id = ?
        """,
        (surviving_job_id, tenant_id, losing_job_id),
    )

    losing_canonical = conn.execute(
        """
        SELECT 1
        FROM job_canonical_identities
        WHERE tenant_id = ? AND job_id = ?
        """,
        (tenant_id, losing_job_id),
    ).fetchone()
    if losing_canonical is not None:
        surviving_canonical = conn.execute(
            """
            SELECT 1
            FROM job_canonical_identities
            WHERE tenant_id = ? AND job_id = ?
            """,
            (tenant_id, surviving_job_id),
        ).fetchone()
        if surviving_canonical is None:
            conn.execute(
                """
                UPDATE job_canonical_identities
                SET job_id = ?
                WHERE tenant_id = ? AND job_id = ?
                """,
                (surviving_job_id, tenant_id, losing_job_id),
            )
        else:
            conn.execute(
                """
                DELETE FROM job_canonical_identities
                WHERE tenant_id = ? AND job_id = ?
                """,
                (tenant_id, losing_job_id),
            )

    conn.execute(
        """
        UPDATE job_duplicate_links
        SET surviving_job_id = ?
        WHERE tenant_id = ? AND surviving_job_id = ?
        """,
        (surviving_job_id, tenant_id, losing_job_id),
    )
    conn.execute(
        """
        DELETE FROM job_rejected_duplicate_links AS losing
        WHERE losing.tenant_id = ?
          AND losing.owner_job_id = ?
          AND EXISTS (
              SELECT 1
              FROM job_rejected_duplicate_links AS surviving
              WHERE surviving.tenant_id = losing.tenant_id
                AND surviving.owner_job_id = ?
                AND surviving.candidate_url = losing.candidate_url
          )
        """,
        (tenant_id, losing_job_id, surviving_job_id),
    )
    conn.execute(
        """
        UPDATE job_rejected_duplicate_links
        SET owner_job_id = ?
        WHERE tenant_id = ? AND owner_job_id = ?
        """,
        (surviving_job_id, tenant_id, losing_job_id),
    )
    if "job_id" in _table_columns(conn, "discovery_execution_jobs"):
        _reassign_execution_memberships(
            conn,
            tenant_id=tenant_id,
            losing_job_id=losing_job_id,
            surviving_job_id=surviving_job_id,
        )
    if "job_id" in _table_columns(conn, "discovery_search_unit_jobs"):
        _reassign_search_unit_receipts(
            conn,
            tenant_id=tenant_id,
            losing_job_id=losing_job_id,
            surviving_job_id=surviving_job_id,
        )
    if _has_preparation_reference_schema_v10(conn):
        conn.execute(
            """
            UPDATE preparation_work_items
            SET job_id = ?
            WHERE tenant_id = ? AND job_id = ?
            """,
            (surviving_job_id, tenant_id, losing_job_id),
        )
    if _has_enrichment_snapshot_reference_schema_v11(conn):
        _reassign_enrichment_snapshot_references_v11(
            conn,
            tenant_id=tenant_id,
            losing_job_id=losing_job_id,
            surviving_job_id=surviving_job_id,
        )
    employer_analysis_generation_map: (
        dict[tuple[str, int], int] | None
    ) = None
    if _has_employer_analysis_reference_schema_v16(conn):
        employer_analysis_generation_map = (
            _reassign_employer_analysis_references_v16(
                conn,
                tenant_id=tenant_id,
                losing_job_id=losing_job_id,
                surviving_job_id=surviving_job_id,
            )
        )
    material_generation_map: dict[tuple[str, int], int] = {}
    if _has_materials_reference_schema_v15(conn):
        material_generation_map = _reassign_materials_references_v15(
            conn,
            tenant_id=tenant_id,
            losing_job_id=losing_job_id,
            surviving_job_id=surviving_job_id,
        )
    if _has_resume_template_reference_schema_v17(conn):
        _reassign_resume_template_references_v17(
            conn,
            tenant_id=tenant_id,
            losing_job_id=losing_job_id,
            surviving_job_id=surviving_job_id,
            material_generation_map=material_generation_map,
        )
    if _has_interview_prep_reference_schema_v18(conn):
        _reassign_interview_prep_references_v18(
            conn,
            tenant_id=tenant_id,
            losing_job_id=losing_job_id,
            surviving_job_id=surviving_job_id,
            losing_job_url=losing_job_url,
            surviving_job_url=surviving_job_url,
        )
        _reassign_application_outcome_job_keys_v18(
            conn,
            tenant_id=tenant_id,
            losing_job_url=losing_job_url,
            surviving_job_url=surviving_job_url,
        )
    if _has_compensation_reference_schema_v19(conn):
        _reassign_compensation_references_v19(
            conn,
            tenant_id=tenant_id,
            losing_job_id=losing_job_id,
            surviving_job_id=surviving_job_id,
        )
    if _has_application_review_reference_schema_v20(conn):
        _reassign_application_review_references_v20(
            conn,
            tenant_id=tenant_id,
            losing_job_id=losing_job_id,
            surviving_job_id=surviving_job_id,
        )
    if _has_application_outcome_reference_schema_v21(conn):
        _reassign_application_outcome_references_v21(
            conn,
            tenant_id=tenant_id,
            losing_job_id=losing_job_id,
            surviving_job_id=surviving_job_id,
        )
    if _has_application_feedback_candidate_schema_v22(conn):
        _reassign_application_feedback_candidate_references_v22(
            conn,
            tenant_id=tenant_id,
            losing_job_id=losing_job_id,
            surviving_job_id=surviving_job_id,
        )
    if _has_repeat_application_reference_schema_v23(conn):
        _reassign_repeat_application_references_v23(
            conn,
            tenant_id=tenant_id,
            losing_job_id=losing_job_id,
            surviving_job_id=surviving_job_id,
        )
    if _has_contact_research_reference_schema_v24(conn):
        _reassign_contact_research_references_v24(
            conn,
            tenant_id=tenant_id,
            losing_job_id=losing_job_id,
            surviving_job_id=surviving_job_id,
            losing_job_url=losing_job_url,
            surviving_job_url=surviving_job_url,
        )
    if _has_outreach_reference_schema_v25(conn):
        _reassign_outreach_references_v25(
            conn,
            tenant_id=tenant_id,
            losing_job_id=losing_job_id,
            surviving_job_id=surviving_job_id,
            losing_job_url=losing_job_url,
            surviving_job_url=surviving_job_url,
        )
    if _has_scoring_reference_schema_v12(conn):
        _reassign_scoring_references_v12(
            conn,
            tenant_id=tenant_id,
            losing_job_id=losing_job_id,
            surviving_job_id=surviving_job_id,
            employer_analysis_generation_map=(
                employer_analysis_generation_map
            ),
        )
    if _has_stage_state_reference_schema_v13(conn):
        _reassign_stage_state_references_v13(
            conn,
            tenant_id=tenant_id,
            losing_job_id=losing_job_id,
            surviving_job_id=surviving_job_id,
        )
    if _has_artifact_registry_reference_schema_v14(conn):
        _reassign_artifact_registry_references_v14(
            conn,
            tenant_id=tenant_id,
            losing_job_id=losing_job_id,
            surviving_job_id=surviving_job_id,
        )


def _reassign_enrichment_snapshot_references_v11(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    losing_job_id: str,
    surviving_job_id: str,
) -> None:
    _merge_enrichment_rows_v11(
        conn,
        tenant_id=tenant_id,
        losing_job_id=losing_job_id,
        surviving_job_id=surviving_job_id,
    )
    _merge_snapshot_rows_v11(
        conn,
        tenant_id=tenant_id,
        losing_job_id=losing_job_id,
        surviving_job_id=surviving_job_id,
    )


def _merge_enrichment_rows_v11(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    losing_job_id: str,
    surviving_job_id: str,
) -> None:
    rows = conn.execute(
        """
        SELECT job_id, current_status, full_description, application_url,
               enriched_at, extraction_tier, attempts_json, updated_at
        FROM job_enrichments
        WHERE tenant_id = ? AND job_id IN (?, ?)
        """,
        (tenant_id, losing_job_id, surviving_job_id),
    ).fetchall()
    by_job_id = {str(row[0]): row for row in rows}
    losing = by_job_id.get(losing_job_id)
    if losing is None:
        return
    surviving = by_job_id.get(surviving_job_id)
    if surviving is None:
        conn.execute(
            """
            UPDATE job_enrichments
            SET job_id = ?
            WHERE tenant_id = ? AND job_id = ?
            """,
            (surviving_job_id, tenant_id, losing_job_id),
        )
        return

    merged_values = _merged_enrichment_values_v11(
        surviving=surviving,
        losing=losing,
    )
    conn.execute(
        """
        UPDATE job_enrichments
        SET current_status = ?,
            full_description = ?,
            application_url = ?,
            enriched_at = ?,
            extraction_tier = ?,
            attempts_json = ?,
            updated_at = ?
        WHERE tenant_id = ? AND job_id = ?
        """,
        (
            *merged_values,
            tenant_id,
            surviving_job_id,
        ),
    )
    conn.execute(
        """
        DELETE FROM job_enrichments
        WHERE tenant_id = ? AND job_id = ?
        """,
        (tenant_id, losing_job_id),
    )


def _merged_enrichment_values_v11(
    *,
    surviving: Any,
    losing: Any,
    allow_conflicting_descriptions: bool = False,
) -> tuple[str, Any, Any, Any, Any, str, str]:
    """Merge two enrichment authorities without discarding newer facts."""
    surviving_description = surviving[2]
    losing_description = losing[2]
    if (
        surviving_description
        and losing_description
        and str(surviving_description) != str(losing_description)
        and not allow_conflicting_descriptions
    ):
        raise RuntimeError(
            "URL collision merge found conflicting canonical enrichment "
            "descriptions"
        )

    attempts: list[dict[str, Any]] = []
    for source_index, row in enumerate((surviving, losing)):
        try:
            source_attempts = json.loads(str(row[6] or "[]"))
        except (TypeError, ValueError) as exc:
            raise RuntimeError(
                "URL collision merge found invalid enrichment attempt history"
            ) from exc
        if not isinstance(source_attempts, list) or any(
            not isinstance(attempt, dict) for attempt in source_attempts
        ):
            raise RuntimeError(
                "URL collision merge found invalid enrichment attempt history"
            )
        for attempt_index, attempt in enumerate(source_attempts):
            copied = dict(attempt)
            copied["_merge_order"] = (source_index, attempt_index)
            attempts.append(copied)
    attempts.sort(
        key=lambda attempt: (
            str(attempt.get("started_at") or ""),
            attempt["_merge_order"],
        )
    )
    if sum(
        1 for attempt in attempts if str(attempt.get("status")) == "running"
    ) > 1:
        raise RuntimeError(
            "URL collision merge found multiple running enrichment attempts"
        )
    for number, attempt in enumerate(attempts, start=1):
        attempt.pop("_merge_order", None)
        attempt["attempt_number"] = number

    canonical_rows = [
        row
        for row in (surviving, losing)
        if row[2] or str(row[1]) == "enriched"
    ]
    authority = max(
        canonical_rows or [surviving, losing],
        key=lambda row: (
            str(row[4] or ""),
            str(row[7] or ""),
            row is surviving,
        ),
    )
    fallback = losing if authority is surviving else surviving
    return (
        str(authority[1]),
        authority[2] or fallback[2],
        authority[3] or fallback[3],
        authority[4] or fallback[4],
        authority[5] or fallback[5],
        json.dumps(attempts, sort_keys=True),
        max(str(surviving[7]), str(losing[7])),
    )


def _merge_snapshot_rows_v11(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    losing_job_id: str,
    surviving_job_id: str,
) -> None:
    rows = conn.execute(
        """
        SELECT job_id, snapshot_set_json, latest_snapshot_version,
               latest_active_state, latest_confidence,
               latest_quarantine_reason, updated_at
        FROM posting_snapshot_sets
        WHERE tenant_id = ? AND job_id IN (?, ?)
        """,
        (tenant_id, losing_job_id, surviving_job_id),
    ).fetchall()
    by_job_id = {str(row[0]): row for row in rows}
    losing = by_job_id.get(losing_job_id)
    surviving = by_job_id.get(surviving_job_id)
    if losing is not None and surviving is None:
        data = _snapshot_json_object_for_merge(losing[1])
        data["tenant_id"] = tenant_id
        data["job_id"] = surviving_job_id
        conn.execute(
            """
            UPDATE posting_snapshot_sets
            SET job_id = ?, snapshot_set_json = ?
            WHERE tenant_id = ? AND job_id = ?
            """,
            (
                surviving_job_id,
                json.dumps(data, sort_keys=True),
                tenant_id,
                losing_job_id,
            ),
        )
    elif losing is not None and surviving is not None:
        merged_values = _merged_snapshot_record_values_v11(
            surviving=tuple(surviving),
            losing=tuple(losing),
            tenant_id=tenant_id,
            surviving_job_id=surviving_job_id,
            losing_job_id=losing_job_id,
        )
        conn.execute(
            """
            UPDATE posting_snapshot_sets
            SET snapshot_set_json = ?,
                latest_snapshot_version = ?,
                latest_active_state = ?,
                latest_confidence = ?,
                latest_quarantine_reason = ?,
                updated_at = ?
            WHERE tenant_id = ? AND job_id = ?
            """,
            (
                *merged_values[1:],
                tenant_id,
                surviving_job_id,
            ),
        )
        conn.execute(
            """
            DELETE FROM posting_snapshot_sets
            WHERE tenant_id = ? AND job_id = ?
            """,
            (tenant_id, losing_job_id),
        )

    snapshot_rows = conn.execute(
        """
        SELECT job_id, snapshot_set_json
        FROM posting_snapshot_sets
        WHERE tenant_id = ?
        """,
        (tenant_id,),
    ).fetchall()
    for row in snapshot_rows:
        owner_job_id = str(row[0])
        data = _snapshot_json_object_for_merge(row[1])
        changed = False
        candidates = data.get("duplicate_candidates") or []
        if not isinstance(candidates, list):
            raise RuntimeError(
                "URL collision merge found invalid duplicate candidates"
            )
        rewritten_candidates: dict[str, dict[str, Any]] = {}
        for candidate in candidates:
            if not isinstance(candidate, dict):
                raise RuntimeError(
                    "URL collision merge found an invalid duplicate candidate"
                )
            candidate_job_id = str(
                candidate.get("candidate_job_id") or ""
            )
            if candidate_job_id == losing_job_id:
                candidate_job_id = surviving_job_id
                changed = True
            if candidate_job_id == owner_job_id:
                changed = True
                continue
            copied = dict(candidate)
            copied["candidate_job_id"] = candidate_job_id
            if candidate_job_id in rewritten_candidates:
                changed = True
                continue
            rewritten_candidates[candidate_job_id] = copied
        if changed:
            data["tenant_id"] = tenant_id
            data["job_id"] = owner_job_id
            data["duplicate_candidates"] = list(
                rewritten_candidates.values()
            )
            conn.execute(
                """
                UPDATE posting_snapshot_sets
                SET snapshot_set_json = ?
                WHERE tenant_id = ? AND job_id = ?
                """,
                (json.dumps(data, sort_keys=True), tenant_id, owner_job_id),
            )


def _snapshot_json_object_for_merge(raw_json: Any) -> dict[str, Any]:
    try:
        data = json.loads(str(raw_json))
    except (TypeError, ValueError) as exc:
        raise RuntimeError(
            "URL collision merge found invalid snapshot aggregate JSON"
        ) from exc
    if not isinstance(data, dict):
        raise RuntimeError(
            "URL collision merge found non-object snapshot aggregate JSON"
        )
    for field in ("snapshots", "failures", "duplicate_candidates"):
        value = data.get(field) or []
        if not isinstance(value, list):
            raise RuntimeError(
                f"URL collision merge found invalid snapshot {field}"
            )
        if any(not isinstance(item, dict) for item in value):
            raise RuntimeError(
                f"URL collision merge found invalid item in snapshot {field}"
            )
    return data


def _merged_snapshot_record_values_v11(
    *,
    surviving: tuple[str, str, int, str, Any, Any, str],
    losing: tuple[str, str, int, str, Any, Any, str],
    tenant_id: str,
    surviving_job_id: str,
    losing_job_id: str,
) -> tuple[str, str, int, str, Any, Any, str]:
    """Merge two snapshot authorities while retaining every history item."""
    surviving_data = _snapshot_json_object_for_merge(surviving[1])
    losing_data = _snapshot_json_object_for_merge(losing[1])
    snapshots = [
        dict(snapshot)
        for data in (surviving_data, losing_data)
        for snapshot in data.get("snapshots") or []
    ]
    snapshots.sort(key=lambda snapshot: str(snapshot.get("captured_at") or ""))
    for version, snapshot in enumerate(snapshots, start=1):
        snapshot["snapshot_version"] = version
    failures = [
        dict(failure)
        for data in (surviving_data, losing_data)
        for failure in data.get("failures") or []
    ]
    failures.sort(key=lambda failure: str(failure.get("failed_at") or ""))

    authority, fallback = (
        (surviving, losing)
        if (str(surviving[6]), True) >= (str(losing[6]), False)
        else (losing, surviving)
    )
    authority_data = (
        surviving_data if authority is surviving else losing_data
    )
    fallback_data = losing_data if authority is surviving else surviving_data
    candidate_by_job_id: dict[str, dict[str, Any]] = {}
    for data in (authority_data, fallback_data):
        for candidate in data.get("duplicate_candidates") or []:
            candidate_job_id = str(
                candidate.get("candidate_job_id") or ""
            )
            if candidate_job_id == losing_job_id:
                candidate_job_id = surviving_job_id
            if candidate_job_id == surviving_job_id:
                continue
            copied = dict(candidate)
            copied["candidate_job_id"] = candidate_job_id
            candidate_by_job_id.setdefault(candidate_job_id, copied)

    updated_at = max(str(surviving[6]), str(losing[6]))
    latest = snapshots[-1] if snapshots else None
    latest_state = (
        str(latest.get("active_state") or "unknown")
        if latest is not None
        else str(authority[3] or "unknown")
    )
    latest_confidence = (
        latest.get("confidence")
        if latest is not None
        else authority[4] or fallback[4]
    )
    latest_quarantine_reason = (
        latest.get("quarantine_reason")
        if latest is not None
        else authority[5] or fallback[5]
    )
    merged = dict(authority_data)
    merged.update(
        {
            "tenant_id": tenant_id,
            "job_id": surviving_job_id,
            "snapshots": snapshots,
            "failures": failures,
            "duplicate_candidates": list(candidate_by_job_id.values()),
            "latest_active_state": latest_state,
            "updated_at": updated_at,
        }
    )
    return (
        surviving_job_id,
        json.dumps(merged, sort_keys=True),
        len(snapshots),
        latest_state,
        latest_confidence,
        latest_quarantine_reason,
        updated_at,
    )


def _reassign_execution_memberships(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    losing_job_id: str,
    surviving_job_id: str,
) -> None:
    losing_rows = conn.execute(
        """
        SELECT discover_workflow_id, discover_run_id, cohort_kind,
               source_family, source_run_id, preparation_workflow_id,
               work_plan_state, required_steps_json, work_plan_reason,
               linked_at
        FROM discovery_execution_jobs
        WHERE tenant_id = ? AND job_id = ?
        """,
        (tenant_id, losing_job_id),
    ).fetchall()
    for losing in losing_rows:
        workflow_id = str(losing[0])
        run_id = str(losing[1])
        surviving = conn.execute(
            """
            SELECT discover_workflow_id, discover_run_id, cohort_kind,
                   source_family, source_run_id, preparation_workflow_id,
                   work_plan_state, required_steps_json, work_plan_reason,
                   linked_at
            FROM discovery_execution_jobs
            WHERE tenant_id = ?
              AND discover_workflow_id = ?
              AND discover_run_id = ?
              AND job_id = ?
            """,
            (tenant_id, workflow_id, run_id, surviving_job_id),
        ).fetchone()
        if surviving is None:
            conn.execute(
                """
                UPDATE discovery_execution_jobs
                SET job_id = ?
                WHERE tenant_id = ?
                  AND discover_workflow_id = ?
                  AND discover_run_id = ?
                  AND job_id = ?
                """,
                (
                    surviving_job_id,
                    tenant_id,
                    workflow_id,
                    run_id,
                    losing_job_id,
                ),
            )
            continue

        cohort_kind = (
            "observed_this_run"
            if "observed_this_run" in {str(surviving[2]), str(losing[2])}
            else "existing_backlog"
        )
        if str(surviving[2]) == "observed_this_run":
            source_family = surviving[3]
            source_run_id = surviving[4]
        elif str(losing[2]) == "observed_this_run":
            source_family = losing[3]
            source_run_id = losing[4]
        else:
            source_family = surviving[3] or losing[3]
            source_run_id = surviving[4] or losing[4]

        work_plan = _merged_execution_work_plan(surviving, losing)
        linked_at = min(str(surviving[9]), str(losing[9]))
        conn.execute(
            """
            UPDATE discovery_execution_jobs
            SET cohort_kind = ?,
                source_family = ?,
                source_run_id = ?,
                preparation_workflow_id = ?,
                work_plan_state = ?,
                required_steps_json = ?,
                work_plan_reason = ?,
                linked_at = ?
            WHERE tenant_id = ?
              AND discover_workflow_id = ?
              AND discover_run_id = ?
              AND job_id = ?
            """,
            (
                cohort_kind,
                source_family,
                source_run_id,
                *work_plan,
                linked_at,
                tenant_id,
                workflow_id,
                run_id,
                surviving_job_id,
            ),
        )
        conn.execute(
            """
            DELETE FROM discovery_execution_jobs
            WHERE tenant_id = ?
              AND discover_workflow_id = ?
              AND discover_run_id = ?
              AND job_id = ?
            """,
            (tenant_id, workflow_id, run_id, losing_job_id),
        )

def _merged_execution_work_plan(
    surviving: sqlite3.Row | tuple[Any, ...],
    losing: sqlite3.Row | tuple[Any, ...],
) -> tuple[Any, str, Any, Any]:
    def plan(row: sqlite3.Row | tuple[Any, ...]) -> tuple[Any, str, Any, Any]:
        return (row[5], str(row[6]), row[7], row[8])

    surviving_plan = plan(surviving)
    losing_plan = plan(losing)
    surviving_decided = surviving_plan[1] in {"planned", "not_eligible"}
    losing_decided = losing_plan[1] in {"planned", "not_eligible"}
    if surviving_decided and losing_decided:
        if surviving_plan != losing_plan:
            raise RuntimeError("URL collision merge found conflicting decided execution work plans")
        return surviving_plan
    if surviving_decided:
        return surviving_plan
    if losing_decided:
        return losing_plan

    surviving_workflow = surviving_plan[0]
    losing_workflow = losing_plan[0]
    if surviving_workflow is not None and losing_workflow is not None and surviving_workflow != losing_workflow:
        raise RuntimeError("URL collision merge found conflicting preparation workflow owners")
    if surviving_workflow is None and losing_workflow is not None:
        return losing_plan
    if surviving_plan[1] == "pending" and losing_plan[1] == "failed":
        return losing_plan
    return surviving_plan

def _reassign_search_unit_receipts(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    losing_job_id: str,
    surviving_job_id: str,
) -> None:
    losing_rows = conn.execute(
        """
        SELECT discover_workflow_id, discover_run_id, unit_id,
               was_new, accepted_at
        FROM discovery_search_unit_jobs
        WHERE tenant_id = ? AND job_id = ?
        """,
        (tenant_id, losing_job_id),
    ).fetchall()
    for losing in losing_rows:
        workflow_id = str(losing[0])
        run_id = str(losing[1])
        unit_id = str(losing[2])
        surviving = conn.execute(
            """
            SELECT was_new, accepted_at
            FROM discovery_search_unit_jobs
            WHERE tenant_id = ?
              AND discover_workflow_id = ?
              AND discover_run_id = ?
              AND unit_id = ?
              AND job_id = ?
            """,
            (
                tenant_id,
                workflow_id,
                run_id,
                unit_id,
                surviving_job_id,
            ),
        ).fetchone()
        if surviving is None:
            conn.execute(
                """
                UPDATE discovery_search_unit_jobs
                SET job_id = ?
                WHERE tenant_id = ?
                  AND discover_workflow_id = ?
                  AND discover_run_id = ?
                  AND unit_id = ?
                  AND job_id = ?
                """,
                (
                    surviving_job_id,
                    tenant_id,
                    workflow_id,
                    run_id,
                    unit_id,
                    losing_job_id,
                ),
            )
            continue
        conn.execute(
            """
            UPDATE discovery_search_unit_jobs
            SET was_new = ?,
                accepted_at = ?
            WHERE tenant_id = ?
              AND discover_workflow_id = ?
              AND discover_run_id = ?
              AND unit_id = ?
              AND job_id = ?
            """,
            (
                max(int(surviving[0]), int(losing[3])),
                min(str(surviving[1]), str(losing[4])),
                tenant_id,
                workflow_id,
                run_id,
                unit_id,
                surviving_job_id,
            ),
        )
        conn.execute(
            """
            DELETE FROM discovery_search_unit_jobs
            WHERE tenant_id = ?
              AND discover_workflow_id = ?
              AND discover_run_id = ?
              AND unit_id = ?
              AND job_id = ?
            """,
            (tenant_id, workflow_id, run_id, unit_id, losing_job_id),
        )

def _table_columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    return {
        str(row[1])
        for row in conn.execute(f'PRAGMA table_info("{table_name}")').fetchall()
    }


def _legacy_or_stable_reference_column(
    conn: sqlite3.Connection,
    table: str,
    *,
    stable: str,
    legacy: str,
) -> str:
    columns = _table_columns(conn, table)
    if stable in columns:
        return stable
    if legacy in columns:
        return legacy
    raise RuntimeError(
        f"discovery identity migration found no job reference in {table}"
    )


def _resolved_job_id_sql(
    table_alias: str,
    reference_column: str,
    *,
    legacy_url: bool = False,
) -> str:
    """Return a correlated SQL expression resolving a legacy or stable key."""

    reference = f"{table_alias}.{reference_column}"
    tenant = f"{table_alias}.tenant_id"
    by_job_id = f"""
        (
            SELECT j.job_id
            FROM jobs j
            WHERE j.tenant_id = {tenant}
              AND j.job_id = {reference}
            LIMIT 1
        )
    """
    by_storage_url = f"""
        (
            SELECT j.job_id
            FROM jobs j
            WHERE j.tenant_id = {tenant}
              AND j.url = {reference}
            LIMIT 1
        )
    """
    by_posting_alias = f"""
        (
            SELECT a.job_id
            FROM job_identity_aliases a
            JOIN jobs j
              ON j.tenant_id = a.tenant_id
             AND j.job_id = a.job_id
            WHERE a.tenant_id = {tenant}
              AND a.alias_kind = 'posting_url'
              AND a.alias_value = {reference}
            LIMIT 1
        )
    """
    # A legacy URL token can itself be UUID-shaped. Resolve it through URL
    # ownership before considering a same-text JobId owned by another
    # aggregate. Stable or historically ambiguous columns retain the
    # migration framework's JobId-first behavior.
    lookups = (
        (by_storage_url, by_posting_alias, by_job_id) if legacy_url else (by_job_id, by_storage_url, by_posting_alias)
    )
    return f"COALESCE({','.join(lookups)})"


def _create_discovery_identity_v8_rebuild_tables(
    conn: sqlite3.Connection,
) -> None:
    for table in _DISCOVERY_IDENTITY_REFERENCE_TABLES:
        conn.execute(f'DROP TABLE IF EXISTS "{table}_v8"')
    conn.execute(
        """
        CREATE TABLE job_source_observations_v8 (
            tenant_id                TEXT NOT NULL DEFAULT 'local',
            source_observation_id    TEXT NOT NULL,
            job_id                   TEXT NOT NULL,
            source_id                TEXT NOT NULL,
            source_native_id         TEXT NOT NULL,
            observed_url             TEXT NOT NULL,
            normalized_observed_url  TEXT NOT NULL,
            run_id                   TEXT NOT NULL DEFAULT '',
            observed_at              TEXT NOT NULL,
            PRIMARY KEY (tenant_id, source_observation_id),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE job_canonical_identities_v8 (
            tenant_id          TEXT NOT NULL DEFAULT 'local',
            job_id             TEXT NOT NULL,
            canonical_url      TEXT NOT NULL,
            ats_kind           TEXT NOT NULL,
            source_native_id   TEXT NOT NULL,
            confidence         REAL NOT NULL,
            resolved_at        TEXT NOT NULL,
            PRIMARY KEY (tenant_id, job_id),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE job_duplicate_links_v8 (
            tenant_id                              TEXT NOT NULL DEFAULT 'local',
            duplicate_link_id                      TEXT NOT NULL,
            surviving_job_id                       TEXT NOT NULL,
            superseded_job_or_observation_id       TEXT NOT NULL,
            reason                                 TEXT NOT NULL,
            confidence                             REAL NOT NULL,
            linked_at                              TEXT NOT NULL,
            PRIMARY KEY (tenant_id, duplicate_link_id),
            FOREIGN KEY (tenant_id, surviving_job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE job_rejected_duplicate_links_v8 (
            tenant_id       TEXT NOT NULL DEFAULT 'local',
            owner_job_id    TEXT NOT NULL,
            candidate_url   TEXT NOT NULL,
            reason          TEXT NOT NULL,
            rejected_at     TEXT NOT NULL,
            PRIMARY KEY (tenant_id, owner_job_id, candidate_url),
            FOREIGN KEY (tenant_id, owner_job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        )
        """
    )


def _create_discovery_identity_v8_indexes(conn: sqlite3.Connection) -> None:
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
        ON job_source_observations(tenant_id, job_id)
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
        CREATE INDEX IF NOT EXISTS idx_job_duplicate_links_surviving
        ON job_duplicate_links(tenant_id, surviving_job_id)
        """
    )


def _has_composite_job_id_foreign_key(
    conn: sqlite3.Connection,
    table: str,
    reference_column: str,
) -> bool:
    groups: dict[int, set[tuple[str, str]]] = {}
    cascades: dict[int, bool] = {}
    for row in conn.execute(f'PRAGMA foreign_key_list("{table}")').fetchall():
        if str(row[2]) != "jobs":
            continue
        foreign_key_id = int(row[0])
        groups.setdefault(foreign_key_id, set()).add(
            (str(row[3]), str(row[4]))
        )
        cascades[foreign_key_id] = str(row[6]).upper() == "CASCADE"
    expected = {("tenant_id", "tenant_id"), (reference_column, "job_id")}
    return any(
        columns == expected and cascades.get(foreign_key_id, False)
        for foreign_key_id, columns in groups.items()
    )


def _primary_key_columns(
    conn: sqlite3.Connection,
    table: str,
) -> tuple[str, ...]:
    keyed = [
        (int(row[5]), str(row[1]))
        for row in conn.execute(f'PRAGMA table_info("{table}")').fetchall()
        if int(row[5]) > 0
    ]
    return tuple(column for _position, column in sorted(keyed))


def _has_index(
    conn: sqlite3.Connection,
    table: str,
    name: str,
    columns: tuple[str, ...],
    *,
    unique: bool,
) -> bool:
    index_row = next(
        (
            row
            for row in conn.execute(
                f'PRAGMA index_list("{table}")'
            ).fetchall()
            if str(row[1]) == name
        ),
        None,
    )
    if index_row is None or bool(index_row[2]) is not unique:
        return False
    actual_columns = tuple(
        str(row[2])
        for row in conn.execute(f'PRAGMA index_info("{name}")').fetchall()
    )
    return actual_columns == columns


def _has_discovery_identity_reference_schema_v8(
    conn: sqlite3.Connection,
) -> bool:
    return (
        "job_id" in _table_columns(conn, "job_source_observations")
        and "job_url" not in _table_columns(conn, "job_source_observations")
        and _primary_key_columns(conn, "job_source_observations")
        == ("tenant_id", "source_observation_id")
        and _has_composite_job_id_foreign_key(
            conn,
            "job_source_observations",
            "job_id",
        )
        and _has_index(
            conn,
            "job_source_observations",
            "idx_job_source_observations_native",
            ("tenant_id", "source_id", "source_native_id"),
            unique=True,
        )
        and _has_index(
            conn,
            "job_source_observations",
            "idx_job_source_observations_normalized_url",
            ("tenant_id", "normalized_observed_url"),
            unique=True,
        )
        and _has_index(
            conn,
            "job_source_observations",
            "idx_job_source_observations_job",
            ("tenant_id", "job_id"),
            unique=False,
        )
        and "job_id" in _table_columns(conn, "job_canonical_identities")
        and "job_url" not in _table_columns(conn, "job_canonical_identities")
        and _primary_key_columns(conn, "job_canonical_identities")
        == ("tenant_id", "job_id")
        and _has_composite_job_id_foreign_key(
            conn,
            "job_canonical_identities",
            "job_id",
        )
        and _has_index(
            conn,
            "job_canonical_identities",
            "idx_job_canonical_identities_canonical_url",
            ("tenant_id", "canonical_url"),
            unique=False,
        )
        and _primary_key_columns(conn, "job_duplicate_links")
        == ("tenant_id", "duplicate_link_id")
        and _has_composite_job_id_foreign_key(
            conn,
            "job_duplicate_links",
            "surviving_job_id",
        )
        and _has_index(
            conn,
            "job_duplicate_links",
            "idx_job_duplicate_links_surviving",
            ("tenant_id", "surviving_job_id"),
            unique=False,
        )
        and "owner_job_id"
        in _table_columns(conn, "job_rejected_duplicate_links")
        and "owner_job_url"
        not in _table_columns(conn, "job_rejected_duplicate_links")
        and _primary_key_columns(conn, "job_rejected_duplicate_links")
        == ("tenant_id", "owner_job_id", "candidate_url")
        and _has_composite_job_id_foreign_key(
            conn,
            "job_rejected_duplicate_links",
            "owner_job_id",
        )
    )


def _verify_discovery_identity_references_v8(
    conn: sqlite3.Connection,
    *,
    expected_counts: dict[str, int],
    check_all_foreign_keys: bool = True,
) -> None:
    if not _has_discovery_identity_reference_schema_v8(conn):
        raise RuntimeError("discovery identity migration did not create the stable reference schema")
    for table, expected_count in expected_counts.items():
        observed_count = int(conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
        if observed_count != expected_count:
            raise RuntimeError(
                "discovery identity migration changed row count for "
                f"{table}: expected {expected_count}, found {observed_count}"
            )

    references = (
        ("job_source_observations", "job_id"),
        ("job_canonical_identities", "job_id"),
        ("job_duplicate_links", "surviving_job_id"),
        ("job_rejected_duplicate_links", "owner_job_id"),
    )
    for table, column in references:
        orphan = conn.execute(
            f"""
            SELECT source.{column}
            FROM {table} source
            LEFT JOIN jobs j
              ON j.tenant_id = source.tenant_id
             AND j.job_id = source.{column}
            WHERE j.job_id IS NULL
            LIMIT 1
            """
        ).fetchone()
        if orphan is not None:
            raise RuntimeError(f"discovery identity migration left an unresolved reference in {table}.{column}")

    if check_all_foreign_keys:
        foreign_key_error = conn.execute("PRAGMA foreign_key_check").fetchone()
        if foreign_key_error is not None:
            raise RuntimeError("discovery identity migration found a foreign-key violation")


_EXECUTION_SEARCH_REFERENCE_SCHEMA_VERSION = 9
_EXECUTION_SEARCH_REFERENCE_TABLES = (
    "discovery_execution_jobs",
    "discovery_search_unit_jobs",
)


def ensure_execution_search_references_v9(
    conn: sqlite3.Connection | None = None,
) -> list[str]:
    """Move Discover membership and accepted receipts to stable JobIds."""
    if conn is None:
        conn = get_connection()

    current = _assert_schema_version_supported(conn)
    if current >= _EXECUTION_SEARCH_REFERENCE_SCHEMA_VERSION:
        return []
    if current != _DISCOVERY_IDENTITY_REFERENCE_SCHEMA_VERSION:
        raise RuntimeError("execution/search reference migration requires discovery identity schema v8")

    conn.execute("SAVEPOINT execution_search_references_v9")
    try:
        _verify_discovery_identity_references_v8(
            conn,
            expected_counts={
                table: int(conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
                for table in _DISCOVERY_IDENTITY_REFERENCE_TABLES
            },
            check_all_foreign_keys=False,
        )
        before_counts = {
            table: int(conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
            for table in _EXECUTION_SEARCH_REFERENCE_TABLES
        }

        if not _has_execution_search_reference_schema_v9(conn):
            execution_reference = _legacy_or_stable_reference_column(
                conn,
                "discovery_execution_jobs",
                stable="job_id",
                legacy="job_url",
            )
            receipt_reference = _legacy_or_stable_reference_column(
                conn,
                "discovery_search_unit_jobs",
                stable="job_id",
                legacy="job_url",
            )
            for table, reference_column in (
                ("discovery_execution_jobs", execution_reference),
                ("discovery_search_unit_jobs", receipt_reference),
            ):
                unresolved = conn.execute(
                    f"""
                    SELECT source.{reference_column}
                    FROM {table} AS source
                    WHERE {
                        _resolved_job_id_sql(
                            "source",
                            reference_column,
                            legacy_url=reference_column == "job_url",
                        )
                    }
                          IS NULL
                    LIMIT 1
                    """
                ).fetchone()
                if unresolved is not None:
                    raise RuntimeError(
                        "execution/search reference migration could not resolve "
                        f"{table}.{reference_column}={unresolved[0]!r}"
                    )

            _create_execution_search_v9_rebuild_tables(conn)
            conn.execute(
                f"""
                INSERT INTO discovery_execution_jobs_v9 (
                    tenant_id, discover_workflow_id, discover_run_id, job_id,
                    cohort_kind, source_family, source_run_id,
                    preparation_workflow_id, work_plan_state,
                    required_steps_json, work_plan_reason, linked_at
                )
                SELECT
                    source.tenant_id,
                    source.discover_workflow_id,
                    source.discover_run_id,
                    {
                    _resolved_job_id_sql(
                        "source",
                        execution_reference,
                        legacy_url=execution_reference == "job_url",
                    )
                },
                    source.cohort_kind,
                    source.source_family,
                    source.source_run_id,
                    source.preparation_workflow_id,
                    source.work_plan_state,
                    source.required_steps_json,
                    source.work_plan_reason,
                    source.linked_at
                FROM discovery_execution_jobs AS source
                """
            )
            conn.execute(
                f"""
                INSERT INTO discovery_search_unit_jobs_v9 (
                    tenant_id, discover_workflow_id, discover_run_id,
                    unit_id, job_id, was_new, accepted_at
                )
                SELECT
                    source.tenant_id,
                    source.discover_workflow_id,
                    source.discover_run_id,
                    source.unit_id,
                    {
                    _resolved_job_id_sql(
                        "source",
                        receipt_reference,
                        legacy_url=receipt_reference == "job_url",
                    )
                },
                    source.was_new,
                    source.accepted_at
                FROM discovery_search_unit_jobs AS source
                """
            )

            for table in _EXECUTION_SEARCH_REFERENCE_TABLES:
                conn.execute(f'DROP TABLE "{table}"')
                conn.execute(f'ALTER TABLE "{table}_v9" RENAME TO "{table}"')
            _create_execution_search_v9_indexes(conn)

        _verify_execution_search_references_v9(
            conn,
            expected_counts=before_counts,
        )
        conn.execute(f"PRAGMA user_version = {_EXECUTION_SEARCH_REFERENCE_SCHEMA_VERSION}")
        conn.execute("RELEASE SAVEPOINT execution_search_references_v9")
        conn.commit()
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT execution_search_references_v9")
        conn.execute("RELEASE SAVEPOINT execution_search_references_v9")
        raise

    return list(_EXECUTION_SEARCH_REFERENCE_TABLES)


def _create_execution_search_v9_rebuild_tables(
    conn: sqlite3.Connection,
) -> None:
    for table in _EXECUTION_SEARCH_REFERENCE_TABLES:
        conn.execute(f'DROP TABLE IF EXISTS "{table}_v9"')
    conn.execute(
        """
        CREATE TABLE discovery_execution_jobs_v9 (
            tenant_id                TEXT NOT NULL,
            discover_workflow_id     TEXT NOT NULL,
            discover_run_id          TEXT NOT NULL,
            job_id                   TEXT NOT NULL,
            cohort_kind              TEXT NOT NULL
                CHECK (cohort_kind IN (
                    'observed_this_run', 'existing_backlog'
                )),
            source_family            TEXT,
            source_run_id            TEXT,
            preparation_workflow_id  TEXT,
            work_plan_state          TEXT NOT NULL DEFAULT 'pending'
                CHECK (work_plan_state IN (
                    'pending', 'planned', 'not_eligible', 'failed'
                )),
            required_steps_json      TEXT,
            work_plan_reason         TEXT,
            linked_at                TEXT NOT NULL,
            PRIMARY KEY (
                tenant_id, discover_workflow_id, discover_run_id, job_id
            ),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE discovery_search_unit_jobs_v9 (
            tenant_id              TEXT NOT NULL,
            discover_workflow_id   TEXT NOT NULL,
            discover_run_id        TEXT NOT NULL,
            unit_id                TEXT NOT NULL,
            job_id                 TEXT NOT NULL,
            was_new                INTEGER NOT NULL CHECK (was_new IN (0, 1)),
            accepted_at            TEXT NOT NULL,
            PRIMARY KEY (
                tenant_id, discover_workflow_id, discover_run_id,
                unit_id, job_id
            ),
            FOREIGN KEY (
                tenant_id, discover_workflow_id, discover_run_id, unit_id
            ) REFERENCES discovery_search_units(
                tenant_id, discover_workflow_id, discover_run_id, unit_id
            ) ON DELETE CASCADE,
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        )
        """
    )


def _create_execution_search_v9_indexes(conn: sqlite3.Connection) -> None:
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
        ON discovery_execution_jobs(tenant_id, job_id, linked_at)
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


def _has_search_unit_foreign_key(conn: sqlite3.Connection) -> bool:
    groups: dict[int, set[tuple[str, str]]] = {}
    cascades: dict[int, bool] = {}
    for row in conn.execute('PRAGMA foreign_key_list("discovery_search_unit_jobs")').fetchall():
        if str(row[2]) != "discovery_search_units":
            continue
        foreign_key_id = int(row[0])
        groups.setdefault(foreign_key_id, set()).add((str(row[3]), str(row[4])))
        cascades[foreign_key_id] = str(row[6]).upper() == "CASCADE"
    expected = {
        ("tenant_id", "tenant_id"),
        ("discover_workflow_id", "discover_workflow_id"),
        ("discover_run_id", "discover_run_id"),
        ("unit_id", "unit_id"),
    }
    return any(
        columns == expected and cascades.get(foreign_key_id, False) for foreign_key_id, columns in groups.items()
    )


def _has_execution_search_reference_schema_v9(
    conn: sqlite3.Connection,
) -> bool:
    return (
        "job_id" in _table_columns(conn, "discovery_execution_jobs")
        and "job_url" not in _table_columns(conn, "discovery_execution_jobs")
        and _primary_key_columns(conn, "discovery_execution_jobs")
        == (
            "tenant_id",
            "discover_workflow_id",
            "discover_run_id",
            "job_id",
        )
        and _has_composite_job_id_foreign_key(
            conn,
            "discovery_execution_jobs",
            "job_id",
        )
        and _has_index(
            conn,
            "discovery_execution_jobs",
            "idx_discovery_execution_jobs_cohort",
            (
                "tenant_id",
                "discover_workflow_id",
                "discover_run_id",
                "cohort_kind",
            ),
            unique=False,
        )
        and _has_index(
            conn,
            "discovery_execution_jobs",
            "idx_discovery_execution_jobs_plan",
            (
                "tenant_id",
                "discover_workflow_id",
                "discover_run_id",
                "work_plan_state",
            ),
            unique=False,
        )
        and _has_index(
            conn,
            "discovery_execution_jobs",
            "idx_discovery_execution_jobs_job",
            ("tenant_id", "job_id", "linked_at"),
            unique=False,
        )
        and "job_id" in _table_columns(conn, "discovery_search_unit_jobs")
        and "job_url" not in _table_columns(conn, "discovery_search_unit_jobs")
        and _primary_key_columns(conn, "discovery_search_unit_jobs")
        == (
            "tenant_id",
            "discover_workflow_id",
            "discover_run_id",
            "unit_id",
            "job_id",
        )
        and _has_search_unit_foreign_key(conn)
        and _has_composite_job_id_foreign_key(
            conn,
            "discovery_search_unit_jobs",
            "job_id",
        )
        and _has_index(
            conn,
            "discovery_search_unit_jobs",
            "idx_discovery_search_unit_jobs_execution",
            (
                "tenant_id",
                "discover_workflow_id",
                "discover_run_id",
                "was_new",
            ),
            unique=False,
        )
    )


def _verify_execution_search_references_v9(
    conn: sqlite3.Connection,
    *,
    expected_counts: dict[str, int],
) -> None:
    if not _has_execution_search_reference_schema_v9(conn):
        raise RuntimeError("execution/search reference migration did not create the stable reference schema")
    for table, expected_count in expected_counts.items():
        observed_count = int(conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
        if observed_count != expected_count:
            raise RuntimeError(
                "execution/search reference migration changed row count for "
                f"{table}: expected {expected_count}, found {observed_count}"
            )
        orphan = conn.execute(
            f"""
            SELECT source.job_id
            FROM {table} AS source
            LEFT JOIN jobs j
              ON j.tenant_id = source.tenant_id
             AND j.job_id = source.job_id
            WHERE j.job_id IS NULL
            LIMIT 1
            """
        ).fetchone()
        if orphan is not None:
            raise RuntimeError(f"execution/search reference migration left an unresolved reference in {table}.job_id")

    foreign_key_error = conn.execute("PRAGMA foreign_key_check").fetchone()
    if foreign_key_error is not None:
        raise RuntimeError("execution/search reference migration found a foreign-key violation")


_PREPARATION_REFERENCE_SCHEMA_VERSION = 10


def ensure_preparation_references_v10(
    conn: sqlite3.Connection | None = None,
) -> list[str]:
    """Move legacy preparation work-item references to stable JobIds.

    The table's historical idempotency keys are opaque workflow-association
    facts and remain byte-for-byte unchanged. The later quiescent workflow
    cutover owns the transition to stable-ID-derived Temporal workflow keys.
    """
    if conn is None:
        conn = get_connection()

    current = _assert_schema_version_supported(conn)
    if current >= _PREPARATION_REFERENCE_SCHEMA_VERSION:
        return []
    if current != _EXECUTION_SEARCH_REFERENCE_SCHEMA_VERSION:
        raise RuntimeError(
            "preparation reference migration requires execution/search schema v9"
        )

    conn.execute("SAVEPOINT preparation_references_v10")
    try:
        _verify_execution_search_references_v9(
            conn,
            expected_counts={
                table: int(
                    conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
                )
                for table in _EXECUTION_SEARCH_REFERENCE_TABLES
            },
        )
        before_count = int(
            conn.execute("SELECT COUNT(*) FROM preparation_work_items").fetchone()[0]
        )

        if not _has_preparation_reference_schema_v10(conn):
            columns = _table_columns(conn, "preparation_work_items")
            if "job_id" not in columns:
                raise RuntimeError(
                    "preparation reference migration found no job reference "
                    "in preparation_work_items"
                )
            resolved_job_id = _resolved_job_id_sql(
                "source",
                "job_id",
                legacy_url=True,
            )
            unresolved = conn.execute(
                f"""
                SELECT source.job_id
                FROM preparation_work_items AS source
                WHERE {resolved_job_id} IS NULL
                LIMIT 1
                """
            ).fetchone()
            if unresolved is not None:
                raise RuntimeError(
                    "preparation reference migration could not resolve "
                    f"preparation_work_items.job_id={unresolved[0]!r}"
                )

            conn.execute("DROP TABLE IF EXISTS preparation_work_items_v10")
            _create_preparation_work_items_v10(
                conn,
                table_name="preparation_work_items_v10",
            )
            conn.execute(
                f"""
                INSERT INTO preparation_work_items_v10 (
                    item_id, tenant_id, job_id, kind, target_version,
                    source_event_id, state, idempotency_key, attempts,
                    last_error, created_at, updated_at, available_at
                )
                SELECT
                    source.item_id,
                    source.tenant_id,
                    {resolved_job_id},
                    source.kind,
                    source.target_version,
                    source.source_event_id,
                    source.state,
                    source.idempotency_key,
                    source.attempts,
                    source.last_error,
                    source.created_at,
                    source.updated_at,
                    source.available_at
                FROM preparation_work_items AS source
                """
            )
            conn.execute("DROP TABLE preparation_work_items")
            conn.execute(
                "ALTER TABLE preparation_work_items_v10 "
                "RENAME TO preparation_work_items"
            )
            _create_preparation_work_item_indexes(conn)

        _verify_preparation_references_v10(
            conn,
            expected_count=before_count,
        )
        conn.execute(
            f"PRAGMA user_version = {_PREPARATION_REFERENCE_SCHEMA_VERSION}"
        )
        conn.execute("RELEASE SAVEPOINT preparation_references_v10")
        conn.commit()
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT preparation_references_v10")
        conn.execute("RELEASE SAVEPOINT preparation_references_v10")
        raise

    return ["preparation_work_items"]


def _create_preparation_work_items_v10(
    conn: sqlite3.Connection,
    *,
    table_name: str = "preparation_work_items",
) -> None:
    conn.execute(
        f"""
        CREATE TABLE {table_name} (
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
            available_at     TEXT NOT NULL,
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        )
        """
    )


def _create_preparation_work_item_indexes(
    conn: sqlite3.Connection,
) -> None:
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


def _has_preparation_reference_schema_v10(
    conn: sqlite3.Connection,
) -> bool:
    return (
        "job_id" in _table_columns(conn, "preparation_work_items")
        and _primary_key_columns(conn, "preparation_work_items") == ("item_id",)
        and _has_composite_job_id_foreign_key(
            conn,
            "preparation_work_items",
            "job_id",
        )
        and _has_index(
            conn,
            "preparation_work_items",
            "idx_preparation_work_items_idempotency",
            ("tenant_id", "idempotency_key"),
            unique=True,
        )
        and _has_index(
            conn,
            "preparation_work_items",
            "idx_preparation_work_items_claim",
            ("tenant_id", "state", "kind", "available_at"),
            unique=False,
        )
        and _has_index(
            conn,
            "preparation_work_items",
            "idx_preparation_work_items_job_target",
            ("tenant_id", "job_id", "kind", "target_version"),
            unique=False,
        )
    )


def _verify_preparation_references_v10(
    conn: sqlite3.Connection,
    *,
    expected_count: int,
) -> None:
    if not _has_preparation_reference_schema_v10(conn):
        raise RuntimeError(
            "preparation reference migration did not create the stable "
            "reference schema"
        )
    observed_count = int(
        conn.execute("SELECT COUNT(*) FROM preparation_work_items").fetchone()[0]
    )
    if observed_count != expected_count:
        raise RuntimeError(
            "preparation reference migration changed row count for "
            "preparation_work_items: "
            f"expected {expected_count}, found {observed_count}"
        )
    orphan = conn.execute(
        """
        SELECT source.job_id
        FROM preparation_work_items AS source
        LEFT JOIN jobs j
          ON j.tenant_id = source.tenant_id
         AND j.job_id = source.job_id
        WHERE j.job_id IS NULL
        LIMIT 1
        """
    ).fetchone()
    if orphan is not None:
        raise RuntimeError(
            "preparation reference migration left an unresolved reference "
            "in preparation_work_items.job_id"
        )
    foreign_key_error = conn.execute("PRAGMA foreign_key_check").fetchone()
    if foreign_key_error is not None:
        raise RuntimeError(
            "preparation reference migration found a foreign-key violation"
        )


_ENRICHMENT_SNAPSHOT_REFERENCE_SCHEMA_VERSION = 11
_ENRICHMENT_SNAPSHOT_REFERENCE_TABLES = (
    "job_enrichments",
    "posting_snapshot_sets",
)


def ensure_enrichment_snapshot_references_v11(
    conn: sqlite3.Connection | None = None,
) -> list[str]:
    """Move Enrichment-owned references and embedded identity to JobIds."""
    if conn is None:
        conn = get_connection()

    current = _assert_schema_version_supported(conn)
    if current >= _ENRICHMENT_SNAPSHOT_REFERENCE_SCHEMA_VERSION:
        return []
    if current != _PREPARATION_REFERENCE_SCHEMA_VERSION:
        raise RuntimeError(
            "enrichment/snapshot reference migration requires preparation "
            "schema v10"
        )

    conn.execute("SAVEPOINT enrichment_snapshot_references_v11")
    try:
        _verify_enrichment_snapshot_prerequisites_v11(conn)
        before_counts = {
            table: int(
                conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            )
            for table in _ENRICHMENT_SNAPSHOT_REFERENCE_TABLES
        }
        expected_counts = dict(before_counts)

        if not _has_enrichment_snapshot_reference_schema_v11(conn):
            enrichment_reference = _enrichment_snapshot_reference_column(
                conn,
                "job_enrichments",
            )
            snapshot_reference = _enrichment_snapshot_reference_column(
                conn,
                "posting_snapshot_sets",
            )
            reference_columns = {
                "job_enrichments": enrichment_reference,
                "posting_snapshot_sets": snapshot_reference,
            }
            for table, reference_column in reference_columns.items():
                legacy_url = reference_column == "job_url"
                resolved_job_id = _resolved_job_id_sql(
                    "source",
                    reference_column,
                    legacy_url=legacy_url,
                )
                unresolved = conn.execute(
                    f"""
                    SELECT source.{reference_column}
                    FROM {table} AS source
                    WHERE {resolved_job_id} IS NULL
                    LIMIT 1
                    """
                ).fetchone()
                if unresolved is not None:
                    raise RuntimeError(
                        "enrichment/snapshot reference migration could not "
                        f"resolve {table}.{reference_column}={unresolved[0]!r}"
                    )

            conn.execute("DROP TABLE IF EXISTS job_enrichments_v11")
            conn.execute("DROP TABLE IF EXISTS posting_snapshot_sets_v11")
            _create_job_enrichments_v11(
                conn,
                table_name="job_enrichments_v11",
            )
            _create_posting_snapshot_sets_v11(
                conn,
                table_name="posting_snapshot_sets_v11",
            )

            enrichment_rows = conn.execute(
                f"""
                SELECT
                    source.tenant_id,
                    source.{enrichment_reference},
                    source.current_status,
                    source.full_description,
                    source.application_url,
                    source.enriched_at,
                    source.extraction_tier,
                    source.attempts_json,
                    source.updated_at
                FROM job_enrichments AS source
                ORDER BY source.tenant_id, source.{enrichment_reference}
                """
            ).fetchall()
            canonical_enrichments: dict[
                tuple[str, str],
                tuple[str, str, Any, Any, Any, Any, str, str],
            ] = {}
            for row in enrichment_rows:
                tenant_id = str(row[0])
                raw_reference = str(row[1])
                stable_job_id = _resolve_job_reference_value(
                    conn,
                    tenant_id=tenant_id,
                    reference=raw_reference,
                    legacy_url=enrichment_reference == "job_url",
                )
                if stable_job_id is None:
                    raise RuntimeError(
                        "enrichment/snapshot reference migration could not "
                        "resolve job_enrichments identity for "
                        f"{raw_reference!r}"
                    )
                candidate = (
                    stable_job_id,
                    str(row[2]),
                    row[3],
                    row[4],
                    row[5],
                    row[6],
                    str(row[7] or "[]"),
                    str(row[8]),
                )
                key = (tenant_id, stable_job_id)
                existing = canonical_enrichments.get(key)
                if existing is not None:
                    candidate = (
                        stable_job_id,
                        *_merged_enrichment_values_v11(
                            surviving=existing,
                            losing=candidate,
                            allow_conflicting_descriptions=True,
                        ),
                    )
                canonical_enrichments[key] = candidate
            conn.executemany(
                """
                INSERT INTO job_enrichments_v11 (
                    tenant_id, job_id, current_status, full_description,
                    application_url, enriched_at, extraction_tier,
                    attempts_json, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    (tenant_id, *record)
                    for (tenant_id, _job_id), record
                    in canonical_enrichments.items()
                ),
            )
            expected_counts["job_enrichments"] = len(
                canonical_enrichments
            )

            snapshot_rows = conn.execute(
                f"""
                SELECT
                    source.tenant_id,
                    source.{snapshot_reference},
                    source.snapshot_set_json,
                    source.latest_snapshot_version,
                    source.latest_active_state,
                    source.latest_confidence,
                    source.latest_quarantine_reason,
                    source.updated_at
                FROM posting_snapshot_sets AS source
                ORDER BY source.tenant_id, source.{snapshot_reference}
                """
            ).fetchall()
            canonical_snapshots: dict[
                tuple[str, str],
                tuple[str, str, int, str, Any, Any, str],
            ] = {}
            for row in snapshot_rows:
                tenant_id = str(row[0])
                raw_reference = str(row[1])
                stable_job_id = _resolve_job_reference_value(
                    conn,
                    tenant_id=tenant_id,
                    reference=raw_reference,
                    legacy_url=snapshot_reference == "job_url",
                )
                if stable_job_id is None:
                    raise RuntimeError(
                        "enrichment/snapshot reference migration could not "
                        "resolve posting_snapshot_sets embedded identity for "
                        f"{raw_reference!r}"
                    )
                rewritten_json = _rewrite_snapshot_set_identity_v11(
                    conn,
                    tenant_id=tenant_id,
                    stable_job_id=stable_job_id,
                    raw_json=str(row[2]),
                    legacy_url=snapshot_reference == "job_url",
                )
                candidate = (
                    stable_job_id,
                    rewritten_json,
                    int(row[3]),
                    str(row[4]),
                    row[5],
                    row[6],
                    str(row[7]),
                )
                key = (tenant_id, stable_job_id)
                existing = canonical_snapshots.get(key)
                if existing is not None:
                    candidate = _merged_snapshot_record_values_v11(
                        surviving=existing,
                        losing=candidate,
                        tenant_id=tenant_id,
                        surviving_job_id=stable_job_id,
                        losing_job_id=stable_job_id,
                    )
                canonical_snapshots[key] = candidate
            conn.executemany(
                """
                INSERT INTO posting_snapshot_sets_v11 (
                    tenant_id, job_id, snapshot_set_json,
                    latest_snapshot_version, latest_active_state,
                    latest_confidence, latest_quarantine_reason, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    (tenant_id, *record)
                    for (tenant_id, _job_id), record
                    in canonical_snapshots.items()
                ),
            )
            expected_counts["posting_snapshot_sets"] = len(
                canonical_snapshots
            )

            for table in _ENRICHMENT_SNAPSHOT_REFERENCE_TABLES:
                conn.execute(f'DROP TABLE "{table}"')
                conn.execute(
                    f'ALTER TABLE "{table}_v11" RENAME TO "{table}"'
                )
            _create_job_enrichment_indexes(conn)
            _create_posting_snapshot_set_indexes(conn)

        _verify_enrichment_snapshot_references_v11(
            conn,
            expected_counts=expected_counts,
        )
        conn.execute(
            f"PRAGMA user_version = "
            f"{_ENRICHMENT_SNAPSHOT_REFERENCE_SCHEMA_VERSION}"
        )
        conn.execute("RELEASE SAVEPOINT enrichment_snapshot_references_v11")
        conn.commit()
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT enrichment_snapshot_references_v11")
        conn.execute("RELEASE SAVEPOINT enrichment_snapshot_references_v11")
        raise

    return list(_ENRICHMENT_SNAPSHOT_REFERENCE_TABLES)


def _verify_enrichment_snapshot_prerequisites_v11(
    conn: sqlite3.Connection,
) -> None:
    """Verify the v10 authority without inspecting v11 migration targets."""
    if not _has_preparation_reference_schema_v10(conn):
        raise RuntimeError(
            "enrichment/snapshot reference migration requires the stable "
            "preparation reference schema"
        )
    orphan = conn.execute(
        """
        SELECT source.job_id
        FROM preparation_work_items AS source
        LEFT JOIN jobs j
          ON j.tenant_id = source.tenant_id
         AND j.job_id = source.job_id
        WHERE j.job_id IS NULL
        LIMIT 1
        """
    ).fetchone()
    if orphan is not None:
        raise RuntimeError(
            "enrichment/snapshot reference migration found an unresolved "
            "preparation_work_items.job_id prerequisite"
        )


def _enrichment_snapshot_reference_column(
    conn: sqlite3.Connection,
    table: str,
) -> str:
    columns = _table_columns(conn, table)
    if "job_id" in columns:
        return "job_id"
    if "job_url" in columns:
        return "job_url"
    raise RuntimeError(
        "enrichment/snapshot reference migration found no job reference "
        f"in {table}"
    )


def _create_job_enrichments_v11(
    conn: sqlite3.Connection,
    *,
    table_name: str = "job_enrichments",
) -> None:
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {table_name} (
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            job_id              TEXT NOT NULL,
            current_status      TEXT NOT NULL,
            full_description    TEXT,
            application_url     TEXT,
            enriched_at         TEXT,
            extraction_tier     TEXT,
            attempts_json       TEXT NOT NULL DEFAULT '[]',
            updated_at          TEXT NOT NULL,
            PRIMARY KEY (tenant_id, job_id),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        )
        """
    )


def _create_posting_snapshot_sets_v11(
    conn: sqlite3.Connection,
    *,
    table_name: str = "posting_snapshot_sets",
) -> None:
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {table_name} (
            tenant_id                TEXT NOT NULL DEFAULT 'local',
            job_id                   TEXT NOT NULL,
            snapshot_set_json        TEXT NOT NULL,
            latest_snapshot_version  INTEGER NOT NULL DEFAULT 0,
            latest_active_state      TEXT NOT NULL DEFAULT 'unknown',
            latest_confidence        TEXT,
            latest_quarantine_reason TEXT,
            updated_at               TEXT NOT NULL,
            PRIMARY KEY (tenant_id, job_id),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        )
        """
    )


def _create_job_enrichment_indexes(conn: sqlite3.Connection) -> None:
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


def _create_posting_snapshot_set_indexes(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_posting_snapshot_sets_updated
        ON posting_snapshot_sets(tenant_id, updated_at DESC)
        """
    )


def _has_enrichment_snapshot_reference_schema_v11(
    conn: sqlite3.Connection,
) -> bool:
    return (
        "job_id" in _table_columns(conn, "job_enrichments")
        and "job_url" not in _table_columns(conn, "job_enrichments")
        and _primary_key_columns(conn, "job_enrichments")
        == ("tenant_id", "job_id")
        and _has_composite_job_id_foreign_key(
            conn,
            "job_enrichments",
            "job_id",
        )
        and _has_index(
            conn,
            "job_enrichments",
            "idx_job_enrichments_tenant_status",
            ("tenant_id", "current_status", "updated_at"),
            unique=False,
        )
        and _has_index(
            conn,
            "job_enrichments",
            "idx_job_enrichments_enriched_at",
            ("enriched_at",),
            unique=False,
        )
        and "job_id" in _table_columns(conn, "posting_snapshot_sets")
        and "job_url" not in _table_columns(conn, "posting_snapshot_sets")
        and _primary_key_columns(conn, "posting_snapshot_sets")
        == ("tenant_id", "job_id")
        and _has_composite_job_id_foreign_key(
            conn,
            "posting_snapshot_sets",
            "job_id",
        )
        and _has_index(
            conn,
            "posting_snapshot_sets",
            "idx_posting_snapshot_sets_updated",
            ("tenant_id", "updated_at"),
            unique=False,
        )
    )


def _resolve_job_reference_value(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    reference: str,
    legacy_url: bool,
) -> str | None:
    by_job_id = (
        "SELECT job_id FROM jobs "
        "WHERE tenant_id = ? AND job_id = ? LIMIT 1"
    )
    by_storage_url = (
        "SELECT job_id FROM jobs "
        "WHERE tenant_id = ? AND url = ? LIMIT 1"
    )
    by_posting_alias = """
        SELECT a.job_id
        FROM job_identity_aliases a
        JOIN jobs j
          ON j.tenant_id = a.tenant_id
         AND j.job_id = a.job_id
        WHERE a.tenant_id = ?
          AND a.alias_kind = 'posting_url'
          AND a.alias_value = ?
        LIMIT 1
    """
    lookups = (
        (by_storage_url, by_posting_alias, by_job_id)
        if legacy_url
        else (by_job_id, by_storage_url, by_posting_alias)
    )
    for sql in lookups:
        row = conn.execute(sql, (tenant_id, reference)).fetchone()
        if row is not None:
            return str(row[0])
    return None


def _rewrite_snapshot_set_identity_v11(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    stable_job_id: str,
    raw_json: str,
    legacy_url: bool,
) -> str:
    try:
        data = json.loads(raw_json)
    except (TypeError, ValueError) as exc:
        raise RuntimeError(
            "enrichment/snapshot reference migration found invalid "
            "posting_snapshot_sets.snapshot_set_json"
        ) from exc
    if not isinstance(data, dict):
        raise RuntimeError(
            "enrichment/snapshot reference migration requires snapshot JSON "
            "to be an object"
        )

    embedded_tenant = str(data.get("tenant_id") or tenant_id)
    if embedded_tenant != tenant_id:
        raise RuntimeError(
            "enrichment/snapshot reference migration found a snapshot tenant "
            "that does not match its row"
        )
    embedded_reference = str(data.get("job_id") or "").strip()
    if embedded_reference:
        embedded_job_id = _resolve_job_reference_value(
            conn,
            tenant_id=tenant_id,
            reference=embedded_reference,
            legacy_url=legacy_url,
        )
        if embedded_job_id != stable_job_id:
            raise RuntimeError(
                "enrichment/snapshot reference migration found embedded "
                "snapshot identity that does not match its row"
            )

    candidates = data.get("duplicate_candidates") or []
    if not isinstance(candidates, list):
        raise RuntimeError(
            "enrichment/snapshot reference migration requires "
            "duplicate_candidates to be a list"
        )
    rewritten_candidates: dict[str, dict[str, Any]] = {}
    for candidate in candidates:
        if not isinstance(candidate, dict):
            raise RuntimeError(
                "enrichment/snapshot reference migration found an invalid "
                "duplicate candidate"
            )
        candidate_reference = str(
            candidate.get("candidate_job_id") or ""
        ).strip()
        candidate_job_id = _resolve_job_reference_value(
            conn,
            tenant_id=tenant_id,
            reference=candidate_reference,
            legacy_url=legacy_url,
        )
        if candidate_job_id is None:
            raise RuntimeError(
                "enrichment/snapshot reference migration could not resolve "
                "embedded duplicate candidate "
                f"{candidate_reference!r}"
            )
        if candidate_job_id == stable_job_id:
            continue
        copied = dict(candidate)
        copied["candidate_job_id"] = candidate_job_id
        rewritten_candidates.setdefault(candidate_job_id, copied)

    data["tenant_id"] = tenant_id
    data["job_id"] = stable_job_id
    data["duplicate_candidates"] = list(rewritten_candidates.values())
    return json.dumps(data, sort_keys=True)


def _verify_enrichment_snapshot_references_v11(
    conn: sqlite3.Connection,
    *,
    expected_counts: dict[str, int],
) -> None:
    if not _has_enrichment_snapshot_reference_schema_v11(conn):
        raise RuntimeError(
            "enrichment/snapshot reference migration did not create the "
            "stable reference schema"
        )
    for table, expected_count in expected_counts.items():
        observed_count = int(
            conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        )
        if observed_count != expected_count:
            raise RuntimeError(
                "enrichment/snapshot reference migration changed row count "
                f"for {table}: expected {expected_count}, found {observed_count}"
            )
        orphan = conn.execute(
            f"""
            SELECT source.job_id
            FROM {table} AS source
            LEFT JOIN jobs j
              ON j.tenant_id = source.tenant_id
             AND j.job_id = source.job_id
            WHERE j.job_id IS NULL
            LIMIT 1
            """
        ).fetchone()
        if orphan is not None:
            raise RuntimeError(
                "enrichment/snapshot reference migration left an unresolved "
                f"reference in {table}.job_id"
            )

    snapshot_rows = conn.execute(
        """
        SELECT tenant_id, job_id, snapshot_set_json, latest_snapshot_version
        FROM posting_snapshot_sets
        """
    ).fetchall()
    for row in snapshot_rows:
        tenant_id = str(row[0])
        job_id = str(row[1])
        _validate_job_uuid(job_id)
        try:
            data = json.loads(str(row[2]))
        except (TypeError, ValueError) as exc:
            raise RuntimeError(
                "enrichment/snapshot reference migration persisted invalid "
                "snapshot JSON"
            ) from exc
        if not isinstance(data, dict):
            raise RuntimeError(
                "enrichment/snapshot reference migration persisted non-object "
                "snapshot JSON"
            )
        if str(data.get("tenant_id") or "") != tenant_id:
            raise RuntimeError(
                "enrichment/snapshot reference migration persisted mismatched "
                "snapshot tenant identity"
            )
        if str(data.get("job_id") or "") != job_id:
            raise RuntimeError(
                "enrichment/snapshot reference migration persisted mismatched "
                "snapshot JobId"
            )
        snapshots = data.get("snapshots") or []
        if not isinstance(snapshots, list) or len(snapshots) != int(row[3]):
            raise RuntimeError(
                "enrichment/snapshot reference migration changed snapshot "
                "version history"
            )
        candidates = data.get("duplicate_candidates") or []
        if not isinstance(candidates, list):
            raise RuntimeError(
                "enrichment/snapshot reference migration persisted invalid "
                "duplicate candidates"
            )
        for candidate in candidates:
            candidate_job_id = str(
                candidate.get("candidate_job_id") if isinstance(candidate, dict) else ""
            )
            _validate_job_uuid(candidate_job_id)
            if candidate_job_id == job_id:
                raise RuntimeError(
                    "enrichment/snapshot reference migration persisted a "
                    "self-referential duplicate candidate"
                )
            exists = conn.execute(
                """
                SELECT 1
                FROM jobs
                WHERE tenant_id = ? AND job_id = ?
                LIMIT 1
                """,
                (tenant_id, candidate_job_id),
            ).fetchone()
            if exists is None:
                raise RuntimeError(
                    "enrichment/snapshot reference migration persisted an "
                    "unresolved duplicate candidate"
                )

    foreign_key_error = conn.execute("PRAGMA foreign_key_check").fetchone()
    if foreign_key_error is not None:
        raise RuntimeError(
            "enrichment/snapshot reference migration found a foreign-key "
            "violation"
        )


_SCORING_REFERENCE_SCHEMA_VERSION = 12
_SCORING_REFERENCE_TABLES = (
    "job_scores",
    "job_score_staleness",
    "job_requirement_fit_reports",
    "job_requirement_fit_items",
)


def _create_job_scores_v12(
    conn: sqlite3.Connection,
    *,
    table_name: str = "job_scores",
) -> None:
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {table_name} (
            tenant_id        TEXT NOT NULL DEFAULT 'local',
            job_id           TEXT NOT NULL,
            version          INTEGER NOT NULL CHECK(version > 0),
            fit_score        INTEGER NOT NULL CHECK(fit_score BETWEEN 1 AND 10),
            breakdown_json   TEXT NOT NULL,
            keywords_json    TEXT NOT NULL,
            scored_at        TEXT NOT NULL,
            correction_json  TEXT,
            criteria_json    TEXT NOT NULL DEFAULT '{{}}',
            trace_json       TEXT NOT NULL DEFAULT '{{}}',
            PRIMARY KEY (tenant_id, job_id, version),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        )
        """
    )


def _create_score_staleness_v12(
    conn: sqlite3.Connection,
    *,
    table_name: str = "job_score_staleness",
) -> None:
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {table_name} (
            tenant_id                 TEXT NOT NULL DEFAULT 'local',
            job_id                   TEXT NOT NULL,
            stale_reason              TEXT NOT NULL,
            old_policy_id             TEXT NOT NULL DEFAULT '',
            old_policy_version        INTEGER NOT NULL,
            new_policy_id             TEXT NOT NULL DEFAULT '',
            new_policy_version        INTEGER NOT NULL,
            marked_at                 TEXT NOT NULL,
            resolved                  INTEGER NOT NULL DEFAULT 0
                CHECK(resolved IN (0, 1)),
            resolved_at               TEXT,
            resolved_by_score_version INTEGER,
            PRIMARY KEY (
                tenant_id, job_id, stale_reason,
                old_policy_version, new_policy_version
            ),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        )
        """
    )


def _create_requirement_fit_tables_v12(
    conn: sqlite3.Connection,
    *,
    reports_table_name: str = "job_requirement_fit_reports",
    items_table_name: str = "job_requirement_fit_items",
    scores_table_name: str = "job_scores",
) -> None:
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {reports_table_name} (
            tenant_id                     TEXT NOT NULL DEFAULT 'local',
            job_id                        TEXT NOT NULL,
            score_version                 INTEGER NOT NULL,
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
            summary_json                  TEXT NOT NULL DEFAULT '{{}}',
            created_at                    TEXT NOT NULL,
            PRIMARY KEY (tenant_id, job_id, score_version),
            FOREIGN KEY (tenant_id, job_id, score_version)
                REFERENCES {scores_table_name}(
                    tenant_id, job_id, version
                ) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {items_table_name} (
            tenant_id              TEXT NOT NULL DEFAULT 'local',
            job_id                 TEXT NOT NULL,
            score_version          INTEGER NOT NULL,
            requirement_id         TEXT NOT NULL,
            requirement_text       TEXT NOT NULL,
            tier                   TEXT NOT NULL CHECK(
                tier IN ('must_have', 'nice_to_have')
            ),
            weight                 REAL NOT NULL CHECK(
                weight >= 0 AND weight <= 1
            ),
            job_evidence_span       TEXT NOT NULL,
            fit_json                TEXT NOT NULL,
            contribution_json       TEXT NOT NULL,
            tailoring_json          TEXT NOT NULL,
            artifact_coverage_json  TEXT,
            position                INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (
                tenant_id, job_id, score_version, requirement_id
            ),
            FOREIGN KEY (tenant_id, job_id, score_version)
                REFERENCES {reports_table_name}(
                    tenant_id, job_id, score_version
                ) ON DELETE CASCADE
        )
        """
    )


def _create_job_score_indexes(conn: sqlite3.Connection) -> None:
    reference = (
        "job_id" if "job_id" in _table_columns(conn, "job_scores") else "job_url"
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_scores_tenant_score
        ON job_scores(tenant_id, fit_score DESC, scored_at DESC)
        """
    )
    conn.execute(
        f"""
        CREATE INDEX IF NOT EXISTS idx_job_scores_job_version
        ON job_scores(tenant_id, {reference}, version DESC)
        """
    )


def _create_score_staleness_indexes(conn: sqlite3.Connection) -> None:
    reference = (
        "job_id"
        if "job_id" in _table_columns(conn, "job_score_staleness")
        else "job_url"
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_score_staleness_unresolved
        ON job_score_staleness(tenant_id, resolved, marked_at DESC)
        """
    )
    conn.execute(
        f"""
        CREATE INDEX IF NOT EXISTS idx_job_score_staleness_job
        ON job_score_staleness(tenant_id, {reference}, resolved)
        """
    )


def _create_requirement_fit_indexes(conn: sqlite3.Connection) -> None:
    reference = (
        "job_id"
        if "job_id" in _table_columns(conn, "job_requirement_fit_reports")
        else "job_url"
    )
    conn.execute(
        f"""
        CREATE INDEX IF NOT EXISTS idx_requirement_fit_reports_tenant_job
        ON job_requirement_fit_reports(
            tenant_id, {reference}, score_version DESC
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_requirement_fit_items_requirement
        ON job_requirement_fit_items(tenant_id, requirement_id)
        """
    )


def _has_composite_foreign_key(
    conn: sqlite3.Connection,
    table: str,
    referenced_table: str,
    columns: set[tuple[str, str]],
    *,
    on_delete: str,
) -> bool:
    groups: dict[int, set[tuple[str, str]]] = {}
    deletes: dict[int, str] = {}
    for row in conn.execute(f'PRAGMA foreign_key_list("{table}")').fetchall():
        if str(row[2]) != referenced_table:
            continue
        foreign_key_id = int(row[0])
        groups.setdefault(foreign_key_id, set()).add((str(row[3]), str(row[4])))
        deletes[foreign_key_id] = str(row[6]).upper()
    return any(
        group == columns and deletes.get(foreign_key_id) == on_delete.upper()
        for foreign_key_id, group in groups.items()
    )


def _has_scoring_reference_schema_v12(conn: sqlite3.Connection) -> bool:
    return (
        "job_id" in _table_columns(conn, "job_scores")
        and "job_url" not in _table_columns(conn, "job_scores")
        and _primary_key_columns(conn, "job_scores")
        == ("tenant_id", "job_id", "version")
        and _has_composite_job_id_foreign_key(conn, "job_scores", "job_id")
        and _has_index(
            conn,
            "job_scores",
            "idx_job_scores_tenant_score",
            ("tenant_id", "fit_score", "scored_at"),
            unique=False,
        )
        and _has_index(
            conn,
            "job_scores",
            "idx_job_scores_job_version",
            ("tenant_id", "job_id", "version"),
            unique=False,
        )
        and "job_id" in _table_columns(conn, "job_score_staleness")
        and "job_url" not in _table_columns(conn, "job_score_staleness")
        and _primary_key_columns(conn, "job_score_staleness")
        == (
            "tenant_id",
            "job_id",
            "stale_reason",
            "old_policy_version",
            "new_policy_version",
        )
        and _has_composite_job_id_foreign_key(
            conn,
            "job_score_staleness",
            "job_id",
        )
        and _has_index(
            conn,
            "job_score_staleness",
            "idx_job_score_staleness_unresolved",
            ("tenant_id", "resolved", "marked_at"),
            unique=False,
        )
        and _has_index(
            conn,
            "job_score_staleness",
            "idx_job_score_staleness_job",
            ("tenant_id", "job_id", "resolved"),
            unique=False,
        )
        and "job_id" in _table_columns(
            conn,
            "job_requirement_fit_reports",
        )
        and "job_url" not in _table_columns(
            conn,
            "job_requirement_fit_reports",
        )
        and _primary_key_columns(conn, "job_requirement_fit_reports")
        == ("tenant_id", "job_id", "score_version")
        and _has_composite_foreign_key(
            conn,
            "job_requirement_fit_reports",
            "job_scores",
            {
                ("tenant_id", "tenant_id"),
                ("job_id", "job_id"),
                ("score_version", "version"),
            },
            on_delete="CASCADE",
        )
        and _has_index(
            conn,
            "job_requirement_fit_reports",
            "idx_requirement_fit_reports_tenant_job",
            ("tenant_id", "job_id", "score_version"),
            unique=False,
        )
        and "job_id" in _table_columns(
            conn,
            "job_requirement_fit_items",
        )
        and "job_url" not in _table_columns(
            conn,
            "job_requirement_fit_items",
        )
        and _primary_key_columns(conn, "job_requirement_fit_items")
        == ("tenant_id", "job_id", "score_version", "requirement_id")
        and _has_composite_foreign_key(
            conn,
            "job_requirement_fit_items",
            "job_requirement_fit_reports",
            {
                ("tenant_id", "tenant_id"),
                ("job_id", "job_id"),
                ("score_version", "score_version"),
            },
            on_delete="CASCADE",
        )
        and _has_index(
            conn,
            "job_requirement_fit_items",
            "idx_requirement_fit_items_requirement",
            ("tenant_id", "requirement_id"),
            unique=False,
        )
    )


def ensure_scoring_references_v12(
    conn: sqlite3.Connection | None = None,
) -> list[str]:
    """Move scoring history and its dependants to stable JobId references.

    Multiple historical posting URLs may resolve to one JobId. Their score
    histories are therefore ordered deterministically and renumbered together;
    requirement-fit reports, items, and resolved staleness markers are remapped
    through the same version map before any legacy table is replaced.
    """
    if conn is None:
        conn = get_connection()

    current = _assert_schema_version_supported(conn)
    if current >= _SCORING_REFERENCE_SCHEMA_VERSION:
        return []
    if current != _ENRICHMENT_SNAPSHOT_REFERENCE_SCHEMA_VERSION:
        raise RuntimeError(
            "scoring reference migration requires enrichment/snapshot "
            "schema v11"
        )

    conn.execute("SAVEPOINT scoring_references_v12")
    try:
        _verify_scoring_prerequisites_v12(conn)
        before_counts = {
            table: int(
                conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            )
            for table in _SCORING_REFERENCE_TABLES
        }
        expected_counts = dict(before_counts)

        if not _has_scoring_reference_schema_v12(conn):
            score_reference = _legacy_or_stable_reference_column(
                conn,
                "job_scores",
                stable="job_id",
                legacy="job_url",
            )
            staleness_reference = _legacy_or_stable_reference_column(
                conn,
                "job_score_staleness",
                stable="job_id",
                legacy="job_url",
            )
            report_reference = _legacy_or_stable_reference_column(
                conn,
                "job_requirement_fit_reports",
                stable="job_id",
                legacy="job_url",
            )
            item_reference = _legacy_or_stable_reference_column(
                conn,
                "job_requirement_fit_items",
                stable="job_id",
                legacy="job_url",
            )
            reference_columns = {
                "job_scores": score_reference,
                "job_score_staleness": staleness_reference,
                "job_requirement_fit_reports": report_reference,
                "job_requirement_fit_items": item_reference,
            }
            for table, reference_column in reference_columns.items():
                unresolved = conn.execute(
                    f"""
                    SELECT source.{reference_column}
                    FROM {table} AS source
                    WHERE {
                        _resolved_job_id_sql(
                            "source",
                            reference_column,
                            legacy_url=reference_column == "job_url",
                        )
                    } IS NULL
                    LIMIT 1
                    """
                ).fetchone()
                if unresolved is not None:
                    raise RuntimeError(
                        "scoring reference migration could not resolve "
                        f"{table}.{reference_column}={unresolved[0]!r}"
                    )

            (
                score_rows,
                version_map,
            ) = _canonical_score_rows_v12(
                conn,
                reference_column=score_reference,
            )
            report_rows = _remapped_requirement_report_rows_v12(
                conn,
                reference_column=report_reference,
                version_map=version_map,
            )
            item_rows = _remapped_requirement_item_rows_v12(
                conn,
                reference_column=item_reference,
                version_map=version_map,
            )
            staleness_rows = _canonical_staleness_rows_v12(
                conn,
                reference_column=staleness_reference,
                version_map=version_map,
            )
            expected_counts["job_score_staleness"] = len(staleness_rows)

            for table in (
                "job_requirement_fit_items_v12",
                "job_requirement_fit_reports_v12",
                "job_score_staleness_v12",
                "job_scores_v12",
            ):
                conn.execute(f'DROP TABLE IF EXISTS "{table}"')
            _create_job_scores_v12(conn, table_name="job_scores_v12")
            _create_requirement_fit_tables_v12(
                conn,
                reports_table_name="job_requirement_fit_reports_v12",
                items_table_name="job_requirement_fit_items_v12",
                scores_table_name="job_scores_v12",
            )
            _create_score_staleness_v12(
                conn,
                table_name="job_score_staleness_v12",
            )
            conn.executemany(
                """
                INSERT INTO job_scores_v12 (
                    tenant_id, job_id, version, fit_score, breakdown_json,
                    keywords_json, scored_at, correction_json,
                    criteria_json, trace_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                score_rows,
            )
            conn.executemany(
                """
                INSERT INTO job_requirement_fit_reports_v12 (
                    tenant_id, job_id, score_version,
                    employer_analysis_generation, profile_snapshot_version,
                    scoring_policy_version, formula_version,
                    resolved_fit_score, fit_band, confidence, summary_json,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                report_rows,
            )
            conn.executemany(
                """
                INSERT INTO job_requirement_fit_items_v12 (
                    tenant_id, job_id, score_version, requirement_id,
                    requirement_text, tier, weight, job_evidence_span,
                    fit_json, contribution_json, tailoring_json,
                    artifact_coverage_json, position
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                item_rows,
            )
            conn.executemany(
                """
                INSERT INTO job_score_staleness_v12 (
                    tenant_id, job_id, stale_reason,
                    old_policy_id, old_policy_version,
                    new_policy_id, new_policy_version,
                    marked_at, resolved, resolved_at,
                    resolved_by_score_version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                staleness_rows,
            )

            for table in (
                "job_requirement_fit_items",
                "job_requirement_fit_reports",
                "job_score_staleness",
                "job_scores",
            ):
                conn.execute(f'DROP TABLE "{table}"')
            for table in (
                "job_scores",
                "job_requirement_fit_reports",
                "job_requirement_fit_items",
                "job_score_staleness",
            ):
                conn.execute(
                    f'ALTER TABLE "{table}_v12" RENAME TO "{table}"'
                )
            _create_job_score_indexes(conn)
            _create_requirement_fit_indexes(conn)
            _create_score_staleness_indexes(conn)

        _verify_scoring_references_v12(
            conn,
            expected_counts=expected_counts,
        )
        conn.execute(
            f"PRAGMA user_version = {_SCORING_REFERENCE_SCHEMA_VERSION}"
        )
        conn.execute("RELEASE SAVEPOINT scoring_references_v12")
        conn.commit()
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT scoring_references_v12")
        conn.execute("RELEASE SAVEPOINT scoring_references_v12")
        raise

    return list(_SCORING_REFERENCE_TABLES)


def _verify_scoring_prerequisites_v12(
    conn: sqlite3.Connection,
) -> None:
    """Verify v11-owned authority without rejecting migratable URL aliases."""
    if not _has_enrichment_snapshot_reference_schema_v11(conn):
        raise RuntimeError(
            "scoring reference migration requires the stable "
            "enrichment/snapshot reference schema"
        )
    for table in _ENRICHMENT_SNAPSHOT_REFERENCE_TABLES:
        orphan = conn.execute(
            f"""
            SELECT source.job_id
            FROM {table} AS source
            LEFT JOIN jobs j
              ON j.tenant_id = source.tenant_id
             AND j.job_id = source.job_id
            WHERE j.job_id IS NULL
            LIMIT 1
            """
        ).fetchone()
        if orphan is not None:
            raise RuntimeError(
                "scoring reference migration found an unresolved "
                f"{table}.job_id prerequisite"
            )


def _canonical_score_rows_v12(
    conn: sqlite3.Connection,
    *,
    reference_column: str,
) -> tuple[
    list[tuple[Any, ...]],
    dict[tuple[str, str, int], int],
]:
    rows = conn.execute(
        f"""
        SELECT tenant_id, {reference_column}, version, fit_score,
               breakdown_json, keywords_json, scored_at, correction_json,
               criteria_json, trace_json
        FROM job_scores
        ORDER BY tenant_id, {reference_column}, version
        """
    ).fetchall()
    grouped: dict[
        tuple[str, str],
        list[tuple[str, int, tuple[Any, ...]]],
    ] = {}
    for row in rows:
        tenant_id = str(row[0])
        raw_reference = str(row[1])
        old_version = int(row[2])
        if old_version <= 0:
            raise RuntimeError(
                "scoring reference migration found a non-positive score "
                "version"
            )
        stable_job_id = _resolve_job_reference_value(
            conn,
            tenant_id=tenant_id,
            reference=raw_reference,
            legacy_url=reference_column == "job_url",
        )
        if stable_job_id is None:
            raise RuntimeError(
                "scoring reference migration could not resolve score "
                f"identity {raw_reference!r}"
            )
        _validate_job_uuid(stable_job_id)
        grouped.setdefault((tenant_id, stable_job_id), []).append(
            (
                raw_reference,
                old_version,
                (
                    int(row[3]),
                    str(row[4]),
                    str(row[5]),
                    str(row[6]),
                    row[7],
                    str(row[8] or "{}"),
                    str(row[9] or "{}"),
                ),
            )
        )

    canonical: list[tuple[Any, ...]] = []
    version_map: dict[tuple[str, str, int], int] = {}
    for (tenant_id, stable_job_id), history in sorted(grouped.items()):
        ordered_history = _merge_score_histories_preserving_version_order(
            history
        )
        for new_version, (
            raw_reference,
            old_version,
            values,
        ) in enumerate(ordered_history, start=1):
            version_map[(tenant_id, raw_reference, old_version)] = new_version
            canonical.append(
                (
                    tenant_id,
                    stable_job_id,
                    new_version,
                    *values,
                )
            )
    return canonical, version_map


def _merge_score_histories_preserving_version_order(
    history: list[tuple[str, int, tuple[Any, ...]]],
) -> list[tuple[str, int, tuple[Any, ...]]]:
    """Deterministically interleave aliases without reversing one history.

    ``version`` is the authoritative order within one scoring aggregate.
    Timestamps are useful only to choose between the next eligible row from
    different aliases because older databases do not constrain timestamp
    monotonicity. This is a stable topological merge: every alias retains its
    original version order even when its timestamps move backwards.
    """
    by_reference: dict[str, list[tuple[str, int, tuple[Any, ...]]]] = {}
    for entry in history:
        by_reference.setdefault(entry[0], []).append(entry)
    for entries in by_reference.values():
        entries.sort(key=lambda entry: entry[1])

    offsets = {reference: 0 for reference in by_reference}
    merged: list[tuple[str, int, tuple[Any, ...]]] = []
    while len(merged) < len(history):
        eligible = [
            entries[offsets[reference]]
            for reference, entries in by_reference.items()
            if offsets[reference] < len(entries)
        ]
        selected = min(
            eligible,
            key=lambda entry: (
                str(entry[2][3]),
                entry[0],
                entry[1],
            ),
        )
        merged.append(selected)
        offsets[selected[0]] += 1
    return merged


def _remapped_requirement_report_rows_v12(
    conn: sqlite3.Connection,
    *,
    reference_column: str,
    version_map: dict[tuple[str, str, int], int],
) -> list[tuple[Any, ...]]:
    rows = conn.execute(
        f"""
        SELECT tenant_id, {reference_column}, score_version,
               employer_analysis_generation, profile_snapshot_version,
               scoring_policy_version, formula_version, resolved_fit_score,
               fit_band, confidence, summary_json, created_at
        FROM job_requirement_fit_reports
        ORDER BY tenant_id, {reference_column}, score_version
        """
    ).fetchall()
    remapped: list[tuple[Any, ...]] = []
    for row in rows:
        tenant_id = str(row[0])
        raw_reference = str(row[1])
        old_version = int(row[2])
        new_version = version_map.get(
            (tenant_id, raw_reference, old_version)
        )
        if new_version is None:
            raise RuntimeError(
                "scoring reference migration found a requirement-fit "
                "report without its score history"
            )
        stable_job_id = _resolve_job_reference_value(
            conn,
            tenant_id=tenant_id,
            reference=raw_reference,
            legacy_url=reference_column == "job_url",
        )
        if stable_job_id is None:
            raise RuntimeError(
                "scoring reference migration could not resolve a "
                "requirement-fit report"
            )
        remapped.append(
            (
                tenant_id,
                stable_job_id,
                new_version,
                *tuple(row[3:]),
            )
        )
    return remapped


def _remapped_requirement_item_rows_v12(
    conn: sqlite3.Connection,
    *,
    reference_column: str,
    version_map: dict[tuple[str, str, int], int],
) -> list[tuple[Any, ...]]:
    rows = conn.execute(
        f"""
        SELECT tenant_id, {reference_column}, score_version,
               requirement_id, requirement_text, tier, weight,
               job_evidence_span, fit_json, contribution_json,
               tailoring_json, artifact_coverage_json, position
        FROM job_requirement_fit_items
        ORDER BY tenant_id, {reference_column}, score_version, position,
                 requirement_id
        """
    ).fetchall()
    remapped: list[tuple[Any, ...]] = []
    for row in rows:
        tenant_id = str(row[0])
        raw_reference = str(row[1])
        old_version = int(row[2])
        new_version = version_map.get(
            (tenant_id, raw_reference, old_version)
        )
        if new_version is None:
            raise RuntimeError(
                "scoring reference migration found a requirement-fit item "
                "without its score history"
            )
        stable_job_id = _resolve_job_reference_value(
            conn,
            tenant_id=tenant_id,
            reference=raw_reference,
            legacy_url=reference_column == "job_url",
        )
        if stable_job_id is None:
            raise RuntimeError(
                "scoring reference migration could not resolve a "
                "requirement-fit item"
            )
        remapped.append(
            (
                tenant_id,
                stable_job_id,
                new_version,
                *tuple(row[3:]),
            )
        )
    return remapped


def _canonical_staleness_rows_v12(
    conn: sqlite3.Connection,
    *,
    reference_column: str,
    version_map: dict[tuple[str, str, int], int],
) -> list[tuple[Any, ...]]:
    rows = conn.execute(
        f"""
        SELECT tenant_id, {reference_column}, stale_reason,
               old_policy_id, old_policy_version,
               new_policy_id, new_policy_version,
               marked_at, resolved, resolved_at,
               resolved_by_score_version
        FROM job_score_staleness
        ORDER BY tenant_id, {reference_column}, marked_at
        """
    ).fetchall()
    canonical: dict[
        tuple[str, str, str, int, int],
        dict[str, Any],
    ] = {}
    for row in rows:
        tenant_id = str(row[0])
        raw_reference = str(row[1])
        stable_job_id = _resolve_job_reference_value(
            conn,
            tenant_id=tenant_id,
            reference=raw_reference,
            legacy_url=reference_column == "job_url",
        )
        if stable_job_id is None:
            raise RuntimeError(
                "scoring reference migration could not resolve a score "
                "staleness marker"
            )
        resolved = bool(row[8])
        old_resolved_version = (
            int(row[10]) if row[10] is not None else None
        )
        resolved_version = None
        if old_resolved_version is not None:
            resolved_version = version_map.get(
                (tenant_id, raw_reference, old_resolved_version)
            )
            if resolved_version is None:
                raise RuntimeError(
                    "scoring reference migration found a staleness marker "
                    "resolved by a missing score version"
                )
        if not resolved and (
            row[9] is not None or old_resolved_version is not None
        ):
            raise RuntimeError(
                "scoring reference migration found an unresolved marker "
                "with resolution evidence"
            )

        key = (
            tenant_id,
            stable_job_id,
            str(row[2]),
            int(row[4]),
            int(row[6]),
        )
        candidate = {
            "old_policy_id": str(row[3] or ""),
            "new_policy_id": str(row[5] or ""),
            "marked_at": str(row[7]),
            "resolved": resolved,
            "resolved_at": str(row[9]) if row[9] is not None else None,
            "resolved_version": resolved_version,
        }
        existing = canonical.get(key)
        if existing is None:
            canonical[key] = candidate
            continue
        if (
            existing["old_policy_id"] != candidate["old_policy_id"]
            or existing["new_policy_id"] != candidate["new_policy_id"]
        ):
            raise RuntimeError(
                "scoring reference migration found conflicting policy "
                "identity on duplicate staleness markers"
            )
        existing["marked_at"] = min(
            existing["marked_at"],
            candidate["marked_at"],
        )
        if not candidate["resolved"]:
            existing["resolved"] = False
            existing["resolved_at"] = None
            existing["resolved_version"] = None
        elif existing["resolved"]:
            resolved_times = [
                value
                for value in (
                    existing["resolved_at"],
                    candidate["resolved_at"],
                )
                if value is not None
            ]
            existing["resolved_at"] = (
                max(resolved_times) if resolved_times else None
            )
            resolved_versions = [
                value
                for value in (
                    existing["resolved_version"],
                    candidate["resolved_version"],
                )
                if value is not None
            ]
            existing["resolved_version"] = (
                max(resolved_versions) if resolved_versions else None
            )

    return [
        (
            tenant_id,
            stable_job_id,
            stale_reason,
            values["old_policy_id"],
            old_policy_version,
            values["new_policy_id"],
            new_policy_version,
            values["marked_at"],
            int(values["resolved"]),
            values["resolved_at"],
            values["resolved_version"],
        )
        for (
            tenant_id,
            stable_job_id,
            stale_reason,
            old_policy_version,
            new_policy_version,
        ), values in sorted(canonical.items())
    ]


def _verify_scoring_references_v12(
    conn: sqlite3.Connection,
    *,
    expected_counts: dict[str, int],
) -> None:
    if not _has_scoring_reference_schema_v12(conn):
        raise RuntimeError(
            "scoring reference migration did not create the stable "
            "reference schema"
        )
    for table, expected_count in expected_counts.items():
        observed_count = int(
            conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        )
        if observed_count != expected_count:
            raise RuntimeError(
                "scoring reference migration changed row count for "
                f"{table}: expected {expected_count}, found {observed_count}"
            )
        invalid_identity = conn.execute(
            f"""
            SELECT source.job_id
            FROM {table} AS source
            LEFT JOIN jobs j
              ON j.tenant_id = source.tenant_id
             AND j.job_id = source.job_id
            WHERE j.job_id IS NULL
            LIMIT 1
            """
        ).fetchone()
        if invalid_identity is not None:
            raise RuntimeError(
                "scoring reference migration left an unresolved reference "
                f"in {table}.job_id"
            )

    invalid_history = conn.execute(
        """
        SELECT tenant_id, job_id
        FROM job_scores
        GROUP BY tenant_id, job_id
        HAVING MIN(version) <> 1
            OR MAX(version) <> COUNT(*)
            OR COUNT(DISTINCT version) <> COUNT(*)
        LIMIT 1
        """
    ).fetchone()
    if invalid_history is not None:
        raise RuntimeError(
            "scoring reference migration did not preserve a contiguous "
            "score history"
        )
    orphan_report = conn.execute(
        """
        SELECT report.job_id
        FROM job_requirement_fit_reports AS report
        LEFT JOIN job_scores AS score
          ON score.tenant_id = report.tenant_id
         AND score.job_id = report.job_id
         AND score.version = report.score_version
        WHERE score.job_id IS NULL
        LIMIT 1
        """
    ).fetchone()
    if orphan_report is not None:
        raise RuntimeError(
            "scoring reference migration left a requirement-fit report "
            "without its score"
        )
    orphan_item = conn.execute(
        """
        SELECT item.job_id
        FROM job_requirement_fit_items AS item
        LEFT JOIN job_requirement_fit_reports AS report
          ON report.tenant_id = item.tenant_id
         AND report.job_id = item.job_id
         AND report.score_version = item.score_version
        WHERE report.job_id IS NULL
        LIMIT 1
        """
    ).fetchone()
    if orphan_item is not None:
        raise RuntimeError(
            "scoring reference migration left a requirement-fit item "
            "without its report"
        )
    invalid_resolution = conn.execute(
        """
        SELECT marker.job_id
        FROM job_score_staleness AS marker
        LEFT JOIN job_scores AS score
          ON score.tenant_id = marker.tenant_id
         AND score.job_id = marker.job_id
         AND score.version = marker.resolved_by_score_version
        WHERE marker.resolved_by_score_version IS NOT NULL
          AND score.job_id IS NULL
        LIMIT 1
        """
    ).fetchone()
    if invalid_resolution is not None:
        raise RuntimeError(
            "scoring reference migration left a staleness marker resolved "
            "by a missing score"
        )
    for row in conn.execute(
        """
        SELECT job_id FROM job_scores
        UNION
        SELECT job_id FROM job_score_staleness
        UNION
        SELECT job_id FROM job_requirement_fit_reports
        UNION
        SELECT job_id FROM job_requirement_fit_items
        """
    ).fetchall():
        _validate_job_uuid(str(row[0]))

    foreign_key_error = conn.execute("PRAGMA foreign_key_check").fetchone()
    if foreign_key_error is not None:
        raise RuntimeError(
            "scoring reference migration found a foreign-key violation"
        )


def _reassign_scoring_references_v12(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    losing_job_id: str,
    surviving_job_id: str,
    employer_analysis_generation_map: (
        dict[tuple[str, int], int] | None
    ) = None,
) -> None:
    """Merge two stable scoring histories without overwriting either one."""
    if losing_job_id == surviving_job_id:
        return

    before_counts = {
        table: int(
            conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        )
        for table in _SCORING_REFERENCE_TABLES
    }
    selected_staleness_count = int(
        conn.execute(
            """
            SELECT COUNT(*)
            FROM job_score_staleness
            WHERE tenant_id = ? AND job_id IN (?, ?)
            """,
            (tenant_id, losing_job_id, surviving_job_id),
        ).fetchone()[0]
    )

    raw_scores = conn.execute(
        """
        SELECT job_id, version, fit_score, breakdown_json, keywords_json,
               scored_at, correction_json, criteria_json, trace_json
        FROM job_scores
        WHERE tenant_id = ? AND job_id IN (?, ?)
        ORDER BY scored_at, job_id, version
        """,
        (tenant_id, losing_job_id, surviving_job_id),
    ).fetchall()
    ordered_scores = _merge_score_histories_preserving_version_order(
        [
            (
                str(row[0]),
                int(row[1]),
                tuple(row[2:]),
            )
            for row in raw_scores
        ]
    )
    version_map: dict[tuple[str, int], int] = {}
    score_rows: list[tuple[Any, ...]] = []
    for new_version, (
        source_job_id,
        old_version,
        values,
    ) in enumerate(ordered_scores, start=1):
        version_map[(source_job_id, old_version)] = new_version
        score_rows.append(
            (
                tenant_id,
                surviving_job_id,
                new_version,
                *values,
            )
        )

    raw_reports = conn.execute(
        """
        SELECT job_id, score_version, employer_analysis_generation,
               profile_snapshot_version, scoring_policy_version,
               formula_version, resolved_fit_score, fit_band, confidence,
               summary_json, created_at
        FROM job_requirement_fit_reports
        WHERE tenant_id = ? AND job_id IN (?, ?)
        ORDER BY job_id, score_version
        """,
        (tenant_id, losing_job_id, surviving_job_id),
    ).fetchall()
    report_rows: list[tuple[Any, ...]] = []
    for row in raw_reports:
        source_job_id = str(row[0])
        new_version = version_map.get(
            (source_job_id, int(row[1]))
        )
        if new_version is None:
            raise RuntimeError(
                "URL collision merge found a requirement-fit report "
                "without its score history"
            )
        old_analysis_generation = int(row[2])
        new_analysis_generation = old_analysis_generation
        if (
            employer_analysis_generation_map is not None
            and old_analysis_generation > 0
        ):
            mapped_generation = (
                employer_analysis_generation_map.get(
                    (source_job_id, old_analysis_generation)
                )
            )
            if mapped_generation is None:
                raise RuntimeError(
                    "URL collision merge found a requirement-fit "
                    "report bound to a missing employer-analysis "
                    "generation"
                )
            new_analysis_generation = mapped_generation
        report_rows.append(
            (
                tenant_id,
                surviving_job_id,
                new_version,
                new_analysis_generation,
                *tuple(row[3:]),
            )
        )

    raw_items = conn.execute(
        """
        SELECT job_id, score_version, requirement_id, requirement_text,
               tier, weight, job_evidence_span, fit_json, contribution_json,
               tailoring_json, artifact_coverage_json, position
        FROM job_requirement_fit_items
        WHERE tenant_id = ? AND job_id IN (?, ?)
        ORDER BY job_id, score_version, position, requirement_id
        """,
        (tenant_id, losing_job_id, surviving_job_id),
    ).fetchall()
    item_rows: list[tuple[Any, ...]] = []
    for row in raw_items:
        new_version = version_map.get((str(row[0]), int(row[1])))
        if new_version is None:
            raise RuntimeError(
                "URL collision merge found a requirement-fit item "
                "without its score history"
            )
        item_rows.append(
            (
                tenant_id,
                surviving_job_id,
                new_version,
                *tuple(row[2:]),
            )
        )

    raw_staleness = conn.execute(
        """
        SELECT job_id, stale_reason, old_policy_id, old_policy_version,
               new_policy_id, new_policy_version, marked_at, resolved,
               resolved_at, resolved_by_score_version
        FROM job_score_staleness
        WHERE tenant_id = ? AND job_id IN (?, ?)
        ORDER BY job_id, marked_at
        """,
        (tenant_id, losing_job_id, surviving_job_id),
    ).fetchall()
    canonical_staleness: dict[
        tuple[str, int, int],
        dict[str, Any],
    ] = {}
    for row in raw_staleness:
        source_job_id = str(row[0])
        resolved = bool(row[7])
        old_resolved_version = (
            int(row[9]) if row[9] is not None else None
        )
        resolved_version = None
        if old_resolved_version is not None:
            resolved_version = version_map.get(
                (source_job_id, old_resolved_version)
            )
            if resolved_version is None:
                raise RuntimeError(
                    "URL collision merge found a staleness marker resolved "
                    "by a missing score version"
                )
        if not resolved and (
            row[8] is not None or old_resolved_version is not None
        ):
            raise RuntimeError(
                "URL collision merge found an unresolved score marker "
                "with resolution evidence"
            )
        key = (str(row[1]), int(row[3]), int(row[5]))
        candidate = {
            "old_policy_id": str(row[2] or ""),
            "new_policy_id": str(row[4] or ""),
            "marked_at": str(row[6]),
            "resolved": resolved,
            "resolved_at": str(row[8]) if row[8] is not None else None,
            "resolved_version": resolved_version,
        }
        existing = canonical_staleness.get(key)
        if existing is None:
            canonical_staleness[key] = candidate
            continue
        if (
            existing["old_policy_id"] != candidate["old_policy_id"]
            or existing["new_policy_id"] != candidate["new_policy_id"]
        ):
            raise RuntimeError(
                "URL collision merge found conflicting policy identity "
                "on duplicate staleness markers"
            )
        existing["marked_at"] = min(
            existing["marked_at"],
            candidate["marked_at"],
        )
        if not candidate["resolved"]:
            existing["resolved"] = False
            existing["resolved_at"] = None
            existing["resolved_version"] = None
        elif existing["resolved"]:
            resolved_times = [
                value
                for value in (
                    existing["resolved_at"],
                    candidate["resolved_at"],
                )
                if value is not None
            ]
            existing["resolved_at"] = (
                max(resolved_times) if resolved_times else None
            )
            resolved_versions = [
                value
                for value in (
                    existing["resolved_version"],
                    candidate["resolved_version"],
                )
                if value is not None
            ]
            existing["resolved_version"] = (
                max(resolved_versions) if resolved_versions else None
            )
    staleness_rows = [
        (
            tenant_id,
            surviving_job_id,
            stale_reason,
            values["old_policy_id"],
            old_policy_version,
            values["new_policy_id"],
            new_policy_version,
            values["marked_at"],
            int(values["resolved"]),
            values["resolved_at"],
            values["resolved_version"],
        )
        for (
            stale_reason,
            old_policy_version,
            new_policy_version,
        ), values in sorted(canonical_staleness.items())
    ]

    for table in (
        "job_requirement_fit_items",
        "job_requirement_fit_reports",
        "job_score_staleness",
        "job_scores",
    ):
        conn.execute(
            f"""
            DELETE FROM {table}
            WHERE tenant_id = ? AND job_id IN (?, ?)
            """,
            (tenant_id, losing_job_id, surviving_job_id),
        )
    conn.executemany(
        """
        INSERT INTO job_scores (
            tenant_id, job_id, version, fit_score, breakdown_json,
            keywords_json, scored_at, correction_json,
            criteria_json, trace_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        score_rows,
    )
    conn.executemany(
        """
        INSERT INTO job_requirement_fit_reports (
            tenant_id, job_id, score_version,
            employer_analysis_generation, profile_snapshot_version,
            scoring_policy_version, formula_version, resolved_fit_score,
            fit_band, confidence, summary_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        report_rows,
    )
    conn.executemany(
        """
        INSERT INTO job_requirement_fit_items (
            tenant_id, job_id, score_version, requirement_id,
            requirement_text, tier, weight, job_evidence_span,
            fit_json, contribution_json, tailoring_json,
            artifact_coverage_json, position
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        item_rows,
    )
    conn.executemany(
        """
        INSERT INTO job_score_staleness (
            tenant_id, job_id, stale_reason,
            old_policy_id, old_policy_version,
            new_policy_id, new_policy_version,
            marked_at, resolved, resolved_at,
            resolved_by_score_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        staleness_rows,
    )

    expected_counts = dict(before_counts)
    expected_counts["job_score_staleness"] = (
        before_counts["job_score_staleness"]
        - selected_staleness_count
        + len(staleness_rows)
    )
    _verify_scoring_references_v12(
        conn,
        expected_counts=expected_counts,
    )


_STAGE_STATE_REFERENCE_SCHEMA_VERSION = 13
_STAGE_STATE_REFERENCE_TABLES = ("job_stage_states",)
_STAGE_STATE_VALUE_COLUMNS = (
    "state",
    "attempt_count",
    "max_attempts",
    "started_at",
    "updated_at",
    "finished_at",
    "duration_ms",
    "error_code",
    "error_message",
    "retryable",
    "blocked_by_json",
    "next_action",
    "metadata_json",
    "version",
)


def _create_job_stage_states_v13(
    conn: sqlite3.Connection,
    *,
    table_name: str = "job_stage_states",
) -> None:
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {table_name} (
            tenant_id          TEXT NOT NULL DEFAULT 'local',
            job_id             TEXT NOT NULL,
            stage              TEXT NOT NULL,
            state              TEXT NOT NULL DEFAULT 'pending',
            attempt_count      INTEGER DEFAULT 0,
            max_attempts       INTEGER,
            started_at         TEXT,
            updated_at         TEXT NOT NULL,
            finished_at        TEXT,
            duration_ms        INTEGER,
            error_code         TEXT,
            error_message      TEXT,
            retryable          INTEGER DEFAULT 1,
            blocked_by_json    TEXT,
            next_action        TEXT,
            metadata_json      TEXT,
            version            INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (tenant_id, job_id, stage),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        )
        """
    )


def _create_job_stage_state_indexes_v13(
    conn: sqlite3.Connection,
) -> None:
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_stage_states_stage_state
        ON job_stage_states(stage, state, updated_at DESC)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_stage_states_job
        ON job_stage_states(tenant_id, job_id, stage)
        """
    )


def _has_stage_state_reference_schema_v13(
    conn: sqlite3.Connection,
) -> bool:
    return (
        "job_id" in _table_columns(conn, "job_stage_states")
        and "job_url" not in _table_columns(conn, "job_stage_states")
        and _primary_key_columns(conn, "job_stage_states")
        == ("tenant_id", "job_id", "stage")
        and _has_composite_job_id_foreign_key(
            conn,
            "job_stage_states",
            "job_id",
        )
        and _has_index(
            conn,
            "job_stage_states",
            "idx_job_stage_states_stage_state",
            ("stage", "state", "updated_at"),
            unique=False,
        )
        and _has_index(
            conn,
            "job_stage_states",
            "idx_job_stage_states_job",
            ("tenant_id", "job_id", "stage"),
            unique=False,
        )
    )


def _stage_state_timestamp_rank(value: Any) -> tuple[float, str]:
    raw = str(value or "")
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        timestamp = parsed.astimezone(timezone.utc).timestamp()
    except (OverflowError, ValueError):
        timestamp = float("-inf")
    return timestamp, raw


def _merge_stage_state_rows_v13(
    rows: list[tuple[str, int, tuple[Any, ...]]],
) -> tuple[Any, ...]:
    """Select one current lifecycle fact without lowering safety counters."""
    if not rows:
        raise RuntimeError("stage-state merge requires at least one row")
    selected_source, selected_rowid, selected_values = max(
        rows,
        key=lambda item: (
            _stage_state_timestamp_rank(
                item[2][_STAGE_STATE_VALUE_COLUMNS.index("updated_at")]
            ),
            int(item[2][_STAGE_STATE_VALUE_COLUMNS.index("version")] or 0),
            item[0],
            item[1],
        ),
    )
    del selected_source, selected_rowid
    merged = list(selected_values)
    attempt_index = _STAGE_STATE_VALUE_COLUMNS.index("attempt_count")
    version_index = _STAGE_STATE_VALUE_COLUMNS.index("version")
    merged[attempt_index] = max(
        int(values[attempt_index] or 0)
        for _source, _rowid, values in rows
    )
    merged[version_index] = max(
        int(values[version_index] or 0)
        for _source, _rowid, values in rows
    )
    return tuple(merged)


def _normalize_stage_state_aggregate_versions_v13(
    rows: list[tuple[Any, ...]],
) -> list[tuple[Any, ...]]:
    """Keep the optimistic-lock version uniform across every Job aggregate."""
    version_index = 3 + _STAGE_STATE_VALUE_COLUMNS.index("version")
    aggregate_versions: dict[tuple[str, str], int] = {}
    for row in rows:
        aggregate_key = (str(row[0]), str(row[1]))
        aggregate_versions[aggregate_key] = max(
            aggregate_versions.get(aggregate_key, 0),
            int(row[version_index] or 0),
        )
    normalized: list[tuple[Any, ...]] = []
    for row in rows:
        values = list(row)
        values[version_index] = aggregate_versions[
            (str(row[0]), str(row[1]))
        ]
        normalized.append(tuple(values))
    return normalized


def _normalize_persisted_stage_state_versions_v13(
    conn: sqlite3.Connection,
) -> None:
    conn.execute(
        """
        UPDATE job_stage_states AS state
        SET version = (
            SELECT MAX(peer.version)
            FROM job_stage_states AS peer
            WHERE peer.tenant_id = state.tenant_id
              AND peer.job_id = state.job_id
        )
        """
    )


def _canonical_stage_state_rows_v13(
    conn: sqlite3.Connection,
) -> list[tuple[Any, ...]]:
    rows = conn.execute(
        f"""
        SELECT rowid, job_url, stage, {", ".join(_STAGE_STATE_VALUE_COLUMNS)}
        FROM job_stage_states
        ORDER BY job_url, stage, rowid
        """
    ).fetchall()
    grouped: dict[
        tuple[str, str, str],
        list[tuple[str, int, tuple[Any, ...]]],
    ] = {}
    for row in rows:
        job_url = str(row[1])
        stage = str(row[2])
        stable_job_id = _resolve_job_reference_value(
            conn,
            tenant_id="local",
            reference=job_url,
            legacy_url=True,
        )
        if stable_job_id is None:
            raise RuntimeError(
                "stage-state reference migration could not resolve "
                f"job_stage_states.job_url={job_url!r}"
            )
        grouped.setdefault(
            ("local", stable_job_id, stage),
            [],
        ).append(
            (
                job_url,
                int(row[0]),
                tuple(row[index] for index in range(3, len(row))),
            )
        )
    return _normalize_stage_state_aggregate_versions_v13(
        [
            (
                tenant_id,
                job_id,
                stage,
                *_merge_stage_state_rows_v13(group_rows),
            )
            for (tenant_id, job_id, stage), group_rows in sorted(grouped.items())
        ]
    )


def ensure_stage_state_references_v13(
    conn: sqlite3.Connection | None = None,
) -> list[str]:
    """Move canonical per-stage lifecycle state to stable JobId references."""
    if conn is None:
        conn = get_connection()

    current = _assert_schema_version_supported(conn)
    if current >= _STAGE_STATE_REFERENCE_SCHEMA_VERSION:
        return []
    if current != _SCORING_REFERENCE_SCHEMA_VERSION:
        raise RuntimeError(
            "stage-state reference migration requires scoring schema v12"
        )

    conn.execute("SAVEPOINT stage_state_references_v13")
    try:
        if not _has_scoring_reference_schema_v12(conn):
            raise RuntimeError(
                "stage-state reference migration requires the stable "
                "scoring reference schema"
            )
        if _has_stage_state_reference_schema_v13(conn):
            expected_count = int(
                conn.execute(
                    "SELECT COUNT(*) FROM job_stage_states"
                ).fetchone()[0]
            )
            _normalize_persisted_stage_state_versions_v13(conn)
        else:
            canonical_rows = _canonical_stage_state_rows_v13(conn)
            expected_count = len(canonical_rows)
            conn.execute("DROP TABLE IF EXISTS job_stage_states_v13")
            _create_job_stage_states_v13(
                conn,
                table_name="job_stage_states_v13",
            )
            conn.executemany(
                f"""
                INSERT INTO job_stage_states_v13 (
                    tenant_id, job_id, stage,
                    {", ".join(_STAGE_STATE_VALUE_COLUMNS)}
                ) VALUES ({", ".join("?" for _ in range(17))})
                """,
                canonical_rows,
            )
            conn.execute("DROP TABLE job_stage_states")
            conn.execute(
                "ALTER TABLE job_stage_states_v13 "
                "RENAME TO job_stage_states"
            )
            _create_job_stage_state_indexes_v13(conn)
        _verify_stage_state_references_v13(
            conn,
            expected_count=expected_count,
        )
        conn.execute(
            f"PRAGMA user_version = "
            f"{_STAGE_STATE_REFERENCE_SCHEMA_VERSION}"
        )
        conn.execute("RELEASE SAVEPOINT stage_state_references_v13")
        conn.commit()
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT stage_state_references_v13")
        conn.execute("RELEASE SAVEPOINT stage_state_references_v13")
        raise

    return list(_STAGE_STATE_REFERENCE_TABLES)


def _verify_stage_state_references_v13(
    conn: sqlite3.Connection,
    *,
    expected_count: int,
) -> None:
    if not _has_stage_state_reference_schema_v13(conn):
        raise RuntimeError(
            "stage-state reference migration did not install the "
            "canonical schema"
        )
    observed_count = int(
        conn.execute("SELECT COUNT(*) FROM job_stage_states").fetchone()[0]
    )
    if observed_count != expected_count:
        raise RuntimeError(
            "stage-state reference migration changed the canonical row "
            f"count: expected {expected_count}, found {observed_count}"
        )
    orphan = conn.execute(
        """
        SELECT state.job_id
        FROM job_stage_states AS state
        LEFT JOIN jobs j
          ON j.tenant_id = state.tenant_id
         AND j.job_id = state.job_id
        WHERE j.job_id IS NULL
        LIMIT 1
        """
    ).fetchone()
    if orphan is not None:
        raise RuntimeError(
            "stage-state reference migration left an unresolved JobId"
        )
    for row in conn.execute(
        "SELECT DISTINCT job_id FROM job_stage_states"
    ).fetchall():
        _validate_job_uuid(str(row[0]))
    foreign_key_error = conn.execute("PRAGMA foreign_key_check").fetchone()
    if foreign_key_error is not None:
        raise RuntimeError(
            "stage-state reference migration found a foreign-key violation"
        )


def _reassign_stage_state_references_v13(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    losing_job_id: str,
    surviving_job_id: str,
) -> None:
    """Merge current lifecycle rows for an in-place identity collision."""
    if losing_job_id == surviving_job_id:
        return
    before_count = int(
        conn.execute("SELECT COUNT(*) FROM job_stage_states").fetchone()[0]
    )
    raw_rows = conn.execute(
        f"""
        SELECT rowid, job_id, stage, {", ".join(_STAGE_STATE_VALUE_COLUMNS)}
        FROM job_stage_states
        WHERE tenant_id = ? AND job_id IN (?, ?)
        ORDER BY job_id, stage, rowid
        """,
        (tenant_id, losing_job_id, surviving_job_id),
    ).fetchall()
    grouped: dict[
        str,
        list[tuple[str, int, tuple[Any, ...]]],
    ] = {}
    for row in raw_rows:
        grouped.setdefault(str(row[2]), []).append(
            (
                str(row[1]),
                int(row[0]),
                tuple(row[index] for index in range(3, len(row))),
            )
        )
    merged_rows = _normalize_stage_state_aggregate_versions_v13(
        [
            (
                tenant_id,
                surviving_job_id,
                stage,
                *_merge_stage_state_rows_v13(stage_rows),
            )
            for stage, stage_rows in sorted(grouped.items())
        ]
    )
    conn.execute(
        """
        DELETE FROM job_stage_states
        WHERE tenant_id = ? AND job_id IN (?, ?)
        """,
        (tenant_id, losing_job_id, surviving_job_id),
    )
    conn.executemany(
        f"""
        INSERT INTO job_stage_states (
            tenant_id, job_id, stage,
            {", ".join(_STAGE_STATE_VALUE_COLUMNS)}
        ) VALUES ({", ".join("?" for _ in range(17))})
        """,
        merged_rows,
    )
    expected_count = before_count - len(raw_rows) + len(merged_rows)
    _verify_stage_state_references_v13(
        conn,
        expected_count=expected_count,
    )


_ARTIFACT_REGISTRY_REFERENCE_SCHEMA_VERSION = 14
_ARTIFACT_REGISTRY_REFERENCE_TABLES = ("job_artifacts",)


def _create_job_artifacts_v14(
    conn: sqlite3.Connection,
    *,
    table_name: str = "job_artifacts",
) -> None:
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {table_name} (
            artifact_id         INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            job_id              TEXT NOT NULL,
            stage               TEXT NOT NULL,
            artifact_type       TEXT NOT NULL,
            status              TEXT NOT NULL DEFAULT 'candidate',
            path                TEXT NOT NULL,
            created_at          TEXT NOT NULL,
            size_bytes          INTEGER,
            metadata_json       TEXT,
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        )
        """
    )


def _create_job_artifact_indexes_v14(
    conn: sqlite3.Connection,
) -> None:
    conn.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_job_artifacts_registry_key
        ON job_artifacts(
            tenant_id, job_id, stage, artifact_type, path
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_artifacts_job_stage
        ON job_artifacts(tenant_id, job_id, stage, status)
        """
    )


def _has_artifact_registry_reference_schema_v14(
    conn: sqlite3.Connection,
) -> bool:
    return (
        "job_id" in _table_columns(conn, "job_artifacts")
        and "job_url" not in _table_columns(conn, "job_artifacts")
        and _primary_key_columns(conn, "job_artifacts") == ("artifact_id",)
        and _has_composite_job_id_foreign_key(
            conn,
            "job_artifacts",
            "job_id",
        )
        and _has_index(
            conn,
            "job_artifacts",
            "idx_job_artifacts_registry_key",
            (
                "tenant_id",
                "job_id",
                "stage",
                "artifact_type",
                "path",
            ),
            unique=True,
        )
        and _has_index(
            conn,
            "job_artifacts",
            "idx_job_artifacts_job_stage",
            ("tenant_id", "job_id", "stage", "status"),
            unique=False,
        )
    )


def _artifact_registry_row_rank_v14(
    row: tuple[Any, ...],
) -> tuple[tuple[float, str], int]:
    return (
        _stage_state_timestamp_rank(row[6]),
        int(row[0]),
    )


def _canonical_artifact_registry_rows_v14(
    conn: sqlite3.Connection,
) -> list[tuple[Any, ...]]:
    rows = conn.execute(
        """
        SELECT artifact_id, job_url, stage, artifact_type, status, path,
               created_at, size_bytes, metadata_json
        FROM job_artifacts
        ORDER BY artifact_id
        """
    ).fetchall()
    grouped: dict[
        tuple[str, str, str, str, str],
        list[tuple[Any, ...]],
    ] = {}
    for row in rows:
        raw_reference = str(row[1])
        stable_job_id = _resolve_job_reference_value(
            conn,
            tenant_id="local",
            reference=raw_reference,
            legacy_url=True,
        )
        if stable_job_id is None:
            raise RuntimeError(
                "artifact registry reference migration could not resolve "
                f"job_artifacts.job_url={raw_reference!r}"
            )
        _validate_job_uuid(stable_job_id)
        key = (
            "local",
            stable_job_id,
            str(row[2]),
            str(row[3]),
            str(row[5]),
        )
        grouped.setdefault(key, []).append(tuple(row))

    canonical: list[tuple[Any, ...]] = []
    for (
        tenant_id,
        stable_job_id,
        stage,
        artifact_type,
        path,
    ), candidates in sorted(grouped.items()):
        selected = max(candidates, key=_artifact_registry_row_rank_v14)
        canonical.append(
            (
                int(selected[0]),
                tenant_id,
                stable_job_id,
                stage,
                artifact_type,
                str(selected[4]),
                path,
                str(selected[6]),
                selected[7],
                selected[8],
            )
        )
    return canonical


def ensure_artifact_registry_references_v14(
    conn: sqlite3.Connection | None = None,
) -> list[str]:
    """Move generic artifact registrations to stable JobId references."""
    if conn is None:
        conn = get_connection()

    current = _assert_schema_version_supported(conn)
    if current >= _ARTIFACT_REGISTRY_REFERENCE_SCHEMA_VERSION:
        return []
    if current != _STAGE_STATE_REFERENCE_SCHEMA_VERSION:
        raise RuntimeError(
            "artifact registry reference migration requires stage-state "
            "schema v13"
        )

    conn.execute("SAVEPOINT artifact_registry_references_v14")
    try:
        if not _has_stage_state_reference_schema_v13(conn):
            raise RuntimeError(
                "artifact registry reference migration requires the stable "
                "stage-state reference schema"
            )
        if _has_artifact_registry_reference_schema_v14(conn):
            expected_count = int(
                conn.execute("SELECT COUNT(*) FROM job_artifacts").fetchone()[0]
            )
        else:
            canonical_rows = _canonical_artifact_registry_rows_v14(conn)
            expected_count = len(canonical_rows)
            conn.execute("DROP TABLE IF EXISTS job_artifacts_v14")
            _create_job_artifacts_v14(
                conn,
                table_name="job_artifacts_v14",
            )
            conn.executemany(
                """
                INSERT INTO job_artifacts_v14 (
                    artifact_id, tenant_id, job_id, stage, artifact_type,
                    status, path, created_at, size_bytes, metadata_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                canonical_rows,
            )
            conn.execute("DROP TABLE job_artifacts")
            conn.execute(
                "ALTER TABLE job_artifacts_v14 RENAME TO job_artifacts"
            )
            _create_job_artifact_indexes_v14(conn)
        _verify_artifact_registry_references_v14(
            conn,
            expected_count=expected_count,
        )
        conn.execute(
            f"PRAGMA user_version = "
            f"{_ARTIFACT_REGISTRY_REFERENCE_SCHEMA_VERSION}"
        )
        conn.execute("RELEASE SAVEPOINT artifact_registry_references_v14")
        conn.commit()
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT artifact_registry_references_v14")
        conn.execute("RELEASE SAVEPOINT artifact_registry_references_v14")
        raise

    return list(_ARTIFACT_REGISTRY_REFERENCE_TABLES)


def _verify_artifact_registry_references_v14(
    conn: sqlite3.Connection,
    *,
    expected_count: int,
) -> None:
    if not _has_artifact_registry_reference_schema_v14(conn):
        raise RuntimeError(
            "artifact registry reference migration did not install the "
            "canonical schema"
        )
    observed_count = int(
        conn.execute("SELECT COUNT(*) FROM job_artifacts").fetchone()[0]
    )
    if observed_count != expected_count:
        raise RuntimeError(
            "artifact registry reference migration changed the canonical "
            f"row count: expected {expected_count}, found {observed_count}"
        )
    orphan = conn.execute(
        """
        SELECT artifact.job_id
        FROM job_artifacts AS artifact
        LEFT JOIN jobs j
          ON j.tenant_id = artifact.tenant_id
         AND j.job_id = artifact.job_id
        WHERE j.job_id IS NULL
        LIMIT 1
        """
    ).fetchone()
    if orphan is not None:
        raise RuntimeError(
            "artifact registry reference migration left an unresolved JobId"
        )
    for row in conn.execute(
        "SELECT DISTINCT job_id FROM job_artifacts"
    ).fetchall():
        _validate_job_uuid(str(row[0]))
    foreign_key_error = conn.execute("PRAGMA foreign_key_check").fetchone()
    if foreign_key_error is not None:
        raise RuntimeError(
            "artifact registry reference migration found a foreign-key "
            "violation"
        )


def _reassign_artifact_registry_references_v14(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    losing_job_id: str,
    surviving_job_id: str,
) -> None:
    """Merge generic artifact registrations during Job identity collapse."""
    if losing_job_id == surviving_job_id:
        return
    before_count = int(
        conn.execute("SELECT COUNT(*) FROM job_artifacts").fetchone()[0]
    )
    rows = conn.execute(
        """
        SELECT artifact_id, tenant_id, job_id, stage, artifact_type,
               status, path, created_at, size_bytes, metadata_json
        FROM job_artifacts
        WHERE tenant_id = ? AND job_id IN (?, ?)
        ORDER BY artifact_id
        """,
        (tenant_id, losing_job_id, surviving_job_id),
    ).fetchall()
    grouped: dict[
        tuple[str, str, str],
        list[tuple[Any, ...]],
    ] = {}
    for row in rows:
        grouped.setdefault(
            (str(row[3]), str(row[4]), str(row[6])),
            [],
        ).append(tuple(row))
    merged_rows: list[tuple[Any, ...]] = []
    for (stage, artifact_type, path), candidates in sorted(grouped.items()):
        selected = max(
            candidates,
            key=lambda row: (
                _stage_state_timestamp_rank(row[7]),
                int(row[0]),
            ),
        )
        merged_rows.append(
            (
                int(selected[0]),
                tenant_id,
                surviving_job_id,
                stage,
                artifact_type,
                str(selected[5]),
                path,
                str(selected[7]),
                selected[8],
                selected[9],
            )
        )
    conn.execute(
        """
        DELETE FROM job_artifacts
        WHERE tenant_id = ? AND job_id IN (?, ?)
        """,
        (tenant_id, losing_job_id, surviving_job_id),
    )
    conn.executemany(
        """
        INSERT INTO job_artifacts (
            artifact_id, tenant_id, job_id, stage, artifact_type,
            status, path, created_at, size_bytes, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        merged_rows,
    )
    expected_count = before_count - len(rows) + len(merged_rows)
    _verify_artifact_registry_references_v14(
        conn,
        expected_count=expected_count,
    )


_MATERIALS_REFERENCE_SCHEMA_VERSION = 15
_MATERIALS_REFERENCE_TABLES = (
    "job_materials",
    "job_materials_artifacts",
    "job_material_layout_boxes",
    "job_bullet_provenance",
)


def _create_materials_tables_v15(
    conn: sqlite3.Connection,
    *,
    materials_table: str = "job_materials",
    artifacts_table: str = "job_materials_artifacts",
    layout_table: str = "job_material_layout_boxes",
) -> None:
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {materials_table} (
            tenant_id            TEXT NOT NULL DEFAULT 'local',
            job_id               TEXT NOT NULL,
            generation           INTEGER NOT NULL CHECK(generation > 0),
            status               TEXT NOT NULL,
            created_at           TEXT NOT NULL,
            updated_at           TEXT NOT NULL,
            last_validation_json TEXT,
            last_verdict_json    TEXT,
            metadata_json        TEXT,
            PRIMARY KEY (tenant_id, job_id, generation),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {artifacts_table} (
            tenant_id      TEXT NOT NULL DEFAULT 'local',
            job_id         TEXT NOT NULL,
            generation     INTEGER NOT NULL CHECK(generation > 0),
            artifact_type  TEXT NOT NULL,
            artifact_id    TEXT NOT NULL,
            status         TEXT NOT NULL,
            path           TEXT NOT NULL,
            render_format  TEXT NOT NULL,
            size_bytes     INTEGER,
            metadata_json  TEXT,
            created_at     TEXT NOT NULL,
            superseded_at  TEXT,
            PRIMARY KEY (
                tenant_id, job_id, generation, artifact_type
            ),
            FOREIGN KEY (tenant_id, job_id, generation)
                REFERENCES {materials_table}(
                    tenant_id, job_id, generation
                ) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {layout_table} (
            tenant_id         TEXT NOT NULL DEFAULT 'local',
            job_id            TEXT NOT NULL,
            generation        INTEGER NOT NULL CHECK(generation > 0),
            artifact_id       TEXT NOT NULL,
            box_index         INTEGER NOT NULL,
            semantic_id       TEXT NOT NULL,
            page_number       INTEGER NOT NULL,
            line_number       INTEGER,
            text_excerpt      TEXT NOT NULL,
            left_pct          REAL NOT NULL,
            top_pct           REAL NOT NULL,
            width_pct         REAL NOT NULL,
            height_pct        REAL NOT NULL,
            audit_target_json TEXT NOT NULL DEFAULT '{{}}',
            created_at        TEXT NOT NULL,
            PRIMARY KEY (
                tenant_id, job_id, generation, artifact_id, box_index
            ),
            FOREIGN KEY (tenant_id, job_id, generation)
                REFERENCES {materials_table}(
                    tenant_id, job_id, generation
                ) ON DELETE CASCADE
        )
        """
    )


def _create_bullet_provenance_v15(
    conn: sqlite3.Connection,
    *,
    table_name: str = "job_bullet_provenance",
    materials_table: str = "job_materials",
) -> None:
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {table_name} (
            tenant_id               TEXT NOT NULL DEFAULT 'local',
            job_id                  TEXT NOT NULL,
            generation              INTEGER NOT NULL CHECK(generation > 0),
            bullet_id               TEXT NOT NULL,
            artifact_id             TEXT NOT NULL,
            section                 TEXT NOT NULL,
            source_id               TEXT,
            evidence_ids_json       TEXT NOT NULL DEFAULT '[]',
            requirement_ids_json    TEXT NOT NULL DEFAULT '[]',
            matched_keywords_json   TEXT NOT NULL DEFAULT '[]',
            transform_type          TEXT NOT NULL,
            control                 TEXT NOT NULL,
            rationale               TEXT NOT NULL DEFAULT '',
            generated_text          TEXT NOT NULL,
            position                INTEGER NOT NULL DEFAULT 0,
            created_at              TEXT NOT NULL,
            coverage_json           TEXT,
            voice_json              TEXT,
            PRIMARY KEY (
                tenant_id, job_id, generation, bullet_id
            ),
            FOREIGN KEY (tenant_id, job_id, generation)
                REFERENCES {materials_table}(
                    tenant_id, job_id, generation
                ) ON DELETE CASCADE
        )
        """
    )


def _create_materials_indexes_v15(
    conn: sqlite3.Connection,
) -> None:
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_materials_tenant_job_gen
        ON job_materials(tenant_id, job_id, generation DESC)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_materials_artifacts_status
        ON job_materials_artifacts(
            artifact_type, status, created_at DESC
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_material_layout_boxes_artifact
        ON job_material_layout_boxes(
            tenant_id, artifact_id, page_number, box_index
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_bullet_provenance_tenant_job_gen
        ON job_bullet_provenance(tenant_id, job_id, generation DESC)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_bullet_provenance_artifact
        ON job_bullet_provenance(tenant_id, artifact_id)
        """
    )


def _has_materials_reference_schema_v15(
    conn: sqlite3.Connection,
) -> bool:
    return (
        "job_id" in _table_columns(conn, "job_materials")
        and "job_url" not in _table_columns(conn, "job_materials")
        and _primary_key_columns(conn, "job_materials")
        == ("tenant_id", "job_id", "generation")
        and _has_composite_job_id_foreign_key(
            conn,
            "job_materials",
            "job_id",
        )
        and "job_id" in _table_columns(
            conn,
            "job_materials_artifacts",
        )
        and "job_url" not in _table_columns(
            conn,
            "job_materials_artifacts",
        )
        and _primary_key_columns(conn, "job_materials_artifacts")
        == ("tenant_id", "job_id", "generation", "artifact_type")
        and _has_composite_foreign_key(
            conn,
            "job_materials_artifacts",
            "job_materials",
            {
                ("tenant_id", "tenant_id"),
                ("job_id", "job_id"),
                ("generation", "generation"),
            },
            on_delete="CASCADE",
        )
        and "job_id" in _table_columns(
            conn,
            "job_material_layout_boxes",
        )
        and "job_url" not in _table_columns(
            conn,
            "job_material_layout_boxes",
        )
        and _primary_key_columns(conn, "job_material_layout_boxes")
        == (
            "tenant_id",
            "job_id",
            "generation",
            "artifact_id",
            "box_index",
        )
        and _has_composite_foreign_key(
            conn,
            "job_material_layout_boxes",
            "job_materials",
            {
                ("tenant_id", "tenant_id"),
                ("job_id", "job_id"),
                ("generation", "generation"),
            },
            on_delete="CASCADE",
        )
        and "job_id" in _table_columns(
            conn,
            "job_bullet_provenance",
        )
        and "job_url" not in _table_columns(
            conn,
            "job_bullet_provenance",
        )
        and _primary_key_columns(conn, "job_bullet_provenance")
        == ("tenant_id", "job_id", "generation", "bullet_id")
        and _has_composite_foreign_key(
            conn,
            "job_bullet_provenance",
            "job_materials",
            {
                ("tenant_id", "tenant_id"),
                ("job_id", "job_id"),
                ("generation", "generation"),
            },
            on_delete="CASCADE",
        )
        and _has_index(
            conn,
            "job_materials",
            "idx_job_materials_tenant_job_gen",
            ("tenant_id", "job_id", "generation"),
            unique=False,
        )
        and _has_index(
            conn,
            "job_materials_artifacts",
            "idx_job_materials_artifacts_status",
            ("artifact_type", "status", "created_at"),
            unique=False,
        )
        and _has_index(
            conn,
            "job_material_layout_boxes",
            "idx_job_material_layout_boxes_artifact",
            ("tenant_id", "artifact_id", "page_number", "box_index"),
            unique=False,
        )
        and _has_index(
            conn,
            "job_bullet_provenance",
            "idx_job_bullet_provenance_tenant_job_gen",
            ("tenant_id", "job_id", "generation"),
            unique=False,
        )
        and _has_index(
            conn,
            "job_bullet_provenance",
            "idx_job_bullet_provenance_artifact",
            ("tenant_id", "artifact_id"),
            unique=False,
        )
    )


def _merge_material_histories_preserving_generation_order_v15(
    history: list[tuple[str, int, tuple[Any, ...]]],
) -> list[tuple[str, int, tuple[Any, ...]]]:
    """Interleave URL-alias histories without reversing either history."""
    by_reference: dict[str, list[tuple[str, int, tuple[Any, ...]]]] = {}
    for entry in history:
        by_reference.setdefault(entry[0], []).append(entry)
    for entries in by_reference.values():
        entries.sort(key=lambda entry: entry[1])

    offsets = {reference: 0 for reference in by_reference}
    merged: list[tuple[str, int, tuple[Any, ...]]] = []
    while len(merged) < len(history):
        eligible = [
            entries[offsets[reference]]
            for reference, entries in by_reference.items()
            if offsets[reference] < len(entries)
        ]
        selected = min(
            eligible,
            key=lambda entry: (
                str(entry[2][1]),
                entry[0],
                entry[1],
            ),
        )
        merged.append(selected)
        offsets[selected[0]] += 1
    return merged


def _canonical_material_rows_v15(
    conn: sqlite3.Connection,
) -> tuple[
    list[tuple[Any, ...]],
    dict[tuple[str, str, int], int],
]:
    rows = conn.execute(
        """
        SELECT tenant_id, job_url, generation, status, created_at, updated_at,
               last_validation_json, last_verdict_json, metadata_json
        FROM job_materials
        ORDER BY tenant_id, job_url, generation
        """
    ).fetchall()
    grouped: dict[
        tuple[str, str],
        list[tuple[str, int, tuple[Any, ...]]],
    ] = {}
    for row in rows:
        tenant_id = str(row[0])
        raw_reference = str(row[1])
        old_generation = int(row[2])
        if old_generation <= 0:
            raise RuntimeError(
                "materials reference migration found a non-positive "
                "generation"
            )
        stable_job_id = _resolve_job_reference_value(
            conn,
            tenant_id=tenant_id,
            reference=raw_reference,
            legacy_url=True,
        )
        if stable_job_id is None:
            raise RuntimeError(
                "materials reference migration could not resolve "
                f"job_materials.job_url={raw_reference!r}"
            )
        _validate_job_uuid(stable_job_id)
        grouped.setdefault((tenant_id, stable_job_id), []).append(
            (
                raw_reference,
                old_generation,
                tuple(row[3:]),
            )
        )

    canonical: list[tuple[Any, ...]] = []
    generation_map: dict[tuple[str, str, int], int] = {}
    for (tenant_id, stable_job_id), history in sorted(grouped.items()):
        ordered = _merge_material_histories_preserving_generation_order_v15(
            history
        )
        for new_generation, (
            raw_reference,
            old_generation,
            values,
        ) in enumerate(ordered, start=1):
            generation_map[
                (tenant_id, raw_reference, old_generation)
            ] = new_generation
            canonical.append(
                (
                    tenant_id,
                    stable_job_id,
                    new_generation,
                    *values,
                )
            )
    return canonical, generation_map


def _canonical_material_artifact_rows_v15(
    conn: sqlite3.Connection,
    *,
    generation_map: dict[tuple[str, str, int], int],
) -> list[tuple[Any, ...]]:
    rows = conn.execute(
        """
        SELECT m.tenant_id, artifact.job_url, artifact.generation,
               artifact.artifact_type, artifact.artifact_id,
               artifact.status, artifact.path, artifact.render_format,
               artifact.size_bytes, artifact.metadata_json,
               artifact.created_at, artifact.superseded_at
        FROM job_materials_artifacts AS artifact
        JOIN job_materials AS m
          ON m.job_url = artifact.job_url
         AND m.generation = artifact.generation
        ORDER BY m.tenant_id, artifact.job_url, artifact.generation,
                 artifact.artifact_type
        """
    ).fetchall()
    canonical: list[tuple[Any, ...]] = []
    for row in rows:
        tenant_id = str(row[0])
        raw_reference = str(row[1])
        old_generation = int(row[2])
        new_generation = generation_map.get(
            (tenant_id, raw_reference, old_generation)
        )
        stable_job_id = _resolve_job_reference_value(
            conn,
            tenant_id=tenant_id,
            reference=raw_reference,
            legacy_url=True,
        )
        if new_generation is None or stable_job_id is None:
            raise RuntimeError(
                "materials reference migration found an artifact without "
                "its material generation"
            )
        canonical.append(
            (
                tenant_id,
                stable_job_id,
                new_generation,
                *tuple(row[3:]),
            )
        )
    return canonical


def _canonical_material_layout_rows_v15(
    conn: sqlite3.Connection,
    *,
    generation_map: dict[tuple[str, str, int], int],
) -> list[tuple[Any, ...]]:
    rows = conn.execute(
        """
        SELECT tenant_id, job_url, generation, artifact_id, box_index,
               semantic_id, page_number, line_number, text_excerpt,
               left_pct, top_pct, width_pct, height_pct,
               audit_target_json, created_at
        FROM job_material_layout_boxes
        ORDER BY tenant_id, job_url, generation, artifact_id, box_index
        """
    ).fetchall()
    canonical: list[tuple[Any, ...]] = []
    for row in rows:
        tenant_id = str(row[0])
        raw_reference = str(row[1])
        old_generation = int(row[2])
        new_generation = generation_map.get(
            (tenant_id, raw_reference, old_generation)
        )
        stable_job_id = _resolve_job_reference_value(
            conn,
            tenant_id=tenant_id,
            reference=raw_reference,
            legacy_url=True,
        )
        if new_generation is None or stable_job_id is None:
            raise RuntimeError(
                "materials reference migration found a layout box without "
                "its material generation"
            )
        canonical.append(
            (
                tenant_id,
                stable_job_id,
                new_generation,
                *tuple(row[3:]),
            )
        )
    return canonical


def _canonical_bullet_provenance_rows_v15(
    conn: sqlite3.Connection,
    *,
    generation_map: dict[tuple[str, str, int], int],
) -> list[tuple[Any, ...]]:
    rows = conn.execute(
        """
        SELECT tenant_id, job_url, generation, bullet_id, artifact_id,
               section, source_id, evidence_ids_json,
               requirement_ids_json, matched_keywords_json,
               transform_type, control, rationale, generated_text,
               position, created_at, coverage_json, voice_json
        FROM job_bullet_provenance
        ORDER BY tenant_id, job_url, generation, bullet_id
        """
    ).fetchall()
    canonical: list[tuple[Any, ...]] = []
    for row in rows:
        tenant_id = str(row[0])
        raw_reference = str(row[1])
        old_generation = int(row[2])
        new_generation = generation_map.get(
            (tenant_id, raw_reference, old_generation)
        )
        stable_job_id = _resolve_job_reference_value(
            conn,
            tenant_id=tenant_id,
            reference=raw_reference,
            legacy_url=True,
        )
        if new_generation is None or stable_job_id is None:
            raise RuntimeError(
                "materials reference migration found bullet provenance "
                "without its material generation"
            )
        canonical.append(
            (
                tenant_id,
                stable_job_id,
                new_generation,
                *tuple(row[3:]),
            )
        )
    return canonical


def ensure_materials_references_v15(
    conn: sqlite3.Connection | None = None,
) -> list[str]:
    """Move generated-material authorities to stable JobId references."""
    if conn is None:
        conn = get_connection()

    current = _assert_schema_version_supported(conn)
    if current >= _MATERIALS_REFERENCE_SCHEMA_VERSION:
        return []
    if current != _ARTIFACT_REGISTRY_REFERENCE_SCHEMA_VERSION:
        raise RuntimeError(
            "materials reference migration requires artifact-registry "
            "schema v14"
        )

    conn.execute("SAVEPOINT materials_references_v15")
    try:
        if not _has_artifact_registry_reference_schema_v14(conn):
            raise RuntimeError(
                "materials reference migration requires the stable "
                "artifact-registry reference schema"
            )
        _backfill_legacy_materials_if_empty(conn)
        before_counts = {
            table: int(
                conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            )
            for table in _MATERIALS_REFERENCE_TABLES
        }

        if not _has_materials_reference_schema_v15(conn):
            (
                material_rows,
                generation_map,
            ) = _canonical_material_rows_v15(conn)
            artifact_rows = _canonical_material_artifact_rows_v15(
                conn,
                generation_map=generation_map,
            )
            layout_rows = _canonical_material_layout_rows_v15(
                conn,
                generation_map=generation_map,
            )
            provenance_rows = _canonical_bullet_provenance_rows_v15(
                conn,
                generation_map=generation_map,
            )
            for table in (
                "job_bullet_provenance_v15",
                "job_material_layout_boxes_v15",
                "job_materials_artifacts_v15",
                "job_materials_v15",
            ):
                conn.execute(f'DROP TABLE IF EXISTS "{table}"')
            _create_materials_tables_v15(
                conn,
                materials_table="job_materials_v15",
                artifacts_table="job_materials_artifacts_v15",
                layout_table="job_material_layout_boxes_v15",
            )
            _create_bullet_provenance_v15(
                conn,
                table_name="job_bullet_provenance_v15",
                materials_table="job_materials_v15",
            )
            conn.executemany(
                """
                INSERT INTO job_materials_v15 (
                    tenant_id, job_id, generation, status,
                    created_at, updated_at, last_validation_json,
                    last_verdict_json, metadata_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                material_rows,
            )
            conn.executemany(
                """
                INSERT INTO job_materials_artifacts_v15 (
                    tenant_id, job_id, generation, artifact_type,
                    artifact_id, status, path, render_format, size_bytes,
                    metadata_json, created_at, superseded_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                artifact_rows,
            )
            conn.executemany(
                """
                INSERT INTO job_material_layout_boxes_v15 (
                    tenant_id, job_id, generation, artifact_id, box_index,
                    semantic_id, page_number, line_number, text_excerpt,
                    left_pct, top_pct, width_pct, height_pct,
                    audit_target_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                layout_rows,
            )
            conn.executemany(
                """
                INSERT INTO job_bullet_provenance_v15 (
                    tenant_id, job_id, generation, bullet_id, artifact_id,
                    section, source_id, evidence_ids_json,
                    requirement_ids_json, matched_keywords_json,
                    transform_type, control, rationale, generated_text,
                    position, created_at, coverage_json, voice_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                provenance_rows,
            )

            for table in (
                "job_bullet_provenance",
                "job_material_layout_boxes",
                "job_materials_artifacts",
                "job_materials",
            ):
                conn.execute(f'DROP TABLE "{table}"')
            for table in (
                "job_materials",
                "job_materials_artifacts",
                "job_material_layout_boxes",
                "job_bullet_provenance",
            ):
                conn.execute(
                    f'ALTER TABLE "{table}_v15" RENAME TO "{table}"'
                )
            _create_materials_indexes_v15(conn)

        _verify_materials_references_v15(
            conn,
            expected_counts=before_counts,
        )
        conn.execute(
            f"PRAGMA user_version = "
            f"{_MATERIALS_REFERENCE_SCHEMA_VERSION}"
        )
        conn.execute("RELEASE SAVEPOINT materials_references_v15")
        conn.commit()
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT materials_references_v15")
        conn.execute("RELEASE SAVEPOINT materials_references_v15")
        raise

    return list(_MATERIALS_REFERENCE_TABLES)


def _verify_materials_references_v15(
    conn: sqlite3.Connection,
    *,
    expected_counts: dict[str, int],
) -> None:
    if not _has_materials_reference_schema_v15(conn):
        raise RuntimeError(
            "materials reference migration did not install the canonical "
            "schema"
        )
    for table, expected_count in expected_counts.items():
        observed_count = int(
            conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        )
        if observed_count != expected_count:
            raise RuntimeError(
                "materials reference migration changed the canonical "
                f"{table} row count: expected {expected_count}, "
                f"found {observed_count}"
            )
    orphan = conn.execute(
        """
        SELECT materials.job_id
        FROM job_materials AS materials
        LEFT JOIN jobs j
          ON j.tenant_id = materials.tenant_id
         AND j.job_id = materials.job_id
        WHERE j.job_id IS NULL
        LIMIT 1
        """
    ).fetchone()
    if orphan is not None:
        raise RuntimeError(
            "materials reference migration left an unresolved JobId"
        )
    for table in _MATERIALS_REFERENCE_TABLES:
        for row in conn.execute(
            f'SELECT DISTINCT job_id FROM "{table}"'
        ).fetchall():
            _validate_job_uuid(str(row[0]))
    foreign_key_error = conn.execute("PRAGMA foreign_key_check").fetchone()
    if foreign_key_error is not None:
        raise RuntimeError(
            "materials reference migration found a foreign-key violation"
        )


def _reassign_materials_references_v15(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    losing_job_id: str,
    surviving_job_id: str,
) -> dict[tuple[str, int], int]:
    """Merge complete material histories during stable Job identity collapse."""
    if losing_job_id == surviving_job_id:
        return {}
    before_counts = {
        table: int(
            conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        )
        for table in _MATERIALS_REFERENCE_TABLES
    }
    parent_rows = conn.execute(
        """
        SELECT job_id, generation, status, created_at, updated_at,
               last_validation_json, last_verdict_json, metadata_json
        FROM job_materials
        WHERE tenant_id = ? AND job_id IN (?, ?)
        ORDER BY job_id, generation
        """,
        (tenant_id, losing_job_id, surviving_job_id),
    ).fetchall()
    if not parent_rows:
        return {}

    history = [
        (
            str(row[0]),
            int(row[1]),
            tuple(row[2:]),
        )
        for row in parent_rows
    ]
    ordered = _merge_material_histories_preserving_generation_order_v15(
        history
    )
    generation_map: dict[tuple[str, int], int] = {}
    material_rows: list[tuple[Any, ...]] = []
    for new_generation, (
        old_job_id,
        old_generation,
        values,
    ) in enumerate(ordered, start=1):
        generation_map[(old_job_id, old_generation)] = new_generation
        material_rows.append(
            (
                tenant_id,
                surviving_job_id,
                new_generation,
                *values,
            )
        )

    artifact_source = conn.execute(
        """
        SELECT job_id, generation, artifact_type, artifact_id, status, path,
               render_format, size_bytes, metadata_json, created_at,
               superseded_at
        FROM job_materials_artifacts
        WHERE tenant_id = ? AND job_id IN (?, ?)
        ORDER BY job_id, generation, artifact_type
        """,
        (tenant_id, losing_job_id, surviving_job_id),
    ).fetchall()
    layout_source = conn.execute(
        """
        SELECT job_id, generation, artifact_id, box_index, semantic_id,
               page_number, line_number, text_excerpt, left_pct, top_pct,
               width_pct, height_pct, audit_target_json, created_at
        FROM job_material_layout_boxes
        WHERE tenant_id = ? AND job_id IN (?, ?)
        ORDER BY job_id, generation, artifact_id, box_index
        """,
        (tenant_id, losing_job_id, surviving_job_id),
    ).fetchall()
    provenance_source = conn.execute(
        """
        SELECT job_id, generation, bullet_id, artifact_id, section, source_id,
               evidence_ids_json, requirement_ids_json,
               matched_keywords_json, transform_type, control, rationale,
               generated_text, position, created_at, coverage_json, voice_json
        FROM job_bullet_provenance
        WHERE tenant_id = ? AND job_id IN (?, ?)
        ORDER BY job_id, generation, bullet_id
        """,
        (tenant_id, losing_job_id, surviving_job_id),
    ).fetchall()

    def _new_generation(row: sqlite3.Row) -> int:
        mapped = generation_map.get((str(row[0]), int(row[1])))
        if mapped is None:
            raise RuntimeError(
                "materials identity collapse found a dependent row without "
                "its material generation"
            )
        return mapped

    artifact_rows = [
        (
            tenant_id,
            surviving_job_id,
            _new_generation(row),
            *tuple(row[2:]),
        )
        for row in artifact_source
    ]
    layout_rows = [
        (
            tenant_id,
            surviving_job_id,
            _new_generation(row),
            *tuple(row[2:]),
        )
        for row in layout_source
    ]
    provenance_rows = [
        (
            tenant_id,
            surviving_job_id,
            _new_generation(row),
            *tuple(row[2:]),
        )
        for row in provenance_source
    ]

    for table in (
        "job_bullet_provenance",
        "job_material_layout_boxes",
        "job_materials_artifacts",
        "job_materials",
    ):
        conn.execute(
            f"""
            DELETE FROM {table}
            WHERE tenant_id = ? AND job_id IN (?, ?)
            """,
            (tenant_id, losing_job_id, surviving_job_id),
        )
    conn.executemany(
        """
        INSERT INTO job_materials (
            tenant_id, job_id, generation, status, created_at, updated_at,
            last_validation_json, last_verdict_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        material_rows,
    )
    conn.executemany(
        """
        INSERT INTO job_materials_artifacts (
            tenant_id, job_id, generation, artifact_type, artifact_id,
            status, path, render_format, size_bytes, metadata_json,
            created_at, superseded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        artifact_rows,
    )
    conn.executemany(
        """
        INSERT INTO job_material_layout_boxes (
            tenant_id, job_id, generation, artifact_id, box_index,
            semantic_id, page_number, line_number, text_excerpt,
            left_pct, top_pct, width_pct, height_pct, audit_target_json,
            created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        layout_rows,
    )
    conn.executemany(
        """
        INSERT INTO job_bullet_provenance (
            tenant_id, job_id, generation, bullet_id, artifact_id,
            section, source_id, evidence_ids_json, requirement_ids_json,
            matched_keywords_json, transform_type, control, rationale,
            generated_text, position, created_at, coverage_json, voice_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        provenance_rows,
    )
    _verify_materials_references_v15(
        conn,
        expected_counts=before_counts,
    )
    return generation_map


_EMPLOYER_ANALYSIS_REFERENCE_SCHEMA_VERSION = 16
_EMPLOYER_ANALYSIS_REFERENCE_TABLES = (
    "job_employer_analysis",
    "job_employer_analysis_sub_analyses",
    "job_employer_analysis_failures",
)


def _create_employer_analysis_tables_v16(
    conn: sqlite3.Connection,
    *,
    analysis_table: str = "job_employer_analysis",
    sub_analyses_table: str = "job_employer_analysis_sub_analyses",
    failures_table: str = "job_employer_analysis_failures",
) -> None:
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {analysis_table} (
            tenant_id                 TEXT NOT NULL DEFAULT 'local',
            job_id                    TEXT NOT NULL,
            generation                INTEGER NOT NULL CHECK(generation > 0),
            snapshot_hash             TEXT NOT NULL,
            prompt_version            TEXT NOT NULL,
            sdk_set_version           TEXT NOT NULL,
            cache_key                 TEXT NOT NULL,
            role_framing              TEXT NOT NULL DEFAULT '',
            inferred_seniority        TEXT NOT NULL DEFAULT '',
            ideal_candidate_narrative TEXT NOT NULL DEFAULT '',
            requirements_json         TEXT NOT NULL DEFAULT '[]',
            keywords_json             TEXT NOT NULL DEFAULT '[]',
            agreement_json            TEXT NOT NULL DEFAULT '{{}}',
            eeo_screen_json           TEXT NOT NULL DEFAULT '[]',
            legs_attempted            INTEGER NOT NULL,
            legs_succeeded            INTEGER NOT NULL,
            created_at                TEXT NOT NULL,
            PRIMARY KEY (tenant_id, job_id, generation),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {sub_analyses_table} (
            tenant_id    TEXT NOT NULL DEFAULT 'local',
            job_id       TEXT NOT NULL,
            generation   INTEGER NOT NULL CHECK(generation > 0),
            model_id     TEXT NOT NULL,
            analysis_json TEXT NOT NULL,
            PRIMARY KEY (tenant_id, job_id, generation, model_id),
            FOREIGN KEY (tenant_id, job_id, generation)
                REFERENCES {analysis_table}(
                    tenant_id, job_id, generation
                ) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {failures_table} (
            tenant_id  TEXT NOT NULL DEFAULT 'local',
            job_id     TEXT NOT NULL,
            generation INTEGER NOT NULL CHECK(generation > 0),
            model_id   TEXT NOT NULL,
            error      TEXT NOT NULL,
            raw_output TEXT,
            PRIMARY KEY (tenant_id, job_id, generation, model_id),
            FOREIGN KEY (tenant_id, job_id, generation)
                REFERENCES {analysis_table}(
                    tenant_id, job_id, generation
                ) ON DELETE CASCADE
        )
        """
    )


def _create_employer_analysis_indexes_v16(
    conn: sqlite3.Connection,
) -> None:
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_employer_analysis_cache_key
        ON job_employer_analysis(tenant_id, job_id, cache_key)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_employer_analysis_tenant_job_gen
        ON job_employer_analysis(tenant_id, job_id, generation DESC)
        """
    )


def _has_employer_analysis_reference_schema_v16(
    conn: sqlite3.Connection,
) -> bool:
    return (
        "job_id" in _table_columns(conn, "job_employer_analysis")
        and "job_url" not in _table_columns(
            conn,
            "job_employer_analysis",
        )
        and _primary_key_columns(conn, "job_employer_analysis")
        == ("tenant_id", "job_id", "generation")
        and _has_composite_job_id_foreign_key(
            conn,
            "job_employer_analysis",
            "job_id",
        )
        and "job_id" in _table_columns(
            conn,
            "job_employer_analysis_sub_analyses",
        )
        and "job_url" not in _table_columns(
            conn,
            "job_employer_analysis_sub_analyses",
        )
        and _primary_key_columns(
            conn,
            "job_employer_analysis_sub_analyses",
        )
        == ("tenant_id", "job_id", "generation", "model_id")
        and _has_composite_foreign_key(
            conn,
            "job_employer_analysis_sub_analyses",
            "job_employer_analysis",
            {
                ("tenant_id", "tenant_id"),
                ("job_id", "job_id"),
                ("generation", "generation"),
            },
            on_delete="CASCADE",
        )
        and "job_id" in _table_columns(
            conn,
            "job_employer_analysis_failures",
        )
        and "job_url" not in _table_columns(
            conn,
            "job_employer_analysis_failures",
        )
        and _primary_key_columns(
            conn,
            "job_employer_analysis_failures",
        )
        == ("tenant_id", "job_id", "generation", "model_id")
        and _has_composite_foreign_key(
            conn,
            "job_employer_analysis_failures",
            "job_employer_analysis",
            {
                ("tenant_id", "tenant_id"),
                ("job_id", "job_id"),
                ("generation", "generation"),
            },
            on_delete="CASCADE",
        )
        and _has_index(
            conn,
            "job_employer_analysis",
            "idx_job_employer_analysis_cache_key",
            ("tenant_id", "job_id", "cache_key"),
            unique=False,
        )
        and _has_index(
            conn,
            "job_employer_analysis",
            "idx_job_employer_analysis_tenant_job_gen",
            ("tenant_id", "job_id", "generation"),
            unique=False,
        )
    )


def _merge_employer_analysis_histories_preserving_order_v16(
    history: list[tuple[str, int, tuple[Any, ...]]],
) -> list[tuple[str, int, tuple[Any, ...]]]:
    """Interleave analysis histories without reversing either history."""
    by_reference: dict[str, list[tuple[str, int, tuple[Any, ...]]]] = {}
    for entry in history:
        by_reference.setdefault(entry[0], []).append(entry)
    for entries in by_reference.values():
        entries.sort(key=lambda entry: entry[1])

    offsets = {reference: 0 for reference in by_reference}
    merged: list[tuple[str, int, tuple[Any, ...]]] = []
    while len(merged) < len(history):
        eligible = [
            entries[offsets[reference]]
            for reference, entries in by_reference.items()
            if offsets[reference] < len(entries)
        ]
        selected = min(
            eligible,
            key=lambda entry: (
                str(entry[2][-1]),
                entry[0],
                entry[1],
            ),
        )
        merged.append(selected)
        offsets[selected[0]] += 1
    return merged


def _canonical_employer_analysis_rows_v16(
    conn: sqlite3.Connection,
) -> tuple[
    list[tuple[Any, ...]],
    dict[tuple[str, str, int], int],
]:
    rows = conn.execute(
        """
        SELECT tenant_id, job_url, generation, snapshot_hash,
               prompt_version, sdk_set_version, cache_key, role_framing,
               inferred_seniority, ideal_candidate_narrative,
               requirements_json, keywords_json, agreement_json,
               eeo_screen_json, legs_attempted, legs_succeeded, created_at
        FROM job_employer_analysis
        ORDER BY tenant_id, job_url, generation
        """
    ).fetchall()
    grouped: dict[
        tuple[str, str],
        list[tuple[str, int, tuple[Any, ...]]],
    ] = {}
    for row in rows:
        tenant_id = str(row[0])
        raw_reference = str(row[1])
        old_generation = int(row[2])
        if old_generation <= 0:
            raise RuntimeError(
                "employer-analysis reference migration found a "
                "non-positive generation"
            )
        stable_job_id = _resolve_job_reference_value(
            conn,
            tenant_id=tenant_id,
            reference=raw_reference,
            legacy_url=True,
        )
        if stable_job_id is None:
            raise RuntimeError(
                "employer-analysis reference migration could not resolve "
                f"job_employer_analysis.job_url={raw_reference!r}"
            )
        _validate_job_uuid(stable_job_id)
        grouped.setdefault((tenant_id, stable_job_id), []).append(
            (
                raw_reference,
                old_generation,
                tuple(row[3:]),
            )
        )

    canonical: list[tuple[Any, ...]] = []
    generation_map: dict[tuple[str, str, int], int] = {}
    for (tenant_id, stable_job_id), history in sorted(grouped.items()):
        ordered = (
            _merge_employer_analysis_histories_preserving_order_v16(
                history
            )
        )
        for new_generation, (
            raw_reference,
            old_generation,
            values,
        ) in enumerate(ordered, start=1):
            generation_map[
                (tenant_id, raw_reference, old_generation)
            ] = new_generation
            canonical.append(
                (
                    tenant_id,
                    stable_job_id,
                    new_generation,
                    *values,
                )
            )
    return canonical, generation_map


def _canonical_employer_analysis_child_rows_v16(
    conn: sqlite3.Connection,
    *,
    table_name: str,
    value_columns: str,
    generation_map: dict[tuple[str, str, int], int],
) -> list[tuple[Any, ...]]:
    rows = conn.execute(
        f"""
        SELECT parent.tenant_id, child.job_url, child.generation,
               {value_columns}
        FROM {table_name} AS child
        JOIN job_employer_analysis AS parent
          ON parent.job_url = child.job_url
         AND parent.generation = child.generation
        ORDER BY parent.tenant_id, child.job_url, child.generation,
                 child.model_id
        """
    ).fetchall()
    canonical: list[tuple[Any, ...]] = []
    for row in rows:
        tenant_id = str(row[0])
        raw_reference = str(row[1])
        old_generation = int(row[2])
        new_generation = generation_map.get(
            (tenant_id, raw_reference, old_generation)
        )
        stable_job_id = _resolve_job_reference_value(
            conn,
            tenant_id=tenant_id,
            reference=raw_reference,
            legacy_url=True,
        )
        if new_generation is None or stable_job_id is None:
            raise RuntimeError(
                "employer-analysis reference migration found a child "
                "without its parent generation"
            )
        canonical.append(
            (
                tenant_id,
                stable_job_id,
                new_generation,
                *tuple(row[3:]),
            )
        )
    return canonical


def ensure_employer_analysis_references_v16(
    conn: sqlite3.Connection | None = None,
) -> list[str]:
    """Move employer-analysis authorities to stable JobId references."""
    if conn is None:
        conn = get_connection()

    current = _assert_schema_version_supported(conn)
    if current >= _EMPLOYER_ANALYSIS_REFERENCE_SCHEMA_VERSION:
        return []
    if current != _MATERIALS_REFERENCE_SCHEMA_VERSION:
        raise RuntimeError(
            "employer-analysis reference migration requires materials "
            "schema v15"
        )

    conn.execute("SAVEPOINT employer_analysis_references_v16")
    try:
        if not _has_materials_reference_schema_v15(conn):
            raise RuntimeError(
                "employer-analysis reference migration requires the "
                "stable materials reference schema"
            )
        before_counts = {
            table: int(
                conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            )
            for table in _EMPLOYER_ANALYSIS_REFERENCE_TABLES
        }

        if not _has_employer_analysis_reference_schema_v16(conn):
            (
                analysis_rows,
                generation_map,
            ) = _canonical_employer_analysis_rows_v16(conn)
            sub_analysis_rows = (
                _canonical_employer_analysis_child_rows_v16(
                    conn,
                    table_name="job_employer_analysis_sub_analyses",
                    value_columns="child.model_id, child.analysis_json",
                    generation_map=generation_map,
                )
            )
            failure_rows = _canonical_employer_analysis_child_rows_v16(
                conn,
                table_name="job_employer_analysis_failures",
                value_columns=(
                    "child.model_id, child.error, child.raw_output"
                ),
                generation_map=generation_map,
            )

            for table in (
                "job_employer_analysis_sub_analyses_v16",
                "job_employer_analysis_failures_v16",
                "job_employer_analysis_v16",
            ):
                conn.execute(f'DROP TABLE IF EXISTS "{table}"')
            _create_employer_analysis_tables_v16(
                conn,
                analysis_table="job_employer_analysis_v16",
                sub_analyses_table=(
                    "job_employer_analysis_sub_analyses_v16"
                ),
                failures_table="job_employer_analysis_failures_v16",
            )
            conn.executemany(
                """
                INSERT INTO job_employer_analysis_v16 (
                    tenant_id, job_id, generation, snapshot_hash,
                    prompt_version, sdk_set_version, cache_key,
                    role_framing, inferred_seniority,
                    ideal_candidate_narrative, requirements_json,
                    keywords_json, agreement_json, eeo_screen_json,
                    legs_attempted, legs_succeeded, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                analysis_rows,
            )
            conn.executemany(
                """
                INSERT INTO job_employer_analysis_sub_analyses_v16 (
                    tenant_id, job_id, generation, model_id, analysis_json
                ) VALUES (?, ?, ?, ?, ?)
                """,
                sub_analysis_rows,
            )
            conn.executemany(
                """
                INSERT INTO job_employer_analysis_failures_v16 (
                    tenant_id, job_id, generation, model_id, error,
                    raw_output
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                failure_rows,
            )

            for table in (
                "job_employer_analysis_sub_analyses",
                "job_employer_analysis_failures",
                "job_employer_analysis",
            ):
                conn.execute(f'DROP TABLE "{table}"')
            for table in (
                "job_employer_analysis",
                "job_employer_analysis_sub_analyses",
                "job_employer_analysis_failures",
            ):
                conn.execute(
                    f'ALTER TABLE "{table}_v16" RENAME TO "{table}"'
                )
            _create_employer_analysis_indexes_v16(conn)

        _verify_employer_analysis_references_v16(
            conn,
            expected_counts=before_counts,
        )
        conn.execute(
            f"PRAGMA user_version = "
            f"{_EMPLOYER_ANALYSIS_REFERENCE_SCHEMA_VERSION}"
        )
        conn.execute(
            "RELEASE SAVEPOINT employer_analysis_references_v16"
        )
        conn.commit()
    except BaseException:
        conn.execute(
            "ROLLBACK TO SAVEPOINT employer_analysis_references_v16"
        )
        conn.execute(
            "RELEASE SAVEPOINT employer_analysis_references_v16"
        )
        raise

    return list(_EMPLOYER_ANALYSIS_REFERENCE_TABLES)


def _verify_employer_analysis_references_v16(
    conn: sqlite3.Connection,
    *,
    expected_counts: dict[str, int],
) -> None:
    if not _has_employer_analysis_reference_schema_v16(conn):
        raise RuntimeError(
            "employer-analysis reference migration did not install the "
            "canonical schema"
        )
    for table, expected_count in expected_counts.items():
        observed_count = int(
            conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        )
        if observed_count != expected_count:
            raise RuntimeError(
                "employer-analysis reference migration changed the "
                f"{table} row count: expected {expected_count}, "
                f"found {observed_count}"
            )
    orphan = conn.execute(
        """
        SELECT analysis.job_id
        FROM job_employer_analysis AS analysis
        LEFT JOIN jobs j
          ON j.tenant_id = analysis.tenant_id
         AND j.job_id = analysis.job_id
        WHERE j.job_id IS NULL
        LIMIT 1
        """
    ).fetchone()
    if orphan is not None:
        raise RuntimeError(
            "employer-analysis reference migration left an unresolved "
            "JobId"
        )
    for table in _EMPLOYER_ANALYSIS_REFERENCE_TABLES:
        for row in conn.execute(
            f'SELECT DISTINCT job_id FROM "{table}"'
        ).fetchall():
            _validate_job_uuid(str(row[0]))
    foreign_key_error = conn.execute(
        "PRAGMA foreign_key_check"
    ).fetchone()
    if foreign_key_error is not None:
        raise RuntimeError(
            "employer-analysis reference migration found a foreign-key "
            "violation"
        )


def _reassign_employer_analysis_references_v16(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    losing_job_id: str,
    surviving_job_id: str,
) -> dict[tuple[str, int], int]:
    """Merge full employer-analysis histories during identity collapse."""
    if losing_job_id == surviving_job_id:
        return {}
    before_counts = {
        table: int(
            conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        )
        for table in _EMPLOYER_ANALYSIS_REFERENCE_TABLES
    }
    parent_rows = conn.execute(
        """
        SELECT job_id, generation, snapshot_hash, prompt_version,
               sdk_set_version, cache_key, role_framing,
               inferred_seniority, ideal_candidate_narrative,
               requirements_json, keywords_json, agreement_json,
               eeo_screen_json, legs_attempted, legs_succeeded, created_at
        FROM job_employer_analysis
        WHERE tenant_id = ? AND job_id IN (?, ?)
        ORDER BY job_id, generation
        """,
        (tenant_id, losing_job_id, surviving_job_id),
    ).fetchall()
    if not parent_rows:
        return {}

    history = [
        (
            str(row[0]),
            int(row[1]),
            tuple(row[2:]),
        )
        for row in parent_rows
    ]
    ordered = _merge_employer_analysis_histories_preserving_order_v16(
        history
    )
    generation_map: dict[tuple[str, int], int] = {}
    analysis_rows: list[tuple[Any, ...]] = []
    for new_generation, (
        old_job_id,
        old_generation,
        values,
    ) in enumerate(ordered, start=1):
        generation_map[(old_job_id, old_generation)] = new_generation
        analysis_rows.append(
            (
                tenant_id,
                surviving_job_id,
                new_generation,
                *values,
            )
        )

    sub_analysis_source = conn.execute(
        """
        SELECT job_id, generation, model_id, analysis_json
        FROM job_employer_analysis_sub_analyses
        WHERE tenant_id = ? AND job_id IN (?, ?)
        ORDER BY job_id, generation, model_id
        """,
        (tenant_id, losing_job_id, surviving_job_id),
    ).fetchall()
    failure_source = conn.execute(
        """
        SELECT job_id, generation, model_id, error, raw_output
        FROM job_employer_analysis_failures
        WHERE tenant_id = ? AND job_id IN (?, ?)
        ORDER BY job_id, generation, model_id
        """,
        (tenant_id, losing_job_id, surviving_job_id),
    ).fetchall()

    def _new_generation(row: sqlite3.Row) -> int:
        mapped = generation_map.get((str(row[0]), int(row[1])))
        if mapped is None:
            raise RuntimeError(
                "employer-analysis identity collapse found a child "
                "without its parent generation"
            )
        return mapped

    sub_analysis_rows = [
        (
            tenant_id,
            surviving_job_id,
            _new_generation(row),
            *tuple(row[2:]),
        )
        for row in sub_analysis_source
    ]
    failure_rows = [
        (
            tenant_id,
            surviving_job_id,
            _new_generation(row),
            *tuple(row[2:]),
        )
        for row in failure_source
    ]

    for table in (
        "job_employer_analysis_sub_analyses",
        "job_employer_analysis_failures",
        "job_employer_analysis",
    ):
        conn.execute(
            f"""
            DELETE FROM {table}
            WHERE tenant_id = ? AND job_id IN (?, ?)
            """,
            (tenant_id, losing_job_id, surviving_job_id),
        )
    conn.executemany(
        """
        INSERT INTO job_employer_analysis (
            tenant_id, job_id, generation, snapshot_hash,
            prompt_version, sdk_set_version, cache_key, role_framing,
            inferred_seniority, ideal_candidate_narrative,
            requirements_json, keywords_json, agreement_json,
            eeo_screen_json, legs_attempted, legs_succeeded, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        analysis_rows,
    )
    conn.executemany(
        """
        INSERT INTO job_employer_analysis_sub_analyses (
            tenant_id, job_id, generation, model_id, analysis_json
        ) VALUES (?, ?, ?, ?, ?)
        """,
        sub_analysis_rows,
    )
    conn.executemany(
        """
        INSERT INTO job_employer_analysis_failures (
            tenant_id, job_id, generation, model_id, error, raw_output
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        failure_rows,
    )
    _verify_employer_analysis_references_v16(
        conn,
        expected_counts=before_counts,
    )
    return generation_map


_RESUME_TEMPLATE_REFERENCE_TABLES = (
    "job_resume_template_assignments",
    "resume_template_refresh_attempts",
)


def _create_resume_template_reference_tables_v17(
    conn: sqlite3.Connection,
    *,
    assignments_table: str = "job_resume_template_assignments",
    refresh_attempts_table: str = "resume_template_refresh_attempts",
) -> None:
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {assignments_table} (
            tenant_id   TEXT NOT NULL DEFAULT 'local',
            job_id      TEXT NOT NULL,
            template_id TEXT NOT NULL,
            version_id  TEXT NOT NULL,
            updated_at  TEXT NOT NULL,
            PRIMARY KEY (tenant_id, job_id),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {refresh_attempts_table} (
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            attempt_id          TEXT NOT NULL,
            job_id              TEXT NOT NULL,
            status              TEXT NOT NULL,
            from_generation     INTEGER,
            to_generation       INTEGER,
            template_id         TEXT,
            template_version_id TEXT,
            template_hash       TEXT,
            error_message       TEXT,
            metadata_json       TEXT NOT NULL DEFAULT '{{}}',
            created_at          TEXT NOT NULL,
            completed_at        TEXT,
            PRIMARY KEY (tenant_id, attempt_id),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        )
        """
    )


def _create_resume_template_reference_indexes_v17(
    conn: sqlite3.Connection,
) -> None:
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS
            idx_job_resume_template_assignments_template
        ON job_resume_template_assignments(
            tenant_id, template_id, version_id
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS
            idx_resume_template_refresh_attempts_job
        ON resume_template_refresh_attempts(
            tenant_id, job_id, created_at DESC
        )
        """
    )


def _has_resume_template_reference_schema_v17(
    conn: sqlite3.Connection,
) -> bool:
    return (
        "job_id"
        in _table_columns(
            conn,
            "job_resume_template_assignments",
        )
        and "job_url"
        not in _table_columns(
            conn,
            "job_resume_template_assignments",
        )
        and _primary_key_columns(
            conn,
            "job_resume_template_assignments",
        )
        == ("tenant_id", "job_id")
        and _has_composite_job_id_foreign_key(
            conn,
            "job_resume_template_assignments",
            "job_id",
        )
        and "job_id"
        in _table_columns(
            conn,
            "resume_template_refresh_attempts",
        )
        and "job_url"
        not in _table_columns(
            conn,
            "resume_template_refresh_attempts",
        )
        and _primary_key_columns(
            conn,
            "resume_template_refresh_attempts",
        )
        == ("tenant_id", "attempt_id")
        and _has_composite_job_id_foreign_key(
            conn,
            "resume_template_refresh_attempts",
            "job_id",
        )
        and _has_index(
            conn,
            "job_resume_template_assignments",
            "idx_job_resume_template_assignments_template",
            ("tenant_id", "template_id", "version_id"),
            unique=False,
        )
        and _has_index(
            conn,
            "resume_template_refresh_attempts",
            "idx_resume_template_refresh_attempts_job",
            ("tenant_id", "job_id", "created_at"),
            unique=False,
        )
    )


def _canonical_resume_template_assignments_v17(
    conn: sqlite3.Connection,
) -> list[tuple[Any, ...]]:
    rows = conn.execute(
        """
        SELECT tenant_id, job_url, template_id, version_id, updated_at
        FROM job_resume_template_assignments
        ORDER BY tenant_id, job_url
        """
    ).fetchall()
    canonical: dict[tuple[str, str], tuple[Any, ...]] = {}
    source_order: dict[
        tuple[str, str],
        tuple[str, bool, str],
    ] = {}
    for row in rows:
        tenant_id = str(row[0])
        raw_reference = str(row[1])
        stable_job_id = _resolve_job_reference_value(
            conn,
            tenant_id=tenant_id,
            reference=raw_reference,
            legacy_url=True,
        )
        if stable_job_id is None:
            raise RuntimeError(
                "resume-template reference migration could not resolve "
                f"job_resume_template_assignments.job_url="
                f"{raw_reference!r}"
            )
        _validate_job_uuid(stable_job_id)
        key = (tenant_id, stable_job_id)
        storage_row = conn.execute(
            """
            SELECT url
            FROM jobs
            WHERE tenant_id = ? AND job_id = ?
            LIMIT 1
            """,
            (tenant_id, stable_job_id),
        ).fetchone()
        storage_url = (
            str(storage_row[0])
            if storage_row is not None
            else ""
        )
        candidate_order = (
            str(row[4]),
            raw_reference == storage_url,
            raw_reference,
        )
        if key not in canonical or candidate_order > source_order[key]:
            canonical[key] = (
                tenant_id,
                stable_job_id,
                str(row[2]),
                str(row[3]),
                str(row[4]),
            )
            source_order[key] = candidate_order
    return [
        canonical[key]
        for key in sorted(canonical)
    ]


def _canonical_resume_template_refresh_attempts_v17(
    conn: sqlite3.Connection,
) -> list[tuple[Any, ...]]:
    rows = conn.execute(
        """
        SELECT tenant_id, attempt_id, job_url, status, from_generation,
               to_generation, template_id, template_version_id,
               template_hash, error_message, metadata_json, created_at,
               completed_at
        FROM resume_template_refresh_attempts
        ORDER BY tenant_id, attempt_id
        """
    ).fetchall()
    canonical: list[tuple[Any, ...]] = []
    for row in rows:
        tenant_id = str(row[0])
        raw_reference = str(row[2])
        stable_job_id = _resolve_job_reference_value(
            conn,
            tenant_id=tenant_id,
            reference=raw_reference,
            legacy_url=True,
        )
        if stable_job_id is None:
            raise RuntimeError(
                "resume-template reference migration could not resolve "
                f"resume_template_refresh_attempts.job_url="
                f"{raw_reference!r}"
            )
        _validate_job_uuid(stable_job_id)
        canonical.append(
            (
                tenant_id,
                str(row[1]),
                stable_job_id,
                *tuple(row[3:]),
            )
        )
    return canonical


def ensure_resume_template_references_v17(
    conn: sqlite3.Connection | None = None,
) -> list[str]:
    """Move job-owned resume-template configuration to stable JobIds."""
    if conn is None:
        conn = get_connection()

    current = _assert_schema_version_supported(conn)
    if current >= _RESUME_TEMPLATE_REFERENCE_SCHEMA_VERSION:
        return []
    if current != _EMPLOYER_ANALYSIS_REFERENCE_SCHEMA_VERSION:
        raise RuntimeError(
            "resume-template reference migration requires employer-analysis "
            "schema v16"
        )

    conn.execute("SAVEPOINT resume_template_references_v17")
    try:
        if not _has_employer_analysis_reference_schema_v16(conn):
            raise RuntimeError(
                "resume-template reference migration requires the stable "
                "employer-analysis reference schema"
            )
        before_counts = {
            table: int(
                conn.execute(
                    f'SELECT COUNT(*) FROM "{table}"'
                ).fetchone()[0]
            )
            for table in _RESUME_TEMPLATE_REFERENCE_TABLES
        }
        expected_counts = dict(before_counts)

        if not _has_resume_template_reference_schema_v17(conn):
            assignment_rows = (
                _canonical_resume_template_assignments_v17(conn)
            )
            refresh_attempt_rows = (
                _canonical_resume_template_refresh_attempts_v17(conn)
            )
            expected_counts[
                "job_resume_template_assignments"
            ] = len(assignment_rows)

            for table in (
                "job_resume_template_assignments_v17",
                "resume_template_refresh_attempts_v17",
            ):
                conn.execute(f'DROP TABLE IF EXISTS "{table}"')
            _create_resume_template_reference_tables_v17(
                conn,
                assignments_table=(
                    "job_resume_template_assignments_v17"
                ),
                refresh_attempts_table=(
                    "resume_template_refresh_attempts_v17"
                ),
            )
            conn.executemany(
                """
                INSERT INTO job_resume_template_assignments_v17 (
                    tenant_id, job_id, template_id, version_id, updated_at
                ) VALUES (?, ?, ?, ?, ?)
                """,
                assignment_rows,
            )
            conn.executemany(
                """
                INSERT INTO resume_template_refresh_attempts_v17 (
                    tenant_id, attempt_id, job_id, status,
                    from_generation, to_generation, template_id,
                    template_version_id, template_hash, error_message,
                    metadata_json, created_at, completed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                refresh_attempt_rows,
            )
            for table in _RESUME_TEMPLATE_REFERENCE_TABLES:
                conn.execute(f'DROP TABLE "{table}"')
            for table in _RESUME_TEMPLATE_REFERENCE_TABLES:
                conn.execute(
                    f'ALTER TABLE "{table}_v17" RENAME TO "{table}"'
                )
            _create_resume_template_reference_indexes_v17(conn)

        _verify_resume_template_references_v17(
            conn,
            expected_counts=expected_counts,
        )
        conn.execute(
            f"PRAGMA user_version = "
            f"{_RESUME_TEMPLATE_REFERENCE_SCHEMA_VERSION}"
        )
        conn.execute(
            "RELEASE SAVEPOINT resume_template_references_v17"
        )
        conn.commit()
    except BaseException:
        conn.execute(
            "ROLLBACK TO SAVEPOINT resume_template_references_v17"
        )
        conn.execute(
            "RELEASE SAVEPOINT resume_template_references_v17"
        )
        raise

    return list(_RESUME_TEMPLATE_REFERENCE_TABLES)


def _verify_resume_template_references_v17(
    conn: sqlite3.Connection,
    *,
    expected_counts: dict[str, int],
) -> None:
    if not _has_resume_template_reference_schema_v17(conn):
        raise RuntimeError(
            "resume-template reference migration did not install the "
            "canonical schema"
        )
    for table, expected_count in expected_counts.items():
        observed_count = int(
            conn.execute(
                f'SELECT COUNT(*) FROM "{table}"'
            ).fetchone()[0]
        )
        if observed_count != expected_count:
            raise RuntimeError(
                "resume-template reference migration changed the "
                f"{table} row count: expected {expected_count}, "
                f"found {observed_count}"
            )
    for table in _RESUME_TEMPLATE_REFERENCE_TABLES:
        orphan = conn.execute(
            f"""
            SELECT owned.job_id
            FROM {table} AS owned
            LEFT JOIN jobs
              ON jobs.tenant_id = owned.tenant_id
             AND jobs.job_id = owned.job_id
            WHERE jobs.job_id IS NULL
            LIMIT 1
            """
        ).fetchone()
        if orphan is not None:
            raise RuntimeError(
                "resume-template reference migration left an "
                f"unresolved {table}.job_id"
            )
        for row in conn.execute(
            f'SELECT DISTINCT job_id FROM "{table}"'
        ).fetchall():
            _validate_job_uuid(str(row[0]))
    foreign_key_error = conn.execute(
        "PRAGMA foreign_key_check"
    ).fetchone()
    if foreign_key_error is not None:
        raise RuntimeError(
            "resume-template reference migration found a foreign-key "
            "violation"
        )


def _reassign_resume_template_references_v17(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    losing_job_id: str,
    surviving_job_id: str,
    material_generation_map: dict[tuple[str, int], int],
) -> None:
    """Preserve current template choice and every refresh attempt."""
    if losing_job_id == surviving_job_id:
        return
    before_counts = {
        table: int(
            conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        )
        for table in _RESUME_TEMPLATE_REFERENCE_TABLES
    }
    assignments = conn.execute(
        """
        SELECT job_id, template_id, version_id, updated_at
        FROM job_resume_template_assignments
        WHERE tenant_id = ? AND job_id IN (?, ?)
        ORDER BY updated_at, job_id
        """,
        (tenant_id, losing_job_id, surviving_job_id),
    ).fetchall()
    if assignments:
        selected = max(
            assignments,
            key=lambda row: (
                str(row[3]),
                str(row[0]) == surviving_job_id,
                str(row[0]),
            ),
        )
        conn.execute(
            """
            DELETE FROM job_resume_template_assignments
            WHERE tenant_id = ? AND job_id IN (?, ?)
            """,
            (tenant_id, losing_job_id, surviving_job_id),
        )
        conn.execute(
            """
            INSERT INTO job_resume_template_assignments (
                tenant_id, job_id, template_id, version_id, updated_at
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (
                tenant_id,
                surviving_job_id,
                str(selected[1]),
                str(selected[2]),
                str(selected[3]),
            ),
        )
    attempts = conn.execute(
        """
        SELECT attempt_id, job_id, from_generation, to_generation
        FROM resume_template_refresh_attempts
        WHERE tenant_id = ? AND job_id IN (?, ?)
        ORDER BY attempt_id
        """,
        (tenant_id, losing_job_id, surviving_job_id),
    ).fetchall()

    def _mapped_generation(
        *,
        source_job_id: str,
        attempt_id: str,
        field: str,
        value: Any,
    ) -> int | None:
        if value is None:
            return None
        generation = int(value)
        if generation <= 0:
            return generation
        mapped = material_generation_map.get(
            (source_job_id, generation)
        )
        if mapped is None:
            raise RuntimeError(
                "resume-template identity collapse could not preserve "
                f"refresh attempt {attempt_id!r} {field}={generation} "
                f"for job_id={source_job_id!r}"
            )
        return mapped

    for row in attempts:
        attempt_id = str(row[0])
        source_job_id = str(row[1])
        conn.execute(
            """
            UPDATE resume_template_refresh_attempts
            SET job_id = ?, from_generation = ?, to_generation = ?
            WHERE tenant_id = ? AND attempt_id = ?
            """,
            (
                surviving_job_id,
                _mapped_generation(
                    source_job_id=source_job_id,
                    attempt_id=attempt_id,
                    field="from_generation",
                    value=row[2],
                ),
                _mapped_generation(
                    source_job_id=source_job_id,
                    attempt_id=attempt_id,
                    field="to_generation",
                    value=row[3],
                ),
                tenant_id,
                attempt_id,
            ),
        )
    expected_counts = dict(before_counts)
    expected_counts["job_resume_template_assignments"] = (
        before_counts["job_resume_template_assignments"]
        - len(assignments)
        + (1 if assignments else 0)
    )
    _verify_resume_template_references_v17(
        conn,
        expected_counts=expected_counts,
    )


_INTERVIEW_PREP_REFERENCE_TABLES = (
    "job_interview_prep",
    "job_interview_prep_items",
)


def _has_interview_prep_parent_foreign_key_v18(
    conn: sqlite3.Connection,
) -> bool:
    groups: dict[int, set[tuple[str, str]]] = {}
    cascades: dict[int, bool] = {}
    for row in conn.execute(
        'PRAGMA foreign_key_list("job_interview_prep_items")'
    ).fetchall():
        if str(row[2]) != "job_interview_prep":
            continue
        foreign_key_id = int(row[0])
        groups.setdefault(foreign_key_id, set()).add(
            (str(row[3]), str(row[4]))
        )
        cascades[foreign_key_id] = str(row[6]).upper() == "CASCADE"
    expected = {
        ("tenant_id", "tenant_id"),
        ("job_id", "job_id"),
        ("generation", "generation"),
    }
    return any(
        columns == expected and cascades.get(foreign_key_id, False)
        for foreign_key_id, columns in groups.items()
    )


def _has_interview_prep_reference_schema_v18(
    conn: sqlite3.Connection,
) -> bool:
    return (
        "job_id" in _table_columns(conn, "job_interview_prep")
        and "job_url" not in _table_columns(conn, "job_interview_prep")
        and _primary_key_columns(conn, "job_interview_prep")
        == ("tenant_id", "job_id", "generation")
        and _has_composite_job_id_foreign_key(
            conn,
            "job_interview_prep",
            "job_id",
        )
        and "job_id"
        in _table_columns(conn, "job_interview_prep_items")
        and "job_url"
        not in _table_columns(conn, "job_interview_prep_items")
        and _primary_key_columns(conn, "job_interview_prep_items")
        == ("tenant_id", "job_id", "generation", "item_id")
        and _has_interview_prep_parent_foreign_key_v18(conn)
        and _has_index(
            conn,
            "job_interview_prep",
            "idx_job_interview_prep_tenant_job_gen",
            ("tenant_id", "job_id", "generation"),
            unique=False,
        )
        and _has_index(
            conn,
            "job_interview_prep",
            "idx_job_interview_prep_tenant_status",
            ("tenant_id", "status", "generated_at"),
            unique=False,
        )
        and _has_index(
            conn,
            "job_interview_prep",
            "idx_job_interview_prep_origin_run",
            ("tenant_id", "job_id", "origin_run_id"),
            unique=False,
        )
        and _has_index(
            conn,
            "job_interview_prep_items",
            "idx_job_interview_prep_items_tenant_kind",
            ("tenant_id", "kind", "position"),
            unique=False,
        )
    )


def _merge_interview_prep_histories_v18(
    history: list[tuple[str, int, tuple[Any, ...]]],
) -> list[tuple[str, int, tuple[Any, ...]]]:
    """Interleave prep histories without reversing either source history."""
    by_reference: dict[
        str,
        list[tuple[str, int, tuple[Any, ...]]],
    ] = {}
    for entry in history:
        by_reference.setdefault(entry[0], []).append(entry)
    for entries in by_reference.values():
        entries.sort(key=lambda entry: entry[1])

    offsets = {reference: 0 for reference in by_reference}
    merged: list[tuple[str, int, tuple[Any, ...]]] = []
    while len(merged) < len(history):
        eligible = [
            entries[offsets[reference]]
            for reference, entries in by_reference.items()
            if offsets[reference] < len(entries)
        ]
        selected = min(
            eligible,
            key=lambda entry: (
                str(entry[2][2]),
                entry[0],
                entry[1],
            ),
        )
        merged.append(selected)
        offsets[selected[0]] += 1
    return merged


def _latest_accepted_interview_prep_key_v18(
    history: list[tuple[str, int, tuple[Any, ...]]],
    *,
    preferred_reference: str,
) -> tuple[str, int] | None:
    accepted = [
        entry
        for entry in history
        if str(entry[2][0]) == "accepted"
    ]
    if not accepted:
        return None
    selected = max(
        accepted,
        key=lambda entry: (
            str(entry[2][2]),
            entry[0] == preferred_reference,
            entry[0],
            entry[1],
        ),
    )
    return selected[0], selected[1]


def _canonical_interview_prep_rows_v18(
    conn: sqlite3.Connection,
) -> tuple[
    list[tuple[Any, ...]],
    dict[tuple[str, str, int], int],
]:
    rows = conn.execute(
        """
        SELECT tenant_id, job_url, generation, status, model, generated_at,
               gate_status, fabrication_findings_json,
               grounding_findings_json, judge_verdict, warnings_json,
               failure_reason, origin_run_id
        FROM job_interview_prep
        ORDER BY tenant_id, job_url, generation
        """
    ).fetchall()
    grouped: dict[
        tuple[str, str],
        list[tuple[str, int, tuple[Any, ...]]],
    ] = {}
    for row in rows:
        tenant_id = str(row[0])
        raw_reference = str(row[1])
        old_generation = int(row[2])
        if old_generation <= 0:
            raise RuntimeError(
                "interview-prep reference migration found a non-positive "
                "generation"
            )
        stable_job_id = _resolve_job_reference_value(
            conn,
            tenant_id=tenant_id,
            reference=raw_reference,
            legacy_url=True,
        )
        if stable_job_id is None:
            raise RuntimeError(
                "interview-prep reference migration could not resolve "
                f"job_interview_prep.job_url={raw_reference!r}"
            )
        _validate_job_uuid(stable_job_id)
        grouped.setdefault((tenant_id, stable_job_id), []).append(
            (
                raw_reference,
                old_generation,
                tuple(row[3:]),
            )
        )

    canonical: list[tuple[Any, ...]] = []
    generation_map: dict[tuple[str, str, int], int] = {}
    for (tenant_id, stable_job_id), history in sorted(grouped.items()):
        ordered = _merge_interview_prep_histories_v18(history)
        storage_row = conn.execute(
            """
            SELECT url
            FROM jobs
            WHERE tenant_id = ? AND job_id = ?
            LIMIT 1
            """,
            (tenant_id, stable_job_id),
        ).fetchone()
        preferred_reference = (
            str(storage_row[0])
            if storage_row is not None
            else ""
        )
        latest_accepted = _latest_accepted_interview_prep_key_v18(
            ordered,
            preferred_reference=preferred_reference,
        )
        for index, (
            raw_reference,
            old_generation,
            values,
        ) in enumerate(ordered):
            new_generation = index + 1
            generation_map[
                (tenant_id, raw_reference, old_generation)
            ] = new_generation
            normalized = list(values)
            if (
                str(normalized[0]) == "accepted"
                and (raw_reference, old_generation) != latest_accepted
            ):
                normalized[0] = "superseded"
            canonical.append(
                (
                    tenant_id,
                    stable_job_id,
                    new_generation,
                    *normalized,
                )
            )
    return canonical, generation_map


def _canonical_interview_prep_item_rows_v18(
    conn: sqlite3.Connection,
    *,
    generation_map: dict[tuple[str, str, int], int],
) -> list[tuple[Any, ...]]:
    rows = conn.execute(
        """
        SELECT tenant_id, job_url, generation, item_id, kind, title,
               generated_text, evidence_ids_json, requirement_ids_json,
               source_text_json, transform_type, control,
               grounding_audit_json, warnings_json, position
        FROM job_interview_prep_items
        ORDER BY tenant_id, job_url, generation, position, item_id
        """
    ).fetchall()
    canonical: list[tuple[Any, ...]] = []
    for row in rows:
        tenant_id = str(row[0])
        raw_reference = str(row[1])
        old_generation = int(row[2])
        new_generation = generation_map.get(
            (tenant_id, raw_reference, old_generation)
        )
        stable_job_id = _resolve_job_reference_value(
            conn,
            tenant_id=tenant_id,
            reference=raw_reference,
            legacy_url=True,
        )
        if new_generation is None or stable_job_id is None:
            raise RuntimeError(
                "interview-prep reference migration found an item without "
                "its parent generation"
            )
        canonical.append(
            (
                tenant_id,
                stable_job_id,
                new_generation,
                *tuple(row[3:]),
            )
        )
    return canonical


def _remap_application_outcome_interview_prep_generations_v18(
    conn: sqlite3.Connection,
    *,
    generation_map: dict[tuple[str, str, int], int],
) -> None:
    """Preserve immutable outcome-to-preparation links during renumbering.

    The outcome reference may be the legacy URL-shaped ``job_key`` or the
    stable ``job_id`` introduced in schema v21. Only the linked preparation
    generation is rewritten, using the exact source reference that owned the
    generation before histories were merged.
    """
    columns = _table_columns(conn, "application_outcomes")
    reference_column = (
        "job_id"
        if "job_id" in columns
        else "job_key"
        if "job_key" in columns
        else None
    )
    required = {
        "tenant_id",
        "outcome_id",
        "interview_prep_generation",
    }
    if reference_column is None or not required.issubset(columns):
        return

    rows = conn.execute(
        f"""
        SELECT tenant_id, outcome_id, {reference_column},
               interview_prep_generation
        FROM application_outcomes
        WHERE interview_prep_generation IS NOT NULL
        ORDER BY tenant_id, outcome_id
        """
    ).fetchall()
    for row in rows:
        tenant_id = str(row[0])
        outcome_id = str(row[1])
        job_key = str(row[2])
        old_generation = int(row[3])
        new_generation = generation_map.get(
            (tenant_id, job_key, old_generation)
        )
        if new_generation is None:
            continue
        updated = conn.execute(
            f"""
            UPDATE application_outcomes
            SET interview_prep_generation = ?
            WHERE tenant_id = ?
              AND outcome_id = ?
              AND {reference_column} = ?
              AND interview_prep_generation = ?
            """,
            (
                new_generation,
                tenant_id,
                outcome_id,
                job_key,
                old_generation,
            ),
        )
        if updated.rowcount != 1:
            raise RuntimeError(
                "interview-prep reference migration could not preserve "
                f"application outcome {outcome_id!r}"
            )


def _reassign_application_outcome_job_keys_v18(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    losing_job_url: str,
    surviving_job_url: str,
) -> None:
    """Keep legacy URL-keyed outcomes reachable after a URL collision.

    The outcome family remains URL-shaped until its later stable-reference
    migration. Repointing only the legacy value to the surviving storage URL
    preserves that compatibility contract and allows the v7 collision cleanup
    to remove the losing alias without orphaning outcome reads.
    """
    columns = _table_columns(conn, "application_outcomes")
    if not {"tenant_id", "job_key"}.issubset(columns):
        return
    conn.execute(
        """
        UPDATE application_outcomes
        SET job_key = ?
        WHERE tenant_id = ? AND job_key = ?
        """,
        (surviving_job_url, tenant_id, losing_job_url),
    )


def ensure_interview_prep_references_v18(
    conn: sqlite3.Connection | None = None,
) -> list[str]:
    """Move Interview Preparation histories to stable JobId references."""
    if conn is None:
        conn = get_connection()

    current = _assert_schema_version_supported(conn)
    if current >= _INTERVIEW_PREP_REFERENCE_SCHEMA_VERSION:
        return []
    if current != _RESUME_TEMPLATE_REFERENCE_SCHEMA_VERSION:
        raise RuntimeError(
            "interview-prep reference migration requires resume-template "
            "schema v17"
        )

    conn.execute("SAVEPOINT interview_prep_references_v18")
    try:
        if not _has_resume_template_reference_schema_v17(conn):
            raise RuntimeError(
                "interview-prep reference migration requires the stable "
                "resume-template reference schema"
            )
        before_counts = {
            table: int(
                conn.execute(
                    f'SELECT COUNT(*) FROM "{table}"'
                ).fetchone()[0]
            )
            for table in _INTERVIEW_PREP_REFERENCE_TABLES
        }

        if not _has_interview_prep_reference_schema_v18(conn):
            (
                prep_rows,
                generation_map,
            ) = _canonical_interview_prep_rows_v18(conn)
            item_rows = _canonical_interview_prep_item_rows_v18(
                conn,
                generation_map=generation_map,
            )
            for table in (
                "job_interview_prep_items_v18",
                "job_interview_prep_v18",
            ):
                conn.execute(f'DROP TABLE IF EXISTS "{table}"')
            _create_interview_prep_tables(
                conn,
                prep_table="job_interview_prep_v18",
                items_table="job_interview_prep_items_v18",
                reference_column="job_id",
            )
            conn.executemany(
                """
                INSERT INTO job_interview_prep_v18 (
                    tenant_id, job_id, generation, status, model,
                    generated_at, gate_status,
                    fabrication_findings_json,
                    grounding_findings_json, judge_verdict,
                    warnings_json, failure_reason, origin_run_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                prep_rows,
            )
            conn.executemany(
                """
                INSERT INTO job_interview_prep_items_v18 (
                    tenant_id, job_id, generation, item_id, kind, title,
                    generated_text, evidence_ids_json,
                    requirement_ids_json, source_text_json,
                    transform_type, control, grounding_audit_json,
                    warnings_json, position
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                item_rows,
            )
            conn.execute('DROP TABLE "job_interview_prep_items"')
            conn.execute('DROP TABLE "job_interview_prep"')
            conn.execute(
                'ALTER TABLE "job_interview_prep_v18" '
                'RENAME TO "job_interview_prep"'
            )
            conn.execute(
                'ALTER TABLE "job_interview_prep_items_v18" '
                'RENAME TO "job_interview_prep_items"'
            )
            _create_interview_prep_indexes(
                conn,
                reference_column="job_id",
            )
            _remap_application_outcome_interview_prep_generations_v18(
                conn,
                generation_map=generation_map,
            )

        _verify_interview_prep_references_v18(
            conn,
            expected_counts=before_counts,
        )
        conn.execute(
            f"PRAGMA user_version = "
            f"{_INTERVIEW_PREP_REFERENCE_SCHEMA_VERSION}"
        )
        conn.execute(
            "RELEASE SAVEPOINT interview_prep_references_v18"
        )
        conn.commit()
    except BaseException:
        conn.execute(
            "ROLLBACK TO SAVEPOINT interview_prep_references_v18"
        )
        conn.execute(
            "RELEASE SAVEPOINT interview_prep_references_v18"
        )
        raise

    return list(_INTERVIEW_PREP_REFERENCE_TABLES)


def _verify_interview_prep_references_v18(
    conn: sqlite3.Connection,
    *,
    expected_counts: dict[str, int],
) -> None:
    if not _has_interview_prep_reference_schema_v18(conn):
        raise RuntimeError(
            "interview-prep reference migration did not create the stable "
            "reference schema"
        )
    for table, expected_count in expected_counts.items():
        observed_count = int(
            conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        )
        if observed_count != expected_count:
            raise RuntimeError(
                "interview-prep reference migration changed row count for "
                f"{table}: expected {expected_count}, found {observed_count}"
            )
    orphan_parent = conn.execute(
        """
        SELECT prep.job_id
        FROM job_interview_prep AS prep
        LEFT JOIN jobs
          ON jobs.tenant_id = prep.tenant_id
         AND jobs.job_id = prep.job_id
        WHERE jobs.job_id IS NULL
        LIMIT 1
        """
    ).fetchone()
    if orphan_parent is not None:
        raise RuntimeError(
            "interview-prep reference migration left an unresolved JobId"
        )
    orphan_item = conn.execute(
        """
        SELECT item.job_id
        FROM job_interview_prep_items AS item
        LEFT JOIN job_interview_prep AS prep
          ON prep.tenant_id = item.tenant_id
         AND prep.job_id = item.job_id
         AND prep.generation = item.generation
        WHERE prep.job_id IS NULL
        LIMIT 1
        """
    ).fetchone()
    if orphan_item is not None:
        raise RuntimeError(
            "interview-prep reference migration left an item without its "
            "parent generation"
        )
    multiple_accepted = conn.execute(
        """
        SELECT tenant_id, job_id
        FROM job_interview_prep
        WHERE status = 'accepted'
        GROUP BY tenant_id, job_id
        HAVING COUNT(*) > 1
        LIMIT 1
        """
    ).fetchone()
    if multiple_accepted is not None:
        raise RuntimeError(
            "interview-prep reference migration left multiple accepted "
            "generations for one job"
        )
    for table in _INTERVIEW_PREP_REFERENCE_TABLES:
        for row in conn.execute(
            f'SELECT DISTINCT job_id FROM "{table}"'
        ).fetchall():
            _validate_job_uuid(str(row[0]))
    foreign_key_error = conn.execute(
        "PRAGMA foreign_key_check"
    ).fetchone()
    if foreign_key_error is not None:
        raise RuntimeError(
            "interview-prep reference migration found a foreign-key "
            "violation"
        )


def _reassign_interview_prep_references_v18(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    losing_job_id: str,
    surviving_job_id: str,
    losing_job_url: str,
    surviving_job_url: str,
) -> dict[tuple[str, int], int]:
    """Merge complete Interview Preparation histories during identity collapse."""
    if losing_job_id == surviving_job_id:
        return {}
    before_counts = {
        table: int(
            conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        )
        for table in _INTERVIEW_PREP_REFERENCE_TABLES
    }
    parent_rows = conn.execute(
        """
        SELECT job_id, generation, status, model, generated_at,
               gate_status, fabrication_findings_json,
               grounding_findings_json, judge_verdict, warnings_json,
               failure_reason, origin_run_id
        FROM job_interview_prep
        WHERE tenant_id = ? AND job_id IN (?, ?)
        ORDER BY job_id, generation
        """,
        (tenant_id, losing_job_id, surviving_job_id),
    ).fetchall()
    if not parent_rows:
        return {}

    history = [
        (
            str(row[0]),
            int(row[1]),
            tuple(row[2:]),
        )
        for row in parent_rows
    ]
    ordered = _merge_interview_prep_histories_v18(history)
    latest_accepted = _latest_accepted_interview_prep_key_v18(
        ordered,
        preferred_reference=surviving_job_id,
    )
    generation_map: dict[tuple[str, int], int] = {}
    canonical_parents: list[tuple[Any, ...]] = []
    for index, (
        old_job_id,
        old_generation,
        values,
    ) in enumerate(ordered):
        new_generation = index + 1
        generation_map[(old_job_id, old_generation)] = new_generation
        normalized = list(values)
        if (
            str(normalized[0]) == "accepted"
            and (old_job_id, old_generation) != latest_accepted
        ):
            normalized[0] = "superseded"
        canonical_parents.append(
            (
                tenant_id,
                surviving_job_id,
                new_generation,
                *normalized,
            )
        )

    item_source = conn.execute(
        """
        SELECT job_id, generation, item_id, kind, title, generated_text,
               evidence_ids_json, requirement_ids_json, source_text_json,
               transform_type, control, grounding_audit_json,
               warnings_json, position
        FROM job_interview_prep_items
        WHERE tenant_id = ? AND job_id IN (?, ?)
        ORDER BY job_id, generation, position, item_id
        """,
        (tenant_id, losing_job_id, surviving_job_id),
    ).fetchall()
    canonical_items: list[tuple[Any, ...]] = []
    for row in item_source:
        mapped = generation_map.get((str(row[0]), int(row[1])))
        if mapped is None:
            raise RuntimeError(
                "interview-prep identity collapse found an item without "
                "its parent generation"
            )
        canonical_items.append(
            (
                tenant_id,
                surviving_job_id,
                mapped,
                *tuple(row[2:]),
            )
        )

    conn.execute(
        """
        DELETE FROM job_interview_prep_items
        WHERE tenant_id = ? AND job_id IN (?, ?)
        """,
        (tenant_id, losing_job_id, surviving_job_id),
    )
    conn.execute(
        """
        DELETE FROM job_interview_prep
        WHERE tenant_id = ? AND job_id IN (?, ?)
        """,
        (tenant_id, losing_job_id, surviving_job_id),
    )
    conn.executemany(
        """
        INSERT INTO job_interview_prep (
            tenant_id, job_id, generation, status, model, generated_at,
            gate_status, fabrication_findings_json,
            grounding_findings_json, judge_verdict, warnings_json,
            failure_reason, origin_run_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        canonical_parents,
    )
    conn.executemany(
        """
        INSERT INTO job_interview_prep_items (
            tenant_id, job_id, generation, item_id, kind, title,
            generated_text, evidence_ids_json, requirement_ids_json,
            source_text_json, transform_type, control,
            grounding_audit_json, warnings_json, position
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        canonical_items,
    )
    _remap_application_outcome_interview_prep_generations_v18(
        conn,
        generation_map={
            key: new_generation
            for (
                old_job_id,
                old_generation,
            ), new_generation in generation_map.items()
            for key in (
                (tenant_id, old_job_id, old_generation),
                (
                    tenant_id,
                    (
                        losing_job_url
                        if old_job_id == losing_job_id
                        else surviving_job_url
                    ),
                    old_generation,
                ),
            )
        },
    )
    _verify_interview_prep_references_v18(
        conn,
        expected_counts=before_counts,
    )
    return generation_map


_COMPENSATION_REFERENCE_SCHEMA_VERSION = 19
_COMPENSATION_REFERENCE_TABLES = (
    "job_posted_compensation_facts",
    "job_market_compensation_estimates",
)
_COMPENSATION_TIMESTAMP_COLUMNS = {
    "job_posted_compensation_facts": "parsed_at",
    "job_market_compensation_estimates": "estimated_at",
}


def _create_compensation_reference_tables_v19(
    conn: sqlite3.Connection,
    *,
    posted_table: str,
    market_table: str,
) -> None:
    conn.execute(
        f"""
        CREATE TABLE "{posted_table}" (
            tenant_id                    TEXT NOT NULL DEFAULT 'local',
            job_id                       TEXT NOT NULL,
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
            PRIMARY KEY (tenant_id, job_id),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        f"""
        CREATE TABLE "{market_table}" (
            tenant_id                          TEXT NOT NULL DEFAULT 'local',
            job_id                             TEXT NOT NULL,
            estimate_state                     TEXT NOT NULL CHECK (
                estimate_state IN (
                    'unsupported',
                    'source_unavailable',
                    'insufficient_evidence',
                    'estimated_range'
                )
            ),
            currency                           TEXT,
            period                             TEXT NOT NULL DEFAULT 'year'
                CHECK (period IN ('year', 'month')),
            component                          TEXT NOT NULL
                DEFAULT 'total_compensation'
                CHECK (
                    component IN (
                        'base_salary',
                        'total_compensation'
                    )
                ),
            minimum_amount                     INTEGER,
            maximum_amount                     INTEGER,
            confidence_interval_minimum_amount INTEGER,
            confidence_interval_maximum_amount INTEGER,
            confidence_band                    TEXT NOT NULL DEFAULT 'none'
                CHECK (
                    confidence_band IN (
                        'none',
                        'low',
                        'medium',
                        'high'
                    )
                ),
            confidence_score                   REAL NOT NULL DEFAULT 0,
            source_count                       INTEGER NOT NULL DEFAULT 0,
            sample_count                       INTEGER,
            aggregate_bucket                   TEXT,
            geography_scope                    TEXT,
            occupation_code                    TEXT,
            occupation_label                   TEXT,
            seniority_label                    TEXT,
            source_snapshot_json               TEXT NOT NULL DEFAULT '[]',
            factor_reasons_json                TEXT NOT NULL DEFAULT '[]',
            selected_evidence_json             TEXT NOT NULL DEFAULT '[]',
            insufficient_reasons_json          TEXT NOT NULL DEFAULT '[]',
            unsupported_reasons_json           TEXT NOT NULL DEFAULT '[]',
            source_unavailable_reasons_json    TEXT NOT NULL DEFAULT '[]',
            warnings_json                      TEXT NOT NULL DEFAULT '[]',
            estimator_version                  TEXT NOT NULL,
            estimated_at                       TEXT NOT NULL,
            company_name                       TEXT,
            normalized_company                 TEXT,
            role_title                         TEXT,
            normalized_role                    TEXT,
            company_tier                       TEXT NOT NULL DEFAULT 'unknown'
                CHECK (
                    company_tier IN (
                        'tier_1_local',
                        'tier_2_ambitious',
                        'tier_3_top_of_market',
                        'unknown'
                    )
                ),
            match_scope                        TEXT NOT NULL DEFAULT 'none'
                CHECK (
                    match_scope IN (
                        'exact_company_role',
                        'same_location_role_fallback',
                        'company_adjacent_role',
                        'tier_role_fallback',
                        'market_baseline_fallback',
                        'none'
                    )
                ),
            PRIMARY KEY (tenant_id, job_id),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        )
        """
    )


def _create_compensation_reference_indexes_v19(
    conn: sqlite3.Connection,
) -> None:
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_posted_compensation_parse_state
        ON job_posted_compensation_facts (tenant_id, parse_state)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_market_compensation_state
        ON job_market_compensation_estimates (tenant_id, estimate_state)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_market_compensation_company_role
        ON job_market_compensation_estimates (
            tenant_id,
            normalized_company,
            normalized_role
        )
        """
    )


def _has_compensation_reference_schema_v19(
    conn: sqlite3.Connection,
) -> bool:
    return (
        all(
            "job_id" in _table_columns(conn, table)
            and "job_url" not in _table_columns(conn, table)
            and _primary_key_columns(conn, table)
            == ("tenant_id", "job_id")
            and _has_composite_job_id_foreign_key(
                conn,
                table,
                "job_id",
            )
            for table in _COMPENSATION_REFERENCE_TABLES
        )
        and _has_index(
            conn,
            "job_posted_compensation_facts",
            "idx_job_posted_compensation_parse_state",
            ("tenant_id", "parse_state"),
            unique=False,
        )
        and _has_index(
            conn,
            "job_market_compensation_estimates",
            "idx_job_market_compensation_state",
            ("tenant_id", "estimate_state"),
            unique=False,
        )
        and _has_index(
            conn,
            "job_market_compensation_estimates",
            "idx_job_market_compensation_company_role",
            ("tenant_id", "normalized_company", "normalized_role"),
            unique=False,
        )
    )


def _canonical_compensation_rows_v19(
    conn: sqlite3.Connection,
    *,
    table: str,
    timestamp_column: str,
) -> tuple[tuple[str, ...], list[tuple[Any, ...]]]:
    columns = tuple(
        str(row[1])
        for row in conn.execute(
            f'PRAGMA table_info("{table}")'
        ).fetchall()
        if str(row[1]) not in {"tenant_id", "job_url"}
    )
    timestamp_index = columns.index(timestamp_column)
    select_columns = ", ".join(f'"{column}"' for column in columns)
    rows = conn.execute(
        f"""
        SELECT tenant_id, job_url, {select_columns}
        FROM "{table}"
        ORDER BY tenant_id, job_url
        """
    ).fetchall()
    grouped: dict[
        tuple[str, str],
        list[tuple[str, tuple[Any, ...]]],
    ] = {}
    for row in rows:
        tenant_id = str(row[0])
        raw_reference = str(row[1])
        stable_job_id = _resolve_job_reference_value(
            conn,
            tenant_id=tenant_id,
            reference=raw_reference,
            legacy_url=True,
        )
        if stable_job_id is None:
            raise RuntimeError(
                "compensation reference migration could not resolve "
                f"{table}.job_url={raw_reference!r}"
            )
        _validate_job_uuid(stable_job_id)
        grouped.setdefault((tenant_id, stable_job_id), []).append(
            (raw_reference, tuple(row[2:]))
        )

    canonical: list[tuple[Any, ...]] = []
    for (tenant_id, stable_job_id), candidates in sorted(grouped.items()):
        storage_row = conn.execute(
            """
            SELECT url
            FROM jobs
            WHERE tenant_id = ? AND job_id = ?
            LIMIT 1
            """,
            (tenant_id, stable_job_id),
        ).fetchone()
        preferred_reference = (
            str(storage_row[0])
            if storage_row is not None
            else ""
        )
        _selected_reference, selected_values = max(
            candidates,
            key=lambda candidate: (
                str(candidate[1][timestamp_index]),
                candidate[0] == preferred_reference,
                candidate[0],
            ),
        )
        canonical.append(
            (tenant_id, stable_job_id, *selected_values)
        )
    return columns, canonical


def ensure_compensation_references_v19(
    conn: sqlite3.Connection | None = None,
) -> list[str]:
    """Move canonical compensation facts and estimates to stable JobIds."""
    if conn is None:
        conn = get_connection()

    current = _assert_schema_version_supported(conn)
    if current >= _COMPENSATION_REFERENCE_SCHEMA_VERSION:
        return []
    if current != _INTERVIEW_PREP_REFERENCE_SCHEMA_VERSION:
        raise RuntimeError(
            "compensation reference migration requires interview-prep "
            "schema v18"
        )

    conn.execute("SAVEPOINT compensation_references_v19")
    try:
        if not _has_interview_prep_reference_schema_v18(conn):
            raise RuntimeError(
                "compensation reference migration requires the stable "
                "interview-prep reference schema"
            )
        if _has_compensation_reference_schema_v19(conn):
            expected_counts = {
                table: int(
                    conn.execute(
                        f'SELECT COUNT(*) FROM "{table}"'
                    ).fetchone()[0]
                )
                for table in _COMPENSATION_REFERENCE_TABLES
            }
        else:
            posted_columns, posted_rows = (
                _canonical_compensation_rows_v19(
                    conn,
                    table="job_posted_compensation_facts",
                    timestamp_column="parsed_at",
                )
            )
            market_columns, market_rows = (
                _canonical_compensation_rows_v19(
                    conn,
                    table="job_market_compensation_estimates",
                    timestamp_column="estimated_at",
                )
            )
            for table in (
                "job_posted_compensation_facts_v19",
                "job_market_compensation_estimates_v19",
            ):
                conn.execute(f'DROP TABLE IF EXISTS "{table}"')
            _create_compensation_reference_tables_v19(
                conn,
                posted_table="job_posted_compensation_facts_v19",
                market_table="job_market_compensation_estimates_v19",
            )
            for table, columns, rows in (
                (
                    "job_posted_compensation_facts_v19",
                    posted_columns,
                    posted_rows,
                ),
                (
                    "job_market_compensation_estimates_v19",
                    market_columns,
                    market_rows,
                ),
            ):
                insert_columns = (
                    "tenant_id, job_id, "
                    + ", ".join(
                        f'"{column}"' for column in columns
                    )
                )
                placeholders = ", ".join(
                    "?" for _ in range(len(columns) + 2)
                )
                conn.executemany(
                    f'INSERT INTO "{table}" '
                    f"({insert_columns}) VALUES ({placeholders})",
                    rows,
                )
            conn.execute(
                'DROP TABLE "job_posted_compensation_facts"'
            )
            conn.execute(
                'DROP TABLE "job_market_compensation_estimates"'
            )
            conn.execute(
                'ALTER TABLE "job_posted_compensation_facts_v19" '
                'RENAME TO "job_posted_compensation_facts"'
            )
            conn.execute(
                'ALTER TABLE "job_market_compensation_estimates_v19" '
                'RENAME TO "job_market_compensation_estimates"'
            )
            _create_compensation_reference_indexes_v19(conn)
            expected_counts = {
                "job_posted_compensation_facts": len(posted_rows),
                "job_market_compensation_estimates": len(market_rows),
            }
        _verify_compensation_references_v19(
            conn,
            expected_counts=expected_counts,
        )
        conn.execute(
            f"PRAGMA user_version = "
            f"{_COMPENSATION_REFERENCE_SCHEMA_VERSION}"
        )
        conn.execute("RELEASE SAVEPOINT compensation_references_v19")
        conn.commit()
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT compensation_references_v19")
        conn.execute("RELEASE SAVEPOINT compensation_references_v19")
        raise

    return list(_COMPENSATION_REFERENCE_TABLES)


def _verify_compensation_references_v19(
    conn: sqlite3.Connection,
    *,
    expected_counts: dict[str, int],
) -> None:
    if not _has_compensation_reference_schema_v19(conn):
        raise RuntimeError(
            "compensation reference migration did not create the stable "
            "reference schema"
        )
    for table, expected_count in expected_counts.items():
        observed_count = int(
            conn.execute(
                f'SELECT COUNT(*) FROM "{table}"'
            ).fetchone()[0]
        )
        if observed_count != expected_count:
            raise RuntimeError(
                "compensation reference migration changed canonical row "
                f"count for {table}: expected {expected_count}, "
                f"found {observed_count}"
            )
        orphan = conn.execute(
            f"""
            SELECT authority.job_id
            FROM "{table}" AS authority
            LEFT JOIN jobs
              ON jobs.tenant_id = authority.tenant_id
             AND jobs.job_id = authority.job_id
            WHERE jobs.job_id IS NULL
            LIMIT 1
            """
        ).fetchone()
        if orphan is not None:
            raise RuntimeError(
                "compensation reference migration left an unresolved "
                f"JobId in {table}"
            )
        for row in conn.execute(
            f'SELECT DISTINCT job_id FROM "{table}"'
        ).fetchall():
            _validate_job_uuid(str(row[0]))
    foreign_key_error = conn.execute(
        "PRAGMA foreign_key_check"
    ).fetchone()
    if foreign_key_error is not None:
        raise RuntimeError(
            "compensation reference migration found a foreign-key "
            "violation"
        )


def _merge_compensation_authority_v19(
    conn: sqlite3.Connection,
    *,
    table: str,
    timestamp_column: str,
    tenant_id: str,
    losing_job_id: str,
    surviving_job_id: str,
) -> int:
    columns = tuple(
        str(row[1])
        for row in conn.execute(
            f'PRAGMA table_info("{table}")'
        ).fetchall()
    )
    job_id_index = columns.index("job_id")
    timestamp_index = columns.index(timestamp_column)
    column_sql = ", ".join(f'"{column}"' for column in columns)
    rows = conn.execute(
        f"""
        SELECT {column_sql}
        FROM "{table}"
        WHERE tenant_id = ? AND job_id IN (?, ?)
        """,
        (tenant_id, losing_job_id, surviving_job_id),
    ).fetchall()
    if not rows:
        return 0
    selected = max(
        rows,
        key=lambda row: (
            str(row[timestamp_index]),
            str(row[job_id_index]) == surviving_job_id,
            str(row[job_id_index]),
        ),
    )
    canonical = list(selected)
    canonical[job_id_index] = surviving_job_id
    conn.execute(
        f"""
        DELETE FROM "{table}"
        WHERE tenant_id = ? AND job_id IN (?, ?)
        """,
        (tenant_id, losing_job_id, surviving_job_id),
    )
    placeholders = ", ".join("?" for _ in columns)
    conn.execute(
        f'INSERT INTO "{table}" ({column_sql}) '
        f"VALUES ({placeholders})",
        tuple(canonical),
    )
    return len(rows)


def _reassign_compensation_references_v19(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    losing_job_id: str,
    surviving_job_id: str,
) -> None:
    if losing_job_id == surviving_job_id:
        return
    before_counts = {
        table: int(
            conn.execute(
                f'SELECT COUNT(*) FROM "{table}"'
            ).fetchone()[0]
        )
        for table in _COMPENSATION_REFERENCE_TABLES
    }
    merged_counts = {
        table: _merge_compensation_authority_v19(
            conn,
            table=table,
            timestamp_column=_COMPENSATION_TIMESTAMP_COLUMNS[table],
            tenant_id=tenant_id,
            losing_job_id=losing_job_id,
            surviving_job_id=surviving_job_id,
        )
        for table in _COMPENSATION_REFERENCE_TABLES
    }
    expected_counts = {
        table: (
            before_counts[table]
            - merged_counts[table]
            + (1 if merged_counts[table] else 0)
        )
        for table in _COMPENSATION_REFERENCE_TABLES
    }
    _verify_compensation_references_v19(
        conn,
        expected_counts=expected_counts,
    )


_APPLICATION_REVIEW_REFERENCE_SCHEMA_VERSION = 20
_APPLICATION_REVIEW_REFERENCE_TABLE = "application_review_decisions"


def _create_application_review_reference_table_v20(
    conn: sqlite3.Connection,
    *,
    table: str,
) -> None:
    conn.execute(
        f"""
        CREATE TABLE "{table}" (
            tenant_id                   TEXT NOT NULL DEFAULT 'local',
            decision_id                 TEXT NOT NULL,
            job_id                      TEXT NOT NULL,
            decision                    TEXT NOT NULL,
            reason                      TEXT,
            decided_by                  TEXT DEFAULT 'user',
            decided_at                  TEXT NOT NULL,
            materials_generation        INTEGER,
            profile_version             INTEGER,
            application_url             TEXT,
            partial_override_run_id     TEXT,
            email_recipient             TEXT,
            email_attachment_artifact_id TEXT,
            PRIMARY KEY (tenant_id, decision_id),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        )
        """
    )


def _create_application_review_reference_index_v20(
    conn: sqlite3.Connection,
) -> None:
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_application_review_decisions_job
        ON application_review_decisions(
            tenant_id,
            job_id,
            decided_at DESC
        )
        """
    )


def _has_application_review_reference_schema_v20(
    conn: sqlite3.Connection,
) -> bool:
    table = _APPLICATION_REVIEW_REFERENCE_TABLE
    return (
        "job_id" in _table_columns(conn, table)
        and "job_key" not in _table_columns(conn, table)
        and _primary_key_columns(conn, table)
        == ("tenant_id", "decision_id")
        and _has_composite_job_id_foreign_key(
            conn,
            table,
            "job_id",
        )
        and _has_index(
            conn,
            table,
            "idx_application_review_decisions_job",
            ("tenant_id", "job_id", "decided_at"),
            unique=False,
        )
    )


def _canonical_application_review_rows_v20(
    conn: sqlite3.Connection,
) -> tuple[tuple[str, ...], list[tuple[Any, ...]]]:
    table = _APPLICATION_REVIEW_REFERENCE_TABLE
    columns = tuple(
        str(row[1])
        for row in conn.execute(
            f'PRAGMA table_info("{table}")'
        ).fetchall()
        if str(row[1]) not in {"tenant_id", "job_key"}
    )
    select_columns = ", ".join(f'"{column}"' for column in columns)
    rows = conn.execute(
        f"""
        SELECT tenant_id, job_key, {select_columns}
        FROM "{table}"
        ORDER BY tenant_id, decision_id
        """
    ).fetchall()
    canonical: list[tuple[Any, ...]] = []
    for row in rows:
        tenant_id = str(row[0])
        legacy_job_key = str(row[1])
        stable_job_id = _resolve_job_reference_value(
            conn,
            tenant_id=tenant_id,
            reference=legacy_job_key,
            legacy_url=True,
        )
        if stable_job_id is None:
            raise RuntimeError(
                "application-review reference migration could not resolve "
                f"application_review_decisions.job_key={legacy_job_key!r}"
            )
        _validate_job_uuid(stable_job_id)
        canonical.append((tenant_id, stable_job_id, *tuple(row[2:])))
    return columns, canonical


def ensure_application_review_references_v20(
    conn: sqlite3.Connection | None = None,
) -> list[str]:
    """Move append-only Apply Review decisions to stable JobIds."""
    if conn is None:
        conn = get_connection()

    current = _assert_schema_version_supported(conn)
    if current >= _APPLICATION_REVIEW_REFERENCE_SCHEMA_VERSION:
        return []
    if current != _COMPENSATION_REFERENCE_SCHEMA_VERSION:
        raise RuntimeError(
            "application-review reference migration requires compensation "
            "schema v19"
        )

    conn.execute("SAVEPOINT application_review_references_v20")
    try:
        if not _has_compensation_reference_schema_v19(conn):
            raise RuntimeError(
                "application-review reference migration requires the stable "
                "compensation reference schema"
            )
        if _has_application_review_reference_schema_v20(conn):
            expected_count = int(
                conn.execute(
                    "SELECT COUNT(*) "
                    "FROM application_review_decisions"
                ).fetchone()[0]
            )
        else:
            columns, rows = _canonical_application_review_rows_v20(conn)
            conn.execute(
                "DROP TABLE IF EXISTS application_review_decisions_v20"
            )
            _create_application_review_reference_table_v20(
                conn,
                table="application_review_decisions_v20",
            )
            insert_columns = (
                "tenant_id, job_id, "
                + ", ".join(f'"{column}"' for column in columns)
            )
            placeholders = ", ".join(
                "?" for _ in range(len(columns) + 2)
            )
            conn.executemany(
                "INSERT INTO application_review_decisions_v20 "
                f"({insert_columns}) VALUES ({placeholders})",
                rows,
            )
            conn.execute('DROP TABLE "application_review_decisions"')
            conn.execute(
                'ALTER TABLE "application_review_decisions_v20" '
                'RENAME TO "application_review_decisions"'
            )
            _create_application_review_reference_index_v20(conn)
            expected_count = len(rows)
        _verify_application_review_references_v20(
            conn,
            expected_count=expected_count,
        )
        conn.execute(
            f"PRAGMA user_version = "
            f"{_APPLICATION_REVIEW_REFERENCE_SCHEMA_VERSION}"
        )
        conn.execute(
            "RELEASE SAVEPOINT application_review_references_v20"
        )
        conn.commit()
    except BaseException:
        conn.execute(
            "ROLLBACK TO SAVEPOINT application_review_references_v20"
        )
        conn.execute(
            "RELEASE SAVEPOINT application_review_references_v20"
        )
        raise

    return [_APPLICATION_REVIEW_REFERENCE_TABLE]


def _verify_application_review_references_v20(
    conn: sqlite3.Connection,
    *,
    expected_count: int,
) -> None:
    if not _has_application_review_reference_schema_v20(conn):
        raise RuntimeError(
            "application-review reference migration did not create the "
            "stable reference schema"
        )
    observed_count = int(
        conn.execute(
            "SELECT COUNT(*) FROM application_review_decisions"
        ).fetchone()[0]
    )
    if observed_count != expected_count:
        raise RuntimeError(
            "application-review reference migration changed append-only "
            f"history count: expected {expected_count}, "
            f"found {observed_count}"
        )
    orphan = conn.execute(
        """
        SELECT decisions.job_id
        FROM application_review_decisions AS decisions
        LEFT JOIN jobs
          ON jobs.tenant_id = decisions.tenant_id
         AND jobs.job_id = decisions.job_id
        WHERE jobs.job_id IS NULL
        LIMIT 1
        """
    ).fetchone()
    if orphan is not None:
        raise RuntimeError(
            "application-review reference migration left an unresolved JobId"
        )
    for row in conn.execute(
        "SELECT DISTINCT job_id FROM application_review_decisions"
    ).fetchall():
        _validate_job_uuid(str(row[0]))
    foreign_key_error = conn.execute(
        "PRAGMA foreign_key_check"
    ).fetchone()
    if foreign_key_error is not None:
        raise RuntimeError(
            "application-review reference migration found a foreign-key "
            "violation"
        )


def _reassign_application_review_references_v20(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    losing_job_id: str,
    surviving_job_id: str,
) -> None:
    if losing_job_id == surviving_job_id:
        return
    expected_count = int(
        conn.execute(
            "SELECT COUNT(*) FROM application_review_decisions"
        ).fetchone()[0]
    )
    conn.execute(
        """
        UPDATE application_review_decisions
        SET job_id = ?
        WHERE tenant_id = ? AND job_id = ?
        """,
        (surviving_job_id, tenant_id, losing_job_id),
    )
    _verify_application_review_references_v20(
        conn,
        expected_count=expected_count,
    )


_APPLICATION_OUTCOME_REFERENCE_SCHEMA_VERSION = 21
_APPLICATION_OUTCOME_REFERENCE_TABLE = "application_outcomes"


def _create_application_outcome_table_v21(
    conn: sqlite3.Connection,
    *,
    table: str,
    stable_reference: bool,
) -> None:
    reference_column = "job_id" if stable_reference else "job_key"
    foreign_key = (
        """,
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE"""
        if stable_reference
        else ""
    )
    conn.execute(
        f"""
        CREATE TABLE "{table}" (
            tenant_id                TEXT NOT NULL DEFAULT 'local',
            outcome_id               TEXT NOT NULL,
            {reference_column}       TEXT NOT NULL,
            kind                     TEXT NOT NULL,
            source                   TEXT NOT NULL,
            note                     TEXT,
            occurred_at              TEXT NOT NULL,
            recorded_at              TEXT NOT NULL,
            suggestion_id            TEXT,
            evidence_id              TEXT,
            created_by               TEXT NOT NULL DEFAULT 'user',
            interview_prep_generation INTEGER,
            PRIMARY KEY (tenant_id, outcome_id)
            {foreign_key}
        )
        """
    )


def _create_application_outcome_reference_index_v21(
    conn: sqlite3.Connection,
    *,
    reference_column: str,
) -> None:
    expected_columns = (
        "tenant_id",
        reference_column,
        "occurred_at",
        "recorded_at",
    )
    if not _has_index(
        conn,
        _APPLICATION_OUTCOME_REFERENCE_TABLE,
        "idx_application_outcomes_job",
        expected_columns,
        unique=False,
    ):
        conn.execute("DROP INDEX IF EXISTS idx_application_outcomes_job")
        conn.execute(
            f"""
            CREATE INDEX idx_application_outcomes_job
            ON application_outcomes(
                tenant_id,
                {reference_column},
                occurred_at DESC,
                recorded_at DESC
            )
            """
        )


def _ensure_application_outcome_table_for_version(
    conn: sqlite3.Connection,
    *,
    current_version: int,
) -> None:
    """Recover a missing outcome table without skipping ordered migration."""
    table = _APPLICATION_OUTCOME_REFERENCE_TABLE
    columns = _table_columns(conn, table)
    if not columns:
        _create_application_outcome_table_v21(
            conn,
            table=table,
            stable_reference=(
                current_version
                >= _APPLICATION_OUTCOME_REFERENCE_SCHEMA_VERSION
            ),
        )
        columns = _table_columns(conn, table)
    for column, definition in (
        ("note", "TEXT"),
        ("suggestion_id", "TEXT"),
        ("evidence_id", "TEXT"),
        ("created_by", "TEXT NOT NULL DEFAULT 'user'"),
        ("interview_prep_generation", "INTEGER"),
    ):
        if column in columns:
            continue
        conn.execute(
            "ALTER TABLE application_outcomes "
            f"ADD COLUMN {column} {definition}"
        )
        columns.add(column)
    reference_column = (
        "job_id"
        if "job_id" in columns
        else "job_key"
        if "job_key" in columns
        else None
    )
    if reference_column is None:
        raise RuntimeError(
            "application_outcomes has no Job identity column"
        )
    _create_application_outcome_reference_index_v21(
        conn,
        reference_column=reference_column,
    )
    if (
        current_version >= _APPLICATION_OUTCOME_REFERENCE_SCHEMA_VERSION
        and not _has_application_outcome_reference_schema_v21(conn)
    ):
        raise RuntimeError(
            "schema v21 requires stable application-outcome references"
        )


def _has_application_outcome_reference_schema_v21(
    conn: sqlite3.Connection,
) -> bool:
    table = _APPLICATION_OUTCOME_REFERENCE_TABLE
    return (
        "job_id" in _table_columns(conn, table)
        and "job_key" not in _table_columns(conn, table)
        and _primary_key_columns(conn, table)
        == ("tenant_id", "outcome_id")
        and _has_composite_job_id_foreign_key(
            conn,
            table,
            "job_id",
        )
        and _has_index(
            conn,
            table,
            "idx_application_outcomes_job",
            (
                "tenant_id",
                "job_id",
                "occurred_at",
                "recorded_at",
            ),
            unique=False,
        )
    )


def _canonical_application_outcome_rows_v21(
    conn: sqlite3.Connection,
) -> list[tuple[Any, ...]]:
    rows = conn.execute(
        """
        SELECT tenant_id, outcome_id, job_key, kind, source, note,
               occurred_at, recorded_at, suggestion_id, evidence_id,
               created_by, interview_prep_generation
        FROM application_outcomes
        ORDER BY tenant_id, outcome_id
        """
    ).fetchall()
    canonical: list[tuple[Any, ...]] = []
    for row in rows:
        tenant_id = str(row[0])
        legacy_job_key = str(row[2])
        stable_job_id = _resolve_job_reference_value(
            conn,
            tenant_id=tenant_id,
            reference=legacy_job_key,
            legacy_url=True,
        )
        if stable_job_id is None:
            raise RuntimeError(
                "application-outcome reference migration could not resolve "
                f"application_outcomes.job_key={legacy_job_key!r}"
            )
        _validate_job_uuid(stable_job_id)
        canonical.append(
            (
                tenant_id,
                str(row[1]),
                stable_job_id,
                *tuple(row[3:]),
            )
        )
    return canonical


def ensure_application_outcome_references_v21(
    conn: sqlite3.Connection | None = None,
) -> list[str]:
    """Move reviewed application outcomes to stable JobId references."""
    if conn is None:
        conn = get_connection()

    current = _assert_schema_version_supported(conn)
    if current >= _APPLICATION_OUTCOME_REFERENCE_SCHEMA_VERSION:
        return []
    if current != _APPLICATION_REVIEW_REFERENCE_SCHEMA_VERSION:
        raise RuntimeError(
            "application-outcome reference migration requires "
            "application-review schema v20"
        )

    conn.execute("SAVEPOINT application_outcome_references_v21")
    try:
        if not _has_application_review_reference_schema_v20(conn):
            raise RuntimeError(
                "application-outcome reference migration requires the "
                "stable application-review reference schema"
            )
        _ensure_application_outcome_table_for_version(
            conn,
            current_version=current,
        )
        if _has_application_outcome_reference_schema_v21(conn):
            expected_count = int(
                conn.execute(
                    "SELECT COUNT(*) FROM application_outcomes"
                ).fetchone()[0]
            )
        else:
            rows = _canonical_application_outcome_rows_v21(conn)
            conn.execute(
                "DROP TABLE IF EXISTS application_outcomes_v21"
            )
            _create_application_outcome_table_v21(
                conn,
                table="application_outcomes_v21",
                stable_reference=True,
            )
            conn.executemany(
                """
                INSERT INTO application_outcomes_v21 (
                    tenant_id, outcome_id, job_id, kind, source, note,
                    occurred_at, recorded_at, suggestion_id, evidence_id,
                    created_by, interview_prep_generation
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )
            conn.execute('DROP TABLE "application_outcomes"')
            conn.execute(
                'ALTER TABLE "application_outcomes_v21" '
                'RENAME TO "application_outcomes"'
            )
            _create_application_outcome_reference_index_v21(
                conn,
                reference_column="job_id",
            )
            expected_count = len(rows)
        _verify_application_outcome_references_v21(
            conn,
            expected_count=expected_count,
        )
        conn.execute(
            f"PRAGMA user_version = "
            f"{_APPLICATION_OUTCOME_REFERENCE_SCHEMA_VERSION}"
        )
        conn.execute(
            "RELEASE SAVEPOINT application_outcome_references_v21"
        )
        conn.commit()
    except BaseException:
        conn.execute(
            "ROLLBACK TO SAVEPOINT application_outcome_references_v21"
        )
        conn.execute(
            "RELEASE SAVEPOINT application_outcome_references_v21"
        )
        raise

    return [_APPLICATION_OUTCOME_REFERENCE_TABLE]


def _verify_application_outcome_references_v21(
    conn: sqlite3.Connection,
    *,
    expected_count: int,
) -> None:
    if not _has_application_outcome_reference_schema_v21(conn):
        raise RuntimeError(
            "application-outcome reference migration did not create the "
            "stable reference schema"
        )
    observed_count = int(
        conn.execute(
            "SELECT COUNT(*) FROM application_outcomes"
        ).fetchone()[0]
    )
    if observed_count != expected_count:
        raise RuntimeError(
            "application-outcome reference migration changed append-only "
            f"history count: expected {expected_count}, "
            f"found {observed_count}"
        )
    orphan = conn.execute(
        """
        SELECT outcomes.job_id
        FROM application_outcomes AS outcomes
        LEFT JOIN jobs
          ON jobs.tenant_id = outcomes.tenant_id
         AND jobs.job_id = outcomes.job_id
        WHERE jobs.job_id IS NULL
        LIMIT 1
        """
    ).fetchone()
    if orphan is not None:
        raise RuntimeError(
            "application-outcome reference migration left an unresolved JobId"
        )
    for row in conn.execute(
        "SELECT DISTINCT job_id FROM application_outcomes"
    ).fetchall():
        _validate_job_uuid(str(row[0]))
    foreign_key_error = conn.execute(
        "PRAGMA foreign_key_check"
    ).fetchone()
    if foreign_key_error is not None:
        raise RuntimeError(
            "application-outcome reference migration found a foreign-key "
            "violation"
        )


def _reassign_application_outcome_references_v21(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    losing_job_id: str,
    surviving_job_id: str,
) -> None:
    if losing_job_id == surviving_job_id:
        return
    expected_count = int(
        conn.execute(
            "SELECT COUNT(*) FROM application_outcomes"
        ).fetchone()[0]
    )
    conn.execute(
        """
        UPDATE application_outcomes
        SET job_id = ?
        WHERE tenant_id = ? AND job_id = ?
        """,
        (surviving_job_id, tenant_id, losing_job_id),
    )
    _verify_application_outcome_references_v21(
        conn,
        expected_count=expected_count,
    )


_APPLICATION_FEEDBACK_CANDIDATE_SCHEMA_VERSION = 22
_APPLICATION_FEEDBACK_CANDIDATE_TABLES = (
    "application_email_evidence",
    "application_outcome_suggestions",
)


def _create_application_email_evidence_table_v22(
    conn: sqlite3.Connection,
    *,
    table: str,
    stable_reference: bool,
) -> None:
    reference_column = "job_id" if stable_reference else "job_key"
    foreign_key = (
        """,
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE"""
        if stable_reference
        else ""
    )
    conn.execute(
        f"""
        CREATE TABLE "{table}" (
            tenant_id            TEXT NOT NULL DEFAULT 'local',
            evidence_id          TEXT NOT NULL,
            {reference_column}   TEXT NOT NULL,
            provider             TEXT NOT NULL DEFAULT 'gmail',
            provider_message_id  TEXT NOT NULL,
            provider_thread_id   TEXT,
            from_address         TEXT,
            to_addresses_json    TEXT NOT NULL DEFAULT '[]',
            subject              TEXT,
            snippet              TEXT,
            received_at          TEXT,
            linked_at            TEXT NOT NULL,
            link_confidence      REAL NOT NULL DEFAULT 0,
            link_signals_json    TEXT NOT NULL DEFAULT '[]',
            body_text            TEXT,
            body_sha256          TEXT,
            body_stored_at       TEXT,
            PRIMARY KEY (tenant_id, evidence_id),
            UNIQUE (tenant_id, provider, provider_message_id)
            {foreign_key}
        )
        """
    )


def _create_application_outcome_suggestion_table_v22(
    conn: sqlite3.Connection,
    *,
    table: str,
    stable_reference: bool,
) -> None:
    reference_column = "job_id" if stable_reference else "job_key"
    foreign_key = (
        """,
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE"""
        if stable_reference
        else ""
    )
    conn.execute(
        f"""
        CREATE TABLE "{table}" (
            tenant_id          TEXT NOT NULL DEFAULT 'local',
            suggestion_id      TEXT NOT NULL,
            {reference_column} TEXT NOT NULL,
            evidence_id        TEXT,
            suggested_kind     TEXT NOT NULL,
            confidence         REAL NOT NULL DEFAULT 0,
            rationale          TEXT NOT NULL DEFAULT '',
            status             TEXT NOT NULL DEFAULT 'pending',
            created_at         TEXT NOT NULL,
            decided_at         TEXT,
            decision           TEXT,
            decision_reason    TEXT,
            decided_outcome_id TEXT,
            PRIMARY KEY (tenant_id, suggestion_id)
            {foreign_key}
        )
        """
    )


def _create_application_feedback_candidate_indexes_v22(
    conn: sqlite3.Connection,
    *,
    evidence_reference: str,
    suggestion_reference: str,
) -> None:
    indexes = (
        (
            "application_email_evidence",
            "idx_application_email_evidence_job",
            ("tenant_id", evidence_reference, "received_at"),
            f"""
            CREATE INDEX idx_application_email_evidence_job
            ON application_email_evidence(
                tenant_id,
                {evidence_reference},
                received_at DESC
            )
            """,
        ),
        (
            "application_outcome_suggestions",
            "idx_application_outcome_suggestions_job",
            (
                "tenant_id",
                suggestion_reference,
                "status",
                "created_at",
            ),
            f"""
            CREATE INDEX idx_application_outcome_suggestions_job
            ON application_outcome_suggestions(
                tenant_id,
                {suggestion_reference},
                status,
                created_at DESC
            )
            """,
        ),
        (
            "application_outcome_suggestions",
            "idx_application_outcome_suggestions_status",
            ("tenant_id", "status", "created_at"),
            """
            CREATE INDEX idx_application_outcome_suggestions_status
            ON application_outcome_suggestions(
                tenant_id,
                status,
                created_at DESC
            )
            """,
        ),
    )
    for table, name, columns, create_sql in indexes:
        if _has_index(
            conn,
            table,
            name,
            columns,
            unique=False,
        ):
            continue
        conn.execute(f'DROP INDEX IF EXISTS "{name}"')
        conn.execute(create_sql)


def _ensure_application_feedback_candidate_tables_for_version(
    conn: sqlite3.Connection,
    *,
    current_version: int,
) -> None:
    """Recover missing candidate tables without skipping ordered migration."""
    stable_reference = (
        current_version
        >= _APPLICATION_FEEDBACK_CANDIDATE_SCHEMA_VERSION
    )
    if not _table_columns(conn, "application_email_evidence"):
        _create_application_email_evidence_table_v22(
            conn,
            table="application_email_evidence",
            stable_reference=stable_reference,
        )
    if not _table_columns(conn, "application_outcome_suggestions"):
        _create_application_outcome_suggestion_table_v22(
            conn,
            table="application_outcome_suggestions",
            stable_reference=stable_reference,
        )
    evidence_columns = _table_columns(
        conn,
        "application_email_evidence",
    )
    suggestion_columns = _table_columns(
        conn,
        "application_outcome_suggestions",
    )
    evidence_reference = (
        "job_id"
        if "job_id" in evidence_columns
        else "job_key"
        if "job_key" in evidence_columns
        else None
    )
    suggestion_reference = (
        "job_id"
        if "job_id" in suggestion_columns
        else "job_key"
        if "job_key" in suggestion_columns
        else None
    )
    if evidence_reference is None or suggestion_reference is None:
        raise RuntimeError(
            "application feedback candidate table has no Job identity column"
        )
    _create_application_feedback_candidate_indexes_v22(
        conn,
        evidence_reference=evidence_reference,
        suggestion_reference=suggestion_reference,
    )
    if (
        current_version
        >= _APPLICATION_FEEDBACK_CANDIDATE_SCHEMA_VERSION
        and not _has_application_feedback_candidate_schema_v22(conn)
    ):
        raise RuntimeError(
            "schema v22 requires stable application-feedback candidate "
            "references"
        )


def _has_unique_index_columns_v22(
    conn: sqlite3.Connection,
    *,
    table: str,
    columns: tuple[str, ...],
) -> bool:
    for row in conn.execute(
        f'PRAGMA index_list("{table}")'
    ).fetchall():
        if not bool(row[2]):
            continue
        name = str(row[1])
        actual_columns = tuple(
            str(index_row[2])
            for index_row in conn.execute(
                f'PRAGMA index_info("{name}")'
            ).fetchall()
        )
        if actual_columns == columns:
            return True
    return False


def _has_application_feedback_candidate_schema_v22(
    conn: sqlite3.Connection,
) -> bool:
    evidence = "application_email_evidence"
    suggestions = "application_outcome_suggestions"
    return (
        "job_id" in _table_columns(conn, evidence)
        and "job_key" not in _table_columns(conn, evidence)
        and _primary_key_columns(conn, evidence)
        == ("tenant_id", "evidence_id")
        and _has_composite_job_id_foreign_key(
            conn,
            evidence,
            "job_id",
        )
        and _has_unique_index_columns_v22(
            conn,
            table=evidence,
            columns=("tenant_id", "provider", "provider_message_id"),
        )
        and _has_index(
            conn,
            evidence,
            "idx_application_email_evidence_job",
            ("tenant_id", "job_id", "received_at"),
            unique=False,
        )
        and "job_id" in _table_columns(conn, suggestions)
        and "job_key" not in _table_columns(conn, suggestions)
        and _primary_key_columns(conn, suggestions)
        == ("tenant_id", "suggestion_id")
        and _has_composite_job_id_foreign_key(
            conn,
            suggestions,
            "job_id",
        )
        and _has_index(
            conn,
            suggestions,
            "idx_application_outcome_suggestions_job",
            ("tenant_id", "job_id", "status", "created_at"),
            unique=False,
        )
        and _has_index(
            conn,
            suggestions,
            "idx_application_outcome_suggestions_status",
            ("tenant_id", "status", "created_at"),
            unique=False,
        )
    )


def _canonical_application_email_evidence_rows_v22(
    conn: sqlite3.Connection,
) -> list[tuple[Any, ...]]:
    rows = conn.execute(
        """
        SELECT tenant_id, evidence_id, job_key, provider,
               provider_message_id, provider_thread_id, from_address,
               to_addresses_json, subject, snippet, received_at, linked_at,
               link_confidence, link_signals_json, body_text, body_sha256,
               body_stored_at
        FROM application_email_evidence
        ORDER BY tenant_id, evidence_id
        """
    ).fetchall()
    canonical: list[tuple[Any, ...]] = []
    for row in rows:
        tenant_id = str(row[0])
        legacy_job_key = str(row[2])
        stable_job_id = _resolve_job_reference_value(
            conn,
            tenant_id=tenant_id,
            reference=legacy_job_key,
            legacy_url=True,
        )
        if stable_job_id is None:
            raise RuntimeError(
                "application-feedback candidate migration could not resolve "
                f"application_email_evidence.job_key={legacy_job_key!r}"
            )
        _validate_job_uuid(stable_job_id)
        canonical.append(
            (
                tenant_id,
                str(row[1]),
                stable_job_id,
                *tuple(row[3:]),
            )
        )
    return canonical


def _canonical_application_outcome_suggestion_rows_v22(
    conn: sqlite3.Connection,
) -> list[tuple[Any, ...]]:
    rows = conn.execute(
        """
        SELECT tenant_id, suggestion_id, job_key, evidence_id,
               suggested_kind, confidence, rationale, status, created_at,
               decided_at, decision, decision_reason, decided_outcome_id
        FROM application_outcome_suggestions
        ORDER BY tenant_id, suggestion_id
        """
    ).fetchall()
    canonical: list[tuple[Any, ...]] = []
    for row in rows:
        tenant_id = str(row[0])
        legacy_job_key = str(row[2])
        stable_job_id = _resolve_job_reference_value(
            conn,
            tenant_id=tenant_id,
            reference=legacy_job_key,
            legacy_url=True,
        )
        if stable_job_id is None:
            raise RuntimeError(
                "application-feedback candidate migration could not resolve "
                "application_outcome_suggestions."
                f"job_key={legacy_job_key!r}"
            )
        _validate_job_uuid(stable_job_id)
        canonical.append(
            (
                tenant_id,
                str(row[1]),
                stable_job_id,
                *tuple(row[3:]),
            )
        )
    return canonical


def ensure_application_feedback_candidate_references_v22(
    conn: sqlite3.Connection | None = None,
) -> list[str]:
    """Move linked evidence and suggestions to stable JobId references."""
    if conn is None:
        conn = get_connection()

    current = _assert_schema_version_supported(conn)
    if current >= _APPLICATION_FEEDBACK_CANDIDATE_SCHEMA_VERSION:
        return []
    if current != _APPLICATION_OUTCOME_REFERENCE_SCHEMA_VERSION:
        raise RuntimeError(
            "application-feedback candidate migration requires "
            "application-outcome schema v21"
        )

    conn.execute(
        "SAVEPOINT application_feedback_candidate_references_v22"
    )
    try:
        if not _has_application_outcome_reference_schema_v21(conn):
            raise RuntimeError(
                "application-feedback candidate migration requires the "
                "stable application-outcome reference schema"
            )
        _ensure_application_feedback_candidate_tables_for_version(
            conn,
            current_version=current,
        )
        expected_counts: dict[str, int] = {}
        if "job_id" not in _table_columns(
            conn,
            "application_email_evidence",
        ):
            evidence_rows = (
                _canonical_application_email_evidence_rows_v22(conn)
            )
            conn.execute(
                "DROP TABLE IF EXISTS application_email_evidence_v22"
            )
            _create_application_email_evidence_table_v22(
                conn,
                table="application_email_evidence_v22",
                stable_reference=True,
            )
            conn.executemany(
                """
                INSERT INTO application_email_evidence_v22 (
                    tenant_id, evidence_id, job_id, provider,
                    provider_message_id, provider_thread_id, from_address,
                    to_addresses_json, subject, snippet, received_at,
                    linked_at, link_confidence, link_signals_json, body_text,
                    body_sha256, body_stored_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                evidence_rows,
            )
            conn.execute('DROP TABLE "application_email_evidence"')
            conn.execute(
                'ALTER TABLE "application_email_evidence_v22" '
                'RENAME TO "application_email_evidence"'
            )
            expected_counts["application_email_evidence"] = len(
                evidence_rows
            )
        else:
            expected_counts["application_email_evidence"] = int(
                conn.execute(
                    "SELECT COUNT(*) FROM application_email_evidence"
                ).fetchone()[0]
            )
        if "job_id" not in _table_columns(
            conn,
            "application_outcome_suggestions",
        ):
            suggestion_rows = (
                _canonical_application_outcome_suggestion_rows_v22(conn)
            )
            conn.execute(
                "DROP TABLE IF EXISTS "
                "application_outcome_suggestions_v22"
            )
            _create_application_outcome_suggestion_table_v22(
                conn,
                table="application_outcome_suggestions_v22",
                stable_reference=True,
            )
            conn.executemany(
                """
                INSERT INTO application_outcome_suggestions_v22 (
                    tenant_id, suggestion_id, job_id, evidence_id,
                    suggested_kind, confidence, rationale, status,
                    created_at, decided_at, decision, decision_reason,
                    decided_outcome_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                suggestion_rows,
            )
            conn.execute(
                'DROP TABLE "application_outcome_suggestions"'
            )
            conn.execute(
                'ALTER TABLE "application_outcome_suggestions_v22" '
                'RENAME TO "application_outcome_suggestions"'
            )
            expected_counts["application_outcome_suggestions"] = len(
                suggestion_rows
            )
        else:
            expected_counts["application_outcome_suggestions"] = int(
                conn.execute(
                    "SELECT COUNT(*) "
                    "FROM application_outcome_suggestions"
                ).fetchone()[0]
            )
        _create_application_feedback_candidate_indexes_v22(
            conn,
            evidence_reference="job_id",
            suggestion_reference="job_id",
        )
        _verify_application_feedback_candidate_references_v22(
            conn,
            expected_counts=expected_counts,
        )
        conn.execute(
            f"PRAGMA user_version = "
            f"{_APPLICATION_FEEDBACK_CANDIDATE_SCHEMA_VERSION}"
        )
        conn.execute(
            "RELEASE SAVEPOINT "
            "application_feedback_candidate_references_v22"
        )
        conn.commit()
    except BaseException:
        conn.execute(
            "ROLLBACK TO SAVEPOINT "
            "application_feedback_candidate_references_v22"
        )
        conn.execute(
            "RELEASE SAVEPOINT "
            "application_feedback_candidate_references_v22"
        )
        raise

    return list(_APPLICATION_FEEDBACK_CANDIDATE_TABLES)


def _verify_application_feedback_candidate_references_v22(
    conn: sqlite3.Connection,
    *,
    expected_counts: dict[str, int],
) -> None:
    if not _has_application_feedback_candidate_schema_v22(conn):
        raise RuntimeError(
            "application-feedback candidate migration did not create the "
            "stable reference schema"
        )
    for table, expected_count in expected_counts.items():
        observed_count = int(
            conn.execute(
                f'SELECT COUNT(*) FROM "{table}"'
            ).fetchone()[0]
        )
        if observed_count != expected_count:
            raise RuntimeError(
                "application-feedback candidate migration changed "
                f"{table} history count: expected {expected_count}, "
                f"found {observed_count}"
            )
        orphan = conn.execute(
            f"""
            SELECT candidates.job_id
            FROM "{table}" AS candidates
            LEFT JOIN jobs
              ON jobs.tenant_id = candidates.tenant_id
             AND jobs.job_id = candidates.job_id
            WHERE jobs.job_id IS NULL
            LIMIT 1
            """
        ).fetchone()
        if orphan is not None:
            raise RuntimeError(
                "application-feedback candidate migration left an "
                f"unresolved JobId in {table}"
            )
        for row in conn.execute(
            f'SELECT DISTINCT job_id FROM "{table}"'
        ).fetchall():
            _validate_job_uuid(str(row[0]))
    foreign_key_error = conn.execute(
        "PRAGMA foreign_key_check"
    ).fetchone()
    if foreign_key_error is not None:
        raise RuntimeError(
            "application-feedback candidate migration found a foreign-key "
            "violation"
        )


def _reassign_application_feedback_candidate_references_v22(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    losing_job_id: str,
    surviving_job_id: str,
) -> None:
    if losing_job_id == surviving_job_id:
        return
    expected_counts = {
        table: int(
            conn.execute(
                f'SELECT COUNT(*) FROM "{table}"'
            ).fetchone()[0]
        )
        for table in _APPLICATION_FEEDBACK_CANDIDATE_TABLES
    }
    for table in _APPLICATION_FEEDBACK_CANDIDATE_TABLES:
        conn.execute(
            f"""
            UPDATE "{table}"
            SET job_id = ?
            WHERE tenant_id = ? AND job_id = ?
            """,
            (surviving_job_id, tenant_id, losing_job_id),
        )
    _verify_application_feedback_candidate_references_v22(
        conn,
        expected_counts=expected_counts,
    )


_REPEAT_APPLICATION_REFERENCE_SCHEMA_VERSION = 23
_REPEAT_APPLICATION_REFERENCE_TABLES = (
    "application_repeat_overrides",
    "application_repeat_override_consumptions",
    "application_repeat_audit",
)


def _create_repeat_application_overrides_table_v23(
    conn: sqlite3.Connection,
    *,
    table: str,
    stable_references: bool,
) -> None:
    target_column = (
        "target_job_id" if stable_references else "target_job_key"
    )
    prior_column = (
        "prior_job_id" if stable_references else "prior_job_key"
    )
    foreign_keys = (
        """,
            FOREIGN KEY (tenant_id, target_job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE,
            FOREIGN KEY (tenant_id, prior_job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE"""
        if stable_references
        else ""
    )
    conn.execute(
        f"""
        CREATE TABLE "{table}" (
            tenant_id            TEXT NOT NULL DEFAULT 'local',
            override_id          TEXT NOT NULL,
            {target_column}      TEXT NOT NULL,
            {prior_column}       TEXT NOT NULL,
            relationship         TEXT NOT NULL,
            evidence_fingerprint TEXT NOT NULL,
            evidence_json        TEXT NOT NULL,
            reason               TEXT NOT NULL,
            confirmed_by         TEXT NOT NULL,
            confirmed_at         TEXT NOT NULL,
            PRIMARY KEY (tenant_id, override_id)
            {foreign_keys}
        )
        """
    )


def _create_repeat_application_consumptions_table_v23(
    conn: sqlite3.Connection,
    *,
    table: str,
) -> None:
    conn.execute(
        f"""
        CREATE TABLE "{table}" (
            tenant_id   TEXT NOT NULL DEFAULT 'local',
            override_id TEXT NOT NULL,
            run_id      TEXT NOT NULL,
            consumed_at TEXT NOT NULL,
            PRIMARY KEY (tenant_id, override_id),
            UNIQUE (tenant_id, run_id)
        )
        """
    )


def _create_repeat_application_audit_table_v23(
    conn: sqlite3.Connection,
    *,
    table: str,
    stable_reference: bool,
) -> None:
    target_column = (
        "target_job_id" if stable_reference else "target_job_key"
    )
    foreign_key = (
        """,
            FOREIGN KEY (tenant_id, target_job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE"""
        if stable_reference
        else ""
    )
    conn.execute(
        f"""
        CREATE TABLE "{table}" (
            tenant_id            TEXT NOT NULL DEFAULT 'local',
            audit_id             TEXT NOT NULL,
            audit_key            TEXT NOT NULL,
            {target_column}      TEXT NOT NULL,
            action               TEXT NOT NULL,
            evidence_fingerprint TEXT NOT NULL,
            evidence_json        TEXT NOT NULL,
            override_id          TEXT,
            actor                TEXT NOT NULL,
            reason               TEXT,
            occurred_at          TEXT NOT NULL,
            PRIMARY KEY (tenant_id, audit_id),
            UNIQUE (tenant_id, audit_key)
            {foreign_key}
        )
        """
    )


def _create_repeat_application_indexes_v23(
    conn: sqlite3.Connection,
    *,
    target_reference: str,
    prior_reference: str,
    audit_reference: str,
) -> None:
    indexes = (
        (
            "application_repeat_overrides",
            "idx_application_repeat_overrides_target",
            ("tenant_id", target_reference, "confirmed_at"),
            f"""
            CREATE INDEX idx_application_repeat_overrides_target
            ON application_repeat_overrides(
                tenant_id,
                {target_reference},
                confirmed_at DESC
            )
            """,
        ),
        (
            "application_repeat_overrides",
            "idx_application_repeat_overrides_prior",
            ("tenant_id", prior_reference, "confirmed_at"),
            f"""
            CREATE INDEX idx_application_repeat_overrides_prior
            ON application_repeat_overrides(
                tenant_id,
                {prior_reference},
                confirmed_at DESC
            )
            """,
        ),
        (
            "application_repeat_audit",
            "idx_application_repeat_audit_target",
            ("tenant_id", audit_reference, "occurred_at"),
            f"""
            CREATE INDEX idx_application_repeat_audit_target
            ON application_repeat_audit(
                tenant_id,
                {audit_reference},
                occurred_at DESC
            )
            """,
        ),
    )
    for table, name, columns, create_sql in indexes:
        if _has_index(
            conn,
            table,
            name,
            columns,
            unique=False,
        ):
            continue
        conn.execute(f'DROP INDEX IF EXISTS "{name}"')
        conn.execute(create_sql)


def _has_unique_index_columns_v23(
    conn: sqlite3.Connection,
    *,
    table: str,
    columns: tuple[str, ...],
) -> bool:
    for row in conn.execute(
        f'PRAGMA index_list("{table}")'
    ).fetchall():
        if not bool(row[2]):
            continue
        name = str(row[1])
        actual_columns = tuple(
            str(index_row[2])
            for index_row in conn.execute(
                f'PRAGMA index_info("{name}")'
            ).fetchall()
        )
        if actual_columns == columns:
            return True
    return False


def _has_repeat_application_reference_schema_v23(
    conn: sqlite3.Connection,
) -> bool:
    overrides = "application_repeat_overrides"
    consumptions = "application_repeat_override_consumptions"
    audit = "application_repeat_audit"
    return (
        "target_job_id" in _table_columns(conn, overrides)
        and "target_job_key" not in _table_columns(conn, overrides)
        and "prior_job_id" in _table_columns(conn, overrides)
        and "prior_job_key" not in _table_columns(conn, overrides)
        and _primary_key_columns(conn, overrides)
        == ("tenant_id", "override_id")
        and _has_composite_job_id_foreign_key(
            conn,
            overrides,
            "target_job_id",
        )
        and _has_composite_job_id_foreign_key(
            conn,
            overrides,
            "prior_job_id",
        )
        and _has_index(
            conn,
            overrides,
            "idx_application_repeat_overrides_target",
            ("tenant_id", "target_job_id", "confirmed_at"),
            unique=False,
        )
        and _has_index(
            conn,
            overrides,
            "idx_application_repeat_overrides_prior",
            ("tenant_id", "prior_job_id", "confirmed_at"),
            unique=False,
        )
        and _primary_key_columns(conn, consumptions)
        == ("tenant_id", "override_id")
        and _has_unique_index_columns_v23(
            conn,
            table=consumptions,
            columns=("tenant_id", "run_id"),
        )
        and "target_job_id" in _table_columns(conn, audit)
        and "target_job_key" not in _table_columns(conn, audit)
        and _primary_key_columns(conn, audit)
        == ("tenant_id", "audit_id")
        and _has_unique_index_columns_v23(
            conn,
            table=audit,
            columns=("tenant_id", "audit_key"),
        )
        and _has_composite_job_id_foreign_key(
            conn,
            audit,
            "target_job_id",
        )
        and _has_index(
            conn,
            audit,
            "idx_application_repeat_audit_target",
            ("tenant_id", "target_job_id", "occurred_at"),
            unique=False,
        )
    )


def _canonical_repeat_application_override_rows_v23(
    conn: sqlite3.Connection,
) -> list[tuple[Any, ...]]:
    target_column = _legacy_or_stable_reference_column(
        conn,
        "application_repeat_overrides",
        stable="target_job_id",
        legacy="target_job_key",
    )
    prior_column = _legacy_or_stable_reference_column(
        conn,
        "application_repeat_overrides",
        stable="prior_job_id",
        legacy="prior_job_key",
    )
    rows = conn.execute(
        f"""
        SELECT tenant_id, override_id, {target_column}, {prior_column},
               relationship, evidence_fingerprint, evidence_json, reason,
               confirmed_by, confirmed_at
        FROM application_repeat_overrides
        ORDER BY tenant_id, override_id
        """
    ).fetchall()
    canonical: list[tuple[Any, ...]] = []
    for row in rows:
        tenant_id = str(row[0])
        target_reference = str(row[2])
        prior_reference = str(row[3])
        target_job_id = _resolve_job_reference_value(
            conn,
            tenant_id=tenant_id,
            reference=target_reference,
            legacy_url=target_column == "target_job_key",
        )
        prior_job_id = _resolve_job_reference_value(
            conn,
            tenant_id=tenant_id,
            reference=prior_reference,
            legacy_url=prior_column == "prior_job_key",
        )
        if target_job_id is None:
            raise RuntimeError(
                "repeat-application reference migration could not resolve "
                f"application_repeat_overrides.{target_column}="
                f"{target_reference!r}"
            )
        if prior_job_id is None:
            raise RuntimeError(
                "repeat-application reference migration could not resolve "
                f"application_repeat_overrides.{prior_column}="
                f"{prior_reference!r}"
            )
        _validate_job_uuid(target_job_id)
        _validate_job_uuid(prior_job_id)
        canonical.append(
            (
                tenant_id,
                str(row[1]),
                target_job_id,
                prior_job_id,
                *tuple(row[4:]),
            )
        )
    return canonical


def _canonical_repeat_application_audit_rows_v23(
    conn: sqlite3.Connection,
) -> list[tuple[Any, ...]]:
    target_column = _legacy_or_stable_reference_column(
        conn,
        "application_repeat_audit",
        stable="target_job_id",
        legacy="target_job_key",
    )
    rows = conn.execute(
        f"""
        SELECT tenant_id, audit_id, audit_key, {target_column}, action,
               evidence_fingerprint, evidence_json, override_id, actor,
               reason, occurred_at
        FROM application_repeat_audit
        ORDER BY tenant_id, audit_id
        """
    ).fetchall()
    canonical: list[tuple[Any, ...]] = []
    for row in rows:
        tenant_id = str(row[0])
        target_reference = str(row[3])
        target_job_id = _resolve_job_reference_value(
            conn,
            tenant_id=tenant_id,
            reference=target_reference,
            legacy_url=target_column == "target_job_key",
        )
        if target_job_id is None:
            raise RuntimeError(
                "repeat-application reference migration could not resolve "
                f"application_repeat_audit.{target_column}="
                f"{target_reference!r}"
            )
        _validate_job_uuid(target_job_id)
        canonical.append(
            (
                tenant_id,
                str(row[1]),
                str(row[2]),
                target_job_id,
                *tuple(row[4:]),
            )
        )
    return canonical


def ensure_repeat_application_references_v23(
    conn: sqlite3.Connection | None = None,
) -> list[str]:
    """Move repeat-protection ownership to stable target/prior JobIds."""
    if conn is None:
        conn = get_connection()

    current = _assert_schema_version_supported(conn)
    if current >= _REPEAT_APPLICATION_REFERENCE_SCHEMA_VERSION:
        return []
    if current != _APPLICATION_FEEDBACK_CANDIDATE_SCHEMA_VERSION:
        raise RuntimeError(
            "repeat-application reference migration requires "
            "application-feedback candidate schema v22"
        )

    conn.execute("SAVEPOINT repeat_application_references_v23")
    try:
        if not _has_application_feedback_candidate_schema_v22(conn):
            raise RuntimeError(
                "repeat-application reference migration requires the "
                "stable application-feedback candidate reference schema"
            )
        from jobctrl.domain.apply.repeat_application import (
            ensure_repeat_application_tables,
        )

        ensure_repeat_application_tables(conn)
        expected_counts = {
            table: int(
                conn.execute(
                    f'SELECT COUNT(*) FROM "{table}"'
                ).fetchone()[0]
            )
            for table in _REPEAT_APPLICATION_REFERENCE_TABLES
        }

        if not {
            "target_job_id",
            "prior_job_id",
        }.issubset(
            _table_columns(conn, "application_repeat_overrides")
        ):
            override_rows = (
                _canonical_repeat_application_override_rows_v23(conn)
            )
            conn.execute(
                "DROP TABLE IF EXISTS application_repeat_overrides_v23"
            )
            _create_repeat_application_overrides_table_v23(
                conn,
                table="application_repeat_overrides_v23",
                stable_references=True,
            )
            conn.executemany(
                """
                INSERT INTO application_repeat_overrides_v23 (
                    tenant_id, override_id, target_job_id, prior_job_id,
                    relationship, evidence_fingerprint, evidence_json,
                    reason, confirmed_by, confirmed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                override_rows,
            )
            conn.execute('DROP TABLE "application_repeat_overrides"')
            conn.execute(
                'ALTER TABLE "application_repeat_overrides_v23" '
                'RENAME TO "application_repeat_overrides"'
            )

        if "target_job_id" not in _table_columns(
            conn,
            "application_repeat_audit",
        ):
            audit_rows = _canonical_repeat_application_audit_rows_v23(
                conn
            )
            conn.execute(
                "DROP TABLE IF EXISTS application_repeat_audit_v23"
            )
            _create_repeat_application_audit_table_v23(
                conn,
                table="application_repeat_audit_v23",
                stable_reference=True,
            )
            conn.executemany(
                """
                INSERT INTO application_repeat_audit_v23 (
                    tenant_id, audit_id, audit_key, target_job_id, action,
                    evidence_fingerprint, evidence_json, override_id, actor,
                    reason, occurred_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                audit_rows,
            )
            conn.execute('DROP TABLE "application_repeat_audit"')
            conn.execute(
                'ALTER TABLE "application_repeat_audit_v23" '
                'RENAME TO "application_repeat_audit"'
            )

        _create_repeat_application_indexes_v23(
            conn,
            target_reference="target_job_id",
            prior_reference="prior_job_id",
            audit_reference="target_job_id",
        )
        _verify_repeat_application_references_v23(
            conn,
            expected_counts=expected_counts,
        )
        conn.execute(
            f"PRAGMA user_version = "
            f"{_REPEAT_APPLICATION_REFERENCE_SCHEMA_VERSION}"
        )
        conn.execute(
            "RELEASE SAVEPOINT repeat_application_references_v23"
        )
        conn.commit()
    except BaseException:
        conn.execute(
            "ROLLBACK TO SAVEPOINT repeat_application_references_v23"
        )
        conn.execute(
            "RELEASE SAVEPOINT repeat_application_references_v23"
        )
        raise

    return list(_REPEAT_APPLICATION_REFERENCE_TABLES)


def _verify_repeat_application_references_v23(
    conn: sqlite3.Connection,
    *,
    expected_counts: dict[str, int],
) -> None:
    if not _has_repeat_application_reference_schema_v23(conn):
        raise RuntimeError(
            "repeat-application reference migration did not create the "
            "stable reference schema"
        )
    for table, expected_count in expected_counts.items():
        observed_count = int(
            conn.execute(
                f'SELECT COUNT(*) FROM "{table}"'
            ).fetchone()[0]
        )
        if observed_count != expected_count:
            raise RuntimeError(
                "repeat-application reference migration changed "
                f"{table} history count: expected {expected_count}, "
                f"found {observed_count}"
            )

    references = (
        (
            "application_repeat_overrides",
            "target_job_id",
        ),
        (
            "application_repeat_overrides",
            "prior_job_id",
        ),
        (
            "application_repeat_audit",
            "target_job_id",
        ),
    )
    for table, column in references:
        orphan = conn.execute(
            f"""
            SELECT source.{column}
            FROM "{table}" AS source
            LEFT JOIN jobs
              ON jobs.tenant_id = source.tenant_id
             AND jobs.job_id = source.{column}
            WHERE jobs.job_id IS NULL
            LIMIT 1
            """
        ).fetchone()
        if orphan is not None:
            raise RuntimeError(
                "repeat-application reference migration left an "
                f"unresolved JobId in {table}.{column}"
            )
        for row in conn.execute(
            f'SELECT DISTINCT {column} FROM "{table}"'
        ).fetchall():
            _validate_job_uuid(str(row[0]))
    foreign_key_error = conn.execute(
        "PRAGMA foreign_key_check"
    ).fetchone()
    if foreign_key_error is not None:
        raise RuntimeError(
            "repeat-application reference migration found a foreign-key "
            "violation"
        )


def _reassign_repeat_application_references_v23(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    losing_job_id: str,
    surviving_job_id: str,
) -> None:
    if losing_job_id == surviving_job_id:
        return
    expected_counts = {
        table: int(
            conn.execute(
                f'SELECT COUNT(*) FROM "{table}"'
            ).fetchone()[0]
        )
        for table in _REPEAT_APPLICATION_REFERENCE_TABLES
    }
    conn.execute(
        """
        UPDATE application_repeat_overrides
        SET target_job_id = ?
        WHERE tenant_id = ? AND target_job_id = ?
        """,
        (surviving_job_id, tenant_id, losing_job_id),
    )
    conn.execute(
        """
        UPDATE application_repeat_overrides
        SET prior_job_id = ?
        WHERE tenant_id = ? AND prior_job_id = ?
        """,
        (surviving_job_id, tenant_id, losing_job_id),
    )
    conn.execute(
        """
        UPDATE application_repeat_audit
        SET target_job_id = ?
        WHERE tenant_id = ? AND target_job_id = ?
        """,
        (surviving_job_id, tenant_id, losing_job_id),
    )
    _verify_repeat_application_references_v23(
        conn,
        expected_counts=expected_counts,
    )


_CONTACT_RESEARCH_REFERENCE_SCHEMA_VERSION = 24
_CONTACT_RESEARCH_REFERENCE_TABLES = (
    "contacts",
    "contact_research_tasks",
)
_CONTACT_RESEARCH_HISTORY_TABLES = (
    "contacts",
    "contact_attributes",
    "contact_research_tasks",
    "contact_candidates",
)


def _has_composite_job_id_foreign_key_action(
    conn: sqlite3.Connection,
    *,
    table: str,
    reference_column: str,
    on_delete: str,
) -> bool:
    groups: dict[int, set[tuple[str, str]]] = {}
    actions: dict[int, str] = {}
    for row in conn.execute(
        f'PRAGMA foreign_key_list("{table}")'
    ).fetchall():
        if str(row[2]) != "jobs":
            continue
        foreign_key_id = int(row[0])
        groups.setdefault(foreign_key_id, set()).add(
            (str(row[3]), str(row[4]))
        )
        actions[foreign_key_id] = str(row[6]).upper()
    expected = {
        ("tenant_id", "tenant_id"),
        (reference_column, "job_id"),
    }
    return any(
        columns == expected
        and actions.get(foreign_key_id) == on_delete.upper()
        for foreign_key_id, columns in groups.items()
    )


def _has_contact_research_reference_schema_v24(
    conn: sqlite3.Connection,
) -> bool:
    contacts = "contacts"
    research = "contact_research_tasks"
    return (
        "job_id" in _table_columns(conn, contacts)
        and "job_url" not in _table_columns(conn, contacts)
        and _primary_key_columns(conn, contacts)
        == ("tenant_id", "contact_id")
        and _has_composite_job_id_foreign_key_action(
            conn,
            table=contacts,
            reference_column="job_id",
            on_delete="RESTRICT",
        )
        and _has_index(
            conn,
            contacts,
            "idx_contacts_lookup",
            ("tenant_id", "employer", "job_id"),
            unique=False,
        )
        and "job_id" in _table_columns(conn, research)
        and "job_url" not in _table_columns(conn, research)
        and _primary_key_columns(conn, research)
        == ("tenant_id", "task_id")
        and _has_composite_job_id_foreign_key_action(
            conn,
            table=research,
            reference_column="job_id",
            on_delete="RESTRICT",
        )
        and _has_index(
            conn,
            research,
            "idx_contact_research_tasks_lookup",
            ("tenant_id", "employer", "job_id"),
            unique=False,
        )
    )


def _canonical_contact_rows_v24(
    conn: sqlite3.Connection,
) -> list[tuple[Any, ...]]:
    reference_column = _legacy_or_stable_reference_column(
        conn,
        "contacts",
        stable="job_id",
        legacy="job_url",
    )
    rows = conn.execute(
        f"""
        SELECT tenant_id, contact_id, employer, {reference_column},
               role, created_at, updated_at, deleted_at
        FROM contacts
        ORDER BY tenant_id, contact_id
        """
    ).fetchall()
    canonical: list[tuple[Any, ...]] = []
    for row in rows:
        values = tuple(row)
        raw_reference = values[3]
        stable_job_id: str | None = None
        if raw_reference is not None:
            stable_job_id = _resolve_job_reference_value(
                conn,
                tenant_id=str(values[0]),
                reference=str(raw_reference),
                legacy_url=reference_column == "job_url",
            )
            if stable_job_id is None:
                raise RuntimeError(
                    "contact reference migration could not resolve "
                    f"contacts.{reference_column}={raw_reference!r} "
                    f"for tenant {values[0]!r}"
                )
            _validate_job_uuid(stable_job_id)
        canonical.append(
            (
                values[0],
                values[1],
                values[2],
                stable_job_id,
                values[4],
                values[5],
                values[6],
                values[7],
            )
        )
    return canonical


def _canonical_contact_research_rows_v24(
    conn: sqlite3.Connection,
) -> list[tuple[Any, ...]]:
    reference_column = _legacy_or_stable_reference_column(
        conn,
        "contact_research_tasks",
        stable="job_id",
        legacy="job_url",
    )
    rows = conn.execute(
        f"""
        SELECT tenant_id, task_id, employer, {reference_column}, status,
               source_attempts_json, started_at, updated_at,
               needs_review_at, completed_at, failed_at, error_class
        FROM contact_research_tasks
        ORDER BY tenant_id, task_id
        """
    ).fetchall()
    canonical: list[tuple[Any, ...]] = []
    for row in rows:
        values = tuple(row)
        raw_reference = values[3]
        stable_job_id: str | None = None
        if raw_reference is not None:
            stable_job_id = _resolve_job_reference_value(
                conn,
                tenant_id=str(values[0]),
                reference=str(raw_reference),
                legacy_url=reference_column == "job_url",
            )
            if stable_job_id is None:
                raise RuntimeError(
                    "contact-research reference migration could not resolve "
                    "contact_research_tasks."
                    f"{reference_column}={raw_reference!r} "
                    f"for tenant {values[0]!r}"
                )
            _validate_job_uuid(stable_job_id)
        canonical.append(
            (
                values[0],
                values[1],
                values[2],
                stable_job_id,
                *values[4:],
            )
        )
    return canonical


def _create_contact_reference_indexes_v24(
    conn: sqlite3.Connection,
) -> None:
    indexes = (
        (
            "contacts",
            "idx_contacts_lookup",
            ("tenant_id", "employer", "job_id"),
            """
            CREATE INDEX idx_contacts_lookup
            ON contacts(tenant_id, employer, job_id)
            """,
        ),
        (
            "contact_research_tasks",
            "idx_contact_research_tasks_lookup",
            ("tenant_id", "employer", "job_id"),
            """
            CREATE INDEX idx_contact_research_tasks_lookup
            ON contact_research_tasks(tenant_id, employer, job_id)
            """,
        ),
    )
    for table, name, columns, create_sql in indexes:
        if _has_index(
            conn,
            table,
            name,
            columns,
            unique=False,
        ):
            continue
        conn.execute(f'DROP INDEX IF EXISTS "{name}"')
        conn.execute(create_sql)


def ensure_contact_research_references_v24(
    conn: sqlite3.Connection | None = None,
) -> list[str]:
    """Move optional Contact and research-task links to stable JobIds."""
    if conn is None:
        conn = get_connection()
    current = _assert_schema_version_supported(conn)
    if current >= _CONTACT_RESEARCH_REFERENCE_SCHEMA_VERSION:
        return list(_CONTACT_RESEARCH_REFERENCE_TABLES)
    if current != _REPEAT_APPLICATION_REFERENCE_SCHEMA_VERSION:
        raise RuntimeError(
            "contact reference migration requires schema v23; "
            f"found v{current}"
        )

    expected_counts = {
        table: int(
            conn.execute(
                f'SELECT COUNT(*) FROM "{table}"'
            ).fetchone()[0]
        )
        for table in _CONTACT_RESEARCH_HISTORY_TABLES
    }
    conn.execute("SAVEPOINT contact_research_references_v24")
    try:
        contact_rows = _canonical_contact_rows_v24(conn)
        research_rows = _canonical_contact_research_rows_v24(conn)

        conn.execute("DROP TABLE IF EXISTS contacts_v24")
        _create_contacts_table_v24(
            conn,
            table="contacts_v24",
            stable_reference=True,
        )
        conn.executemany(
            """
            INSERT INTO contacts_v24 (
                tenant_id, contact_id, employer, job_id, role,
                created_at, updated_at, deleted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            contact_rows,
        )

        conn.execute(
            "DROP TABLE IF EXISTS contact_research_tasks_v24"
        )
        _create_contact_research_tasks_table_v24(
            conn,
            table="contact_research_tasks_v24",
            stable_reference=True,
        )
        conn.executemany(
            """
            INSERT INTO contact_research_tasks_v24 (
                tenant_id, task_id, employer, job_id, status,
                source_attempts_json, started_at, updated_at,
                needs_review_at, completed_at, failed_at, error_class
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            research_rows,
        )

        conn.execute('DROP TABLE "contacts"')
        conn.execute(
            'ALTER TABLE "contacts_v24" RENAME TO "contacts"'
        )
        conn.execute('DROP TABLE "contact_research_tasks"')
        conn.execute(
            'ALTER TABLE "contact_research_tasks_v24" '
            'RENAME TO "contact_research_tasks"'
        )
        _create_contact_reference_indexes_v24(conn)
        _verify_contact_research_references_v24(
            conn,
            expected_counts=expected_counts,
        )
        conn.execute(
            f"PRAGMA user_version = "
            f"{_CONTACT_RESEARCH_REFERENCE_SCHEMA_VERSION}"
        )
        conn.execute("RELEASE SAVEPOINT contact_research_references_v24")
    except BaseException:
        conn.execute(
            "ROLLBACK TO SAVEPOINT contact_research_references_v24"
        )
        conn.execute(
            "RELEASE SAVEPOINT contact_research_references_v24"
        )
        raise
    return list(_CONTACT_RESEARCH_REFERENCE_TABLES)


def _verify_contact_research_references_v24(
    conn: sqlite3.Connection,
    *,
    expected_counts: dict[str, int],
) -> None:
    if not _has_contact_research_reference_schema_v24(conn):
        raise RuntimeError(
            "contact reference migration did not create the stable "
            "reference schema"
        )
    for table, expected_count in expected_counts.items():
        observed_count = int(
            conn.execute(
                f'SELECT COUNT(*) FROM "{table}"'
            ).fetchone()[0]
        )
        if observed_count != expected_count:
            raise RuntimeError(
                "contact reference migration changed "
                f"{table} row count: expected {expected_count}, "
                f"found {observed_count}"
            )
    for table in _CONTACT_RESEARCH_REFERENCE_TABLES:
        orphan = conn.execute(
            f"""
            SELECT source.job_id
            FROM "{table}" AS source
            LEFT JOIN jobs
              ON jobs.tenant_id = source.tenant_id
             AND jobs.job_id = source.job_id
            WHERE source.job_id IS NOT NULL
              AND jobs.job_id IS NULL
            LIMIT 1
            """
        ).fetchone()
        if orphan is not None:
            raise RuntimeError(
                "contact reference migration left an unresolved "
                f"JobId in {table}.job_id"
            )
        for row in conn.execute(
            f'SELECT DISTINCT job_id FROM "{table}" '
            "WHERE job_id IS NOT NULL"
        ).fetchall():
            _validate_job_uuid(str(row[0]))
    foreign_key_error = conn.execute(
        "PRAGMA foreign_key_check"
    ).fetchone()
    if foreign_key_error is not None:
        raise RuntimeError(
            "contact reference migration found a foreign-key violation"
        )


def _reassign_contact_research_references_v24(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    losing_job_id: str,
    surviving_job_id: str,
    losing_job_url: str,
    surviving_job_url: str,
) -> None:
    if losing_job_id == surviving_job_id:
        return
    expected_counts = {
        table: int(
            conn.execute(
                f'SELECT COUNT(*) FROM "{table}"'
            ).fetchone()[0]
        )
        for table in _CONTACT_RESEARCH_HISTORY_TABLES
    }
    for table in _CONTACT_RESEARCH_REFERENCE_TABLES:
        conn.execute(
            f"""
            UPDATE "{table}"
            SET job_id = ?
            WHERE tenant_id = ? AND job_id = ?
            """,
            (surviving_job_id, tenant_id, losing_job_id),
        )
    for projection in (
        "contact_projections",
        "contact_research_task_projections",
    ):
        if not _table_columns(conn, projection):
            continue
        conn.execute(
            f"""
            UPDATE "{projection}"
            SET job_id = ?
            WHERE tenant_id = ? AND job_id = ?
            """,
            (surviving_job_url, tenant_id, losing_job_url),
        )
    _verify_contact_research_references_v24(
        conn,
        expected_counts=expected_counts,
    )


_OUTREACH_REFERENCE_SCHEMA_VERSION = 25
_OUTREACH_REFERENCE_TABLES = ("outreach_threads",)
_OUTREACH_HISTORY_TABLES = (
    "outreach_threads",
    "outreach_drafts",
    "outreach_send_logs",
)


def _has_outreach_reference_schema_v25(
    conn: sqlite3.Connection,
) -> bool:
    table = "outreach_threads"
    return (
        "job_id" in _table_columns(conn, table)
        and "job_url" not in _table_columns(conn, table)
        and _primary_key_columns(conn, table)
        == ("tenant_id", "thread_id")
        and _has_composite_job_id_foreign_key_action(
            conn,
            table=table,
            reference_column="job_id",
            on_delete="RESTRICT",
        )
        and _has_index(
            conn,
            table,
            "idx_outreach_threads_contact",
            ("tenant_id", "contact_id", "job_id"),
            unique=False,
        )
    )


def _canonical_outreach_thread_rows_v25(
    conn: sqlite3.Connection,
) -> list[tuple[Any, ...]]:
    reference_column = _legacy_or_stable_reference_column(
        conn,
        "outreach_threads",
        stable="job_id",
        legacy="job_url",
    )
    rows = conn.execute(
        f"""
        SELECT tenant_id, thread_id, contact_id, {reference_column},
               created_at, updated_at, follow_up_due_at,
               follow_up_basis, follow_up_state
        FROM outreach_threads
        ORDER BY tenant_id, thread_id
        """
    ).fetchall()
    canonical: list[tuple[Any, ...]] = []
    for row in rows:
        values = tuple(row)
        raw_reference = values[3]
        stable_job_id: str | None = None
        if raw_reference is not None:
            stable_job_id = _resolve_job_reference_value(
                conn,
                tenant_id=str(values[0]),
                reference=str(raw_reference),
                legacy_url=reference_column == "job_url",
            )
            if stable_job_id is None:
                raise RuntimeError(
                    "outreach reference migration could not resolve "
                    f"outreach_threads.{reference_column}="
                    f"{raw_reference!r} for tenant {values[0]!r}"
                )
            _validate_job_uuid(stable_job_id)
        canonical.append(
            (
                values[0],
                values[1],
                values[2],
                stable_job_id,
                *values[4:],
            )
        )
    return canonical


def _create_outreach_reference_indexes_v25(
    conn: sqlite3.Connection,
) -> None:
    if _has_index(
        conn,
        "outreach_threads",
        "idx_outreach_threads_contact",
        ("tenant_id", "contact_id", "job_id"),
        unique=False,
    ):
        return
    conn.execute(
        'DROP INDEX IF EXISTS "idx_outreach_threads_contact"'
    )
    conn.execute(
        """
        CREATE INDEX idx_outreach_threads_contact
        ON outreach_threads(tenant_id, contact_id, job_id)
        """
    )


def ensure_outreach_references_v25(
    conn: sqlite3.Connection | None = None,
) -> list[str]:
    """Move optional OutreachThread application links to stable JobIds."""
    if conn is None:
        conn = get_connection()
    current = _assert_schema_version_supported(conn)
    if current >= _OUTREACH_REFERENCE_SCHEMA_VERSION:
        return list(_OUTREACH_REFERENCE_TABLES)
    if current != _CONTACT_RESEARCH_REFERENCE_SCHEMA_VERSION:
        raise RuntimeError(
            "outreach reference migration requires schema v24; "
            f"found v{current}"
        )

    expected_counts = {
        table: int(
            conn.execute(
                f'SELECT COUNT(*) FROM "{table}"'
            ).fetchone()[0]
        )
        for table in _OUTREACH_HISTORY_TABLES
    }
    conn.execute("SAVEPOINT outreach_references_v25")
    try:
        thread_rows = _canonical_outreach_thread_rows_v25(conn)

        conn.execute("DROP TABLE IF EXISTS outreach_threads_v25")
        _create_outreach_threads_table_v25(
            conn,
            table="outreach_threads_v25",
            stable_reference=True,
        )
        conn.executemany(
            """
            INSERT INTO outreach_threads_v25 (
                tenant_id, thread_id, contact_id, job_id,
                created_at, updated_at, follow_up_due_at,
                follow_up_basis, follow_up_state
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            thread_rows,
        )

        conn.execute('DROP TABLE "outreach_threads"')
        conn.execute(
            'ALTER TABLE "outreach_threads_v25" '
            'RENAME TO "outreach_threads"'
        )
        _create_outreach_reference_indexes_v25(conn)
        _verify_outreach_references_v25(
            conn,
            expected_counts=expected_counts,
        )
        conn.execute(
            f"PRAGMA user_version = "
            f"{_OUTREACH_REFERENCE_SCHEMA_VERSION}"
        )
        conn.execute("RELEASE SAVEPOINT outreach_references_v25")
    except BaseException:
        conn.execute(
            "ROLLBACK TO SAVEPOINT outreach_references_v25"
        )
        conn.execute(
            "RELEASE SAVEPOINT outreach_references_v25"
        )
        raise
    return list(_OUTREACH_REFERENCE_TABLES)


def _verify_outreach_references_v25(
    conn: sqlite3.Connection,
    *,
    expected_counts: dict[str, int],
) -> None:
    if not _has_outreach_reference_schema_v25(conn):
        raise RuntimeError(
            "outreach reference migration did not create the stable "
            "reference schema"
        )
    for table, expected_count in expected_counts.items():
        observed_count = int(
            conn.execute(
                f'SELECT COUNT(*) FROM "{table}"'
            ).fetchone()[0]
        )
        if observed_count != expected_count:
            raise RuntimeError(
                "outreach reference migration changed "
                f"{table} row count: expected {expected_count}, "
                f"found {observed_count}"
            )
    orphan = conn.execute(
        """
        SELECT source.job_id
        FROM outreach_threads AS source
        LEFT JOIN jobs
          ON jobs.tenant_id = source.tenant_id
         AND jobs.job_id = source.job_id
        WHERE source.job_id IS NOT NULL
          AND jobs.job_id IS NULL
        LIMIT 1
        """
    ).fetchone()
    if orphan is not None:
        raise RuntimeError(
            "outreach reference migration left an unresolved "
            "JobId in outreach_threads.job_id"
        )
    for row in conn.execute(
        "SELECT DISTINCT job_id FROM outreach_threads "
        "WHERE job_id IS NOT NULL"
    ).fetchall():
        _validate_job_uuid(str(row[0]))
    foreign_key_error = conn.execute(
        "PRAGMA foreign_key_check"
    ).fetchone()
    if foreign_key_error is not None:
        raise RuntimeError(
            "outreach reference migration found a foreign-key violation"
        )


def _reassign_outreach_references_v25(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    losing_job_id: str,
    surviving_job_id: str,
    losing_job_url: str,
    surviving_job_url: str,
) -> None:
    if losing_job_id == surviving_job_id:
        return
    expected_counts = {
        table: int(
            conn.execute(
                f'SELECT COUNT(*) FROM "{table}"'
            ).fetchone()[0]
        )
        for table in _OUTREACH_HISTORY_TABLES
    }
    conn.execute(
        """
        UPDATE outreach_threads
        SET job_id = ?
        WHERE tenant_id = ? AND job_id = ?
        """,
        (surviving_job_id, tenant_id, losing_job_id),
    )
    for projection in (
        "outreach_thread_projections",
        "due_follow_up_projections",
    ):
        if not _table_columns(conn, projection):
            continue
        conn.execute(
            f"""
            UPDATE "{projection}"
            SET job_id = ?
            WHERE tenant_id = ? AND job_id = ?
            """,
            (surviving_job_url, tenant_id, losing_job_url),
        )
    _verify_outreach_references_v25(
        conn,
        expected_counts=expected_counts,
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
    "LEFT JOIN job_enrichments je "
    "ON je.tenant_id = jobs.tenant_id AND je.job_id = jobs.job_id "
    "LEFT JOIN job_stage_states jss_enrich "
    "ON jss_enrich.tenant_id = jobs.tenant_id "
    "AND jss_enrich.job_id = jobs.job_id "
    "AND jss_enrich.stage = 'enrich'"
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
    "(je.job_id IS NULL OR je.current_status = 'pending') "
    "AND COALESCE(jss_enrich.state, CASE WHEN jobs.detail_scraped_at IS NOT NULL THEN 'succeeded' ELSE 'pending' END) = 'pending'"
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
# job_materials read fragments — used by the queue selectors that
# previously read bare ``jobs.tailored_resume_path`` / ``cover_letter_path``.
# After Phase 6 the canonical artifact paths live in ``job_materials_artifacts``
# (latest generation per stable JobId); the legacy ``jobs.*_path`` columns
# stay as read-only fallback for historical rows that have no canonical
# materials row. Once ``job_materials`` exists, approved artifacts are the
# only active paths; suppressed artifacts must not fall through to legacy
# columns left populated by the backfill.
# ---------------------------------------------------------------------------

# LEFT JOIN that surfaces the latest generation's tailored-resume and
# cover-letter artifact paths under fixed aliases.
_LATEST_MATERIALS_JOIN: str = (
    "LEFT JOIN ("
    "SELECT history.tenant_id AS jm_tenant_id, "
    "history.job_id AS jm_job_id, latest.max_generation AS jm_generation, "
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
    ") jm ON jm.jm_tenant_id = jobs.tenant_id "
    "AND jm.jm_job_id = jobs.job_id"
)

_EFFECTIVE_TAILOR_PATH: str = (
    "CASE WHEN jm.jm_job_id IS NOT NULL THEN jm.jm_tailored_path "
    "ELSE jobs.tailored_resume_path END"
)
_EFFECTIVE_COVER_PATH: str = (
    "CASE WHEN jm.jm_job_id IS NOT NULL THEN jm.jm_cover_path "
    "ELSE jobs.cover_letter_path END"
)
_READY_TAILORED_RESUME_WITH_PDF: str = (
    "((jm.jm_job_id IS NOT NULL "
    "AND jm.jm_tailored_path IS NOT NULL AND jm.jm_tailored_path != '' "
    "AND jm.jm_resume_pdf_path IS NOT NULL AND jm.jm_resume_pdf_path != '') "
    "OR (jm.jm_job_id IS NULL "
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
    "SELECT tenant_id AS jss_s_tenant_id, job_id AS jss_s_job_id, "
    "state AS jss_s_state, "
    "attempt_count AS jss_s_attempts "
    "FROM job_stage_states WHERE stage = 'score'"
    ") jss_s ON jss_s.jss_s_tenant_id = jobs.tenant_id "
    "AND jss_s.jss_s_job_id = jobs.job_id "
    "LEFT JOIN ("
    "SELECT DISTINCT tenant_id AS jss_stale_tenant_id, "
    "job_id AS jss_stale_job_id "
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
# job_scores read fragments — used by every selector / stat that previously
# read bare ``jobs.fit_score``. After Phase 5 the canonical fit score lives
# in ``job_scores`` (latest version per stable ``JobId``); the legacy
# ``jobs.fit_score`` column stays as a read-only fallback for historical
# rows that were never re-scored. ``_EFFECTIVE_FIT_SCORE`` is the COALESCE
# expression every WHERE / ORDER BY / aggregate query should use instead of
# bare ``fit_score`` so the worker queue selectors see new scores
# immediately and don't re-pick already-scored jobs forever (round-1
# review B1).
# ---------------------------------------------------------------------------

_LATEST_SCORE_JOIN: str = (
    "LEFT JOIN ("
    "SELECT s.tenant_id AS js_tenant_id, s.job_id AS js_job_id, "
    "s.fit_score AS js_fit_score, "
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
    "SELECT tenant_id, job_id, MAX(version) AS max_version "
    "FROM job_scores GROUP BY tenant_id, job_id"
    ") latest ON latest.tenant_id = s.tenant_id "
    "AND latest.job_id = s.job_id AND latest.max_version = s.version"
    ") js ON js.js_tenant_id = jobs.tenant_id "
    "AND js.js_job_id = jobs.job_id"
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
        jm_job_id = record.pop("jm_job_id", None)
        jm_tailored = record.pop("jm_tailored_path", None)
        jm_tailored_at = record.pop("jm_tailored_at", None)
        jm_cover = record.pop("jm_cover_path", None)
        jm_cover_at = record.pop("jm_cover_at", None)
        if jm_job_id is not None:
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
