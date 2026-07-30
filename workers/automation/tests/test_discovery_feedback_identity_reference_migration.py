"""Schema-v26 Discovery feedback stable JobId contracts."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

import pytest

import jobctrl.database as database_module
from jobctrl.database import (
    ensure_discovery_control_tables,
    ensure_discovery_feedback_references_v26,
    init_db,
    reassign_discovery_identity_references,
)

PREVIOUS_SCHEMA_VERSION = 25
NOW = "2026-07-30T12:00:00+00:00"
UUID_SHAPED_URL = "11111111-1111-4111-8111-111111111111"
TARGET_JOB_ID = "22222222-2222-4222-8222-222222222222"
COLLIDING_JOB_ID = UUID_SHAPED_URL
PRIOR_JOB_ID = "33333333-3333-4333-8333-333333333333"
SURVIVOR_JOB_ID = "44444444-4444-4444-8444-444444444444"


def _columns(
    conn: sqlite3.Connection,
    table: str,
) -> set[str]:
    return {
        str(row[1])
        for row in conn.execute(
            f'PRAGMA table_info("{table}")'
        ).fetchall()
    }


def _insert_job(
    conn: sqlite3.Connection,
    *,
    url: str,
    job_id: str,
    tenant_id: str = "local",
) -> None:
    conn.execute(
        """
        INSERT INTO jobs (
            url, tenant_id, job_id, title, company, discovered_at
        ) VALUES (?, ?, ?, 'Platform Engineer', 'ExampleCo', ?)
        """,
        (url, tenant_id, job_id, NOW),
    )


def _downgrade_discovery_feedback_table_to_v25(
    conn: sqlite3.Connection,
) -> None:
    conn.commit()
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("DROP TABLE discovery_feedback")
    database_module._create_discovery_feedback_table_v26(
        conn,
        table="discovery_feedback",
        stable_reference=False,
    )
    conn.execute(
        f"PRAGMA user_version = {PREVIOUS_SCHEMA_VERSION}"
    )
    conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")


def _seed_v25_database(db_path: Path) -> sqlite3.Connection:
    conn = init_db(db_path)
    conn.row_factory = sqlite3.Row
    _downgrade_discovery_feedback_table_to_v25(conn)
    return conn


def _feedback_snapshot(
    conn: sqlite3.Connection,
) -> list[tuple[Any, ...]]:
    return [
        tuple(row)
        for row in conn.execute(
            """
            SELECT * FROM discovery_feedback
            ORDER BY tenant_id, feedback_id
            """
        ).fetchall()
    ]


def test_v25_rows_migrate_exactly_with_url_first_resolution(
    tmp_path: Path,
) -> None:
    conn = _seed_v25_database(tmp_path / "jobs.db")
    colliding_owner_url = (
        "https://careers.example.test/uuid-id-owner"
    )
    prior_url = "https://careers.example.test/prior"
    prior_alias = "https://legacy.example.test/prior"
    blue_target_url = "https://blue.example.test/target"
    _insert_job(
        conn,
        url=UUID_SHAPED_URL,
        job_id=TARGET_JOB_ID,
    )
    _insert_job(
        conn,
        url=colliding_owner_url,
        job_id=COLLIDING_JOB_ID,
    )
    _insert_job(conn, url=prior_url, job_id=PRIOR_JOB_ID)
    _insert_job(
        conn,
        url=blue_target_url,
        job_id=TARGET_JOB_ID,
        tenant_id="blue",
    )
    conn.execute(
        """
        INSERT INTO job_identity_aliases (
            tenant_id, alias_kind, alias_value, job_id, created_at
        ) VALUES ('local', 'posting_url', ?, ?, ?)
        """,
        (prior_alias, PRIOR_JOB_ID, NOW),
    )
    conn.executemany(
        """
        INSERT INTO discovery_feedback (
            tenant_id, feedback_id, job_key, source_id,
            kind, note, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            (
                "local",
                "feedback:uuid-url",
                UUID_SHAPED_URL,
                "source:one",
                "bad_source",
                "private: uuid-shaped URL note",
                NOW,
            ),
            (
                "local",
                "feedback:alias",
                prior_alias,
                None,
                "irrelevant",
                "private: alias note",
                NOW,
            ),
            (
                "blue",
                "feedback:blue",
                blue_target_url,
                "source:blue",
                "useful",
                "private: tenant-isolated note",
                NOW,
            ),
        ),
    )
    conn.commit()

    assert ensure_discovery_feedback_references_v26(
        conn
    ) == list(
        database_module._DISCOVERY_FEEDBACK_REFERENCE_TABLES
    )

    assert conn.execute("PRAGMA user_version").fetchone()[0] == 26
    assert (
        database_module
        ._has_discovery_feedback_reference_schema_v26(conn)
    )
    assert [
        tuple(row)
        for row in conn.execute(
            """
            SELECT tenant_id, feedback_id, job_id, source_id,
                   kind, note, recorded_at
            FROM discovery_feedback
            ORDER BY tenant_id, feedback_id
            """
        ).fetchall()
    ] == [
        (
            "blue",
            "feedback:blue",
            TARGET_JOB_ID,
            "source:blue",
            "useful",
            "private: tenant-isolated note",
            NOW,
        ),
        (
            "local",
            "feedback:alias",
            PRIOR_JOB_ID,
            None,
            "irrelevant",
            "private: alias note",
            NOW,
        ),
        (
            "local",
            "feedback:uuid-url",
            TARGET_JOB_ID,
            "source:one",
            "bad_source",
            "private: uuid-shaped URL note",
            NOW,
        ),
    ]
    assert {
        str(row[6]).upper()
        for row in conn.execute(
            'PRAGMA foreign_key_list("discovery_feedback")'
        ).fetchall()
    } == {"CASCADE"}
    assert conn.execute(
        "PRAGMA foreign_key_check"
    ).fetchone() is None


