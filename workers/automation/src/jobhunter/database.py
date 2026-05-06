"""JobHunter database layer: schema, migrations, stats, and connection helpers.

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

from jobhunter.config import DB_PATH

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

    if not hasattr(_local, 'connections'):
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
    if hasattr(_local, 'connections'):
        conn = _local.connections.pop(path, None)
        if conn is not None:
            conn.close()


def init_db(db_path: Path | str | None = None) -> sqlite3.Connection:
    """Create the full jobs table with all columns from every pipeline stage.

    This is idempotent -- safe to call on every startup. Uses CREATE TABLE IF NOT EXISTS
    so it won't destroy existing data.

    Schema columns by stage:
      - Discovery:  url, title, salary, description, location, site, strategy, discovered_at
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
    conn.execute("""
        CREATE TABLE IF NOT EXISTS jobs (
            -- Discovery stage (smart_extract / job_search)
            url                   TEXT PRIMARY KEY,
            title                 TEXT,
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
    ensure_observability_tables(conn)
    ensure_state_tables(conn)
    ensure_score_tables(conn)
    ensure_materials_tables(conn)
    ensure_enrichment_tables(conn)

    return conn


# Complete column registry: column_name -> SQL type with optional default.
# This is the single source of truth. Adding a column here is all that's needed
# for it to appear in both new databases and migrated ones.
_ALL_COLUMNS: dict[str, str] = {
    # Discovery
    "url": "TEXT PRIMARY KEY",
    "title": "TEXT",
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


def ensure_observability_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create the apply-agent observability tables if they do not exist.

    Returns:
        List of table names that were ensured.
    """
    if conn is None:
        conn = get_connection()

    conn.execute("""
        CREATE TABLE IF NOT EXISTS apply_runs (
            run_id              TEXT PRIMARY KEY,
            job_url             TEXT NOT NULL,
            site                TEXT,
            title               TEXT,
            application_url     TEXT,
            worker_id           INTEGER,
            worker_name         TEXT,
            model               TEXT,
            pid                 INTEGER,
            chrome_pid          INTEGER,
            status              TEXT NOT NULL DEFAULT 'starting',
            result              TEXT,
            error               TEXT,
            dry_run             INTEGER DEFAULT 0,
            headless            INTEGER DEFAULT 0,
            attempts            INTEGER DEFAULT 1,
            started_at          TEXT NOT NULL,
            updated_at          TEXT NOT NULL,
            finished_at         TEXT,
            duration_ms         INTEGER,
            prompt_path         TEXT,
            mcp_config_path     TEXT,
            log_path            TEXT,
            output_path         TEXT,
            resume_path         TEXT,
            cover_letter_path   TEXT,
            task_id             TEXT,
            input_tokens        INTEGER,
            output_tokens       INTEGER,
            cache_read_tokens   INTEGER,
            cache_create_tokens INTEGER,
            cost_usd            REAL,
            extra_json          TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS apply_run_events (
            event_id        INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id          TEXT NOT NULL,
            occurred_at     TEXT NOT NULL,
            worker_id       INTEGER,
            event_type      TEXT NOT NULL,
            level           TEXT NOT NULL DEFAULT 'info',
            message         TEXT,
            payload_json    TEXT
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_apply_runs_job_url_started
        ON apply_runs(job_url, started_at DESC)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_apply_runs_status_started
        ON apply_runs(status, started_at DESC)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_apply_runs_worker_started
        ON apply_runs(worker_id, started_at DESC)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_apply_run_events_run_event
        ON apply_run_events(run_id, event_id)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_apply_run_events_run_time
        ON apply_run_events(run_id, occurred_at, event_id)
    """)
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
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        )
    """)
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
    conn.commit()
    return ["job_stage_states", "job_events", "job_artifacts", "event_watermarks"]


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
            PRIMARY KEY (job_url, version),
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_job_scores_tenant_score
        ON job_scores(tenant_id, fit_score DESC, scored_at DESC)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_job_scores_job_version
        ON job_scores(job_url, version DESC)
    """)

    # One-shot backfill from the legacy columns. Only fires when
    # job_scores has no rows AND there are jobs with a legacy fit_score.
    backfill_count = conn.execute(
        "SELECT COUNT(*) FROM job_scores"
    ).fetchone()[0]
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
                reasoning = (
                    row["score_reasoning"]
                    if isinstance(row, sqlite3.Row)
                    else row[2]
                )
                scored_at = (
                    row["scored_at"]
                    if isinstance(row, sqlite3.Row)
                    else row[3]
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
                conn.execute(
                    """
                    INSERT OR IGNORE INTO job_scores (
                        job_url, version, tenant_id, fit_score,
                        breakdown_json, keywords_json, scored_at, correction_json
                    ) VALUES (?, 1, 'local', ?, ?, ?, ?, NULL)
                    """,
                    (url, int(fit), breakdown_json, keywords_json, scored_at or now),
                )

    conn.commit()
    return ["job_scores"]


def ensure_materials_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create the per-job ``job_materials`` tables and run their backfill.

    See ddd-target.md §4.5 / §7.2. Two tables form the persistence side
    of the Phase-6 :class:`MaterialsSet` aggregate:

      * ``job_materials`` — one row per ``(job_url, generation)`` aggregate.
      * ``job_materials_artifacts`` — one row per artifact slot per
        aggregate (``tailored_resume``, ``cover_letter``, ``resume_pdf``,
        ``cover_letter_pdf``).

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

    # Idempotent backfill from the legacy ``jobs`` columns. Fires only
    # when ``job_materials`` is empty.
    backfill_count = conn.execute(
        "SELECT COUNT(*) FROM job_materials"
    ).fetchone()[0]
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
    return ["job_materials", "job_materials_artifacts"]


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
        artifacts.append(
            ("tailored_resume", tailor_path, "text", _size(tailor_path), tailor_at)
        )
    if resume_pdf:
        artifacts.append(
            ("resume_pdf", resume_pdf, "latex_pdf", _size(resume_pdf), tailor_at)
        )
    if cover_path:
        artifacts.append(
            ("cover_letter", cover_path, "text", _size(cover_path), cover_at)
        )
    if cover_pdf:
        artifacts.append(
            ("cover_letter_pdf", cover_pdf, "html_pdf", _size(cover_pdf), cover_at)
        )

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
    backfill_count = conn.execute(
        "SELECT COUNT(*) FROM job_enrichments"
    ).fetchone()[0]
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
    "LEFT JOIN job_enrichments je ON je.job_url = jobs.url"
)

