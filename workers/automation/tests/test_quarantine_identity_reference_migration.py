"""Schema-v28 Discovery quarantine stable JobId contracts."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

import pytest

import jobctrl.database as database_module
from jobctrl.database import (
    ensure_discovery_control_tables,
    ensure_quarantine_references_v28,
    init_db,
    reassign_discovery_identity_references,
)

PREVIOUS_SCHEMA_VERSION = 27
NOW = "2026-07-30T12:00:00+00:00"
UUID_SHAPED_URL = "11111111-1111-4111-8111-111111111111"
TARGET_JOB_ID = "22222222-2222-4222-8222-222222222222"
COLLIDING_JOB_ID = UUID_SHAPED_URL
PRIOR_JOB_ID = "33333333-3333-4333-8333-333333333333"
MERGED_JOB_ID = "44444444-4444-4444-8444-444444444444"
SURVIVOR_JOB_ID = "55555555-5555-4555-8555-555555555555"


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


def _downgrade_quarantine_table_to_v27(
    conn: sqlite3.Connection,
) -> None:
    conn.commit()
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("DROP TABLE discovery_quarantine_entries")
    database_module._create_quarantine_table_v28(
        conn,
        table="discovery_quarantine_entries",
        stable_reference=False,
    )
    conn.execute(
        f"PRAGMA user_version = {PREVIOUS_SCHEMA_VERSION}"
    )
    conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")


def _seed_v27_database(db_path: Path) -> sqlite3.Connection:
    conn = init_db(db_path)
    conn.row_factory = sqlite3.Row
    _downgrade_quarantine_table_to_v27(conn)
    return conn


def _quarantine_snapshot(
    conn: sqlite3.Connection,
) -> list[tuple[Any, ...]]:
    return [
        tuple(row)
        for row in conn.execute(
            """
            SELECT * FROM discovery_quarantine_entries
            ORDER BY tenant_id, job_key
            """
        ).fetchall()
    ]


def _insert_legacy_quarantine(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    job_url: str,
    title: str,
    source_id: str,
    posting_url: str,
    reason: str,
    confidence: float,
    snapshot_version: int,
    captured_at: str,
    notice_text: str,
    status: str,
    decision_reason: str | None = None,
    decided_at: str | None = None,
    job_id_url: str | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO discovery_quarantine_entries (
            tenant_id, job_id, job_key, title, company, source_id,
            posting_url, reason, confidence, snapshot_version,
            captured_at, notice_text, status, decision_reason,
            decided_at
        ) VALUES (
            ?, ?, ?, ?, 'ExampleCo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        """,
        (
            tenant_id,
            job_id_url or job_url,
            job_url,
            title,
            source_id,
            posting_url,
            reason,
            confidence,
            snapshot_version,
            captured_at,
            notice_text,
            status,
            decision_reason,
            decided_at,
        ),
    )


