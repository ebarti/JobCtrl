"""Schema-v24 Contact and contact-research stable JobId contracts."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

import pytest

import jobctrl.database as database_module
from jobctrl.database import (
    ensure_contact_research_references_v24,
    ensure_contact_tables,
    init_db,
    reassign_discovery_identity_references,
)

PREVIOUS_SCHEMA_VERSION = 23
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


def _downgrade_contact_tables_to_v23(
    conn: sqlite3.Connection,
) -> None:
    conn.commit()
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.executescript(
        """
        DROP TABLE contacts;
        DROP TABLE contact_research_tasks;
        """
    )
    database_module._create_contacts_table_v24(
        conn,
        table="contacts",
        stable_reference=False,
    )
    database_module._create_contact_research_tasks_table_v24(
        conn,
        table="contact_research_tasks",
        stable_reference=False,
    )
    conn.executescript(
        """
        CREATE INDEX idx_contacts_lookup
        ON contacts(tenant_id, employer, job_url);
        CREATE INDEX idx_contact_research_tasks_lookup
        ON contact_research_tasks(tenant_id, employer, job_url);
        """
    )
    conn.execute(
        f"PRAGMA user_version = {PREVIOUS_SCHEMA_VERSION}"
    )
    conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")


def _seed_v23_database(db_path: Path) -> sqlite3.Connection:
    conn = init_db(db_path)
    conn.row_factory = sqlite3.Row
    _downgrade_contact_tables_to_v23(conn)
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
        for table in database_module._CONTACT_RESEARCH_HISTORY_TABLES
    }


def test_v23_rows_migrate_exactly_with_url_first_resolution(
    tmp_path: Path,
) -> None:
    conn = _seed_v23_database(tmp_path / "jobs.db")
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
        INSERT INTO contacts (
            tenant_id, contact_id, employer, job_url, role,
            created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            (
                "local",
                "contact:uuid-url",
                "ExampleCo",
                UUID_SHAPED_URL,
                "recruiter",
                NOW,
                NOW,
                None,
            ),
            (
                "local",
                "contact:employer-only",
                "ExampleCo",
                None,
                "hiring_manager",
                NOW,
                NOW,
                None,
            ),
            (
                "blue",
                "contact:blue",
                "BlueCo",
                blue_target_url,
                "other",
                NOW,
                NOW,
                None,
            ),
        ),
    )
    conn.execute(
        """
        INSERT INTO contact_attributes (
            tenant_id, attribute_id, contact_id, attribute_kind,
            value_json, source_kind, source_ref, capture_method,
            confidence, user_confirmed, recorded_at
        ) VALUES (
            'local', 'attribute:exact', 'contact:uuid-url', 'note',
            '"private:exact"', 'user_entered', 'user_entered',
            'manual', 1, 1, ?
        )
        """,
        (NOW,),
    )
    conn.executemany(
        """
        INSERT INTO contact_research_tasks (
            tenant_id, task_id, employer, job_url, status,
            source_attempts_json, started_at, updated_at,
            needs_review_at, completed_at, failed_at, error_class
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            (
                "local",
                "task:alias",
                "ExampleCo",
                prior_alias,
                "needs_review",
                '[{"sourceRef":"private:exact"}]',
                NOW,
                NOW,
                NOW,
                None,
                None,
                None,
            ),
            (
                "local",
                "task:employer-only",
                "ExampleCo",
                None,
                "queued",
                "[]",
                None,
                NOW,
                None,
                None,
                None,
                None,
            ),
        ),
    )
    conn.execute(
        """
        INSERT INTO contact_candidates (
            tenant_id, candidate_id, task_id, role, attributes_json,
            source_kind, source_ref, capture_method, confidence,
            status, proposed_at
        ) VALUES (
            'local', 'candidate:exact', 'task:alias', 'recruiter',
            '[{"value":"private:exact"}]', 'public_web_page',
            'https://example.test/team', 'llm_assisted', 0.8,
            'needs_review', ?
        )
        """,
        (NOW,),
    )
    conn.commit()
    before_attributes = [
        tuple(row)
        for row in conn.execute(
            "SELECT * FROM contact_attributes ORDER BY rowid"
        ).fetchall()
    ]
    before_candidates = [
        tuple(row)
        for row in conn.execute(
            "SELECT * FROM contact_candidates ORDER BY rowid"
        ).fetchall()
    ]

    assert ensure_contact_research_references_v24(conn) == list(
        database_module._CONTACT_RESEARCH_REFERENCE_TABLES
    )

    assert conn.execute("PRAGMA user_version").fetchone()[0] == 24
    assert (
        database_module._has_contact_research_reference_schema_v24(
            conn
        )
    )
    assert [
        tuple(row)
        for row in conn.execute(
            """
            SELECT tenant_id, contact_id, job_id
            FROM contacts
            ORDER BY tenant_id, contact_id
            """
        ).fetchall()
    ] == [
        ("blue", "contact:blue", TARGET_JOB_ID),
        ("local", "contact:employer-only", None),
        ("local", "contact:uuid-url", TARGET_JOB_ID),
    ]
    assert [
        tuple(row)
        for row in conn.execute(
            """
            SELECT task_id, job_id
            FROM contact_research_tasks
            ORDER BY task_id
            """
        ).fetchall()
    ] == [
        ("task:alias", PRIOR_JOB_ID),
        ("task:employer-only", None),
    ]
    assert [
        tuple(row)
        for row in conn.execute(
            "SELECT * FROM contact_attributes ORDER BY rowid"
        ).fetchall()
    ] == before_attributes
    assert [
        tuple(row)
        for row in conn.execute(
            "SELECT * FROM contact_candidates ORDER BY rowid"
        ).fetchall()
    ] == before_candidates
    for table in database_module._CONTACT_RESEARCH_REFERENCE_TABLES:
        actions = {
            str(row[6]).upper()
            for row in conn.execute(
                f'PRAGMA foreign_key_list("{table}")'
            ).fetchall()
        }
        assert actions == {"RESTRICT"}
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None