_EFFECTIVE_FULL_DESCRIPTION: str = (
    "COALESCE(je.full_description, jobs.full_description)"
)
_EFFECTIVE_APPLICATION_URL: str = (
    "COALESCE(je.application_url, jobs.application_url)"
)
_EFFECTIVE_DETAIL_SCRAPED_AT: str = (
    "COALESCE(je.enriched_at, jobs.detail_scraped_at)"
)
# Per §7.1 the canonical "this job has been enriched" predicate is the
# aggregate's terminal status; un-backfilled rows fall back to the legacy
# detail_scraped_at column.
_ENRICHMENT_DONE: str = (
    "(je.current_status = 'enriched' OR jobs.detail_scraped_at IS NOT NULL)"
)
# Phase 7 (S-26 round-1 review M3): the canonical "this job needs
# enrichment" predicate is the aggregate's status alone. Earlier drafts
# carried an `AND jobs.detail_scraped_at IS NULL` clause that (a)
# excluded backfilled `pending` rows that happened to have the legacy
# timestamp set, and (b) would block the post-reset re-pickup once
# `reset_job_stage("enrich")` clears the aggregate. The predicate now
# matches the Phase-5/6 pattern — COALESCE expressions are the source
# of truth, the legacy column is read-only fallback only.
_ENRICHMENT_PENDING: str = (
    "(je.job_url IS NULL OR je.current_status = 'pending')"
)


