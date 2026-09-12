"""Frozen pre-v7 Gmail table owner for historical migration fixtures only."""
from __future__ import annotations

import sqlite3


def ensure_application_feedback_tables(conn: sqlite3.Connection) -> None:
    """Create the feedback tables with the TypeScript API's table shape."""

    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS application_review_decisions (
          tenant_id    TEXT NOT NULL DEFAULT 'local',
          decision_id  TEXT NOT NULL,
          job_key      TEXT NOT NULL,
          decision     TEXT NOT NULL,
          reason       TEXT,
          decided_by   TEXT NOT NULL DEFAULT 'user',
          decided_at   TEXT NOT NULL,
          materials_generation INTEGER,
          profile_version INTEGER,
          application_url TEXT,
          partial_override_run_id TEXT,
          email_recipient TEXT,
          email_attachment_artifact_id TEXT,
          PRIMARY KEY (tenant_id, decision_id)
        );
        CREATE INDEX IF NOT EXISTS idx_application_review_decisions_job
          ON application_review_decisions(tenant_id, job_key, decided_at DESC);

        CREATE TABLE IF NOT EXISTS application_outcomes (
          tenant_id     TEXT NOT NULL DEFAULT 'local',
          outcome_id    TEXT NOT NULL,
          job_key       TEXT NOT NULL,
          kind          TEXT NOT NULL,
          source        TEXT NOT NULL,
          note          TEXT,
          occurred_at   TEXT NOT NULL,
          recorded_at   TEXT NOT NULL,
          suggestion_id TEXT,
          evidence_id   TEXT,
          created_by    TEXT NOT NULL DEFAULT 'user',
          PRIMARY KEY (tenant_id, outcome_id)
        );
        CREATE INDEX IF NOT EXISTS idx_application_outcomes_job
          ON application_outcomes(tenant_id, job_key, occurred_at DESC, recorded_at DESC);

        CREATE TABLE IF NOT EXISTS application_email_evidence (
          tenant_id            TEXT NOT NULL DEFAULT 'local',
          evidence_id          TEXT NOT NULL,
          job_key              TEXT NOT NULL,
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
        );
        CREATE INDEX IF NOT EXISTS idx_application_email_evidence_job
          ON application_email_evidence(tenant_id, job_key, received_at DESC);

        CREATE TABLE IF NOT EXISTS application_outcome_suggestions (
          tenant_id          TEXT NOT NULL DEFAULT 'local',
          suggestion_id      TEXT NOT NULL,
          job_key            TEXT NOT NULL,
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
        );
        CREATE INDEX IF NOT EXISTS idx_application_outcome_suggestions_job
          ON application_outcome_suggestions(tenant_id, job_key, status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_application_outcome_suggestions_status
          ON application_outcome_suggestions(tenant_id, status, created_at DESC);
        """
    )
    _ensure_columns(
        conn,
        "application_review_decisions",
        {
            "materials_generation": "INTEGER",
            "profile_version": "INTEGER",
            "application_url": "TEXT",
            "partial_override_run_id": "TEXT",
            "email_recipient": "TEXT",
            "email_attachment_artifact_id": "TEXT",
        },
    )



def _columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    return {
        row["name"] if isinstance(row, sqlite3.Row) else row[1]
        for row in conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    }


def _ensure_columns(
    conn: sqlite3.Connection,
    table_name: str,
    additions: dict[str, str],
) -> None:
    columns = _columns(conn, table_name)
    for column, definition in additions.items():
        if column not in columns:
            conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {column} {definition}")
