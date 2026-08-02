"""Self-contained shipped-v6 fixture loader for migration tests."""

from __future__ import annotations

import sqlite3
from pathlib import Path


_V6_SCHEMA_SQL = (
    Path(__file__).with_name("fixtures") / "shipped_v6_schema.sql"
).read_text(encoding="utf-8")

_CANDIDATE_PROFILE_RUNTIME_ALTERS = (
    "ALTER TABLE candidate_profiles ADD COLUMN "
    "application_attestation_age_18_plus INTEGER DEFAULT NULL",
    "ALTER TABLE candidate_profiles ADD COLUMN "
    "application_attestation_background_check_consent INTEGER DEFAULT NULL",
    "ALTER TABLE candidate_profiles ADD COLUMN "
    "application_attestation_felony_conviction INTEGER DEFAULT NULL",
    "ALTER TABLE candidate_profiles ADD COLUMN "
    "application_attestation_previously_worked_at_employer INTEGER DEFAULT NULL",
    "ALTER TABLE candidate_profiles ADD COLUMN "
    "application_attestation_additional_json TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE candidate_profiles ADD COLUMN "
    "application_preference_how_heard TEXT NOT NULL DEFAULT ''",
)


def create_shipped_v6_database(path: Path) -> None:
    """Create the exact shipped-v6 schema with deterministic synthetic data."""
    conn = sqlite3.connect(path)
    try:
        conn.executescript(_V6_SCHEMA_SQL)
        conn.execute(
            "INSERT INTO jobs (url, title, discovered_at) VALUES (?, ?, ?)",
            (
                "https://jobs.example/shipped-v6",
                "Shipped V6 fixture",
                "2026-07-30T09:00:00+00:00",
            ),
        )
        conn.commit()
    finally:
        conn.close()


def create_runtime_attestation_v6_database(path: Path) -> None:
    """Create the exact v6 shape after the shipped profile ALTER sequence."""
    create_shipped_v6_database(path)
    _apply_candidate_profile_runtime_alters(path)


def _apply_candidate_profile_runtime_alters(path: Path) -> None:
    conn = sqlite3.connect(path)
    try:
        for statement in _CANDIDATE_PROFILE_RUNTIME_ALTERS:
            conn.execute(statement)
        conn.commit()
    finally:
        conn.close()


