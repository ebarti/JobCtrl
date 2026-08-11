"""Exact-v7 construction and current runtime-open contracts."""

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
from jobctrl.infrastructure.migrations import schema_v8
from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V7_MANIFEST,
    EXACT_V8_MANIFEST,
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
    "learning_recommendation_reviews",
    "learning_recommendation_evidence",
    "learning_recommendation_evidence_jobs",
    "learning_recommendation_jobs",
    "learning_recommendation_tombstones",
    "learning_recommendations",
    "role_match_feedback_suggestions",
    "resume_review_comment_replies",
    "resume_review_comment_threads",
    "resume_review_draft_revisions",
    "resume_review_drafts",
    "resume_review_edit_deltas",
    "tailoring_feedback_signals",
    "tailoring_feedback_signal_contradictions",
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


def test_fresh_runtime_creation_matches_the_exact_v8_manifest(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"

    conn = init_db(db_path)

    assert conn.execute("PRAGMA user_version").fetchone()[0] == EXACT_V8_MANIFEST.version
    assert_exact_manifest(conn, EXACT_V8_MANIFEST)
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
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


def test_exact_v8_reopen_has_no_writes_or_schema_or_data_changes(tmp_path: Path) -> None:
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


def test_worker_heartbeat_does_not_drift_the_exact_v8_schema(
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
    assert_exact_manifest(reopened, EXACT_V8_MANIFEST)
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
    conn.execute(
        """
        INSERT INTO tailoring_feedback_signals (
            tenant_id, signal_id, job_id, draft_id, source_kind, source_id,
            signal_kind, status, summary, created_at
        ) VALUES (
            'local', 'signal-2', ?, 'draft-1', 'comment_reply', 'reply-2',
            'factual_correction', 'candidate', 'private contradiction text', ?
        )
        """,
        (job_id, "2026-08-01T00:01:30Z"),
    )
    conn.execute(
        """
        INSERT INTO tailoring_feedback_signal_reviews (
            tenant_id, review_id, signal_id, revision, decision, signal_kind,
            rule_key, rule_value, allowlist_version, reviewed_at
        ) VALUES (
            'local', 'review-2', 'signal-2', 1, 'accepted',
            'factual_correction', 'fact_handling', 'require_source_match', 1, ?
        )
        """,
        ("2026-08-01T00:02:30Z",),
    )
    conn.execute(
        """
        INSERT INTO tailoring_feedback_signal_contradictions (
            tenant_id, contradiction_id, signal_id, signal_revision,
            signal_job_id, contradicting_signal_id,
            contradicting_signal_revision, contradicting_signal_job_id,
            recorded_at
        ) VALUES (
            'local', 'contradiction-1', 'signal-1', 1, ?,
            'signal-2', 1, ?, '2026-08-01T00:03:00Z'
        )
        """,
        (job_id, job_id),
    )

    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            """
            INSERT INTO tailoring_feedback_signal_contradictions (
                tenant_id, contradiction_id, signal_id, signal_revision,
                signal_job_id, contradicting_signal_id,
                contradicting_signal_revision, contradicting_signal_job_id,
                recorded_at
            ) VALUES (
                'local', 'contradiction-reversed', 'signal-2', 1, ?,
                'signal-1', 1, ?, '2026-08-01T00:03:00Z'
            )
            """,
            (job_id, job_id),
        )
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        conn.execute(
            """
            UPDATE tailoring_feedback_signal_contradictions
            SET recorded_at = '2026-08-01T00:04:00Z'
            WHERE contradiction_id = 'contradiction-1'
            """
        )
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        conn.execute(
            """
            DELETE FROM tailoring_feedback_signal_contradictions
            WHERE contradiction_id = 'contradiction-1'
            """
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
            """
            SELECT decision, rule_key, rule_value
            FROM tailoring_feedback_signal_reviews
            ORDER BY review_id
            """
        ).fetchall()
    ] == [
        ("accepted", "fact_handling", "require_source_match"),
        ("accepted", "fact_handling", "require_source_match"),
    ]
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None

    indexes = {
        str(index[1])
        for index in conn.execute("PRAGMA index_list(tailoring_feedback_signal_reviews)")
    }
    assert {
        "idx_tailoring_feedback_signal_reviews_signal",
        "idx_tailoring_feedback_signal_reviews_decision",
    } <= indexes
    contradiction_indexes = {
        str(index[1])
        for index in conn.execute(
            "PRAGMA index_list(tailoring_feedback_signal_contradictions)"
        )
    }
    assert {
        "idx_tailoring_feedback_signal_contradictions_signal",
        "idx_tailoring_feedback_signal_contradictions_other",
    } <= contradiction_indexes
    close_connection(db_path)


