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

    # Enrichment stage
    stats["pending_detail"] = conn.execute(
        "SELECT COUNT(*) FROM jobs WHERE detail_scraped_at IS NULL"
    ).fetchone()[0]

    stats["with_description"] = conn.execute(
        "SELECT COUNT(*) FROM jobs WHERE full_description IS NOT NULL"
    ).fetchone()[0]

    stats["detail_errors"] = conn.execute(
        "SELECT COUNT(*) FROM jobs WHERE detail_error IS NOT NULL"
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
        f"SELECT COUNT(*) FROM jobs {_LATEST_SCORE_JOIN} "
        f"WHERE full_description IS NOT NULL AND {_EFFECTIVE_FIT_SCORE} IS NULL"
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

    # Tailoring stage
    stats["tailored"] = conn.execute(
        "SELECT COUNT(*) FROM jobs WHERE tailored_resume_path IS NOT NULL"
    ).fetchone()[0]

    stats["untailored_eligible"] = conn.execute(
        f"SELECT COUNT(*) FROM jobs {_LATEST_SCORE_JOIN} "
        f"WHERE {_EFFECTIVE_FIT_SCORE} >= 7 AND full_description IS NOT NULL "
        f"AND tailored_resume_path IS NULL"
    ).fetchone()[0]

    stats["tailor_exhausted"] = conn.execute(
        "SELECT COUNT(*) FROM jobs "
        "WHERE COALESCE(tailor_attempts, 0) >= 5 "
        "AND tailored_resume_path IS NULL"
    ).fetchone()[0]

    # Cover letter stage
    stats["with_cover_letter"] = conn.execute(
        "SELECT COUNT(*) FROM jobs WHERE cover_letter_path IS NOT NULL"
    ).fetchone()[0]

    stats["cover_exhausted"] = conn.execute(
        "SELECT COUNT(*) FROM jobs "
        "WHERE COALESCE(cover_attempts, 0) >= 5 "
        "AND (cover_letter_path IS NULL OR cover_letter_path = '')"
    ).fetchone()[0]

    # Application stage
    stats["applied"] = conn.execute(
        "SELECT COUNT(*) FROM jobs WHERE applied_at IS NOT NULL"
    ).fetchone()[0]

    stats["apply_errors"] = conn.execute(
        "SELECT COUNT(*) FROM jobs WHERE apply_error IS NOT NULL"
    ).fetchone()[0]

    stats["ready_to_apply"] = conn.execute(
        "SELECT COUNT(*) FROM jobs "
        "WHERE tailored_resume_path IS NOT NULL "
        "AND applied_at IS NULL "
        "AND application_url IS NOT NULL AND application_url != ''"
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
    pending_tailor_where = (
        f"{_EFFECTIVE_FIT_SCORE} >= ? AND full_description IS NOT NULL "
        "AND (tailored_resume_path IS NOT NULL OR COALESCE(tailor_attempts, 0) < 5)"
        if retailor else
        f"{_EFFECTIVE_FIT_SCORE} >= ? AND full_description IS NOT NULL "
        "AND tailored_resume_path IS NULL AND COALESCE(tailor_attempts, 0) < 5"
    )

    conditions = {
        "discovered": "1=1",
        "pending_detail": "detail_scraped_at IS NULL",
        "enriched": "full_description IS NOT NULL",
        "pending_score": f"full_description IS NOT NULL AND {_EFFECTIVE_FIT_SCORE} IS NULL",
        "scored": f"{_EFFECTIVE_FIT_SCORE} IS NOT NULL",
        "pending_tailor": pending_tailor_where,
        "pending_cover": (
            f"{_EFFECTIVE_FIT_SCORE} >= ? AND full_description IS NOT NULL "
            "AND tailored_resume_path IS NOT NULL AND tailored_resume_path != '' "
            "AND (cover_letter_path IS NULL OR cover_letter_path = '') "
            "AND COALESCE(cover_attempts, 0) < 5"
        ),
        "tailored": "tailored_resume_path IS NOT NULL",
        "pending_apply": (
            "tailored_resume_path IS NOT NULL AND applied_at IS NULL "
            "AND application_url IS NOT NULL"
        ),
        "applied": "applied_at IS NOT NULL",
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
    query = (
        f"SELECT jobs.*, js.js_fit_score AS js_fit_score "
        f"FROM jobs {_LATEST_SCORE_JOIN} "
        f"WHERE {where} "
        f"ORDER BY {_EFFECTIVE_FIT_SCORE} DESC NULLS LAST, discovered_at DESC"
    )
    if limit > 0:
        query += " LIMIT ?"
        params.append(limit)

    rows = conn.execute(query, params).fetchall()

    # Convert sqlite3.Row objects to dicts. We promote ``js_fit_score``
    # into the legacy ``fit_score`` slot so downstream consumers that
    # haven't been ported yet (and read ``job["fit_score"]``) see the
    # canonical value rather than NULL.
    if not rows:
        return []
    columns = rows[0].keys()
    out: list[dict] = []
    for row in rows:
        record = dict(zip(columns, row))
        js_value = record.pop("js_fit_score", None)
        if js_value is not None:
            record["fit_score"] = js_value
        out.append(record)
    return out
