"""Schema-v29 soft-delete tombstone stable JobId contracts."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

import pytest

import jobctrl.database as database_module
from jobctrl.database import (
    ensure_deleted_job_references_v29,
    ensure_deleted_jobs_table,
    init_db,
    reassign_discovery_identity_references,
)
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.discovery import SqliteJobRepository

PREVIOUS_SCHEMA_VERSION = 28
NOW = "2026-07-30T12:00:00+00:00"
UUID_SHAPED_URL = "11111111-1111-4111-8111-111111111111"
TARGET_JOB_ID = "22222222-2222-4222-8222-222222222222"
COLLIDING_JOB_ID = UUID_SHAPED_URL
ALIAS_JOB_ID = "33333333-3333-4333-8333-333333333333"
LOSING_JOB_ID = "44444444-4444-4444-8444-444444444444"
SURVIVING_JOB_ID = "55555555-5555-4555-8555-555555555555"
SHARED_JOB_ID = "66666666-6666-4666-8666-666666666666"


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


def _downgrade_deleted_jobs_table_to_v28(
    conn: sqlite3.Connection,
) -> None:
    conn.commit()
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("DROP TABLE jobctrl_deleted_jobs")
    database_module._create_deleted_jobs_table_v29(
        conn,
        table="jobctrl_deleted_jobs",
        stable_reference=False,
    )
    conn.execute(
        f"PRAGMA user_version = {PREVIOUS_SCHEMA_VERSION}"
    )
    conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")


def _seed_v28_database(db_path: Path) -> sqlite3.Connection:
    conn = init_db(db_path)
    conn.row_factory = sqlite3.Row
    _downgrade_deleted_jobs_table_to_v28(conn)
    return conn


def _tombstone_snapshot(
    conn: sqlite3.Connection,
) -> list[tuple[Any, ...]]:
    return [
        tuple(row)
        for row in conn.execute(
            """
            SELECT *
            FROM jobctrl_deleted_jobs
            ORDER BY job_url
            """
        ).fetchall()
    ]


def test_v28_rows_migrate_url_first_and_alias_lifecycle_merges(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = _seed_v28_database(db_path)
    colliding_owner_url = (
        "https://careers.example.test/uuid-id-owner"
    )
    canonical_url = "https://careers.example.test/alias-owner"
    alias_url = "https://legacy.example.test/alias-owner"
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
    _insert_job(
        conn,
        url=canonical_url,
        job_id=ALIAS_JOB_ID,
    )
    conn.execute(
        """
        INSERT INTO job_identity_aliases (
            tenant_id, alias_kind, alias_value, job_id, created_at
        ) VALUES ('local', 'posting_url', ?, ?, ?)
        """,
        (alias_url, ALIAS_JOB_ID, NOW),
    )
    conn.commit()
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.executemany(
        """
        INSERT INTO jobctrl_deleted_jobs (
            job_url, deleted_at, reason, restored_at
        ) VALUES (?, ?, ?, ?)
        """,
        (
            (
                UUID_SHAPED_URL,
                "2026-07-30T09:00:00+00:00",
                "uuid-shaped URL",
                None,
            ),
            (
                alias_url,
                "2026-07-30T10:00:00+00:00",
                "older alias delete",
                "2026-07-30T13:00:00+00:00",
            ),
            (
                canonical_url,
                "2026-07-30T12:00:00+00:00",
                "latest canonical delete",
                "2026-07-30T11:00:00+00:00",
            ),
        ),
    )
    conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")

    ensure_deleted_job_references_v29(conn)

    assert (
        conn.execute("PRAGMA user_version").fetchone()[0]
        == 29
    )
    assert _columns(conn, "jobctrl_deleted_jobs") == {
        "tenant_id",
        "job_id",
        "deleted_at",
        "reason",
        "restored_at",
    }
    rows = [
        tuple(row)
        for row in conn.execute(
            """
            SELECT tenant_id, job_id, deleted_at, reason, restored_at
            FROM jobctrl_deleted_jobs
            ORDER BY job_id
            """
        ).fetchall()
    ]
    assert rows == [
        (
            "local",
            TARGET_JOB_ID,
            "2026-07-30T09:00:00+00:00",
            "uuid-shaped URL",
            None,
        ),
        (
            "local",
            ALIAS_JOB_ID,
            "2026-07-30T12:00:00+00:00",
            "latest canonical delete",
            "2026-07-30T13:00:00+00:00",
        ),
    ]
    repository = SqliteJobRepository(conn)
    uuid_url_job = repository.load(
        LOCAL_TENANT,
        JobId(TARGET_JOB_ID),
    )
    alias_job = repository.load(
        LOCAL_TENANT,
        JobId(ALIAS_JOB_ID),
    )
    assert uuid_url_job is not None
    assert uuid_url_job.is_deleted is True
    assert alias_job is not None
    assert alias_job.is_deleted is False

    conn.commit()
    conn.close()
    reopened = init_db(db_path)
    assert database_module._has_deleted_job_reference_schema_v29(
        reopened
    )


def test_unresolved_reference_rolls_back_then_retries(
    tmp_path: Path,
) -> None:
    conn = _seed_v28_database(tmp_path / "jobs.db")
    unresolved_url = "https://careers.example.test/missing"
    conn.commit()
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute(
        """
        INSERT INTO jobctrl_deleted_jobs (
            job_url, deleted_at, reason, restored_at
        ) VALUES (?, ?, ?, NULL)
        """,
        (
            unresolved_url,
            "2026-07-30T10:00:00+00:00",
            "unresolved",
        ),
    )
    conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")
    before = _tombstone_snapshot(conn)

    with pytest.raises(
        RuntimeError,
        match="could not resolve",
    ):
        ensure_deleted_job_references_v29(conn)

    assert _tombstone_snapshot(conn) == before
    assert "job_url" in _columns(
        conn,
        "jobctrl_deleted_jobs",
    )
    assert (
        conn.execute("PRAGMA user_version").fetchone()[0]
        == PREVIOUS_SCHEMA_VERSION
    )
    assert conn.execute(
        """
        SELECT 1
        FROM sqlite_master
        WHERE type = 'table'
          AND name = 'jobctrl_deleted_jobs_v29'
        """
    ).fetchone() is None

    _insert_job(
        conn,
        url=unresolved_url,
        job_id=TARGET_JOB_ID,
    )
    ensure_deleted_job_references_v29(conn)
    assert conn.execute(
        """
        SELECT job_id
        FROM jobctrl_deleted_jobs
        """
    ).fetchone()[0] == TARGET_JOB_ID


def test_verification_failure_rolls_back_then_retries(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn = _seed_v28_database(tmp_path / "jobs.db")
    url = "https://careers.example.test/verification"
    _insert_job(conn, url=url, job_id=TARGET_JOB_ID)
    conn.execute(
        """
        INSERT INTO jobctrl_deleted_jobs (
            job_url, deleted_at, reason, restored_at
        ) VALUES (?, ?, ?, NULL)
        """,
        (
            url,
            "2026-07-30T10:00:00+00:00",
            "verification",
        ),
    )
    conn.commit()
    before = _tombstone_snapshot(conn)
    original_verify = (
        database_module._verify_deleted_job_references_v29
    )

    def fail_verification(
        _conn: sqlite3.Connection,
        *,
        expected_count: int,
    ) -> None:
        del expected_count
        raise RuntimeError("injected verification failure")

    monkeypatch.setattr(
        database_module,
        "_verify_deleted_job_references_v29",
        fail_verification,
    )
    with pytest.raises(
        RuntimeError,
        match="injected verification failure",
    ):
        ensure_deleted_job_references_v29(conn)

    assert _tombstone_snapshot(conn) == before
    assert "job_url" in _columns(
        conn,
        "jobctrl_deleted_jobs",
    )
    assert (
        conn.execute("PRAGMA user_version").fetchone()[0]
        == PREVIOUS_SCHEMA_VERSION
    )

    monkeypatch.setattr(
        database_module,
        "_verify_deleted_job_references_v29",
        original_verify,
    )
    ensure_deleted_job_references_v29(conn)
    assert database_module._has_deleted_job_reference_schema_v29(
        conn
    )


def test_missing_table_recovery_matches_schema_version(
    tmp_path: Path,
) -> None:
    legacy = sqlite3.connect(":memory:")
    legacy.execute(
        "CREATE TABLE jobs (url TEXT PRIMARY KEY)"
    )
    ensure_deleted_jobs_table(legacy)
    assert "job_url" in _columns(
        legacy,
        "jobctrl_deleted_jobs",
    )

    v28 = _seed_v28_database(tmp_path / "v28.db")
    v28.execute("DROP TABLE jobctrl_deleted_jobs")
    ensure_deleted_job_references_v29(v28)
    assert database_module._has_deleted_job_reference_schema_v29(
        v28
    )

    v29 = init_db(tmp_path / "v29.db")
    v29.execute("DROP TABLE jobctrl_deleted_jobs")
    ensure_deleted_jobs_table(v29)
    assert database_module._has_deleted_job_reference_schema_v29(
        v29
    )


def test_stamped_v29_legacy_table_fails_closed(
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "jobs.db")
    _downgrade_deleted_jobs_table_to_v28(conn)
    conn.execute("PRAGMA user_version = 29")

    with pytest.raises(
        RuntimeError,
        match="requires stable soft-delete tombstone",
    ):
        ensure_deleted_jobs_table(conn)

    assert "job_url" in _columns(
        conn,
        "jobctrl_deleted_jobs",
    )


def test_collision_rehome_merges_lifecycle_before_job_delete(
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "jobs.db")
    losing_url = "https://careers.example.test/losing"
    surviving_url = "https://careers.example.test/surviving"
    _insert_job(
        conn,
        url=losing_url,
        job_id=LOSING_JOB_ID,
    )
    _insert_job(
        conn,
        url=surviving_url,
        job_id=SURVIVING_JOB_ID,
    )
    conn.executemany(
        """
        INSERT INTO jobctrl_deleted_jobs (
            tenant_id, job_id, deleted_at, reason, restored_at
        ) VALUES ('local', ?, ?, ?, ?)
        """,
        (
            (
                LOSING_JOB_ID,
                "2026-07-30T14:00:00+00:00",
                "latest losing delete",
                "2026-07-30T11:00:00+00:00",
            ),
            (
                SURVIVING_JOB_ID,
                "2026-07-30T10:00:00+00:00",
                "older surviving delete",
                "2026-07-30T15:00:00+00:00",
            ),
        ),
    )

    reassign_discovery_identity_references(
        conn,
        losing_job_url=losing_url,
        surviving_job_url=surviving_url,
    )

    row = conn.execute(
        """
        SELECT tenant_id, job_id, deleted_at, reason, restored_at
        FROM jobctrl_deleted_jobs
        """
    ).fetchone()
    assert tuple(row) == (
        "local",
        SURVIVING_JOB_ID,
        "2026-07-30T14:00:00+00:00",
        "latest losing delete",
        "2026-07-30T15:00:00+00:00",
    )
    conn.execute(
        "DELETE FROM jobs WHERE url = ?",
        (losing_url,),
    )
    assert conn.execute(
        """
        SELECT job_id
        FROM jobctrl_deleted_jobs
        """
    ).fetchone()[0] == SURVIVING_JOB_ID


def test_runtime_restore_is_tenant_scoped(
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "jobs.db")
    _insert_job(
        conn,
        tenant_id="local",
        url="https://local.example.test/shared",
        job_id=SHARED_JOB_ID,
    )
    _insert_job(
        conn,
        tenant_id="blue",
        url="https://blue.example.test/shared",
        job_id=SHARED_JOB_ID,
    )
    conn.executemany(
        """
        INSERT INTO jobctrl_deleted_jobs (
            tenant_id, job_id, deleted_at, reason, restored_at
        ) VALUES (?, ?, ?, 'tenant isolation', NULL)
        """,
        (
            (
                "local",
                SHARED_JOB_ID,
                "2026-07-30T10:00:00+00:00",
            ),
            (
                "blue",
                SHARED_JOB_ID,
                "2026-07-30T10:00:00+00:00",
            ),
        ),
    )
    repository = SqliteJobRepository(conn)

    restored = repository.restore(
        LOCAL_TENANT,
        JobId(SHARED_JOB_ID),
        restored_at="2026-07-30T11:00:00+00:00",
    )

    assert restored is not None
    rows = [
        tuple(row)
        for row in conn.execute(
            """
            SELECT tenant_id, restored_at
            FROM jobctrl_deleted_jobs
            ORDER BY tenant_id
            """
        ).fetchall()
    ]
    assert rows == [
        ("blue", None),
        ("local", "2026-07-30T11:00:00+00:00"),
    ]


def test_stable_tombstone_cascades_with_job_delete(
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "jobs.db")
    conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")
    url = "https://careers.example.test/cascade"
    _insert_job(conn, url=url, job_id=TARGET_JOB_ID)
    conn.execute(
        """
        INSERT INTO jobctrl_deleted_jobs (
            tenant_id, job_id, deleted_at, reason, restored_at
        ) VALUES (
            'local', ?, '2026-07-30T10:00:00+00:00',
            'cascade', NULL
        )
        """,
        (TARGET_JOB_ID,),
    )

    conn.execute(
        "DELETE FROM jobs WHERE url = ?",
        (url,),
    )

    assert conn.execute(
        "SELECT COUNT(*) FROM jobctrl_deleted_jobs"
    ).fetchone()[0] == 0