def test_v27_rows_migrate_and_duplicate_authorities_merge(
    tmp_path: Path,
) -> None:
    conn = _seed_v27_database(tmp_path / "jobs.db")
    colliding_owner_url = (
        "https://careers.example.test/uuid-id-owner"
    )
    prior_url = "https://careers.example.test/prior"
    prior_alias = "https://legacy.example.test/prior"
    merged_url = "https://careers.example.test/merged"
    merged_alias = "https://legacy.example.test/merged"
    blue_url = "https://blue.example.test/target"
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
    _insert_job(conn, url=merged_url, job_id=MERGED_JOB_ID)
    _insert_job(
        conn,
        url=blue_url,
        job_id=TARGET_JOB_ID,
        tenant_id="blue",
    )
    conn.executemany(
        """
        INSERT INTO job_identity_aliases (
            tenant_id, alias_kind, alias_value, job_id, created_at
        ) VALUES ('local', 'posting_url', ?, ?, ?)
        """,
        (
            (prior_alias, PRIOR_JOB_ID, NOW),
            (merged_alias, MERGED_JOB_ID, NOW),
        ),
    )
    _insert_legacy_quarantine(
        conn,
        tenant_id="local",
        job_url=UUID_SHAPED_URL,
        title="UUID URL",
        source_id="source:uuid",
        posting_url=UUID_SHAPED_URL,
        reason="unknown_active_state",
        confidence=0.4,
        snapshot_version=1,
        captured_at="2026-07-30T09:00:00+00:00",
        notice_text="UUID-shaped URL evidence",
        status="pending",
    )
    _insert_legacy_quarantine(
        conn,
        tenant_id="local",
        job_url=prior_alias,
        title="Alias URL",
        source_id="source:alias",
        posting_url=prior_alias,
        reason="user_review_requested",
        confidence=0.6,
        snapshot_version=2,
        captured_at="2026-07-30T09:30:00+00:00",
        notice_text="Alias evidence",
        status="approve",
        decision_reason="Reviewed alias",
        decided_at="2026-07-30T09:45:00+00:00",
    )
    _insert_legacy_quarantine(
        conn,
        tenant_id="blue",
        job_url=blue_url,
        title="Blue tenant",
        source_id="source:blue",
        posting_url=blue_url,
        reason="broad_board_only",
        confidence=0.5,
        snapshot_version=1,
        captured_at="2026-07-30T10:00:00+00:00",
        notice_text="Blue evidence",
        status="pending",
    )
    _insert_legacy_quarantine(
        conn,
        tenant_id="local",
        job_url=merged_url,
        title="Older reviewed capture",
        source_id="source:older",
        posting_url=merged_url,
        reason="low_confidence_extraction",
        confidence=0.3,
        snapshot_version=3,
        captured_at="2026-07-30T10:00:00+00:00",
        notice_text="Older review evidence",
        status="reject",
        decision_reason="Rejected older capture",
        decided_at="2026-07-30T10:30:00+00:00",
    )
    _insert_legacy_quarantine(
        conn,
        tenant_id="local",
        job_url=merged_alias,
        title="Newest pending capture",
        source_id="source:newest",
        posting_url=merged_alias,
        reason="policy_overridden",
        confidence=0.8,
        snapshot_version=4,
        captured_at="2026-07-30T11:00:00+00:00",
        notice_text="Newest pending evidence",
        status="pending",
    )
    conn.commit()

    assert ensure_quarantine_references_v28(
        conn
    ) == list(database_module._QUARANTINE_REFERENCE_TABLES)

    assert (
        conn.execute("PRAGMA user_version").fetchone()[0]
        == 28
    )
    assert database_module._has_quarantine_reference_schema_v28(
        conn
    )
    assert [
        tuple(row)
        for row in conn.execute(
            """
            SELECT tenant_id, job_id, title, source_id, posting_url,
                   reason, confidence, snapshot_version, captured_at,
                   notice_text, status, decision_reason, decided_at
            FROM discovery_quarantine_entries
            ORDER BY tenant_id, job_id
            """
        ).fetchall()
    ] == [
        (
            "blue",
            TARGET_JOB_ID,
            "Blue tenant",
            "source:blue",
            blue_url,
            "broad_board_only",
            0.5,
            1,
            "2026-07-30T10:00:00+00:00",
            "Blue evidence",
            "pending",
            None,
            None,
        ),
        (
            "local",
            TARGET_JOB_ID,
            "UUID URL",
            "source:uuid",
            UUID_SHAPED_URL,
            "unknown_active_state",
            0.4,
            1,
            "2026-07-30T09:00:00+00:00",
            "UUID-shaped URL evidence",
            "pending",
            None,
            None,
        ),
        (
            "local",
            PRIOR_JOB_ID,
            "Alias URL",
            "source:alias",
            prior_alias,
            "user_review_requested",
            0.6,
            2,
            "2026-07-30T09:30:00+00:00",
            "Alias evidence",
            "approve",
            "Reviewed alias",
            "2026-07-30T09:45:00+00:00",
        ),
        (
            "local",
            MERGED_JOB_ID,
            "Newest pending capture",
            "source:newest",
            merged_alias,
            "policy_overridden",
            0.8,
            4,
            "2026-07-30T11:00:00+00:00",
            "Newest pending evidence",
            "pending",
            "Rejected older capture",
            "2026-07-30T10:30:00+00:00",
        ),
    ]
    assert {
        str(row[6]).upper()
        for row in conn.execute(
            'PRAGMA foreign_key_list("discovery_quarantine_entries")'
        ).fetchall()
    } == {"CASCADE"}
    assert conn.execute(
        "PRAGMA foreign_key_check"
    ).fetchone() is None


