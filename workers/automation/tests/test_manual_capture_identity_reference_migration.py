"""Schema-v27 manual-capture stable JobId contracts."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

import pytest

import jobctrl.database as database_module
from jobctrl.database import (
    ensure_discovery_control_tables,
    ensure_manual_capture_references_v27,
    init_db,
    reassign_discovery_identity_references,
)

PREVIOUS_SCHEMA_VERSION = 26
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


def _downgrade_manual_capture_table_to_v26(
    conn: sqlite3.Connection,
) -> None:
    conn.commit()
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("DROP TABLE manual_capture_queue")
    database_module._create_manual_capture_queue_table_v27(
        conn,
        table="manual_capture_queue",
        stable_reference=False,
    )
    conn.execute(
        f"PRAGMA user_version = {PREVIOUS_SCHEMA_VERSION}"
    )
    conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")


def _seed_v26_database(db_path: Path) -> sqlite3.Connection:
    conn = init_db(db_path)
    conn.row_factory = sqlite3.Row
    _downgrade_manual_capture_table_to_v26(conn)
    return conn


def _capture_snapshot(
    conn: sqlite3.Connection,
) -> list[tuple[Any, ...]]:
    return [
        tuple(row)
        for row in conn.execute(
            """
            SELECT * FROM manual_capture_queue
            ORDER BY tenant_id, item_id
            """
        ).fetchall()
    ]


def _capture_payload_snapshot(
    conn: sqlite3.Connection,
) -> list[tuple[Any, ...]]:
    return [
        tuple(row)
        for row in conn.execute(
            """
            SELECT tenant_id, item_id, originating_url, source_id,
                   reason, retry_context_json, required_at, status,
                   imported_at, dismissed_at, capture_mode,
                   captured_url, content_sha256, content_length,
                   note, future_manual_action_required
            FROM manual_capture_queue
            ORDER BY tenant_id, item_id
            """
        ).fetchall()
    ]


def test_v26_rows_migrate_exactly_with_url_first_resolution(
    tmp_path: Path,
) -> None:
    conn = _seed_v26_database(tmp_path / "jobs.db")
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
        INSERT INTO manual_capture_queue (
            tenant_id, item_id, originating_url, source_id,
            reason, retry_context_json, required_at, status,
            imported_at, dismissed_at, capture_mode, captured_url,
            content_sha256, content_length, note,
            future_manual_action_required, job_key
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        """,
        (
            (
                "local",
                "capture:uuid-url",
                "https://login.example.test/source",
                "source:one",
                "login_required",
                '{"private":"exact","unicode":"café"}',
                NOW,
                "imported",
                NOW,
                None,
                "saved_html",
                UUID_SHAPED_URL,
                "a" * 64,
                1234,
                "private: multiline\ncapture note",
                1,
                UUID_SHAPED_URL,
            ),
            (
                "local",
                "capture:alias",
                prior_alias,
                "source:alias",
                "browser_extension_capture",
                '{"source":"browser_extension"}',
                NOW,
                "dismissed",
                NOW,
                NOW,
                "current_page",
                prior_alias,
                "b" * 64,
                4321,
                "private: dismissed note",
                0,
                prior_alias,
            ),
            (
                "local",
                "capture:pending",
                "https://protected.example.test/pending",
                None,
                "captcha",
                '{"pending":true}',
                NOW,
                "pending",
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                0,
                None,
            ),
            (
                "blue",
                "capture:blue",
                blue_target_url,
                "source:blue",
                "paywall",
                '{"tenant":"blue"}',
                NOW,
                "imported",
                NOW,
                None,
                "copied_url",
                blue_target_url,
                "c" * 64,
                99,
                "private: blue note",
                0,
                blue_target_url,
            ),
        ),
    )
    conn.commit()
    before_payload = _capture_payload_snapshot(conn)

    assert ensure_manual_capture_references_v27(
        conn
    ) == list(
        database_module._MANUAL_CAPTURE_REFERENCE_TABLES
    )

    assert conn.execute("PRAGMA user_version").fetchone()[0] == 27
    assert (
        database_module
        ._has_manual_capture_reference_schema_v27(conn)
    )
    assert _capture_payload_snapshot(conn) == before_payload
    assert [
        tuple(row)
        for row in conn.execute(
            """
            SELECT tenant_id, item_id, job_id
            FROM manual_capture_queue
            ORDER BY tenant_id, item_id
            """
        ).fetchall()
    ] == [
        ("blue", "capture:blue", TARGET_JOB_ID),
        ("local", "capture:alias", PRIOR_JOB_ID),
        ("local", "capture:pending", None),
        ("local", "capture:uuid-url", TARGET_JOB_ID),
    ]
    assert {
        str(row[6]).upper()
        for row in conn.execute(
            'PRAGMA foreign_key_list("manual_capture_queue")'
        ).fetchall()
    } == {"CASCADE"}
    assert conn.execute(
        "PRAGMA foreign_key_check"
    ).fetchone() is None