def _insert_learning_recommendation_fixture(
    conn: sqlite3.Connection,
    recommendation_id: str,
    fingerprint_character: str,
) -> None:
    job_ids = (
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
    )
    for index in range(1, 4):
        signal_id = f"{recommendation_id}-signal-{index}"
        conn.execute(
            """
            INSERT INTO learning_recommendation_evidence (
                tenant_id, recommendation_id, signal_id, evidence_role,
                source_kind, source_id, source_revision, recorded_at
            ) VALUES (
                'local', ?, ?, 'supporting',
                'tailoring_feedback_signal', ?, ?, ?
            )
            """,
            (
                recommendation_id,
                signal_id,
                f"source-{signal_id}",
                index,
                f"2026-08-01T00:00:0{index}Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO learning_recommendation_evidence_jobs (
                tenant_id, recommendation_id, signal_id, job_id
            ) VALUES ('local', ?, ?, ?)
            """,
            (recommendation_id, signal_id, job_ids[min(index - 1, 1)]),
        )
    for job_id in job_ids:
        conn.execute(
            """
            INSERT INTO learning_recommendation_jobs (
                tenant_id, recommendation_id, job_id
            ) VALUES ('local', ?, ?)
            """,
            (recommendation_id, job_id),
        )
    conn.execute(
        """
        INSERT INTO learning_recommendations (
            tenant_id, recommendation_id, derivation_version,
            evaluation_fixture_version, context, policy_kind, signal_kind,
            rule_key, rule_value, allowlist_version, status,
            observed_signal_count, observed_job_count, minimum_signal_count,
            minimum_job_count, confidence_limit, input_fingerprint, derived_at
        ) VALUES (
            'local', ?, 1, 1, 'materials', 'tailoring_rule',
            'factual_correction', 'fact_handling', 'require_source_match',
            1, 'pending', 3, 2, 3, 2,
            'sample_gated_no_population_inference', ?, '2026-08-01T01:00:00Z'
        )
        """,
        (recommendation_id, fingerprint_character * 64),
    )


def test_learning_recommendation_storage_is_structured_append_only_and_private(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    conn.execute("PRAGMA foreign_keys = ON")
    insert_recommendation = """
        INSERT INTO learning_recommendations (
            tenant_id, recommendation_id, derivation_version,
            evaluation_fixture_version, context, policy_kind, signal_kind,
            rule_key, rule_value, allowlist_version, status,
            observed_signal_count, observed_job_count, minimum_signal_count,
            minimum_job_count, confidence_limit, input_fingerprint, derived_at
        ) VALUES (
            'local', ?, 1, 1, 'materials', 'tailoring_rule',
            'factual_correction', ?, ?, 1, 'pending', ?, ?, 3, 2,
            'sample_gated_no_population_inference', ?, ?
        )
    """
    job_ids = (
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
    )
    for index in range(1, 4):
        conn.execute(
            """
            INSERT INTO learning_recommendation_evidence (
                tenant_id, recommendation_id, signal_id, evidence_role,
                source_kind, source_id, source_revision, recorded_at
            ) VALUES (
                'local', 'recommendation-1', ?, 'supporting',
                'tailoring_feedback_signal', ?, ?, ?
            )
            """,
            (
                f"signal-{index}",
                f"source-signal-{index}",
                index,
                f"2026-08-01T00:00:0{index}Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO learning_recommendation_evidence_jobs (
                tenant_id, recommendation_id, signal_id, job_id
            ) VALUES ('local', 'recommendation-1', ?, ?)
            """,
            (f"signal-{index}", job_ids[min(index - 1, 1)]),
        )
    for job_id in job_ids:
        conn.execute(
            """
            INSERT INTO learning_recommendation_jobs (
                tenant_id, recommendation_id, job_id
            ) VALUES ('local', 'recommendation-1', ?)
            """,
            (job_id,),
        )
    conn.execute(
        """
        INSERT INTO learning_recommendation_evidence (
            tenant_id, recommendation_id, signal_id, evidence_role,
            source_kind, source_id, source_revision, recorded_at
        ) VALUES (
            'local', 'recommendation-1', 'contradiction-1', 'contradicting',
            'tailoring_feedback_signal', 'source-contradiction-1', 4, ?
        )
        """,
        ("2026-08-01T00:00:04Z",),
    )
    conn.execute(
        """
        INSERT INTO learning_recommendation_evidence_jobs (
            tenant_id, recommendation_id, signal_id, job_id
        ) VALUES (
            'local', 'recommendation-1', 'contradiction-1',
            '33333333-3333-4333-8333-333333333333'
        )
        """
    )
    conn.execute(
        insert_recommendation,
        (
            "recommendation-1",
            "fact_handling",
            "require_source_match",
            3,
            2,
            "a" * 64,
            "2026-08-01T01:00:00Z",
        ),
    )
    conn.execute(
        """
        INSERT INTO learning_recommendation_tombstones (
            tenant_id, tombstone_id, recommendation_id, affected_signal_id,
            affected_source_revision, reason_code, derivation_version,
            tombstoned_at, rederived_at, replacement_recommendation_id
        ) VALUES (
            'local', 'tombstone-1', 'recommendation-1', 'signal-1', 1,
            'source_corrected', 1, ?, ?, NULL
        )
        """,
        ("2026-08-01T02:00:00Z", "2026-08-01T02:00:01Z"),
    )
    conn.commit()
    assert tuple(
        conn.execute(
            """
            SELECT evidence.evidence_role, evidence_job.signal_id,
                   evidence_job.job_id
            FROM learning_recommendation_evidence_jobs AS evidence_job
            JOIN learning_recommendation_evidence AS evidence
              ON evidence.tenant_id = evidence_job.tenant_id
             AND evidence.recommendation_id = evidence_job.recommendation_id
             AND evidence.signal_id = evidence_job.signal_id
            WHERE evidence_job.tenant_id = 'local'
              AND evidence_job.recommendation_id = 'recommendation-1'
              AND evidence_job.signal_id = 'contradiction-1'
            """
        ).fetchone()
    ) == (
        "contradicting",
        "contradiction-1",
        "33333333-3333-4333-8333-333333333333",
    )

    with pytest.raises(sqlite3.IntegrityError, match="supporting signal count mismatch"):
        conn.execute(
            insert_recommendation,
            (
                "recommendation-missing-evidence",
                "fact_handling",
                "require_source_match",
                3,
                2,
                "c" * 64,
                "2026-08-01T03:00:00Z",
            ),
        )

    for recommendation_id, rule_key, rule_value, signal_count, job_count, match in (
        (
            "recommendation-too-few-signals",
            "fact_handling",
            "require_source_match",
            2,
            2,
            "observed_signal_count",
        ),
        (
            "recommendation-one-job",
            "fact_handling",
            "require_source_match",
            3,
            1,
            "observed_job_count",
        ),
        (
            "recommendation-free-text",
            "free text",
            "require_source_match",
            3,
            2,
            "rule_key",
        ),
        (
            "recommendation-free-value",
            "fact_handling",
            "free text",
            3,
            2,
            "rule_value",
        ),
    ):
        conn.execute("SAVEPOINT invalid_recommendation")
        for index in range(1, signal_count + 1):
            conn.execute(
                """
                INSERT INTO learning_recommendation_evidence (
                    tenant_id, recommendation_id, signal_id, evidence_role,
                    source_kind, source_id, source_revision, recorded_at
                ) VALUES (
                    'local', ?, ?, 'supporting',
                    'tailoring_feedback_signal', ?, ?, ?
                )
                """,
                (
                    recommendation_id,
                    f"{recommendation_id}-signal-{index}",
                    f"{recommendation_id}-source-{index}",
                    index,
                    f"2026-08-01T03:00:0{index}Z",
                ),
            )
            conn.execute(
                """
                INSERT INTO learning_recommendation_evidence_jobs (
                    tenant_id, recommendation_id, signal_id, job_id
                ) VALUES ('local', ?, ?, ?)
                """,
                (
                    recommendation_id,
                    f"{recommendation_id}-signal-{index}",
                    f"00000000-0000-4000-8000-{min(index, job_count):012d}",
                ),
            )
        for index in range(1, job_count + 1):
            conn.execute(
                """
                INSERT INTO learning_recommendation_jobs (
                    tenant_id, recommendation_id, job_id
                ) VALUES ('local', ?, ?)
                """,
                (
                    recommendation_id,
                    f"00000000-0000-4000-8000-{index:012d}",
                ),
            )
        with pytest.raises(sqlite3.IntegrityError, match=match):
            conn.execute(
                insert_recommendation,
                (
                    recommendation_id,
                    rule_key,
                    rule_value,
                    signal_count,
                    job_count,
                    "b" * 64,
                    "2026-08-01T03:00:00Z",
                ),
            )
        conn.execute("ROLLBACK TO invalid_recommendation")
        conn.execute("RELEASE invalid_recommendation")

    with pytest.raises(sqlite3.IntegrityError, match="evidence is sealed"):
        conn.execute(
            """
            INSERT INTO learning_recommendation_evidence (
                tenant_id, recommendation_id, signal_id, evidence_role,
                source_kind, source_id, source_revision, recorded_at
            ) VALUES (
                'local', 'recommendation-1', 'signal-late', 'supporting',
                'tailoring_feedback_signal', 'source-late', 4, ?
            )
            """,
            ("2026-08-01T03:00:00Z",),
        )
    with pytest.raises(sqlite3.IntegrityError, match="jobs are sealed"):
        conn.execute(
            """
            INSERT INTO learning_recommendation_jobs (
                tenant_id, recommendation_id, job_id
            ) VALUES (
                'local', 'recommendation-1',
                '33333333-3333-4333-8333-333333333333'
            )
            """
        )
    with pytest.raises(sqlite3.IntegrityError, match="evidence jobs are sealed"):
        conn.execute(
            """
            INSERT INTO learning_recommendation_evidence_jobs (
                tenant_id, recommendation_id, signal_id, job_id
            ) VALUES (
                'local', 'recommendation-1', 'signal-1',
                '33333333-3333-4333-8333-333333333333'
            )
            """
        )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            """
            INSERT INTO learning_recommendation_jobs (
                tenant_id, recommendation_id, job_id
            ) VALUES (
                'local', 'missing-recommendation',
                'https://jobs.example/not-a-job-id'
            )
            """
        )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            """
            INSERT INTO learning_recommendation_evidence_jobs (
                tenant_id, recommendation_id, signal_id, job_id
            ) VALUES (
                'local', 'missing-recommendation', 'signal-orphan',
                'https://jobs.example/not-a-job-id'
            )
            """
        )

    conn.execute(
        """
        INSERT INTO learning_recommendation_evidence (
            tenant_id, recommendation_id, signal_id, evidence_role,
            source_kind, source_id, source_revision, recorded_at
        ) VALUES (
            'local', 'missing-recommendation', 'signal-orphan', 'supporting',
            'tailoring_feedback_signal', 'source-orphan', 1, ?
        )
        """,
        ("2026-08-01T03:00:00Z",),
    )
    with pytest.raises(sqlite3.IntegrityError):
        conn.commit()
    conn.rollback()
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            """
            INSERT INTO learning_recommendation_tombstones (
                tenant_id, tombstone_id, recommendation_id, affected_signal_id,
                affected_source_revision, reason_code, derivation_version,
                tombstoned_at, rederived_at, replacement_recommendation_id
            ) VALUES (
                'local', 'tombstone-self', 'recommendation-1', 'signal-2', 2,
                'source_deleted', 1, ?, ?, 'recommendation-1'
            )
            """,
            ("2026-08-01T03:00:00Z", "2026-08-01T03:00:01Z"),
        )

    tombstone_before = tuple(
        conn.execute(
            """
            SELECT tombstone_id, reason_code, tombstoned_at, rederived_at
            FROM learning_recommendation_tombstones
            WHERE tenant_id = 'local' AND tombstone_id = 'tombstone-1'
            """
        ).fetchone()
    )
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        conn.execute(
            """
            INSERT OR REPLACE INTO learning_recommendation_tombstones (
                tenant_id, tombstone_id, recommendation_id, affected_signal_id,
                affected_source_revision, reason_code, derivation_version,
                tombstoned_at, rederived_at, replacement_recommendation_id
            ) VALUES (
                'local', 'tombstone-1', 'recommendation-1', 'signal-1', 1,
                'source_deleted', 1, ?, ?, NULL
            )
            """,
            ("2026-08-01T04:00:00Z", "2026-08-01T04:00:01Z"),
        )
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        conn.execute(
            """
            INSERT OR REPLACE INTO learning_recommendation_tombstones (
                tenant_id, tombstone_id, recommendation_id, affected_signal_id,
                affected_source_revision, reason_code, derivation_version,
                tombstoned_at, rederived_at, replacement_recommendation_id
            ) VALUES (
                'local', 'tombstone-duplicate', 'recommendation-1', 'signal-1', 1,
                'source_corrected', 1, ?, ?, NULL
            )
            """,
            ("2026-08-01T04:00:00Z", "2026-08-01T04:00:01Z"),
        )
    assert tuple(
        conn.execute(
            """
            SELECT tombstone_id, reason_code, tombstoned_at, rederived_at
            FROM learning_recommendation_tombstones
            WHERE tenant_id = 'local' AND tombstone_id = 'tombstone-1'
            """
        ).fetchone()
    ) == tombstone_before

    append_only_mutations = (
        "UPDATE learning_recommendations SET derived_at = derived_at WHERE recommendation_id = 'recommendation-1'",
        "DELETE FROM learning_recommendation_evidence WHERE recommendation_id = 'recommendation-1'",
        "UPDATE learning_recommendation_evidence_jobs SET job_id = job_id WHERE recommendation_id = 'recommendation-1'",
        "UPDATE learning_recommendation_jobs SET job_id = job_id WHERE recommendation_id = 'recommendation-1'",
        "DELETE FROM learning_recommendation_tombstones WHERE tombstone_id = 'tombstone-1'",
    )
    for statement in append_only_mutations:
        with pytest.raises(sqlite3.IntegrityError, match="append-only"):
            conn.execute(statement)

    forbidden_fragments = {
        "artifact",
        "body",
        "description",
        "mail",
        "note",
        "path",
        "prompt",
        "resume",
        "summary",
        "text",
    }
    for table in (
        "learning_recommendation_reviews",
        "learning_recommendations",
        "learning_recommendation_evidence",
        "learning_recommendation_evidence_jobs",
        "learning_recommendation_jobs",
        "learning_recommendation_tombstones",
    ):
        columns = {
            str(column[1])
            for column in conn.execute(f"PRAGMA table_info({table})").fetchall()
        }
        assert not {
            column
            for column in columns
            if column in forbidden_fragments
            or any(column.endswith(f"_{fragment}") for fragment in forbidden_fragments)
        }

    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None
    close_connection(db_path)