def test_unresolved_reference_rolls_back_and_retry_succeeds(
    tmp_path: Path,
) -> None:
    conn = _seed_v27_database(tmp_path / "retry.db")
    missing_url = "https://careers.example.test/retry"
    _insert_legacy_quarantine(
        conn,
        tenant_id="local",
        job_url=missing_url,
        title="Retry",
        source_id="source:retry",
        posting_url=missing_url,
        reason="unknown_active_state",
        confidence=0.2,
        snapshot_version=1,
        captured_at=NOW,
        notice_text="Retry evidence",
        status="pending",
    )
    conn.commit()
    before = _quarantine_snapshot(conn)

    with pytest.raises(
        RuntimeError,
        match="could not resolve both URL-era identity columns",
    ):
        ensure_quarantine_references_v28(conn)

    assert (
        conn.execute("PRAGMA user_version").fetchone()[0]
        == PREVIOUS_SCHEMA_VERSION
    )
    assert _quarantine_snapshot(conn) == before
    assert "job_key" in _columns(
        conn,
        "discovery_quarantine_entries",
    )
    assert conn.execute(
        """
        SELECT COUNT(*) FROM sqlite_master
        WHERE type = 'table'
          AND name = 'discovery_quarantine_entries_v28'
        """
    ).fetchone()[0] == 0

    _insert_job(conn, url=missing_url, job_id=TARGET_JOB_ID)
    conn.commit()
    ensure_quarantine_references_v28(conn)
    assert conn.execute(
        "SELECT job_id FROM discovery_quarantine_entries"
    ).fetchone()[0] == TARGET_JOB_ID


def test_conflicting_legacy_identity_columns_fail_closed(
    tmp_path: Path,
) -> None:
    conn = _seed_v27_database(tmp_path / "conflict.db")
    first_url = "https://careers.example.test/first"
    second_url = "https://careers.example.test/second"
    _insert_job(conn, url=first_url, job_id=TARGET_JOB_ID)
    _insert_job(conn, url=second_url, job_id=PRIOR_JOB_ID)
    _insert_legacy_quarantine(
        conn,
        tenant_id="local",
        job_url=second_url,
        job_id_url=first_url,
        title="Conflicting identity",
        source_id="source:conflict",
        posting_url=second_url,
        reason="unknown_active_state",
        confidence=0.1,
        snapshot_version=1,
        captured_at=NOW,
        notice_text="Conflict",
        status="pending",
    )
    conn.commit()
    before = _quarantine_snapshot(conn)

    with pytest.raises(
        RuntimeError,
        match="conflicting URL-era identity columns",
    ):
        ensure_quarantine_references_v28(conn)

    assert _quarantine_snapshot(conn) == before
    assert (
        conn.execute("PRAGMA user_version").fetchone()[0]
        == PREVIOUS_SCHEMA_VERSION
    )


