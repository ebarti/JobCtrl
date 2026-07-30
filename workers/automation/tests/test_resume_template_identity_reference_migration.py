"""Schema-v17 resume-template JobId reference contracts."""

from __future__ import annotations

import sqlite3
import uuid
from pathlib import Path

import pytest

import jobctrl.database as database_module
from jobctrl.database import (
    SCHEMA_VERSION,
    close_connection,
    ensure_resume_template_references_v17,
    init_db,
    reassign_discovery_identity_references,
)
from jobctrl.domain.discovery import (
    Employer,
    Job,
    JobMetadata,
    PostingUrl,
    SearchStrategy,
    Source,
)
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.discovery import SqliteJobRepository
from jobctrl.infrastructure.materials import SqliteMaterialsRepository


PREVIOUS_SCHEMA_VERSION = 16
BUILT_IN_TEMPLATE = "built_in:modern-html"
BUILT_IN_VERSION = "built_in:modern-html:v1"
CUSTOM_TEMPLATE = "template:compact"
CUSTOM_VERSION = "template:compact:v1"


def _discovered_job(posting_url: str, job_id: JobId) -> Job:
    return Job.discover(
        tenant_id=LOCAL_TENANT,
        job_id=job_id,
        posting_url=PostingUrl(value=posting_url),
        source=Source(board="example"),
        employer=Employer(name="Example"),
        search_strategy=SearchStrategy.JOBSPY,
        metadata=JobMetadata(title="Platform Engineer"),
        discovered_at="2026-07-29T10:00:00+00:00",
    )


def _insert_custom_template(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        INSERT OR IGNORE INTO resume_templates (
            tenant_id, template_id, display_name, status, built_in,
            created_at, updated_at
        ) VALUES (
            'local', ?, 'Compact', 'active', 0,
            '2026-07-29T09:00:00+00:00',
            '2026-07-29T09:00:00+00:00'
        )
        """,
        (CUSTOM_TEMPLATE,),
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO resume_template_versions (
            tenant_id, version_id, template_id, version_number,
            display_name, status, theme_json, layout_json,
            content_hash, created_at
        ) VALUES (
            'local', ?, ?, 1, 'Compact', 'active', '{}', '{}',
            'compact-hash', '2026-07-29T09:00:00+00:00'
        )
        """,
        (CUSTOM_VERSION, CUSTOM_TEMPLATE),
    )


def _downgrade_resume_template_references_to_v16(
    conn: sqlite3.Connection,
) -> None:
    conn.execute("DROP TABLE job_resume_template_assignments")
    conn.execute("DROP TABLE resume_template_refresh_attempts")
    conn.executescript(
        """
        CREATE TABLE job_resume_template_assignments (
            tenant_id   TEXT NOT NULL DEFAULT 'local',
            job_url     TEXT NOT NULL,
            template_id TEXT NOT NULL,
            version_id  TEXT NOT NULL,
            updated_at  TEXT NOT NULL,
            PRIMARY KEY (tenant_id, job_url)
        );
        CREATE INDEX idx_job_resume_template_assignments_template
            ON job_resume_template_assignments(
                tenant_id, template_id, version_id
            );
        CREATE TABLE resume_template_refresh_attempts (
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            attempt_id          TEXT NOT NULL,
            job_url             TEXT NOT NULL,
            status              TEXT NOT NULL,
            from_generation     INTEGER,
            to_generation       INTEGER,
            template_id         TEXT,
            template_version_id TEXT,
            template_hash       TEXT,
            error_message       TEXT,
            metadata_json       TEXT NOT NULL DEFAULT '{}',
            created_at          TEXT NOT NULL,
            completed_at        TEXT,
            PRIMARY KEY (tenant_id, attempt_id)
        );
        CREATE INDEX idx_resume_template_refresh_attempts_job
            ON resume_template_refresh_attempts(
                tenant_id, job_url, created_at DESC
            );
        """
    )
    conn.execute(f"PRAGMA user_version = {PREVIOUS_SCHEMA_VERSION}")
    conn.commit()