def test_learning_recommendation_reviews_are_append_only_and_policy_linked(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    conn.execute("PRAGMA foreign_keys = ON")
    for recommendation_id, fingerprint in (
        ("recommendation-rejected", "d"),
        ("recommendation-accepted", "e"),
        ("recommendation-revision-gap", "f"),
    ):
        _insert_learning_recommendation_fixture(
            conn,
            recommendation_id,
            fingerprint,
        )
    conn.execute(
        """
        INSERT INTO tailoring_policies (
            tenant_id, version, prompt_version, schema_version,
            judge_schema_version, prompt_fingerprint, config_fingerprint,
            profile_policy_fingerprint, custom_prompt_fingerprint,
            generator_settings_json, judge_settings_json,
            runtime_settings_json, rollback_of_version, rollback_reason,
            created_at, created_from_event_id
        ) VALUES (
            'local', 1, 'prompt-v1', 'schema-v1', 'judge-v1',
            'prompt-fingerprint', 'config-fingerprint',
            'profile-fingerprint', 'custom-fingerprint',
            '{}', '{}', '{}', NULL, '', '2026-08-01T02:00:00Z', NULL
        )
        """
    )
    conn.execute(
        """
        INSERT INTO tailoring_policies (
            tenant_id, version, prompt_version, schema_version,
            judge_schema_version, prompt_fingerprint, config_fingerprint,
            profile_policy_fingerprint, custom_prompt_fingerprint,
            generator_settings_json, judge_settings_json,
            runtime_settings_json, rollback_of_version, rollback_reason,
            created_at, created_from_event_id
        ) VALUES (
            'local', 2, 'prompt-v1', 'schema-v1', 'judge-v1',
            'prompt-fingerprint', 'config-fingerprint-2',
            'profile-fingerprint', 'custom-fingerprint',
            '{}', '{}', '{}', NULL, '', '2026-08-01T02:00:01Z', NULL
        )
        """
    )
    conn.execute(
        """
        INSERT INTO learning_recommendation_reviews (
            tenant_id, review_id, recommendation_id, revision, decision,
            context, policy_kind, policy_version, reviewed_at
        ) VALUES (
            'local', 'review-rejected', 'recommendation-rejected', 1,
            'rejected', 'materials', 'tailoring_rule', NULL,
            '2026-08-01T02:01:00Z'
        )
        """
    )
    conn.execute(
        """
        INSERT INTO learning_recommendation_reviews (
            tenant_id, review_id, recommendation_id, revision, decision,
            context, policy_kind, policy_version, reviewed_at
        ) VALUES (
            'local', 'review-accepted', 'recommendation-accepted', 1,
            'accepted', 'materials', 'tailoring_rule', 1,
            '2026-08-01T02:02:00Z'
        )
        """
    )
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        conn.execute(
            """
            INSERT OR REPLACE INTO learning_recommendation_reviews (
                tenant_id, review_id, recommendation_id, revision, decision,
                context, policy_kind, policy_version, reviewed_at
            ) VALUES (
                'local', 'review-rejected', 'recommendation-rejected', 1,
                'rejected', 'materials', 'tailoring_rule', NULL,
                '2026-08-01T03:00:00Z'
            )
            """
        )
    with pytest.raises(sqlite3.IntegrityError, match="contiguous"):
        conn.execute(
            """
            INSERT INTO learning_recommendation_reviews (
                tenant_id, review_id, recommendation_id, revision, decision,
                context, policy_kind, policy_version, reviewed_at
            ) VALUES (
                'local', 'review-later-accepted-gap',
                'recommendation-revision-gap', 3, 'accepted',
                'materials', 'tailoring_rule', 2, '2026-08-01T03:01:00Z'
            )
            """
        )
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        conn.execute(
            """
            INSERT INTO learning_recommendation_reviews (
                tenant_id, review_id, recommendation_id, revision, decision,
                context, policy_kind, policy_version, reviewed_at
            ) VALUES (
                'local', 'review-after-rejected',
                'recommendation-rejected', 2, 'accepted',
                'materials', 'tailoring_rule', 2, '2026-08-01T03:02:00Z'
            )
            """
        )
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        conn.execute(
            """
            INSERT INTO learning_recommendation_reviews (
                tenant_id, review_id, recommendation_id, revision, decision,
                context, policy_kind, policy_version, reviewed_at
            ) VALUES (
                'local', 'review-after-accepted',
                'recommendation-accepted', 2, 'rejected',
                'materials', 'tailoring_rule', NULL, '2026-08-01T03:03:00Z'
            )
            """
        )
    for decision, policy_version in (("accepted", None), ("rejected", 1)):
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """
                INSERT INTO learning_recommendation_reviews (
                    tenant_id, review_id, recommendation_id, revision, decision,
                    context, policy_kind, policy_version, reviewed_at
                ) VALUES (
                    'local', ?, 'recommendation-revision-gap', 1, ?,
                    'materials', 'tailoring_rule', ?, '2026-08-01T04:00:00Z'
                )
                """,
                (f"review-invalid-{decision}", decision, policy_version),
            )
    for statement in (
        "UPDATE learning_recommendation_reviews SET reviewed_at = reviewed_at WHERE review_id = 'review-rejected'",
        "DELETE FROM learning_recommendation_reviews WHERE review_id = 'review-accepted'",
    ):
        with pytest.raises(sqlite3.IntegrityError, match="append-only"):
            conn.execute(statement)

    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None
    close_connection(db_path)