def test_unresolved_reference_rolls_back_and_retry_succeeds(
    tmp_path: Path,
) -> None:
    conn = _seed_v26_database(tmp_path / "retry.db")
    missing_url = "https://careers.example.test/retry"
    conn.execute(
        """
        INSERT INTO manual_capture_queue (
            tenant_id, item_id, originating_url, reason,
            retry_context_json, required_at, status,
            imported_at, captured_url, job_key
        ) VALUES (
            'local', 'capture:retry', ?, 'login_required',
            '{}', ?, 'imported', ?, ?, ?
        )
        """,
        (missing_url, NOW, NOW, missing_url, missing_url),
    )
    conn.commit()
    before = _capture_snapshot(conn)

    with pytest.raises(
        RuntimeError,
        match="could not resolve manual_capture_queue.job_key",
    ):
        ensure_manual_capture_references_v27(conn)

    assert (
        conn.execute("PRAGMA user_version").fetchone()[0]
        == PREVIOUS_SCHEMA_VERSION
    )
    assert _capture_snapshot(conn) == before
    assert "job_key" in _columns(conn, "manual_capture_queue")
    assert "job_id" not in _columns(conn, "manual_capture_queue")
    assert conn.execute(
        """
        SELECT COUNT(*) FROM sqlite_master
        WHERE type = 'table' AND name = 'manual_capture_queue_v27'
        """
    ).fetchone()[0] == 0

    _insert_job(conn, url=missing_url, job_id=TARGET_JOB_ID)
    conn.commit()
    ensure_manual_capture_references_v27(conn)
    assert conn.execute(
        "SELECT job_id FROM manual_capture_queue"
    ).fetchone()[0] == TARGET_JOB_ID


def test_verification_failure_rolls_back_and_retry_succeeds(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn = _seed_v26_database(tmp_path / "verify.db")
    job_url = "https://careers.example.test/verify"
    _insert_job(conn, url=job_url, job_id=TARGET_JOB_ID)
    conn.execute(
        """
        INSERT INTO manual_capture_queue (
            tenant_id, item_id, originating_url, reason,
            retry_context_json, required_at, status,
            imported_at, captured_url, note, job_key
        ) VALUES (
            'local', 'capture:verify', ?, 'login_required',
            '{"private":"verify"}', ?, 'imported',
            ?, ?, 'private: verification note', ?
        )
        """,
        (job_url, NOW, NOW, job_url, job_url),
    )
    conn.commit()
    before = _capture_snapshot(conn)
    original_verify = (
        database_module._verify_manual_capture_references_v27
    )

    def _fail_verification(
        _conn: sqlite3.Connection,
        *,
        expected_count: int,
    ) -> None:
        del expected_count
        raise RuntimeError(
            "injected manual-capture verification failure"
        )

    monkeypatch.setattr(
        database_module,
        "_verify_manual_capture_references_v27",
        _fail_verification,
    )
    with pytest.raises(
        RuntimeError,
        match="injected manual-capture verification failure",
    ):
        ensure_manual_capture_references_v27(conn)
    assert (
        conn.execute("PRAGMA user_version").fetchone()[0]
        == PREVIOUS_SCHEMA_VERSION
    )
    assert _capture_snapshot(conn) == before
    assert "job_key" in _columns(conn, "manual_capture_queue")

    monkeypatch.setattr(
        database_module,
        "_verify_manual_capture_references_v27",
        original_verify,
    )
    ensure_manual_capture_references_v27(conn)
    assert conn.execute(
        "SELECT job_id FROM manual_capture_queue"
    ).fetchone()[0] == TARGET_JOB_ID


@pytest.mark.parametrize(
    ("schema_version", "expected_reference"),
    ((0, "job_key"), (26, "job_key"), (27, "job_id")),
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
        "manual_capture_queue",
    )
    if schema_version == 27:
        assert (
            database_module
            ._has_manual_capture_reference_schema_v27(conn)
        )


def test_stamped_v27_legacy_table_fails_closed() -> None:
    conn = sqlite3.connect(":memory:")
    conn.executescript(
        """
        CREATE TABLE jobs (
            url TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL DEFAULT 'local',
            job_id TEXT NOT NULL,
            UNIQUE (tenant_id, job_id)
        );
        PRAGMA user_version = 26;
        """
    )
    ensure_discovery_control_tables(conn)
    conn.execute("PRAGMA user_version = 27")

    with pytest.raises(
        RuntimeError,
        match="Schema v27 requires stable manual-capture",
    ):
        ensure_discovery_control_tables(conn)


def test_runtime_collision_rehomes_imported_capture(
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
        INSERT INTO manual_capture_queue (
            tenant_id, item_id, originating_url, reason,
            retry_context_json, required_at, status,
            imported_at, captured_url, note, job_id
        ) VALUES (
            'local', 'capture:collision', ?, 'login_required',
            '{"private":"collision"}', ?, 'imported',
            ?, ?, 'private: collision note', ?
        )
        """,
        (losing_url, NOW, NOW, losing_url, TARGET_JOB_ID),
    )
    conn.commit()

    reassign_discovery_identity_references(
        conn,
        losing_job_url=losing_url,
        surviving_job_url=surviving_url,
    )

    row = conn.execute(
        """
        SELECT job_id, captured_url, note
        FROM manual_capture_queue
        WHERE item_id = 'capture:collision'
        """
    ).fetchone()
    assert tuple(row) == (
        SURVIVOR_JOB_ID,
        losing_url,
        "private: collision note",
    )
    assert conn.execute(
        "PRAGMA foreign_key_check"
    ).fetchone() is None