# ---------------------------------------------------------------------------
# job_materials read fragments — used by the queue selectors that
# previously read bare ``jobs.tailored_resume_path`` / ``cover_letter_path``.
# After Phase 6 the canonical artifact paths live in ``job_materials_artifacts``
# (latest generation per ``job_url``); the legacy ``jobs.*_path`` columns
# stay as read-only fallback for historical rows. ``_EFFECTIVE_TAILOR_PATH``
# / ``_EFFECTIVE_COVER_PATH`` are the COALESCE expressions every WHERE /
# ORDER BY query should use instead of bare column reads so the worker
# queue selectors see new materials immediately and don't re-pick already-
# tailored jobs forever (mirrors Phase-5 round-1 review B1).
# ---------------------------------------------------------------------------

# LEFT JOIN that surfaces the latest generation's tailored-resume and
# cover-letter artifact paths under fixed aliases.
_LATEST_MATERIALS_JOIN: str = (
    "LEFT JOIN ("
    "SELECT m.job_url AS jm_job_url, m.generation AS jm_generation, m.status AS jm_status, "
    "tr.path AS jm_tailored_path, tr.created_at AS jm_tailored_at, "
    "cl.path AS jm_cover_path, cl.created_at AS jm_cover_at, "
    "rpdf.path AS jm_resume_pdf_path, "
    "cpdf.path AS jm_cover_pdf_path "
    "FROM job_materials m "
    "INNER JOIN ("
    "SELECT job_url, MAX(generation) AS max_generation "
    "FROM job_materials GROUP BY job_url"
    ") latest ON latest.job_url = m.job_url AND latest.max_generation = m.generation "
    "LEFT JOIN job_materials_artifacts tr "
    "ON tr.job_url = m.job_url AND tr.generation = m.generation "
    "AND tr.artifact_type = 'tailored_resume' AND tr.status = 'approved' "
    "LEFT JOIN job_materials_artifacts cl "
    "ON cl.job_url = m.job_url AND cl.generation = m.generation "
    "AND cl.artifact_type = 'cover_letter' AND cl.status = 'approved' "
    "LEFT JOIN job_materials_artifacts rpdf "
    "ON rpdf.job_url = m.job_url AND rpdf.generation = m.generation "
    "AND rpdf.artifact_type = 'resume_pdf' AND rpdf.status = 'approved' "
    "LEFT JOIN job_materials_artifacts cpdf "
    "ON cpdf.job_url = m.job_url AND cpdf.generation = m.generation "
    "AND cpdf.artifact_type = 'cover_letter_pdf' AND cpdf.status = 'approved'"
    ") jm ON jm.jm_job_url = jobs.url"
)

_EFFECTIVE_TAILOR_PATH: str = "COALESCE(jm.jm_tailored_path, jobs.tailored_resume_path)"
_EFFECTIVE_COVER_PATH: str = "COALESCE(jm.jm_cover_path, jobs.cover_letter_path)"


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
    "SELECT s.job_url AS js_job_url, s.fit_score AS js_fit_score "
    "FROM job_scores s "
    "INNER JOIN ("
    "SELECT job_url, MAX(version) AS max_version FROM job_scores GROUP BY job_url"
    ") latest ON latest.job_url = s.job_url AND latest.max_version = s.version"
    ") js ON js.js_job_url = jobs.url"
)

_EFFECTIVE_FIT_SCORE: str = "COALESCE(js.js_fit_score, jobs.fit_score)"


# ---------------------------------------------------------------------------
# Phase 8 (S-30): apply read-side. The legacy launcher wrote
# ``jobs.applied_at`` / ``jobs.apply_status`` / ``jobs.apply_error`` etc.;
# the new launcher (and the ``ApplyRunRepository``) write ONLY to
# ``apply_runs`` + ``apply_run_events``. This LEFT JOIN promotes the
# latest apply_runs row's status / finished_at into the legacy column
# slots so the queue selectors (``pending_apply``, ``applied``) and
# ``get_stats`` see new aggregate writes without re-querying through
# the repository at every read site.
# ---------------------------------------------------------------------------