def test_unresolved_reference_rolls_back_and_retry_succeeds(
    tmp_path: Path,
) -> None:
    conn = _seed_v25_database(tmp_path / "retry.db")
    missing_url = "https://careers.example.test/retry"
    conn.execute(
        """
        INSERT INTO discovery_feedback (
            tenant_id, feedback_id, job_key, source_id,
            kind, note, recorded_at
        ) VALUES (
            'local', 'feedback:retry', ?, 'source:retry',
            'bad_source', 'private: retry note', ?
        )
        """,
        (missing_url, NOW),
    )
    conn.commit()
    before = _feedback_snapshot(conn)

    with pytest.raises(
        RuntimeError,
        match="could not resolve discovery_feedback.job_key",
    ):
        ensure_discovery_feedback_references_v26(conn)

    assert (
        conn.execute("PRAGMA user_version").fetchone()[0]
        == PREVIOUS_SCHEMA_VERSION
    )
    assert _feedback_snapshot(conn) == before
    assert "job_key" in _columns(conn, "discovery_feedback")
    assert "job_id" not in _columns(conn, "discovery_feedback")
    assert conn.execute(
        """
        SELECT COUNT(*) FROM sqlite_master
        WHERE type = 'table' AND name = 'discovery_feedback_v26'
        """
    ).fetchone()[0] == 0

    _insert_job(conn, url=missing_url, job_id=TARGET_JOB_ID)
    conn.commit()
    ensure_discovery_feedback_references_v26(conn)
    assert conn.execute(
        "SELECT job_id FROM discovery_feedback"
    ).fetchone()[0] == TARGET_JOB_ID


