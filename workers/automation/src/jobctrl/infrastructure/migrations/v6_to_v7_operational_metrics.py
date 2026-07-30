"""Explicit v6-to-v7 transform for operational-metric Job references."""

from __future__ import annotations

import sqlite3

from jobctrl.infrastructure.migrations.v6_to_v7_support import table_columns, table_exists


def migrate_v6_operational_attempt_metrics(conn: sqlite3.Connection) -> list[str]:
    """Replace optional v6 metric URLs with canonical JobId references."""
    if not table_exists(conn, "operational_attempt_metrics"):
        return []
    columns = table_columns(conn, "operational_attempt_metrics")
    if "job_url" not in columns:
        raise RuntimeError("v6 operational metrics is missing job_url")
    expected_count = int(
        conn.execute("SELECT COUNT(*) FROM operational_attempt_metrics").fetchone()[0]
    )
    sequence_row = conn.execute(
        "SELECT seq FROM sqlite_sequence WHERE name = 'operational_attempt_metrics'"
    ).fetchone()
    max_metric_row = conn.execute(
        "SELECT COALESCE(MAX(metric_id), 0) FROM operational_attempt_metrics"
    ).fetchone()
    sequence_high_water = max(
        int(sequence_row[0]) if sequence_row is not None else 0,
        int(max_metric_row[0]),
    )
    unresolved = conn.execute(
        """
        SELECT metrics.metric_id
        FROM operational_attempt_metrics AS metrics
        LEFT JOIN jobs AS current_job
          ON current_job.tenant_id = metrics.tenant_id
         AND current_job.url = metrics.job_url
        LEFT JOIN job_identity_aliases AS locators
          ON locators.tenant_id = metrics.tenant_id
         AND locators.alias_kind = 'posting_url'
         AND locators.alias_value = metrics.job_url
        WHERE metrics.job_url IS NOT NULL
          AND current_job.job_id IS NULL
          AND locators.job_id IS NULL
        LIMIT 1
        """
    ).fetchone()
    if unresolved is not None:
        raise RuntimeError("operational metrics contains an unresolved job locator")

    conn.execute("SAVEPOINT v6_operational_metrics")
    try:
        conn.execute('DROP TABLE IF EXISTS "operational_attempt_metrics_rebuilt"')
        conn.execute(
            """
            CREATE TABLE operational_attempt_metrics_rebuilt (
            metric_id               INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id               TEXT NOT NULL DEFAULT 'local',
            occurred_at             TEXT NOT NULL,
            stage                   TEXT NOT NULL,
            source_id               TEXT,
            source_kind             TEXT,
            source_priority         TEXT,
            source_role             TEXT,
            adapter                 TEXT,
            attempt_kind            TEXT NOT NULL,
            outcome                 TEXT NOT NULL,
            failure_category        TEXT,
            is_operational_failure  INTEGER NOT NULL DEFAULT 0,
            is_scrape_failure       INTEGER NOT NULL DEFAULT 0,
            is_retryable            INTEGER NOT NULL DEFAULT 1,
            run_id                  TEXT,
            job_id                  TEXT,
            duration_ms             INTEGER,
            total_count             INTEGER,
            new_count               INTEGER,
            existing_count          INTEGER,
            observed_count          INTEGER,
            duplicate_count         INTEGER,
            error_class             TEXT,
            error_message           TEXT,
            metadata_json           TEXT NOT NULL DEFAULT '{}',
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE RESTRICT
        )
            """
        )
        conn.execute(
            """
            INSERT INTO operational_attempt_metrics_rebuilt (
            metric_id, tenant_id, occurred_at, stage, source_id, source_kind,
            source_priority, source_role, adapter, attempt_kind, outcome,
            failure_category, is_operational_failure, is_scrape_failure,
            is_retryable, run_id, job_id, duration_ms, total_count, new_count,
            existing_count, observed_count, duplicate_count, error_class,
            error_message, metadata_json
        )
        SELECT
            metrics.metric_id, metrics.tenant_id, metrics.occurred_at,
            metrics.stage, metrics.source_id, metrics.source_kind,
            metrics.source_priority, metrics.source_role, metrics.adapter,
            metrics.attempt_kind, metrics.outcome, metrics.failure_category,
            metrics.is_operational_failure, metrics.is_scrape_failure,
            metrics.is_retryable, metrics.run_id,
            COALESCE(current_job.job_id, historical_job.job_id),
            metrics.duration_ms, metrics.total_count, metrics.new_count,
            metrics.existing_count, metrics.observed_count,
            metrics.duplicate_count, metrics.error_class,
            metrics.error_message, metrics.metadata_json
        FROM operational_attempt_metrics AS metrics
        LEFT JOIN jobs AS current_job
          ON current_job.tenant_id = metrics.tenant_id
         AND current_job.url = metrics.job_url
        LEFT JOIN job_identity_aliases AS locators
          ON locators.tenant_id = metrics.tenant_id
         AND locators.alias_kind = 'posting_url'
         AND locators.alias_value = metrics.job_url
        LEFT JOIN jobs AS historical_job
          ON historical_job.tenant_id = locators.tenant_id
         AND historical_job.job_id = locators.job_id
            """
        )
        conn.execute('DROP TABLE "operational_attempt_metrics"')
        conn.execute(
            'ALTER TABLE "operational_attempt_metrics_rebuilt" '
            'RENAME TO "operational_attempt_metrics"'
        )
        conn.execute(
            "CREATE INDEX idx_operational_attempt_metrics_stage_time "
            "ON operational_attempt_metrics"
            "(tenant_id, stage, occurred_at DESC, metric_id DESC)"
        )
        conn.execute(
            "CREATE INDEX idx_operational_attempt_metrics_source_time "
            "ON operational_attempt_metrics"
            "(tenant_id, source_id, occurred_at DESC, metric_id DESC)"
        )
        conn.execute(
            "DELETE FROM sqlite_sequence WHERE name = 'operational_attempt_metrics'"
        )
        if sequence_high_water:
            conn.execute(
                "INSERT INTO sqlite_sequence(name, seq) "
                "VALUES ('operational_attempt_metrics', ?)",
                (sequence_high_water,),
            )
        verify_v7_operational_attempt_metrics(
            conn,
            expected_count=expected_count,
            expected_sequence_high_water=sequence_high_water,
        )
        conn.execute("RELEASE SAVEPOINT v6_operational_metrics")
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT v6_operational_metrics")
        conn.execute("RELEASE SAVEPOINT v6_operational_metrics")
        raise
    return ["operational_attempt_metrics"]


def verify_v7_operational_attempt_metrics(
    conn: sqlite3.Connection,
    *,
    expected_count: int,
    expected_sequence_high_water: int,
) -> None:
    """Verify the exact metric identity transform and sequence continuity."""
    columns = table_columns(conn, "operational_attempt_metrics")
    if "job_id" not in columns or "job_url" in columns:
        raise RuntimeError("operational metrics migration did not create v7 identity")
    observed_count = int(
        conn.execute("SELECT COUNT(*) FROM operational_attempt_metrics").fetchone()[0]
    )
    if observed_count != expected_count:
        raise RuntimeError("operational metrics migration changed the row count")
    sequence_row = conn.execute(
        "SELECT seq FROM sqlite_sequence WHERE name = 'operational_attempt_metrics'"
    ).fetchone()
    observed_high_water = int(sequence_row[0]) if sequence_row is not None else 0
    if observed_high_water != expected_sequence_high_water:
        raise RuntimeError("operational metrics migration changed the ID high-water")
    if conn.execute("PRAGMA foreign_key_check").fetchone() is not None:
        raise RuntimeError("operational metrics migration found a foreign-key violation")


__all__ = [
    "migrate_v6_operational_attempt_metrics",
    "verify_v7_operational_attempt_metrics",
]
