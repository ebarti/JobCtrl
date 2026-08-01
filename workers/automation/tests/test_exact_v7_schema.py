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
    "tailoring_feedback_signal_reviews",
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


def test_job_score_keywords_exact_schema_contract(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    conn.execute("PRAGMA foreign_keys = ON")
    job_id = "11111111-1111-4111-8111-111111111111"
    conn.execute(
        "INSERT INTO jobs (tenant_id, job_id, url) VALUES (?, ?, ?)",
        ("local", job_id, "https://jobs.example/1"),
    )
    conn.execute(
        """
        INSERT INTO job_scores (
            tenant_id, job_id, version, fit_score, breakdown_json,
            keywords_json, scored_at
        ) VALUES (?, ?, 1, 8, '{}', '[]', ?)
        """,
        ("local", job_id, "2026-08-01T00:00:00Z"),
    )
    conn.execute(
        """
        INSERT INTO job_score_keywords (
            tenant_id, job_id, score_version, normalized_keyword,
            display_keyword, position
        ) VALUES (?, ?, 1, 'python', 'Python', 0)
        """,
        ("local", job_id),
    )
    conn.commit()

    columns = conn.execute("PRAGMA table_info(job_score_keywords)").fetchall()
    assert tuple(str(column[1]) for column in columns) == (
        "tenant_id",
        "job_id",
        "score_version",
        "normalized_keyword",
        "display_keyword",
        "position",
    )
    assert tuple(
        str(column[1]) for column in columns if int(column[5])
    ) == ("tenant_id", "job_id", "score_version", "normalized_keyword")

    foreign_keys = conn.execute(
        "PRAGMA foreign_key_list(job_score_keywords)"
    ).fetchall()
    score_foreign_keys = [foreign_key for foreign_key in foreign_keys if foreign_key[2] == "job_scores"]
    assert {(foreign_key[3], foreign_key[4]) for foreign_key in score_foreign_keys} == {
        ("tenant_id", "tenant_id"),
        ("job_id", "job_id"),
        ("score_version", "version"),
    }
    assert {foreign_key[6] for foreign_key in score_foreign_keys} == {"CASCADE"}

    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            """
            INSERT INTO job_score_keywords (
                tenant_id, job_id, score_version, normalized_keyword,
                display_keyword, position
            ) VALUES (?, ?, 1, 'python', 'PYTHON', 1)
            """,
            ("local", job_id),
        )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            """
            INSERT INTO job_score_keywords (
                tenant_id, job_id, score_version, normalized_keyword,
                display_keyword, position
            ) VALUES (?, ?, 1, 'python', 'Python', 0)
            """,
            ("other-tenant", job_id),
        )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            """
            INSERT INTO job_score_keywords (
                tenant_id, job_id, score_version, normalized_keyword,
                display_keyword, position
            ) VALUES (?, ?, 1, '   ', 'SQL', 1)
            """,
            ("local", job_id),
        )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            """
            INSERT INTO job_score_keywords (
                tenant_id, job_id, score_version, normalized_keyword,
                display_keyword, position
            ) VALUES (?, ?, 1, 'sql', '', 1)
            """,
            ("local", job_id),
        )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            """
            INSERT INTO job_score_keywords (
                tenant_id, job_id, score_version, normalized_keyword,
                display_keyword, position
            ) VALUES (?, ?, 1, 'sql', 'SQL', 0)
            """,
            ("local", job_id),
        )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            """
            INSERT INTO job_score_keywords (
                tenant_id, job_id, score_version, normalized_keyword,
                display_keyword, position
            ) VALUES (?, ?, 1, 'sql', 'SQL', -1)
            """,
            ("local", job_id),
        )

    indexes = {
        str(index[1]): index
        for index in conn.execute("PRAGMA index_list(job_score_keywords)")
    }
    assert indexes["idx_job_score_keywords_tenant_normalized"][2] == 0
    assert tuple(
        str(column[2])
        for column in conn.execute(
            "PRAGMA index_info(idx_job_score_keywords_tenant_normalized)"
        )
    ) == ("tenant_id", "normalized_keyword", "job_id", "score_version")

    conn.execute(
        "DELETE FROM job_scores WHERE tenant_id = ? AND job_id = ? AND version = 1",
        ("local", job_id),
    )
    assert conn.execute("SELECT COUNT(*) FROM job_score_keywords").fetchone()[0] == 0
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None
    close_connection(db_path)