def create_supported_upgrade_history_v6_database(path: Path) -> None:
    """Create the exact raw schema left by a v1.3-to-v2.0.8 local upgrade."""
    create_shipped_v6_database(path)
    replacements = {
        "artifact_list_projections": (
            (
                "            metadata_json          TEXT,\n"
                "            layout_boxes_json      TEXT,\n"
                "            bullet_provenance_json TEXT,\n"
                "            coverage_audit_json    TEXT,\n"
                "            voice_pass_json        TEXT\n"
                "        )",
                "            metadata_json          TEXT,\n"
                "            bullet_provenance_json TEXT,\n"
                "            coverage_audit_json    TEXT,\n"
                "            voice_pass_json        TEXT\n"
                "        , layout_boxes_json TEXT)",
            ),
        ),
        "candidate_profiles": (
            (
                "            revision_min_fit_score            "
                "INTEGER NOT NULL DEFAULT 8,\n"
                "            revision_must_have_coverage       "
                "REAL NOT NULL DEFAULT 0.85,\n"
                "            revision_max_attempts             "
                "INTEGER NOT NULL DEFAULT 1,\n",
                "",
            ),
            (
                "            updated_at                        TEXT NOT NULL,\n"
                "            PRIMARY KEY",
                "            updated_at                        TEXT NOT NULL, "
                "revision_min_fit_score INTEGER NOT NULL DEFAULT 8, "
                "revision_must_have_coverage REAL NOT NULL DEFAULT 0.85, "
                "revision_max_attempts INTEGER NOT NULL DEFAULT 1,\n"
                "            PRIMARY KEY",
            ),
        ),
        "dashboard_projections": (
            (
                "            outcome_conversion_json TEXT NOT NULL DEFAULT '{}',\n"
                "            generated_at           TEXT NOT NULL DEFAULT ''\n"
                "        )",
                "            generated_at           TEXT NOT NULL DEFAULT ''\n"
                "        , outcome_conversion_json TEXT NOT NULL DEFAULT '{}')",
            ),
        ),
        "job_detail_projections": (
            (
                "            score_criteria_json    TEXT,\n"
                "            score_trace_json       TEXT,\n"
                "            score_correction_json  TEXT,\n",
                "",
            ),
            (
                "            interview_prep_json    TEXT,\n"
                "            last_updated_at        TEXT,\n"
                "            PRIMARY KEY",
                "            last_updated_at        TEXT, score_criteria_json TEXT, "
                "score_trace_json TEXT, score_correction_json TEXT, "
                "interview_prep_json TEXT,\n"
                "            PRIMARY KEY",
            ),
        ),
        "job_events": (
            (
                "            payload_json        TEXT,\n"
                "            entity_kind         TEXT,\n"
                "            entity_ref          TEXT,\n"
                "            idempotency_key     TEXT,",
                "            payload_json        TEXT, entity_kind TEXT, "
                "entity_ref TEXT, idempotency_key TEXT,",
            ),
        ),
        "job_list_projections": (
            (
                "            fit_score              INTEGER,\n"
                "            fit_band               TEXT,",
                "            fit_score              INTEGER,",
            ),
            (
                "            score_criteria_json    TEXT,\n"
                "            score_trace_json       TEXT,\n"
                "            score_correction_json  TEXT,\n",
                "",
            ),
            (
                "            apply_mode             TEXT,\n"
                "            resume_template_id     TEXT,\n"
                "            resume_template_name   TEXT,\n"
                "            tailoring_policy_version INTEGER,\n",
                "",
            ),
            (
                "            last_updated_at        TEXT,\n"
                "            PRIMARY KEY",
                "            last_updated_at        TEXT, score_criteria_json TEXT, "
                "score_trace_json TEXT, score_correction_json TEXT, fit_band TEXT, "
                "apply_mode TEXT, resume_template_id TEXT, "
                "resume_template_name TEXT, tailoring_policy_version INTEGER,\n"
                "            PRIMARY KEY",
            ),
        ),
        "posting_snapshot_sets": (
            (
                "            latest_active_state      "
                "TEXT NOT NULL DEFAULT 'unknown',\n"
                "            latest_confidence        TEXT,\n"
                "            latest_quarantine_reason TEXT,\n"
                "            updated_at               TEXT NOT NULL,",
                "            latest_active_state      "
                "TEXT NOT NULL DEFAULT 'unknown',\n"
                "            updated_at               TEXT NOT NULL, "
                "latest_confidence TEXT, latest_quarantine_reason TEXT,",
            ),
        ),
    }
    conn = sqlite3.connect(path)
    try:
        conn.execute("PRAGMA writable_schema = ON")
        for table_name, table_replacements in replacements.items():
            raw_sql = str(
                conn.execute(
                    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
                    (table_name,),
                ).fetchone()[0]
            )
            for old, new in table_replacements:
                if old not in raw_sql:
                    raise AssertionError(
                        f"frozen v6 fixture drifted at {table_name}"
                    )
                raw_sql = raw_sql.replace(old, new)
            conn.execute(
                "UPDATE sqlite_master SET sql = ? "
                "WHERE type = 'table' AND name = ?",
                (raw_sql, table_name),
            )
        conn.execute("PRAGMA writable_schema = OFF")
        conn.execute(
            """CREATE TABLE discovery_run_projections (
            run_id                 TEXT PRIMARY KEY,
            tenant_id              TEXT NOT NULL DEFAULT 'local',
            source_ids_json        TEXT NOT NULL DEFAULT '[]',
            profile_snapshot_id    TEXT,
            status                 TEXT NOT NULL DEFAULT 'running',
            counts_json            TEXT NOT NULL DEFAULT '{}',
            error_classes_json     TEXT NOT NULL DEFAULT '[]',
            started_at             TEXT,
            completed_at           TEXT,
            failed_at              TEXT,
            failed_source_id       TEXT,
            retryable              INTEGER NOT NULL DEFAULT 1
        )"""
        )
        conn.execute("PRAGMA schema_version = 1000")
        conn.commit()
    finally:
        conn.close()


def create_runtime_attestation_upgrade_history_v6_database(path: Path) -> None:
    """Create the named upgrade-history shape after the same runtime alters."""
    create_supported_upgrade_history_v6_database(path)
    _apply_candidate_profile_runtime_alters(path)