def test_verification_failure_rolls_back_and_retry_succeeds(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn = _seed_v23_database(tmp_path / "retry.db")
    job_url = "https://careers.example.test/retry"
    _insert_job(conn, url=job_url, job_id=TARGET_JOB_ID)
    conn.execute(
        """
        INSERT INTO contacts (
            tenant_id, contact_id, employer, job_url, role,
            created_at, updated_at
        ) VALUES ('local', 'contact:retry', 'ExampleCo', ?,
                  'other', ?, ?)
        """,
        (job_url, NOW, NOW),
    )
    conn.execute(
        """
        INSERT INTO contact_research_tasks (
            tenant_id, task_id, employer, job_url, status, updated_at
        ) VALUES (
            'local', 'task:retry', 'ExampleCo', ?, 'queued', ?
        )
        """,
        (job_url, NOW),
    )
    conn.commit()
    before = _history_snapshot(conn)
    original_verify = (
        database_module._verify_contact_research_references_v24
    )

    def _fail_verification(
        _conn: sqlite3.Connection,
        *,
        expected_counts: dict[str, int],
    ) -> None:
        del expected_counts
        raise RuntimeError("injected contact verification failure")

    monkeypatch.setattr(
        database_module,
        "_verify_contact_research_references_v24",
        _fail_verification,
    )
    with pytest.raises(
        RuntimeError,
        match="injected contact verification failure",
    ):
        ensure_contact_research_references_v24(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 23
    assert _history_snapshot(conn) == before
    assert "job_url" in _columns(conn, "contacts")
    assert "job_url" in _columns(conn, "contact_research_tasks")
    assert {
        str(row[0])
        for row in conn.execute(
            """
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name LIKE '%_v24'
            """
        ).fetchall()
    } == set()
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1

    monkeypatch.setattr(
        database_module,
        "_verify_contact_research_references_v24",
        original_verify,
    )
    ensure_contact_research_references_v24(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 24
    assert conn.execute(
        "SELECT job_id FROM contacts"
    ).fetchone()[0] == TARGET_JOB_ID


@pytest.mark.parametrize(
    ("schema_version", "expected_reference"),
    ((0, "job_url"), (23, "job_url"), (24, "job_id")),
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

    assert expected_reference in _columns(conn, "contacts")
    assert expected_reference in _columns(
        conn,
        "contact_research_tasks",
    )
    if schema_version == 24:
        assert (
            database_module._has_contact_research_reference_schema_v24(
                conn
            )
        )


def test_stamped_v24_legacy_tables_fail_closed() -> None:
    conn = sqlite3.connect(":memory:")
    conn.executescript(
        """
        CREATE TABLE jobs (
            url TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL DEFAULT 'local',
            job_id TEXT NOT NULL,
            UNIQUE (tenant_id, job_id)
        );
        PRAGMA user_version = 23;
        """
    )
    ensure_contact_tables(conn)
    conn.execute("PRAGMA user_version = 24")

    with pytest.raises(
        RuntimeError,
        match="Schema v24 requires stable contact",
    ):
        ensure_contact_tables(conn)


def test_runtime_collision_rehomes_authorities_and_url_projections(
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
        INSERT INTO contacts (
            tenant_id, contact_id, employer, job_id, role,
            created_at, updated_at
        ) VALUES (
            'local', 'contact:collision', 'ExampleCo', ?,
            'other', ?, ?
        )
        """,
        (TARGET_JOB_ID, NOW, NOW),
    )
    conn.execute(
        """
        INSERT INTO contact_research_tasks (
            tenant_id, task_id, employer, job_id, status, updated_at
        ) VALUES (
            'local', 'task:collision', 'ExampleCo', ?, 'queued', ?
        )
        """,
        (TARGET_JOB_ID, NOW),
    )
    conn.execute(
        """
        INSERT INTO contact_projections (
            tenant_id, contact_id, employer, job_id, role,
            attribute_count, confirmed_count, source_kinds_json,
            provenance_json, updated_at, last_updated_at
        ) VALUES (
            'local', 'contact:collision', 'ExampleCo', ?, 'other',
            0, 0, '[]', '[]', ?, ?
        )
        """,
        (losing_url, NOW, NOW),
    )
    conn.execute(
        """
        INSERT INTO contact_research_task_projections (
            tenant_id, task_id, employer, job_id, status,
            candidate_count, needs_review_count, confirmed_count,
            source_attempts_json, candidates_json, updated_at,
            last_updated_at
        ) VALUES (
            'local', 'task:collision', 'ExampleCo', ?, 'queued',
            0, 0, 0, '[]', '[]', ?, ?
        )
        """,
        (losing_url, NOW, NOW),
    )
    conn.commit()

    reassign_discovery_identity_references(
        conn,
        losing_job_url=losing_url,
        surviving_job_url=surviving_url,
    )

    assert conn.execute(
        "SELECT job_id FROM contacts"
    ).fetchone()[0] == SURVIVOR_JOB_ID
    assert conn.execute(
        "SELECT job_id FROM contact_research_tasks"
    ).fetchone()[0] == SURVIVOR_JOB_ID
    assert conn.execute(
        "SELECT job_id FROM contact_projections"
    ).fetchone()[0] == surviving_url
    assert conn.execute(
        "SELECT job_id FROM contact_research_task_projections"
    ).fetchone()[0] == surviving_url
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None


def test_direct_job_delete_is_restricted_until_links_are_detached(
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "restrict.db")
    conn.execute("PRAGMA foreign_keys = ON")
    job_url = "https://careers.example.test/restrict"
    _insert_job(conn, url=job_url, job_id=TARGET_JOB_ID)
    conn.execute(
        """
        INSERT INTO contacts (
            tenant_id, contact_id, employer, job_id, role,
            created_at, updated_at
        ) VALUES (
            'local', 'contact:restrict', 'ExampleCo', ?,
            'other', ?, ?
        )
        """,
        (TARGET_JOB_ID, NOW, NOW),
    )
    conn.commit()

    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("DELETE FROM jobs WHERE url = ?", (job_url,))

    assert conn.execute(
        "SELECT COUNT(*) FROM contacts"
    ).fetchone()[0] == 1