def test_learning_recommendation_job_provenance_constraints_fail_closed(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    insert_recommendation = """
        INSERT INTO learning_recommendations (
            tenant_id, recommendation_id, derivation_version,
            evaluation_fixture_version, context, policy_kind, signal_kind,
            rule_key, rule_value, allowlist_version, status,
            observed_signal_count, observed_job_count, minimum_signal_count,
            minimum_job_count, confidence_limit, input_fingerprint, derived_at
        ) VALUES (
            'local', ?, 1, 1, 'materials', 'tailoring_rule',
            'factual_correction', 'fact_handling', 'require_source_match',
            1, 'pending', 3, 2, 3, 2,
            'sample_gated_no_population_inference', ?, ?
        )
    """
    job_ids = (
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
    )
    cases = (
        (
            "missing-provenance",
            (job_ids[0], job_ids[1], None),
            "evidence job provenance missing",
        ),
        (
            "supporting-mismatch",
            (job_ids[0], job_ids[1], job_ids[2]),
            "supporting evidence job mismatch",
        ),
        (
            "unsupported-threshold-job",
            (job_ids[0], job_ids[0], job_ids[0]),
            "job lacks supporting evidence",
        ),
    )
    for recommendation_id, evidence_job_ids, match in cases:
        conn.execute("SAVEPOINT invalid_evidence_jobs")
        for index in range(1, 4):
            signal_id = f"{recommendation_id}-signal-{index}"
            conn.execute(
                """
                INSERT INTO learning_recommendation_evidence (
                    tenant_id, recommendation_id, signal_id, evidence_role,
                    source_kind, source_id, source_revision, recorded_at
                ) VALUES (
                    'local', ?, ?, 'supporting',
                    'tailoring_feedback_signal', ?, ?, ?
                )
                """,
                (
                    recommendation_id,
                    signal_id,
                    f"{recommendation_id}-source-{index}",
                    index,
                    f"2026-08-01T05:00:0{index}Z",
                ),
            )
            evidence_job_id = evidence_job_ids[index - 1]
            if evidence_job_id is not None:
                conn.execute(
                    """
                    INSERT INTO learning_recommendation_evidence_jobs (
                        tenant_id, recommendation_id, signal_id, job_id
                    ) VALUES ('local', ?, ?, ?)
                    """,
                    (recommendation_id, signal_id, evidence_job_id),
                )
        for job_id in job_ids[:2]:
            conn.execute(
                """
                INSERT INTO learning_recommendation_jobs (
                    tenant_id, recommendation_id, job_id
                ) VALUES ('local', ?, ?)
                """,
                (recommendation_id, job_id),
            )
        with pytest.raises(sqlite3.IntegrityError, match=match):
            conn.execute(
                insert_recommendation,
                (
                    recommendation_id,
                    str(len(recommendation_id)).zfill(64),
                    "2026-08-01T05:01:00Z",
                ),
            )
        conn.execute("ROLLBACK TO invalid_evidence_jobs")
        conn.execute("RELEASE invalid_evidence_jobs")

    assert conn.execute("SELECT COUNT(*) FROM learning_recommendations").fetchone()[0] == 0
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None
    close_connection(db_path)


def test_incomplete_v6_is_rejected_before_any_write(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    _create_incomplete_v6_database(db_path)
    before = _complete_database_dump(db_path)

    with pytest.raises(SchemaMigrationRequiredError, match="jobctrl update"):
        init_db(db_path)

    close_connection(db_path)
    assert _complete_database_dump(db_path) == before


def test_exact_v7_is_rejected_before_any_write(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = sqlite3.connect(db_path)
    create_exact_v7_schema(conn)
    conn.close()
    before = _complete_database_dump(db_path)

    with pytest.raises(SchemaMigrationRequiredError, match="schema v7"):
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
    create_schema = schema_v8.create_exact_v8_schema

    def fail_after_partial_creation(conn: sqlite3.Connection) -> None:
        executed = 0

        def fail_second_statement(statement: str) -> object:
            nonlocal executed
            executed += 1
            if executed == 2:
                raise RuntimeError("fixture creation failure")
            return conn.execute(statement)

        create_schema(conn, _execute=fail_second_statement)

    monkeypatch.setattr(schema_v8, "create_exact_v8_schema", fail_after_partial_creation)
    with pytest.raises(RuntimeError, match="fixture creation failure"):
        init_db(db_path)

    assert not db_path.exists()
    assert not Path(f"{db_path}-wal").exists()
    assert not Path(f"{db_path}-shm").exists()

    monkeypatch.setattr(schema_v8, "create_exact_v8_schema", create_schema)
    conn = init_db(db_path)
    assert_exact_manifest(conn, EXACT_V8_MANIFEST)
    close_connection(db_path)
