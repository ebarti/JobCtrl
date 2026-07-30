"""Schema-v25 OutreachThread stable JobId contracts."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

import pytest

import jobctrl.database as database_module
from jobctrl.database import (
    SCHEMA_VERSION,
    ensure_contact_tables,
    ensure_outreach_references_v25,
    init_db,
    reassign_discovery_identity_references,
)
from jobctrl.domain.contact.outreach import OutreachThread
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.contact.outreach_repository import (
    SqliteOutreachThreadRepository,
)
from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus

PREVIOUS_SCHEMA_VERSION = 24
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


def _downgrade_outreach_table_to_v24(
    conn: sqlite3.Connection,
) -> None:
    conn.commit()
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("DROP TABLE outreach_threads")
    database_module._create_outreach_threads_table_v25(
        conn,
        table="outreach_threads",
        stable_reference=False,
    )
    conn.execute(
        """
        CREATE INDEX idx_outreach_threads_contact
        ON outreach_threads(tenant_id, contact_id)
        """
    )
    conn.execute(
        f"PRAGMA user_version = {PREVIOUS_SCHEMA_VERSION}"
    )
    conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")


def _seed_v24_database(db_path: Path) -> sqlite3.Connection:
    conn = init_db(db_path)
    conn.row_factory = sqlite3.Row
    _downgrade_outreach_table_to_v24(conn)
    return conn


def _history_snapshot(
    conn: sqlite3.Connection,
) -> dict[str, list[tuple[Any, ...]]]:
    return {
        table: [
            tuple(row)
            for row in conn.execute(
                f'SELECT * FROM "{table}" ORDER BY tenant_id, rowid'
            ).fetchall()
        ]
        for table in database_module._OUTREACH_HISTORY_TABLES
    }


def test_v24_rows_migrate_exactly_with_url_first_resolution(
    tmp_path: Path,
) -> None:
    conn = _seed_v24_database(tmp_path / "jobs.db")
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
        INSERT INTO outreach_threads (
            tenant_id, thread_id, contact_id, job_url,
            created_at, updated_at, follow_up_due_at,
            follow_up_basis, follow_up_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            (
                "local",
                "thread:uuid-url",
                "contact:uuid-url",
                UUID_SHAPED_URL,
                NOW,
                NOW,
                NOW,
                "application_submitted",
                "scheduled",
            ),
            (
                "local",
                "thread:alias",
                "contact:alias",
                prior_alias,
                NOW,
                NOW,
                None,
                None,
                "none",
            ),
            (
                "local",
                "thread:contact-only",
                "contact:only",
                None,
                NOW,
                NOW,
                None,
                None,
                "none",
            ),
            (
                "blue",
                "thread:blue",
                "contact:blue",
                blue_target_url,
                NOW,
                NOW,
                None,
                None,
                "none",
            ),
        ),
    )
    conn.execute(
        """
        INSERT INTO outreach_drafts (
            tenant_id, draft_id, thread_id, generation, kind,
            status, body_text, gate_results_json, provenance_json,
            created_at
        ) VALUES (
            'local', 'draft:exact', 'thread:uuid-url', 1,
            'intro_request', 'approved', 'private:exact',
            '{"passed":true}', '[{"source":"private:exact"}]', ?
        )
        """,
        (NOW,),
    )
    conn.execute(
        """
        INSERT INTO outreach_send_logs (
            tenant_id, send_log_id, thread_id, draft_id,
            channel, sent_at, logged_at
        ) VALUES (
            'local', 'send:exact', 'thread:uuid-url',
            'draft:exact', 'other', ?, ?
        )
        """,
        (NOW, NOW),
    )
    conn.commit()
    before_drafts = [
        tuple(row)
        for row in conn.execute(
            "SELECT * FROM outreach_drafts ORDER BY rowid"
        ).fetchall()
    ]
    before_send_logs = [
        tuple(row)
        for row in conn.execute(
            "SELECT * FROM outreach_send_logs ORDER BY rowid"
        ).fetchall()
    ]

    assert ensure_outreach_references_v25(conn) == list(
        database_module._OUTREACH_REFERENCE_TABLES
    )

    assert (
        conn.execute("PRAGMA user_version").fetchone()[0]
        == SCHEMA_VERSION
        == 25
    )
    assert database_module._has_outreach_reference_schema_v25(
        conn
    )
    assert [
        tuple(row)
        for row in conn.execute(
            """
            SELECT tenant_id, thread_id, job_id
            FROM outreach_threads
            ORDER BY tenant_id, thread_id
            """
        ).fetchall()
    ] == [
        ("blue", "thread:blue", TARGET_JOB_ID),
        ("local", "thread:alias", PRIOR_JOB_ID),
        ("local", "thread:contact-only", None),
        ("local", "thread:uuid-url", TARGET_JOB_ID),
    ]
    assert [
        tuple(row)
        for row in conn.execute(
            "SELECT * FROM outreach_drafts ORDER BY rowid"
        ).fetchall()
    ] == before_drafts
    assert [
        tuple(row)
        for row in conn.execute(
            "SELECT * FROM outreach_send_logs ORDER BY rowid"
        ).fetchall()
    ] == before_send_logs
    assert {
        str(row[6]).upper()
        for row in conn.execute(
            'PRAGMA foreign_key_list("outreach_threads")'
        ).fetchall()
    } == {"RESTRICT"}
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None


def test_verification_failure_rolls_back_and_retry_succeeds(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn = _seed_v24_database(tmp_path / "retry.db")
    job_url = "https://careers.example.test/retry"
    _insert_job(conn, url=job_url, job_id=TARGET_JOB_ID)
    conn.execute(
        """
        INSERT INTO outreach_threads (
            tenant_id, thread_id, contact_id, job_url,
            created_at, updated_at
        ) VALUES (
            'local', 'thread:retry', 'contact:retry', ?, ?, ?
        )
        """,
        (job_url, NOW, NOW),
    )
    conn.execute(
        """
        INSERT INTO outreach_drafts (
            tenant_id, draft_id, thread_id, generation, kind,
            status, created_at
        ) VALUES (
            'local', 'draft:retry', 'thread:retry', 1,
            'intro_request', 'candidate', ?
        )
        """,
        (NOW,),
    )
    conn.commit()
    before = _history_snapshot(conn)
    original_verify = database_module._verify_outreach_references_v25

    def _fail_verification(
        _conn: sqlite3.Connection,
        *,
        expected_counts: dict[str, int],
    ) -> None:
        del expected_counts
        raise RuntimeError("injected outreach verification failure")

    monkeypatch.setattr(
        database_module,
        "_verify_outreach_references_v25",
        _fail_verification,
    )
    with pytest.raises(
        RuntimeError,
        match="injected outreach verification failure",
    ):
        ensure_outreach_references_v25(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 24
    assert _history_snapshot(conn) == before
    assert "job_url" in _columns(conn, "outreach_threads")
    assert {
        str(row[0])
        for row in conn.execute(
            """
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name LIKE '%_v25'
            """
        ).fetchall()
    } == set()
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1

    monkeypatch.setattr(
        database_module,
        "_verify_outreach_references_v25",
        original_verify,
    )
    ensure_outreach_references_v25(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 25
    assert conn.execute(
        "SELECT job_id FROM outreach_threads"
    ).fetchone()[0] == TARGET_JOB_ID


@pytest.mark.parametrize(
    ("schema_version", "expected_reference"),
    ((0, "job_url"), (24, "job_url"), (25, "job_id")),
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

    ensure_contact_tables(conn)

    assert expected_reference in _columns(
        conn,
        "outreach_threads",
    )
    if schema_version == 25:
        assert database_module._has_outreach_reference_schema_v25(
            conn
        )


def test_stamped_v25_legacy_table_fails_closed() -> None:
    conn = sqlite3.connect(":memory:")
    conn.executescript(
        """
        CREATE TABLE jobs (
            url TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL DEFAULT 'local',
            job_id TEXT NOT NULL,
            UNIQUE (tenant_id, job_id)
        );
        PRAGMA user_version = 24;
        """
    )
    ensure_contact_tables(conn)
    conn.execute("PRAGMA user_version = 25")

    with pytest.raises(
        RuntimeError,
        match="Schema v25 requires stable outreach",
    ):
        ensure_contact_tables(conn)


def test_runtime_collision_rehomes_authority_and_url_projections(
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "collision.db")
    conn.row_factory = sqlite3.Row
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
        INSERT INTO outreach_threads (
            tenant_id, thread_id, contact_id, job_id,
            created_at, updated_at, follow_up_due_at,
            follow_up_basis, follow_up_state
        ) VALUES (
            'local', 'thread:collision', 'contact:collision', ?,
            ?, ?, ?, 'application_submitted', 'scheduled'
        )
        """,
        (TARGET_JOB_ID, NOW, NOW, NOW),
    )
    conn.execute(
        """
        INSERT INTO outreach_drafts (
            tenant_id, draft_id, thread_id, generation, kind,
            status, created_at
        ) VALUES (
            'local', 'draft:collision', 'thread:collision', 1,
            'intro_request', 'candidate', ?
        )
        """,
        (NOW,),
    )
    conn.execute(
        """
        INSERT INTO outreach_thread_projections (
            tenant_id, thread_id, contact_id, job_id, draft_count,
            latest_generation, has_approved_draft, drafts_json,
            created_at, updated_at, last_updated_at
        ) VALUES (
            'local', 'thread:collision', 'contact:collision', ?, 1,
            1, 0, '[]', ?, ?, ?
        )
        """,
        (losing_url, NOW, NOW, NOW),
    )
    conn.execute(
        """
        INSERT INTO due_follow_up_projections (
            tenant_id, thread_id, contact_id, job_id, due_at,
            basis, state, created_at, updated_at, last_updated_at
        ) VALUES (
            'local', 'thread:collision', 'contact:collision', ?, ?,
            'application_submitted', 'scheduled', ?, ?, ?
        )
        """,
        (losing_url, NOW, NOW, NOW, NOW),
    )
    conn.commit()

    reassign_discovery_identity_references(
        conn,
        losing_job_url=losing_url,
        surviving_job_url=surviving_url,
    )

    assert conn.execute(
        "SELECT job_id FROM outreach_threads"
    ).fetchone()[0] == SURVIVOR_JOB_ID
    assert conn.execute(
        "SELECT job_id FROM outreach_thread_projections"
    ).fetchone()[0] == surviving_url
    assert conn.execute(
        "SELECT job_id FROM due_follow_up_projections"
    ).fetchone()[0] == surviving_url
    assert conn.execute(
        "SELECT COUNT(*) FROM outreach_drafts"
    ).fetchone()[0] == 1
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None