# Round-1 review L1: tie-break by run_id when two apply_runs rows
# share the same ``started_at`` (same-second collisions are possible
# with ``_utc_now()``-stamped retries). The correlated subquery picks
# the latest row deterministically — ORDER BY started_at DESC,
# run_id DESC + LIMIT 1.
_LATEST_APPLY_RUN_JOIN: str = (
    "LEFT JOIN ("
    "SELECT ar.job_url AS ar_job_url, ar.status AS ar_status, "
    "ar.result AS ar_result, ar.finished_at AS ar_finished_at, "
    "ar.started_at AS ar_started_at, ar.run_id AS ar_run_id "
    "FROM apply_runs ar "
    "WHERE ar.run_id = ("
    "SELECT run_id FROM apply_runs ar_inner "
    "WHERE ar_inner.job_url = ar.job_url "
    "ORDER BY ar_inner.started_at DESC, ar_inner.run_id DESC "
    "LIMIT 1"
    ")"
    ") ar ON ar.ar_job_url = jobs.url"
)

# Applied = any apply_run with status='succeeded' for the job (we
# COALESCE with the legacy column so historical rows stay visible).
_EFFECTIVE_APPLIED_AT: str = (
    "CASE WHEN ar.ar_status = 'succeeded' THEN ar.ar_finished_at "
    "ELSE jobs.applied_at END"
)

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
    rows = conn.execute(
        "SELECT site, COUNT(*) as cnt FROM jobs GROUP BY site ORDER BY cnt DESC"
    ).fetchall()
    stats["by_site"] = [(row[0], row[1]) for row in rows]

    # Enrichment stage — Phase 7 (S-26): read through the
    # ``job_enrichments`` join so dashboard counts reflect new
    # JobEnrichment writes (jobs.full_description / jobs.application_url
    # are NULL on the new path).
    stats["pending_detail"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_ENRICHMENT_JOIN} WHERE {_ENRICHMENT_PENDING}"
    ).fetchone()[0]

    stats["with_description"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_ENRICHMENT_JOIN} "
        f"WHERE {_EFFECTIVE_FULL_DESCRIPTION} IS NOT NULL"
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
        f"SELECT COUNT(*) FROM jobs {_LATEST_SCORE_JOIN} "
        f"WHERE {_EFFECTIVE_FIT_SCORE} IS NOT NULL"
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
        f"SELECT COUNT(*) FROM jobs {_LATEST_MATERIALS_JOIN} "
        f"WHERE {_EFFECTIVE_TAILOR_PATH} IS NOT NULL"
    ).fetchone()[0]

    stats["untailored_eligible"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_LATEST_SCORE_JOIN} {_LATEST_MATERIALS_JOIN} "
        f"{_ENRICHMENT_JOIN} "
        f"WHERE {_EFFECTIVE_FIT_SCORE} >= 7 "
        f"AND {_EFFECTIVE_FULL_DESCRIPTION} IS NOT NULL "
        f"AND {_EFFECTIVE_TAILOR_PATH} IS NULL"
    ).fetchone()[0]

    stats["tailor_exhausted"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_LATEST_MATERIALS_JOIN} {_LATEST_STAGE_ATTEMPTS_JOIN} "
        f"WHERE {_EFFECTIVE_TAILOR_PATH} IS NULL "
        f"AND ({_EFFECTIVE_TAILOR_ATTEMPTS} >= 5 OR jss_t.jss_t_state = 'exhausted')"
    ).fetchone()[0]

    stats["with_cover_letter"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_LATEST_MATERIALS_JOIN} "
        f"WHERE {_EFFECTIVE_COVER_PATH} IS NOT NULL"
    ).fetchone()[0]

    stats["cover_exhausted"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_LATEST_MATERIALS_JOIN} {_LATEST_STAGE_ATTEMPTS_JOIN} "
        f"WHERE ({_EFFECTIVE_COVER_PATH} IS NULL OR {_EFFECTIVE_COVER_PATH} = '') "
        f"AND ({_EFFECTIVE_COVER_ATTEMPTS} >= 5 OR jss_c.jss_c_state = 'exhausted')"
    ).fetchone()[0]

    # Application stage — Phase 8 (S-30): read through the
    # ``apply_runs`` join so dashboard counts reflect new ApplyRun
    # writes (jobs.applied_at / apply_status / apply_error are NULL
    # on the new write path).
    stats["applied"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_LATEST_APPLY_RUN_JOIN} "
        f"WHERE {_EFFECTIVE_APPLIED_AT} IS NOT NULL"
    ).fetchone()[0]

    stats["apply_errors"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_LATEST_APPLY_RUN_JOIN} "
        f"WHERE ar.ar_status IN ('failed', 'captcha', 'login_issue', 'expired') "
        "OR jobs.apply_error IS NOT NULL"
    ).fetchone()[0]

    stats["ready_to_apply"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_LATEST_MATERIALS_JOIN} {_ENRICHMENT_JOIN} "
        f"{_LATEST_APPLY_RUN_JOIN} "
        f"WHERE {_EFFECTIVE_TAILOR_PATH} IS NOT NULL "
        f"AND {_EFFECTIVE_APPLIED_AT} IS NULL "
        f"AND {_EFFECTIVE_APPLICATION_URL} IS NOT NULL "
        f"AND {_EFFECTIVE_APPLICATION_URL} != ''"
    ).fetchone()[0]

    return stats