def test_tailoring_feedback_reviews_are_structured_append_only_facts(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    conn.execute("PRAGMA foreign_keys = ON")
    job_id = "11111111-1111-4111-8111-111111111112"
    conn.execute(
        "INSERT INTO jobs (tenant_id, job_id, url) VALUES (?, ?, ?)",
        ("local", job_id, "https://jobs.example/feedback-review"),
    )
    conn.execute(
        """
        INSERT INTO resume_review_drafts (
            tenant_id, draft_id, job_id, base_generation, created_at, updated_at
        ) VALUES ('local', 'draft-1', ?, 1, ?, ?)
        """,
        (job_id, "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z"),
    )
    conn.execute(
        """
        INSERT INTO tailoring_feedback_signals (
            tenant_id, signal_id, job_id, draft_id, source_kind, source_id,
            signal_kind, status, summary, created_at
        ) VALUES (
            'local', 'signal-1', ?, 'draft-1', 'edit_delta', 'delta-1',
            'factual_correction', 'candidate', 'private source text', ?
        )
        """,
        (job_id, "2026-08-01T00:01:00Z"),
    )
    conn.execute(
        """
        INSERT INTO tailoring_feedback_signal_reviews (
            tenant_id, review_id, signal_id, revision, decision, signal_kind,
            rule_key, rule_value, allowlist_version, reviewed_at
        ) VALUES (
            'local', 'review-1', 'signal-1', 1, 'accepted',
            'factual_correction', 'fact_handling', 'require_source_match', 1, ?
        )
        """,
        ("2026-08-01T00:02:00Z",),
    )

    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            """
            INSERT INTO tailoring_feedback_signal_reviews (
                tenant_id, review_id, signal_id, revision, decision, signal_kind,
                rule_key, rule_value, allowlist_version, reviewed_at
            ) VALUES (
                'local', 'review-duplicate', 'signal-1', 1, 'rejected',
                'factual_correction', NULL, NULL, 1, ?
            )
            """,
            ("2026-08-01T00:03:00Z",),
        )
    with pytest.raises(sqlite3.IntegrityError, match="source mismatch"):
        conn.execute(
            """
            INSERT INTO tailoring_feedback_signal_reviews (
                tenant_id, review_id, signal_id, revision, decision, signal_kind,
                rule_key, rule_value, allowlist_version, reviewed_at
            ) VALUES (
                'local', 'review-kind-mismatch', 'signal-1', 2, 'accepted',
                'style_preference', 'resume_style', 'concise', 1, ?
            )
            """,
            ("2026-08-01T00:03:00Z",),
        )
    for rule_key, rule_value in (
        (None, None),
        ("free text", "require_source_match"),
        ("fact_handling", "free text"),
    ):
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """
                INSERT INTO tailoring_feedback_signal_reviews (
                    tenant_id, review_id, signal_id, revision, decision,
                    signal_kind, rule_key, rule_value, allowlist_version,
                    reviewed_at
                ) VALUES (
                    'local', ?, 'signal-1', ?, 'accepted',
                    'factual_correction', ?, ?, 1, ?
                )
                """,
                (
                    f"review-invalid-{rule_key}-{rule_value}",
                    10 + len(str(rule_key)),
                    rule_key,
                    rule_value,
                    "2026-08-01T00:04:00Z",
                ),
            )

    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        conn.execute(
            """
            UPDATE tailoring_feedback_signal_reviews
            SET rule_value = 'silently_changed'
            WHERE tenant_id = 'local' AND review_id = 'review-1'
            """
        )
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        conn.execute(
            """
            DELETE FROM tailoring_feedback_signal_reviews
            WHERE tenant_id = 'local' AND review_id = 'review-1'
            """
        )

    conn.execute(
        "DELETE FROM tailoring_feedback_signals WHERE tenant_id = 'local' AND signal_id = 'signal-1'"
    )
    assert [
        tuple(row)
        for row in conn.execute(
            "SELECT decision, rule_key, rule_value FROM tailoring_feedback_signal_reviews"
        ).fetchall()
    ] == [("accepted", "fact_handling", "require_source_match")]
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None

    indexes = {
        str(index[1])
        for index in conn.execute("PRAGMA index_list(tailoring_feedback_signal_reviews)")
    }
    assert {
        "idx_tailoring_feedback_signal_reviews_signal",
        "idx_tailoring_feedback_signal_reviews_decision",
    } <= indexes
    close_connection(db_path)


def test_incomplete_v6_is_rejected_before_any_write(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    _create_incomplete_v6_database(db_path)
    before = _complete_database_dump(db_path)

    with pytest.raises(SchemaMigrationRequiredError, match="jobctrl update"):
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