def _insert_assignment(
    conn: sqlite3.Connection,
    *,
    job_url: str,
    template_id: str,
    version_id: str,
    updated_at: str,
) -> None:
    conn.execute(
        """
        INSERT INTO job_resume_template_assignments (
            tenant_id, job_url, template_id, version_id, updated_at
        ) VALUES ('local', ?, ?, ?, ?)
        """,
        (job_url, template_id, version_id, updated_at),
    )


def _insert_attempt(
    conn: sqlite3.Connection,
    *,
    attempt_id: str,
    job_url: str,
    created_at: str,
) -> None:
    conn.execute(
        """
        INSERT INTO resume_template_refresh_attempts (
            tenant_id, attempt_id, job_url, status, from_generation,
            to_generation, template_id, template_version_id,
            template_hash, error_message, metadata_json, created_at,
            completed_at
        ) VALUES (
            'local', ?, ?, 'completed', 1, 2, ?, ?, 'compact-hash',
            NULL, '{"source":"test"}', ?, ?
        )
        """,
        (
            attempt_id,
            job_url,
            CUSTOM_TEMPLATE,
            CUSTOM_VERSION,
            created_at,
            created_at,
        ),
    )


def _columns(
    conn: sqlite3.Connection,
    table_name: str,
) -> set[str]:
    return {
        str(row[1])
        for row in conn.execute(
            f'PRAGMA table_info("{table_name}")'
        ).fetchall()
    }