def store_jobs(conn: sqlite3.Connection, jobs: list[dict],
               site: str, strategy: str) -> tuple[int, int]:
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
                "INSERT INTO jobs (url, title, salary, description, location, site, strategy, discovered_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (url, job.get("title"), job.get("salary"), job.get("description"),
                 job.get("location"), site, strategy, now),
            )
            from jobhunter.state import ensure_job_stage_rows, record_job_event, set_stage_state

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
            existing += 1

    conn.commit()
    return new, existing


def load_job_with_enrichment(
    conn: sqlite3.Connection,
    url: str,
) -> dict | None:
    """Load one job row with the canonical enrichment fields promoted.

    Phase 7 (S-26 round-1 review B6). The legacy
    ``SELECT * FROM jobs WHERE url = ?`` reads NULL for
    ``full_description`` / ``application_url`` / ``detail_scraped_at``
    on the new write path. This helper LEFT JOINs ``job_enrichments``
    and promotes the joined values into the legacy column slots so
    callers (manual ``apply_jobs`` flow, ``apply/launcher`` snapshots)
    keep reading via the existing keys without an extra round-trip
    through the repository.

    Returns the row dict, or ``None`` if no job row exists for ``url``.
    """
    row = conn.execute(
        f"SELECT jobs.*, "
        f"je.full_description AS je_full_description, "
        f"je.application_url AS je_application_url, "
        f"je.enriched_at AS je_enriched_at, "
        f"je.current_status AS je_current_status, "
        f"je.extraction_tier AS je_extraction_tier, "
        f"ar.ar_status AS ar_status, "
        f"ar.ar_finished_at AS ar_finished_at, "
        f"ar.ar_run_id AS ar_run_id, "
        f"{_EFFECTIVE_APPLIED_AT} AS effective_applied_at, "
        f"{_EFFECTIVE_APPLY_STATUS} AS effective_apply_status "
        f"FROM jobs {_ENRICHMENT_JOIN} {_LATEST_APPLY_RUN_JOIN} "
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
    # Phase 8 (S-30): promote apply_runs columns.
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


def get_jobs_by_stage(conn: sqlite3.Connection | None = None,
                      stage: str = "discovered",
                      min_score: int | None = None,
                      limit: int = 100,
                      retailor: bool = False) -> list[dict]:
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
        f"AND {_TAILOR_NOT_EXHAUSTED} "
        f"AND ({_EFFECTIVE_TAILOR_PATH} IS NOT NULL OR {_EFFECTIVE_TAILOR_ATTEMPTS} < 5)"
        if retailor else
        f"{_EFFECTIVE_FIT_SCORE} >= ? AND {_EFFECTIVE_FULL_DESCRIPTION} IS NOT NULL "
        f"AND {_EFFECTIVE_TAILOR_PATH} IS NULL "
        f"AND {_TAILOR_NOT_EXHAUSTED} "
        f"AND {_EFFECTIVE_TAILOR_ATTEMPTS} < 5"
    )

    conditions = {
        "discovered": "1=1",
        "pending_detail": _ENRICHMENT_PENDING,
        "enriched": f"{_EFFECTIVE_FULL_DESCRIPTION} IS NOT NULL",
        "pending_score": (
            f"{_EFFECTIVE_FULL_DESCRIPTION} IS NOT NULL "
            f"AND {_EFFECTIVE_FIT_SCORE} IS NULL"
        ),
        "scored": f"{_EFFECTIVE_FIT_SCORE} IS NOT NULL",
        "pending_tailor": pending_tailor_where,
        "pending_cover": (
            f"{_EFFECTIVE_FIT_SCORE} >= ? AND {_EFFECTIVE_FULL_DESCRIPTION} IS NOT NULL "
            f"AND {_EFFECTIVE_TAILOR_PATH} IS NOT NULL AND {_EFFECTIVE_TAILOR_PATH} != '' "
            f"AND ({_EFFECTIVE_COVER_PATH} IS NULL OR {_EFFECTIVE_COVER_PATH} = '') "
            f"AND {_COVER_NOT_EXHAUSTED} "
            f"AND {_EFFECTIVE_COVER_ATTEMPTS} < 5"
        ),
        "pending_pdf": (
            f"({_EFFECTIVE_TAILOR_PATH} IS NOT NULL AND jm.jm_resume_pdf_path IS NULL) "
            f"OR ({_EFFECTIVE_COVER_PATH} IS NOT NULL AND jm.jm_cover_pdf_path IS NULL)"
        ),
        "tailored": f"{_EFFECTIVE_TAILOR_PATH} IS NOT NULL",
        # Phase 8 (S-30): pending_apply / applied read through
        # ``apply_runs`` so the new write path (which leaves
        # jobs.applied_at NULL) is visible.
        "pending_apply": (
            f"{_EFFECTIVE_TAILOR_PATH} IS NOT NULL "
            f"AND {_EFFECTIVE_APPLIED_AT} IS NULL "
            f"AND {_EFFECTIVE_APPLICATION_URL} IS NOT NULL "
            "AND (ar.ar_status IS NULL "
            "     OR ar.ar_status NOT IN ('starting', 'in_progress'))"
        ),
        "applied": f"{_EFFECTIVE_APPLIED_AT} IS NOT NULL",
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
    if (
        min_score is not None
        and stage in ("scored", "tailored", "applied")
        and _EFFECTIVE_FIT_SCORE not in where
    ):
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
        f"ar.ar_status AS ar_status, "
        f"ar.ar_finished_at AS ar_finished_at, "
        f"ar.ar_run_id AS ar_run_id, "
        f"{_EFFECTIVE_APPLIED_AT} AS effective_applied_at, "
        f"{_EFFECTIVE_APPLY_STATUS} AS effective_apply_status "
        f"FROM jobs {_LATEST_SCORE_JOIN} {_LATEST_MATERIALS_JOIN} "
        f"{_LATEST_STAGE_ATTEMPTS_JOIN} {_ENRICHMENT_JOIN} {_LATEST_APPLY_RUN_JOIN} "
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
        if js_value is not None:
            record["fit_score"] = js_value
        jm_tailored = record.pop("jm_tailored_path", None)
        jm_tailored_at = record.pop("jm_tailored_at", None)
        jm_cover = record.pop("jm_cover_path", None)
        jm_cover_at = record.pop("jm_cover_at", None)
        if jm_tailored is not None:
            record["tailored_resume_path"] = jm_tailored
            if jm_tailored_at is not None:
                record["tailored_at"] = jm_tailored_at
        if jm_cover is not None:
            record["cover_letter_path"] = jm_cover
            if jm_cover_at is not None:
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
        # Phase 8 (S-30): promote apply_runs columns into the legacy
        # column slots so consumers (TS read-model, Rich dashboard,
        # legacy CLI) that still read ``applied_at`` / ``apply_status``
        # see canonical values written by ``ApplyRunRepository``.
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