def test_verification_failure_rolls_back_and_retry_succeeds(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn = _seed_v27_database(tmp_path / "verify.db")
    job_url = "https://careers.example.test/verify"
    _insert_job(conn, url=job_url, job_id=TARGET_JOB_ID)
    _insert_legacy_quarantine(
        conn,
        tenant_id="local",
        job_url=job_url,
        title="Verify",
        source_id="source:verify",
        posting_url=job_url,
        reason="unknown_active_state",
        confidence=0.4,
        snapshot_version=1,
        captured_at=NOW,
        notice_text="Verification evidence",
        status="pending",
    )
    conn.commit()
    before = _quarantine_snapshot(conn)
    original_verify = (
        database_module._verify_quarantine_references_v28
    )

    def _fail_verification(
        _conn: sqlite3.Connection,
        *,
        expected_count: int,
    ) -> None:
        del expected_count
        raise RuntimeError(
            "injected quarantine verification failure"
        )

    monkeypatch.setattr(
        database_module,
        "_verify_quarantine_references_v28",
        _fail_verification,
    )
    with pytest.raises(
        RuntimeError,
        match="injected quarantine verification failure",
    ):
        ensure_quarantine_references_v28(conn)
    assert _quarantine_snapshot(conn) == before
    assert (
        conn.execute("PRAGMA user_version").fetchone()[0]
        == PREVIOUS_SCHEMA_VERSION
    )

    monkeypatch.setattr(
        database_module,
        "_verify_quarantine_references_v28",
        original_verify,
    )
    ensure_quarantine_references_v28(conn)
    assert conn.execute(
        "SELECT job_id FROM discovery_quarantine_entries"
    ).fetchone()[0] == TARGET_JOB_ID


@pytest.mark.parametrize(
    ("schema_version", "stable"),
    ((0, False), (27, False), (28, True)),
)
def test_missing_table_recovery_is_schema_version_aware(
    schema_version: int,
    stable: bool,
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

    columns = _columns(
        conn,
        "discovery_quarantine_entries",
    )
    assert ("job_key" not in columns) is stable
    if stable:
        assert database_module._has_quarantine_reference_schema_v28(
            conn
        )


def test_stamped_v28_legacy_table_fails_closed() -> None:
    conn = sqlite3.connect(":memory:")
    conn.executescript(
        """
        CREATE TABLE jobs (
            url TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL DEFAULT 'local',
            job_id TEXT NOT NULL,
            UNIQUE (tenant_id, job_id)
        );
        PRAGMA user_version = 27;
        """
    )
    ensure_discovery_control_tables(conn)
    conn.execute("PRAGMA user_version = 28")

    with pytest.raises(
        RuntimeError,
        match="Schema v28 requires stable Discovery quarantine",
    ):
        ensure_discovery_control_tables(conn)


def test_runtime_collision_merges_current_projection(
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
    conn.executemany(
        """
        INSERT INTO discovery_quarantine_entries (
            tenant_id, job_id, title, company, source_id,
            posting_url, reason, confidence, snapshot_version,
            captured_at, notice_text, status, decision_reason,
            decided_at
        ) VALUES (
            'local', ?, ?, 'ExampleCo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        """,
        (
            (
                TARGET_JOB_ID,
                "Newest losing capture",
                "source:losing",
                losing_url,
                "policy_overridden",
                0.8,
                4,
                "2026-07-30T11:00:00+00:00",
                "Newest evidence",
                "pending",
                None,
                None,
            ),
            (
                SURVIVOR_JOB_ID,
                "Older survivor capture",
                "source:surviving",
                surviving_url,
                "low_confidence_extraction",
                0.3,
                3,
                "2026-07-30T10:00:00+00:00",
                "Older evidence",
                "reject",
                "Reviewed survivor",
                "2026-07-30T10:30:00+00:00",
            ),
        ),
    )
    conn.commit()

    reassign_discovery_identity_references(
        conn,
        losing_job_url=losing_url,
        surviving_job_url=surviving_url,
    )
    conn.execute(
        """
        DELETE FROM jobs
        WHERE tenant_id = 'local' AND job_id = ?
        """,
        (TARGET_JOB_ID,),
    )

    assert [
        tuple(row)
        for row in conn.execute(
            """
            SELECT job_id, title, source_id, posting_url, reason,
                   confidence, snapshot_version, captured_at,
                   notice_text, status, decision_reason, decided_at
            FROM discovery_quarantine_entries
            """
        ).fetchall()
    ] == [
        (
            SURVIVOR_JOB_ID,
            "Newest losing capture",
            "source:losing",
            losing_url,
            "policy_overridden",
            0.8,
            4,
            "2026-07-30T11:00:00+00:00",
            "Newest evidence",
            "pending",
            "Reviewed survivor",
            "2026-07-30T10:30:00+00:00",
        )
    ]
    assert (
        database_module._resolve_job_reference_value(
            conn,
            tenant_id="local",
            reference=losing_url,
            legacy_url=True,
        )
        is None
    )
    assert conn.execute(
        "PRAGMA foreign_key_check"
    ).fetchone() is None