def test_runtime_repository_resolves_uuid_shaped_url_before_job_id(
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "repository.db")
    conn.row_factory = sqlite3.Row
    _insert_job(
        conn,
        url=UUID_SHAPED_URL,
        job_id=TARGET_JOB_ID,
    )
    _insert_job(
        conn,
        url="https://careers.example.test/uuid-id-owner",
        job_id=COLLIDING_JOB_ID,
    )
    conn.commit()
    repository = SqliteOutreachThreadRepository(
        conn,
        publisher=InProcessEventBus(),
    )

    repository.save(
        LOCAL_TENANT,
        OutreachThread(
            tenant_id=LOCAL_TENANT,
            thread_id="thread:runtime",
            contact_id="contact:runtime",
            job_id=UUID_SHAPED_URL,
            created_at=NOW,
            updated_at=NOW,
        ),
    )

    assert conn.execute(
        """
        SELECT job_id FROM outreach_threads
        WHERE thread_id = 'thread:runtime'
        """
    ).fetchone()[0] == TARGET_JOB_ID
    loaded = repository.load(LOCAL_TENANT, "thread:runtime")
    assert loaded is not None
    assert loaded.job_id == UUID_SHAPED_URL


def test_direct_job_delete_is_restricted_until_thread_is_detached(
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "restrict.db")
    conn.execute("PRAGMA foreign_keys = ON")
    job_url = "https://careers.example.test/restrict"
    _insert_job(conn, url=job_url, job_id=TARGET_JOB_ID)
    conn.execute(
        """
        INSERT INTO outreach_threads (
            tenant_id, thread_id, contact_id, job_id,
            created_at, updated_at
        ) VALUES (
            'local', 'thread:restrict', 'contact:restrict', ?, ?, ?
        )
        """,
        (TARGET_JOB_ID, NOW, NOW),
    )
    conn.commit()

    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("DELETE FROM jobs WHERE url = ?", (job_url,))

    assert conn.execute(
        "SELECT COUNT(*) FROM outreach_threads"
    ).fetchone()[0] == 1
