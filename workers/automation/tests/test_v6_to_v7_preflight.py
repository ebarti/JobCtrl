"""Focused admission tests for the exact shipped-v6 migration boundary."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from jobctrl.infrastructure.gmail.feedback import (
    ensure_application_feedback_tables,
)
from jobctrl.infrastructure.migrations.v6_to_v7_preflight import (
    V6MigrationPreflightError,
    _V6_AUXILIARY_DDL,
    _V6_AUXILIARY_TABLE_VARIANTS,
    assert_v6_migration_preflight,
)
from tests.v6_migration_fixture import (
    create_runtime_attestation_v6_database,
    create_runtime_attestation_upgrade_history_v6_database,
    create_shipped_v6_database,
    create_supported_upgrade_history_v6_database,
)

# Exact SQLite inventory produced by v2.0.8's TypeScript
# `ensureApplicationFeedbackTables` owner. SQLite omits `IF NOT EXISTS` from
# sqlite_master.sql, so the source fixture intentionally uses the persisted
# DDL rather than the TypeScript input statements.
_V2_0_8_APPLICATION_OUTCOMES_DDL = """CREATE TABLE application_outcomes (
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
    CREATE INDEX idx_application_outcomes_job
      ON application_outcomes(tenant_id, job_key, occurred_at DESC, recorded_at DESC);"""

_V2_0_8_APPLICATION_EMAIL_EVIDENCE_DDL = """CREATE TABLE application_email_evidence (
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
    CREATE INDEX idx_application_email_evidence_job
      ON application_email_evidence(tenant_id, job_key, received_at DESC);"""

_V2_0_8_APPLICATION_OUTCOME_SUGGESTIONS_DDL = """CREATE TABLE application_outcome_suggestions (
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
    CREATE INDEX idx_application_outcome_suggestions_job
      ON application_outcome_suggestions(tenant_id, job_key, status, created_at DESC);
    CREATE INDEX idx_application_outcome_suggestions_status
      ON application_outcome_suggestions(tenant_id, status, created_at DESC);"""


def _install_v2_0_8_application_feedback(
    conn: sqlite3.Connection,
    *,
    with_interview_prep_generation: bool = False,
) -> None:
    conn.executescript(
        "\n".join(
            (
                _V2_0_8_APPLICATION_OUTCOMES_DDL,
                _V2_0_8_APPLICATION_EMAIL_EVIDENCE_DDL,
                _V2_0_8_APPLICATION_OUTCOME_SUGGESTIONS_DDL,
            )
        )
    )
    if with_interview_prep_generation:
        # This is the exact v2.0.8 TypeScript column guard sequence.
        conn.execute(
            "ALTER TABLE application_outcomes ADD COLUMN interview_prep_generation INTEGER"
        )


def test_self_contained_shipped_v6_fixture_passes_preflight(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    create_shipped_v6_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        assert_v6_migration_preflight(conn)
    finally:
        conn.close()


def test_supported_v1_3_to_v2_0_8_upgrade_history_passes_preflight(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "upgraded-v6.db"
    create_supported_upgrade_history_v6_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        assert_v6_migration_preflight(conn)
    finally:
        conn.close()


def test_preflight_admits_only_the_exact_runtime_candidate_profile_alter_sequence(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "runtime-attestations-v6.db"
    create_runtime_attestation_v6_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        assert_v6_migration_preflight(conn)
    finally:
        conn.close()

    history_path = tmp_path / "runtime-attestations-history-v6.db"
    create_runtime_attestation_upgrade_history_v6_database(history_path)
    conn = sqlite3.connect(history_path)
    try:
        assert_v6_migration_preflight(conn)
    finally:
        conn.close()

    drift_path = tmp_path / "partial-runtime-attestations-v6.db"
    create_shipped_v6_database(drift_path)
    conn = sqlite3.connect(drift_path)
    try:
        conn.execute(
            "ALTER TABLE candidate_profiles ADD COLUMN "
            "application_attestation_age_18_plus INTEGER DEFAULT NULL"
        )
        with pytest.raises(V6MigrationPreflightError, match="shipped v6"):
            assert_v6_migration_preflight(conn)
    finally:
        conn.close()


def test_preflight_admits_only_exact_named_optional_v6_tables(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    create_shipped_v6_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        for ddl in _V6_AUXILIARY_DDL:
            conn.execute(ddl)
        assert_v6_migration_preflight(conn)

        for table_name, variants in _V6_AUXILIARY_TABLE_VARIANTS.items():
            conn.execute(f'DROP TABLE "{table_name}"')
            for variant in variants:
                conn.executescript(variant)
                assert_v6_migration_preflight(conn)
                conn.execute(f'DROP TABLE "{table_name}"')
            conn.executescript(variants[-1])

        assert_v6_migration_preflight(conn)
    finally:
        conn.close()


def test_preflight_admits_v2_0_8_outcomes_without_interview_prep_generation(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "v2.0.8-outcomes-without-prep.db"
    create_shipped_v6_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(_V2_0_8_APPLICATION_OUTCOMES_DDL)

        assert_v6_migration_preflight(conn)
    finally:
        conn.close()


def test_preflight_admits_v2_0_8_outcomes_with_interview_prep_generation(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "v2.0.8-outcomes-with-prep.db"
    create_shipped_v6_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(_V2_0_8_APPLICATION_OUTCOMES_DDL)
        conn.execute("ALTER TABLE application_outcomes ADD COLUMN interview_prep_generation INTEGER")

        assert_v6_migration_preflight(conn)
    finally:
        conn.close()


def test_preflight_admits_v2_0_8_email_evidence_and_outcome_suggestions(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "v2.0.8-feedback-evidence-and-suggestions.db"
    create_shipped_v6_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(_V2_0_8_APPLICATION_EMAIL_EVIDENCE_DDL)
        conn.executescript(_V2_0_8_APPLICATION_OUTCOME_SUGGESTIONS_DDL)

        assert_v6_migration_preflight(conn)
    finally:
        conn.close()


@pytest.mark.parametrize(
    ("ddl", "description"),
    (
        (
            _V2_0_8_APPLICATION_EMAIL_EVIDENCE_DDL.replace(
                "DEFAULT 'gmail'",
                "DEFAULT 'outlook'",
                1,
            ),
            "email-evidence table default",
        ),
        (
            _V2_0_8_APPLICATION_OUTCOME_SUGGESTIONS_DDL.replace(
                "status, created_at DESC);",
                "status, created_at ASC);",
                1,
            ),
            "outcome-suggestion index ordering",
        ),
    ),
)
def test_preflight_rejects_v2_0_8_feedback_schema_drift(
    tmp_path: Path,
    ddl: str,
    description: str,
) -> None:
    db_path = tmp_path / f"v2.0.8-feedback-{description}.db"
    create_shipped_v6_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(ddl)

        with pytest.raises(V6MigrationPreflightError, match="durable-table variant"):
            assert_v6_migration_preflight(conn)
    finally:
        conn.close()


def test_preflight_does_not_write_a_supported_v2_0_8_feedback_database(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "v2.0.8-feedback-no-writes.db"
    create_shipped_v6_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        _install_v2_0_8_application_feedback(
            conn,
            with_interview_prep_generation=True,
        )
        conn.commit()
    finally:
        conn.close()

    before = db_path.read_bytes()
    conn = sqlite3.connect(db_path)
    try:
        assert_v6_migration_preflight(conn)
    finally:
        conn.close()

    assert db_path.read_bytes() == before


@pytest.mark.parametrize("with_interview_prep_generation", [False, True])
def test_preflight_admits_the_python_gmail_feedback_owner_without_writes(
    tmp_path: Path,
    with_interview_prep_generation: bool,
) -> None:
    db_path = tmp_path / (
        "python-feedback-with-prep.db"
        if with_interview_prep_generation
        else "python-feedback-without-prep.db"
    )
    create_shipped_v6_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        ensure_application_feedback_tables(conn)
        if with_interview_prep_generation:
            conn.execute(
                "ALTER TABLE application_outcomes "
                "ADD COLUMN interview_prep_generation INTEGER"
            )
        conn.commit()
    finally:
        conn.close()

    before = db_path.read_bytes()
    conn = sqlite3.connect(db_path)
    try:
        before_changes = conn.total_changes
        assert_v6_migration_preflight(conn)
        assert conn.total_changes == before_changes
    finally:
        conn.close()

    assert db_path.read_bytes() == before


def test_preflight_rejects_unknown_object_with_allowlisted_index_name(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "trigger-collision.db"
    create_shipped_v6_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            CREATE TRIGGER idx_resume_review_drafts_job
            AFTER INSERT ON jobs
            BEGIN
                UPDATE jobs SET title = 'unexpected' WHERE rowid = NEW.rowid;
            END
            """
        )
        with pytest.raises(V6MigrationPreflightError, match="shipped v6"):
            assert_v6_migration_preflight(conn)
    finally:
        conn.close()


def test_preflight_rejects_unshipped_auxiliary_default_drift(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "auxiliary-drift.db"
    create_shipped_v6_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        heartbeat_ddl = next(
            ddl for ddl in _V6_AUXILIARY_DDL if "worker_runtime_heartbeats" in ddl
        )
        conn.execute(heartbeat_ddl.replace("DEFAULT 2", "DEFAULT 3"))

        with pytest.raises(V6MigrationPreflightError, match="durable-table variant"):
            assert_v6_migration_preflight(conn)
    finally:
        conn.close()


def test_preflight_rejects_a_hidden_sqlite_namespace_trigger(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "sqlite-trigger.db"
    create_shipped_v6_database(db_path)
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("PRAGMA writable_schema = ON")
        conn.execute(
            """
            INSERT INTO sqlite_master (type, name, tbl_name, rootpage, sql)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                "trigger",
                "sqlite_hidden_trigger",
                "jobs",
                0,
                "CREATE TRIGGER sqlite_hidden_trigger AFTER INSERT ON jobs "
                "BEGIN UPDATE jobs SET title='tampered' WHERE rowid=NEW.rowid; END",
            ),
        )
        conn.execute("PRAGMA writable_schema = OFF")
        conn.execute("PRAGMA schema_version = 1001")
        conn.commit()
    finally:
        conn.close()

    reopened = sqlite3.connect(db_path)
    try:
        with pytest.raises(V6MigrationPreflightError, match="shipped v6"):
            assert_v6_migration_preflight(reopened)
    finally:
        reopened.close()
