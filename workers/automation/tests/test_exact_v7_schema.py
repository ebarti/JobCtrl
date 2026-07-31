"""Exact-v7 schema creation and runtime-open contracts."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from jobctrl.database import (
    SCHEMA_VERSION,
    SchemaMigrationRequiredError,
    close_connection,
    init_db,
)
from jobctrl.infrastructure.migrations import schema_v7
from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V7_MANIFEST,
    SchemaManifestError,
    assert_exact_manifest,
    schema_dump,
    schema_manifest,
)
from jobctrl.infrastructure.migrations.schema_v7 import (
    create_exact_v7_schema,
    create_unstamped_exact_v7_candidate,
)
from jobctrl.infrastructure import runtime_identity


_CROSS_RUNTIME_DURABLE_TABLES = {
    "discovery_execution_recoveries",
    "jobctrl_hidden_jobs",
    "role_match_feedback_suggestions",
    "resume_review_comment_replies",
    "resume_review_comment_threads",
    "resume_review_draft_revisions",
    "resume_review_drafts",
    "resume_review_edit_deltas",
    "tailoring_feedback_signals",
    "worker_runtime_heartbeats",
}


def _complete_database_dump(path: Path) -> tuple[object, ...]:
    conn = sqlite3.connect(path)
    try:
        tables = tuple(
            row[0]
            for row in conn.execute(
                """
                SELECT name FROM sqlite_master
                WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                ORDER BY name
                """
            )
        )
        rows = tuple(
            (
                table,
                tuple(
                    conn.execute(
                        f'SELECT * FROM "{table.replace(chr(34), chr(34) * 2)}"'
                    ).fetchall()
                ),
            )
            for table in tables
        )
        sequence_exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'"
        ).fetchone()
        sequence = (
            tuple(conn.execute("SELECT name, seq FROM sqlite_sequence ORDER BY name"))
            if sequence_exists is not None
            else ()
        )
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        return version, schema_dump(conn), rows, sequence
    finally:
        conn.close()


def _create_incomplete_v6_database(path: Path) -> None:
    conn = sqlite3.connect(path)
    try:
        conn.execute("CREATE TABLE jobs (url TEXT PRIMARY KEY)")
        conn.execute("PRAGMA user_version = 6")
        conn.commit()
    finally:
        conn.close()


def test_fresh_v7_creation_matches_the_exact_manifest(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"

    conn = init_db(db_path)

    assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
    assert_exact_manifest(conn, EXACT_V7_MANIFEST)
    assert conn.execute(
        "SELECT name FROM sqlite_master WHERE name = 'job_identity_aliases'"
    ).fetchone() is None
    tables = {
        str(row[0])
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        ).fetchall()
    }
    assert _CROSS_RUNTIME_DURABLE_TABLES <= tables
    profile_columns = {
        str(row[1])
        for row in conn.execute("PRAGMA table_info(candidate_profiles)").fetchall()
    }
    assert {
        "application_attestation_age_18_plus",
        "application_attestation_background_check_consent",
        "application_attestation_felony_conviction",
        "application_attestation_previously_worked_at_employer",
        "application_attestation_additional_json",
        "application_preference_how_heard",
    } <= profile_columns
    close_connection(db_path)


def test_unstamped_v7_candidate_matches_the_exact_manifest_without_version_stamp() -> None:
    conn = sqlite3.connect(":memory:")

    def deny_version_pragma(
        action: int,
        argument1: str | None,
        argument2: str | None,
        _database: str | None,
        _source: str | None,
    ) -> int:
        if (
            action == sqlite3.SQLITE_PRAGMA
            and argument1 == "user_version"
            and argument2 is not None
        ):
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK

    try:
        conn.set_authorizer(deny_version_pragma)
        create_unstamped_exact_v7_candidate(conn)
        conn.set_authorizer(None)

        assert_exact_manifest(conn, EXACT_V7_MANIFEST)
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 0
    finally:
        conn.set_authorizer(None)
        conn.close()


@pytest.mark.parametrize("version", (1, 6, SCHEMA_VERSION, 99))
def test_unstamped_v7_candidate_rejects_nonzero_version_without_mutation(
    version: int,
) -> None:
    conn = sqlite3.connect(":memory:")
    conn.execute(f"PRAGMA user_version = {version}")
    before = schema_dump(conn), conn.execute("PRAGMA user_version").fetchone()[0]

    try:
        with pytest.raises(
            SchemaManifestError,
            match="unstamped exact v7 candidate creation requires user_version 0",
        ):
            create_unstamped_exact_v7_candidate(conn)

        assert (
            schema_dump(conn),
            conn.execute("PRAGMA user_version").fetchone()[0],
        ) == before
    finally:
        conn.close()


def test_exact_v7_reopen_has_no_writes_or_schema_or_data_changes(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    before = _complete_database_dump(db_path)
    denied_actions = {
        sqlite3.SQLITE_INSERT,
        sqlite3.SQLITE_UPDATE,
        sqlite3.SQLITE_DELETE,
        sqlite3.SQLITE_CREATE_INDEX,
        sqlite3.SQLITE_CREATE_TABLE,
        sqlite3.SQLITE_CREATE_TEMP_INDEX,
        sqlite3.SQLITE_CREATE_TEMP_TABLE,
        sqlite3.SQLITE_CREATE_TEMP_TRIGGER,
        sqlite3.SQLITE_CREATE_TEMP_VIEW,
        sqlite3.SQLITE_CREATE_TRIGGER,
        sqlite3.SQLITE_CREATE_VIEW,
        sqlite3.SQLITE_DROP_INDEX,
        sqlite3.SQLITE_DROP_TABLE,
        sqlite3.SQLITE_DROP_TEMP_INDEX,
        sqlite3.SQLITE_DROP_TEMP_TABLE,
        sqlite3.SQLITE_DROP_TEMP_TRIGGER,
        sqlite3.SQLITE_DROP_TEMP_VIEW,
        sqlite3.SQLITE_DROP_TRIGGER,
        sqlite3.SQLITE_DROP_VIEW,
        sqlite3.SQLITE_ALTER_TABLE,
        sqlite3.SQLITE_REINDEX,
    }

    def deny_writes(
        action: int,
        argument1: str | None,
        _argument2: str | None,
        _database: str | None,
        _source: str | None,
    ) -> int:
        if action in denied_actions:
            return sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_PRAGMA and argument1 != "user_version":
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK

    conn.set_authorizer(deny_writes)
    assert init_db(db_path) is conn
    conn.set_authorizer(None)
    assert _complete_database_dump(db_path) == before
    close_connection(db_path)


def test_worker_heartbeat_does_not_drift_the_exact_v7_schema(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    before_schema = schema_dump(conn)
    close_connection(db_path)
    monkeypatch.setattr(runtime_identity.config, "APP_DIR", tmp_path)
    monkeypatch.setattr(runtime_identity.config, "DB_PATH", db_path)

    runtime_identity.write_worker_heartbeat(
        task_queue="jobctrl-default",
        worker_id="worker-test",
    )

    reopened = init_db(db_path)
    assert schema_dump(reopened) == before_schema
    assert_exact_manifest(reopened, EXACT_V7_MANIFEST)
    close_connection(db_path)


def test_manifest_preserves_semantic_quotes_inside_defaults() -> None:
    quoted = sqlite3.connect(":memory:")
    unquoted = sqlite3.connect(":memory:")
    try:
        quoted.execute(
            """CREATE TABLE example (value TEXT DEFAULT '"quoted"')"""
        )
        unquoted.execute(
            """CREATE TABLE example (value TEXT DEFAULT 'quoted')"""
        )

        assert schema_manifest(quoted, version=7) != schema_manifest(
            unquoted,
            version=7,
        )
    finally:
        quoted.close()
        unquoted.close()


def test_job_purge_cascades_private_resume_review_rows(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute(
        "INSERT INTO jobs (tenant_id, job_id, url) VALUES (?, ?, ?)",
        ("local", "11111111-1111-4111-8111-111111111111", "https://jobs.example/1"),
    )
    conn.execute(
        """
        INSERT INTO resume_review_drafts (
            tenant_id, draft_id, job_id, base_generation, renderer_format,
            state, latest_revision_number, created_at, updated_at
        ) VALUES (?, ?, ?, 1, 'html_pdf', 'active', 1, ?, ?)
        """,
        (
            "local",
            "draft-1",
            "11111111-1111-4111-8111-111111111111",
            "2026-07-30T00:00:00Z",
            "2026-07-30T00:00:00Z",
        ),
    )
    conn.execute(
        """
        INSERT INTO resume_review_draft_revisions (
            tenant_id, revision_id, draft_id, job_id, revision_number,
            edited_text, created_at
        ) VALUES (?, ?, ?, ?, 1, 'private revision', ?)
        """,
        (
            "local",
            "revision-1",
            "draft-1",
            "11111111-1111-4111-8111-111111111111",
            "2026-07-30T00:00:00Z",
        ),
    )
    conn.execute(
        """
        INSERT INTO resume_review_comment_threads (
            tenant_id, thread_id, draft_id, job_id, comment_body,
            lifecycle_state, anchor_resolved, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'private comment', 'open', 1, ?, ?)
        """,
        (
            "local",
            "thread-1",
            "draft-1",
            "11111111-1111-4111-8111-111111111111",
            "2026-07-30T00:00:00Z",
            "2026-07-30T00:00:00Z",
        ),
    )
    conn.execute(
        """
        INSERT INTO resume_review_comment_replies (
            tenant_id, reply_id, thread_id, draft_revision_id,
            decision, body, created_at
        ) VALUES (?, ?, ?, ?, 'comment', 'private reply', ?)
        """,
        (
            "local",
            "reply-1",
            "thread-1",
            "revision-1",
            "2026-07-30T00:00:00Z",
        ),
    )
    conn.commit()

    conn.execute(
        "DELETE FROM jobs WHERE tenant_id = ? AND job_id = ?",
        ("local", "11111111-1111-4111-8111-111111111111"),
    )
    conn.commit()

    for table in (
        "resume_review_comment_replies",
        "resume_review_comment_threads",
        "resume_review_draft_revisions",
        "resume_review_drafts",
    ):
        assert conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None
    close_connection(db_path)


def test_incomplete_v6_is_rejected_before_any_write(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    _create_incomplete_v6_database(db_path)
    before = _complete_database_dump(db_path)

    with pytest.raises(SchemaMigrationRequiredError, match="jobctrl migrate"):
        init_db(db_path)

    close_connection(db_path)
    assert _complete_database_dump(db_path) == before


def test_fresh_schema_fault_leaves_no_partial_stamped_v7_database(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = sqlite3.connect(db_path)
    before = _complete_database_dump(db_path)
    executed = 0

    def fail_after_partial_creation(statement: str) -> object:
        nonlocal executed
        executed += 1
        if executed == 2:
            raise RuntimeError("fixture creation failure")
        return conn.execute(statement)

    with pytest.raises(RuntimeError, match="fixture creation failure"):
        create_exact_v7_schema(conn, _execute=fail_after_partial_creation)

    conn.close()
    assert executed == 2
    assert _complete_database_dump(db_path) == before


def test_unstamped_candidate_fault_rolls_back_and_can_retry() -> None:
    conn = sqlite3.connect(":memory:")
    before = schema_dump(conn)
    executed = 0

    def fail_after_partial_creation(statement: str) -> object:
        nonlocal executed
        executed += 1
        if executed == 2:
            raise RuntimeError("fixture candidate creation failure")
        return conn.execute(statement)

    try:
        with pytest.raises(RuntimeError, match="fixture candidate creation failure"):
            create_unstamped_exact_v7_candidate(
                conn,
                _execute=fail_after_partial_creation,
            )

        assert executed == 2
        assert schema_dump(conn) == before
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 0

        create_unstamped_exact_v7_candidate(conn)

        assert_exact_manifest(conn, EXACT_V7_MANIFEST)
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 0
    finally:
        conn.close()


def test_failed_fresh_init_removes_its_file_and_can_retry(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    create_schema = schema_v7.create_exact_v7_schema

    def fail_after_partial_creation(conn: sqlite3.Connection) -> None:
        executed = 0

        def fail_second_statement(statement: str) -> object:
            nonlocal executed
            executed += 1
            if executed == 2:
                raise RuntimeError("fixture creation failure")
            return conn.execute(statement)

        create_schema(conn, _execute=fail_second_statement)

    monkeypatch.setattr(schema_v7, "create_exact_v7_schema", fail_after_partial_creation)
    with pytest.raises(RuntimeError, match="fixture creation failure"):
        init_db(db_path)

    assert not db_path.exists()
    assert not Path(f"{db_path}-wal").exists()
    assert not Path(f"{db_path}-shm").exists()

    monkeypatch.setattr(schema_v7, "create_exact_v7_schema", create_schema)
    conn = init_db(db_path)
    assert_exact_manifest(conn, EXACT_V7_MANIFEST)
    close_connection(db_path)