def test_v16_template_references_migrate_aliases_and_uuid_urls(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    jobs = SqliteJobRepository(conn)
    stable_job_id = JobId(str(uuid.uuid4()))
    original_url = "https://boards.example/jobs/123"
    current_url = "https://careers.example/jobs/platform"
    jobs.save(_discovered_job(original_url, stable_job_id))
    jobs.save(_discovered_job(current_url, stable_job_id))

    uuid_shaped_url = str(uuid.uuid4())
    uuid_url_owner = JobId(str(uuid.uuid4()))
    jobs.save(_discovered_job(uuid_shaped_url, uuid_url_owner))
    jobs.save(
        _discovered_job(
            "https://example.com/jobs/id-text-owner",
            JobId(uuid_shaped_url),
        )
    )
    _insert_custom_template(conn)
    _downgrade_resume_template_references_to_v16(conn)
    _insert_assignment(
        conn,
        job_url=original_url,
        template_id=BUILT_IN_TEMPLATE,
        version_id=BUILT_IN_VERSION,
        updated_at="2026-07-29T10:00:00+00:00",
    )
    _insert_assignment(
        conn,
        job_url=current_url,
        template_id=CUSTOM_TEMPLATE,
        version_id=CUSTOM_VERSION,
        updated_at="2026-07-29T10:01:00+00:00",
    )
    _insert_assignment(
        conn,
        job_url=uuid_shaped_url,
        template_id=BUILT_IN_TEMPLATE,
        version_id=BUILT_IN_VERSION,
        updated_at="2026-07-29T10:02:00+00:00",
    )
    _insert_attempt(
        conn,
        attempt_id="attempt-original",
        job_url=original_url,
        created_at="2026-07-29T10:00:00+00:00",
    )
    _insert_attempt(
        conn,
        attempt_id="attempt-current",
        job_url=current_url,
        created_at="2026-07-29T10:01:00+00:00",
    )
    _insert_attempt(
        conn,
        attempt_id="attempt-uuid-url",
        job_url=uuid_shaped_url,
        created_at="2026-07-29T10:02:00+00:00",
    )
    conn.commit()
    close_connection(db_path)

    reopened = init_db(db_path)

    assert (
        reopened.execute("PRAGMA user_version").fetchone()[0]
        == SCHEMA_VERSION
        == 23
    )
    for table in database_module._RESUME_TEMPLATE_REFERENCE_TABLES:
        assert "job_id" in _columns(reopened, table)
        assert "job_url" not in _columns(reopened, table)
    assert reopened.execute(
        "SELECT COUNT(*) FROM job_resume_template_assignments"
    ).fetchone()[0] == 2
    assert reopened.execute(
        "SELECT COUNT(*) FROM resume_template_refresh_attempts"
    ).fetchone()[0] == 3
    assignment = reopened.execute(
        """
        SELECT template_id, version_id
        FROM job_resume_template_assignments
        WHERE tenant_id = 'local' AND job_id = ?
        """,
        (str(stable_job_id),),
    ).fetchone()
    assert tuple(assignment) == (CUSTOM_TEMPLATE, CUSTOM_VERSION)
    uuid_owner = reopened.execute(
        """
        SELECT job_id
        FROM job_resume_template_assignments
        WHERE template_id = ? AND job_id != ?
        """,
        (BUILT_IN_TEMPLATE, str(stable_job_id)),
    ).fetchone()
    assert uuid_owner[0] == str(uuid_url_owner)
    assert {
        row[0]
        for row in reopened.execute(
            """
            SELECT job_id
            FROM resume_template_refresh_attempts
            WHERE attempt_id IN ('attempt-original', 'attempt-current')
            """
        ).fetchall()
    } == {str(stable_job_id)}
    effective = SqliteMaterialsRepository(
        reopened
    ).resolve_effective_resume_template(stable_job_id)
    assert effective["metadata"]["templateId"] == CUSTOM_TEMPLATE
    assert effective["metadata"]["assignmentSource"] == "job_override"
    assert reopened.execute("PRAGMA foreign_key_check").fetchone() is None
    close_connection(db_path)

    reopened_again = init_db(db_path)
    assert reopened_again.execute(
        "SELECT COUNT(*) FROM resume_template_refresh_attempts"
    ).fetchone()[0] == 3
    close_connection(db_path)


def test_v17_template_reference_migration_rolls_back_and_retries(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    job_id = JobId(str(uuid.uuid4()))
    job_url = "https://example.com/jobs/retry"
    SqliteJobRepository(conn).save(_discovered_job(job_url, job_id))
    _downgrade_resume_template_references_to_v16(conn)
    _insert_assignment(
        conn,
        job_url=job_url,
        template_id=BUILT_IN_TEMPLATE,
        version_id=BUILT_IN_VERSION,
        updated_at="2026-07-29T10:00:00+00:00",
    )
    conn.commit()
    original_verify = (
        database_module._verify_resume_template_references_v17
    )

    def _fail_verification(
        _conn: sqlite3.Connection,
        *,
        expected_counts: dict[str, int],
    ) -> None:
        del expected_counts
        raise RuntimeError("injected template verification failure")

    monkeypatch.setattr(
        database_module,
        "_verify_resume_template_references_v17",
        _fail_verification,
    )
    with pytest.raises(
        RuntimeError,
        match="injected template verification failure",
    ):
        ensure_resume_template_references_v17(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 16
    assert "job_url" in _columns(
        conn,
        "job_resume_template_assignments",
    )
    assert conn.execute(
        "SELECT COUNT(*) FROM job_resume_template_assignments"
    ).fetchone()[0] == 1

    monkeypatch.setattr(
        database_module,
        "_verify_resume_template_references_v17",
        original_verify,
    )
    assert ensure_resume_template_references_v17(conn) == list(
        database_module._RESUME_TEMPLATE_REFERENCE_TABLES
    )
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 17
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None
    close_connection(db_path)


def test_runtime_template_reference_merge_keeps_latest_assignment_and_attempts(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    jobs = SqliteJobRepository(conn)
    losing_id = JobId(str(uuid.uuid4()))
    surviving_id = JobId(str(uuid.uuid4()))
    other_tenant_job_id = JobId(str(uuid.uuid4()))
    losing_url = "https://example.com/jobs/losing"
    surviving_url = "https://example.com/jobs/surviving"
    jobs.save(_discovered_job(losing_url, losing_id))
    jobs.save(_discovered_job(surviving_url, surviving_id))
    conn.execute(
        """
        INSERT INTO jobs (
            url, tenant_id, job_id, title, company, site, strategy,
            discovered_at
        ) VALUES (?, 'tenant-b', ?, 'Platform Engineer', 'Example',
                  'example', 'jobspy', ?)
        """,
        (
            "https://tenant-b.example/jobs/stable",
            str(other_tenant_job_id),
            "2026-07-29T10:00:00+00:00",
        ),
    )
    _insert_custom_template(conn)
    conn.executemany(
        """
        INSERT INTO job_resume_template_assignments (
            tenant_id, job_id, template_id, version_id, updated_at
        ) VALUES ('local', ?, ?, ?, ?)
        """,
        (
            (
                str(surviving_id),
                BUILT_IN_TEMPLATE,
                BUILT_IN_VERSION,
                "2026-07-29T10:00:00+00:00",
            ),
            (
                str(losing_id),
                CUSTOM_TEMPLATE,
                CUSTOM_VERSION,
                "2026-07-29T10:01:00+00:00",
            ),
        ),
    )
    conn.executemany(
        """
        INSERT INTO job_materials (
            tenant_id, job_id, generation, status, created_at, updated_at,
            last_validation_json, last_verdict_json, metadata_json
        ) VALUES (?, ?, 1, 'resume_approved', ?, ?, '{}', '{}', '{}')
        """,
        (
            (
                "local",
                str(surviving_id),
                "2026-07-29T10:00:00+00:00",
                "2026-07-29T10:00:00+00:00",
            ),
            (
                "local",
                str(losing_id),
                "2026-07-29T10:01:00+00:00",
                "2026-07-29T10:01:00+00:00",
            ),
            (
                "tenant-b",
                str(other_tenant_job_id),
                "2026-07-29T10:02:00+00:00",
                "2026-07-29T10:02:00+00:00",
            ),
        ),
    )
    conn.executemany(
        """
        INSERT INTO resume_template_refresh_attempts (
            tenant_id, attempt_id, job_id, status, from_generation,
            to_generation, metadata_json, created_at
        ) VALUES (?, ?, ?, 'completed', ?, ?, '{}', ?)
        """,
        (
            (
                "local",
                "attempt-surviving",
                str(surviving_id),
                1,
                None,
                "2026-07-29T10:00:00+00:00",
            ),
            (
                "local",
                "attempt-losing",
                str(losing_id),
                1,
                1,
                "2026-07-29T10:01:00+00:00",
            ),
            (
                "tenant-b",
                "attempt-other-tenant",
                str(other_tenant_job_id),
                1,
                1,
                "2026-07-29T10:02:00+00:00",
            ),
        ),
    )
    conn.commit()

    reassign_discovery_identity_references(
        conn,
        losing_job_url=losing_url,
        surviving_job_url=surviving_url,
    )

    assignment = conn.execute(
        """
        SELECT job_id, template_id, version_id
        FROM job_resume_template_assignments
        """
    ).fetchone()
    assert tuple(assignment) == (
        str(surviving_id),
        CUSTOM_TEMPLATE,
        CUSTOM_VERSION,
    )
    attempts = conn.execute(
        """
        SELECT attempt_id, job_id, from_generation, to_generation
        FROM resume_template_refresh_attempts
        WHERE tenant_id = 'local'
        ORDER BY attempt_id
        """
    ).fetchall()
    assert [tuple(row) for row in attempts] == [
        ("attempt-losing", str(surviving_id), 2, 2),
        ("attempt-surviving", str(surviving_id), 1, None),
    ]
    assert tuple(
        conn.execute(
            """
            SELECT job_id, from_generation, to_generation
            FROM resume_template_refresh_attempts
            WHERE tenant_id = 'tenant-b'
              AND attempt_id = 'attempt-other-tenant'
            """
        ).fetchone()
    ) == (str(other_tenant_job_id), 1, 1)
    assert [
        tuple(row)
        for row in conn.execute(
            """
            SELECT generation, created_at
            FROM job_materials
            WHERE tenant_id = 'local' AND job_id = ?
            ORDER BY generation
            """,
            (str(surviving_id),),
        ).fetchall()
    ] == [
        (1, "2026-07-29T10:00:00+00:00"),
        (2, "2026-07-29T10:01:00+00:00"),
    ]
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None
    close_connection(db_path)