def test_verification_failure_rolls_back_and_retry_succeeds(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn = _seed_v25_database(tmp_path / "verify.db")
    job_url = "https://careers.example.test/verify"
    _insert_job(conn, url=job_url, job_id=TARGET_JOB_ID)
    conn.execute(
        """
        INSERT INTO discovery_feedback (
            tenant_id, feedback_id, job_key, kind, note, recorded_at
        ) VALUES (
            'local', 'feedback:verify', ?, 'useful',
            'private: verification note', ?
        )
        """,
        (job_url, NOW),
    )
    conn.commit()
    before = _feedback_snapshot(conn)
    original_verify = (
        database_module
        ._verify_discovery_feedback_references_v26
    )

    def _fail_verification(
        _conn: sqlite3.Connection,
        *,
        expected_count: int,
    ) -> None:
        del expected_count
        raise RuntimeError(
            "injected discovery-feedback verification failure"
        )

    monkeypatch.setattr(
        database_module,
        "_verify_discovery_feedback_references_v26",
        _fail_verification,
    )
    with pytest.raises(
        RuntimeError,
        match="injected discovery-feedback verification failure",
    ):
        ensure_discovery_feedback_references_v26(conn)
    assert (
        conn.execute("PRAGMA user_version").fetchone()[0]
        == PREVIOUS_SCHEMA_VERSION
    )
    assert _feedback_snapshot(conn) == before
    assert "job_key" in _columns(conn, "discovery_feedback")

    monkeypatch.setattr(
        database_module,
        "_verify_discovery_feedback_references_v26",
        original_verify,
    )
    ensure_discovery_feedback_references_v26(conn)
    assert conn.execute(
        "SELECT job_id FROM discovery_feedback"
    ).fetchone()[0] == TARGET_JOB_ID


@pytest.mark.parametrize(
    ("schema_version", "expected_reference"),
    ((0, "job_key"), (25, "job_key"), (26, "job_id")),
)
def test_missing_table_recovery_is_schema_version_aware(
    schema_version: int,
    expected_reference: str,
) -> None:
    conn = sqlite3.connect(":memory:")
    conn.executescript(
        f"""
        CREATE TABLE jobs (
            url TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL DEFAULT 'local',
            job_id TEXT NOT NULL,
            UNIQUE (tenant_id, job_id)
        );
        PRAGMA user_version = {schema_version};
        """
    )

    ensure_discovery_control_tables(conn)

    assert expected_reference in _columns(
        conn,
        "discovery_feedback",
    )
    if schema_version == 26:
        assert (
            database_module
            ._has_discovery_feedback_reference_schema_v26(conn)
        )


def test_stamped_v26_legacy_table_fails_closed() -> None:
    conn = sqlite3.connect(":memory:")
    conn.executescript(
        """
        CREATE TABLE jobs (
            url TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL DEFAULT 'local',
            job_id TEXT NOT NULL,
            UNIQUE (tenant_id, job_id)
        );
        PRAGMA user_version = 25;
        """
    )
    ensure_discovery_control_tables(conn)
    conn.execute("PRAGMA user_version = 26")

    with pytest.raises(
        RuntimeError,
        match="Schema v26 requires stable discovery-feedback",
    ):
        ensure_discovery_control_tables(conn)


def test_runtime_collision_rehomes_feedback_without_exposing_note(
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "collision.db")
    losing_url = "https://careers.example.test/losing"
    surviving_url = "https://careers.example.test/surviving"
    _insert_job(conn, url=losing_url, job_id=TARGET_JOB_ID)
    _insert_job(
        conn,
        url=surviving_url,
        job_id=SURVIVOR_JOB_ID,
    )
    conn.execute(
        """
        INSERT INTO discovery_feedback (
            tenant_id, feedback_id, job_id, source_id,
            kind, note, recorded_at
        ) VALUES (
            'local', 'feedback:collision', ?, 'source:collision',
            'bad_source', 'private: collision note', ?
        )
        """,
        (TARGET_JOB_ID, NOW),
    )
    conn.commit()

    reassign_discovery_identity_references(
        conn,
        losing_job_url=losing_url,
        surviving_job_url=surviving_url,
    )

    row = conn.execute(
        """
        SELECT job_id, note
        FROM discovery_feedback
        WHERE feedback_id = 'feedback:collision'
        """
    ).fetchone()
    assert tuple(row) == (
        SURVIVOR_JOB_ID,
        "private: collision note",
    )
    assert conn.execute(
        "PRAGMA foreign_key_check"
    ).fetchone() is None
