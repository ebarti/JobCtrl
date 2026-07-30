"""Schema-v20 Apply Review JobId reference contracts."""

from __future__ import annotations

import sqlite3
import uuid
from pathlib import Path

import pytest

import jobctrl.database as database_module
from jobctrl.database import (
    SCHEMA_VERSION,
    close_connection,
    ensure_application_review_references_v20,
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


PREVIOUS_SCHEMA_VERSION = 19


def _discovered_job(posting_url: str, job_id: JobId) -> Job:
    return Job.discover(
        tenant_id=LOCAL_TENANT,
        job_id=job_id,
        posting_url=PostingUrl(value=posting_url),
        source=Source(board="example"),
        employer=Employer(name="Example"),
        search_strategy=SearchStrategy.JOBSPY,
        metadata=JobMetadata(title="Platform Engineer"),
        discovered_at="2026-07-30T10:00:00+00:00",
    )


def _downgrade_application_review_references_to_v19(
    conn: sqlite3.Connection,
) -> None:
    conn.execute("DROP TABLE application_review_decisions")
    conn.executescript(
        """
        CREATE TABLE application_review_decisions (
            tenant_id                    TEXT NOT NULL DEFAULT 'local',
            decision_id                  TEXT NOT NULL,
            job_key                      TEXT NOT NULL,
            decision                     TEXT NOT NULL,
            reason                       TEXT,
            decided_by                   TEXT DEFAULT 'user',
            decided_at                   TEXT NOT NULL,
            materials_generation         INTEGER,
            profile_version              INTEGER,
            application_url              TEXT,
            partial_override_run_id      TEXT,
            email_recipient              TEXT,
            email_attachment_artifact_id TEXT,
            PRIMARY KEY (tenant_id, decision_id)
        );
        CREATE INDEX idx_application_review_decisions_job
        ON application_review_decisions(
            tenant_id,
            job_key,
            decided_at DESC
        );
        """
    )
    conn.execute(f"PRAGMA user_version = {PREVIOUS_SCHEMA_VERSION}")
    conn.commit()


def _insert_decision(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    decision_id: str,
    reference_column: str,
    reference: str,
    decision: str,
    decided_at: str,
) -> None:
    conn.execute(
        f"""
        INSERT INTO application_review_decisions (
            tenant_id,
            decision_id,
            {reference_column},
            decision,
            reason,
            decided_by,
            decided_at
        ) VALUES (?, ?, ?, ?, ?, 'user', ?)
        """,
        (
            tenant_id,
            decision_id,
            reference,
            decision,
            f"reason:{decision_id}",
            decided_at,
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


def test_v19_review_decisions_migrate_every_alias_and_uuid_url(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    jobs = SqliteJobRepository(conn)
    stable_job_id = JobId(str(uuid.uuid4()))
    storage_url = "https://boards.example/jobs/review"
    alias_url = "https://careers.example/jobs/review"
    jobs.save(_discovered_job(storage_url, stable_job_id))
    jobs.save(_discovered_job(alias_url, stable_job_id))

    uuid_shaped_url = str(uuid.uuid4())
    uuid_url_owner = JobId(str(uuid.uuid4()))
    jobs.save(_discovered_job(uuid_shaped_url, uuid_url_owner))
    jobs.save(
        _discovered_job(
            "https://example.com/jobs/id-text-owner",
            JobId(uuid_shaped_url),
        )
    )
    other_tenant_job_id = str(stable_job_id)
    other_tenant_url = "https://tenant-b.example/jobs/review"
    conn.execute(
        """
        INSERT INTO jobs (
            url, tenant_id, job_id, title, company, discovered_at
        ) VALUES (?, 'tenant-b', ?, 'Platform Engineer', 'Example', ?)
        """,
        (
            other_tenant_url,
            other_tenant_job_id,
            "2026-07-30T10:00:00+00:00",
        ),
    )

    _downgrade_application_review_references_to_v19(conn)
    _insert_decision(
        conn,
        tenant_id="local",
        decision_id="storage-decision",
        reference_column="job_key",
        reference=storage_url,
        decision="approve_dry_run",
        decided_at="2026-07-30T10:00:00+00:00",
    )
    _insert_decision(
        conn,
        tenant_id="local",
        decision_id="alias-decision",
        reference_column="job_key",
        reference=alias_url,
        decision="defer",
        decided_at="2026-07-30T10:01:00+00:00",
    )
    _insert_decision(
        conn,
        tenant_id="local",
        decision_id="shared-decision",
        reference_column="job_key",
        reference=uuid_shaped_url,
        decision="decline",
        decided_at="2026-07-30T10:02:00+00:00",
    )
    _insert_decision(
        conn,
        tenant_id="tenant-b",
        decision_id="shared-decision",
        reference_column="job_key",
        reference=other_tenant_url,
        decision="approve_submit",
        decided_at="2026-07-30T10:03:00+00:00",
    )
    conn.commit()
    close_connection(db_path)

    reopened = init_db(db_path)
    assert (
        reopened.execute("PRAGMA user_version").fetchone()[0]
        == SCHEMA_VERSION
        == 26
    )
    assert "job_id" in _columns(
        reopened,
        "application_review_decisions",
    )
    assert "job_key" not in _columns(
        reopened,
        "application_review_decisions",
    )
    assert [
        tuple(row)
        for row in reopened.execute(
            """
            SELECT tenant_id, decision_id, job_id, decision
            FROM application_review_decisions
            ORDER BY tenant_id, decision_id
            """
        ).fetchall()
    ] == [
        (
            "local",
            "alias-decision",
            str(stable_job_id),
            "defer",
        ),
        (
            "local",
            "shared-decision",
            str(uuid_url_owner),
            "decline",
        ),
        (
            "local",
            "storage-decision",
            str(stable_job_id),
            "approve_dry_run",
        ),
        (
            "tenant-b",
            "shared-decision",
            other_tenant_job_id,
            "approve_submit",
        ),
    ]
    assert reopened.execute(
        "PRAGMA foreign_key_check"
    ).fetchone() is None
    close_connection(db_path)

    reopened_again = init_db(db_path)
    assert reopened_again.execute(
        "SELECT COUNT(*) FROM application_review_decisions"
    ).fetchone()[0] == 4
    close_connection(db_path)


def test_v20_review_decision_migration_rolls_back_and_retries(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    job_id = JobId(str(uuid.uuid4()))
    job_url = "https://example.com/jobs/review-retry"
    SqliteJobRepository(conn).save(_discovered_job(job_url, job_id))
    _downgrade_application_review_references_to_v19(conn)
    _insert_decision(
        conn,
        tenant_id="local",
        decision_id="retry-decision",
        reference_column="job_key",
        reference=job_url,
        decision="defer",
        decided_at="2026-07-30T10:00:00+00:00",
    )
    conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")
    original_verify = (
        database_module._verify_application_review_references_v20
    )

    def _fail_verification(
        _conn: sqlite3.Connection,
        *,
        expected_count: int,
    ) -> None:
        del expected_count
        raise RuntimeError("injected review verification failure")

    monkeypatch.setattr(
        database_module,
        "_verify_application_review_references_v20",
        _fail_verification,
    )
    with pytest.raises(
        RuntimeError,
        match="injected review verification failure",
    ):
        ensure_application_review_references_v20(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 19
    assert "job_key" in _columns(
        conn,
        "application_review_decisions",
    )
    assert conn.execute(
        "SELECT decision FROM application_review_decisions"
    ).fetchone()[0] == "defer"

    monkeypatch.setattr(
        database_module,
        "_verify_application_review_references_v20",
        original_verify,
    )
    assert ensure_application_review_references_v20(conn) == [
        "application_review_decisions"
    ]
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 20
    assert "job_id" in _columns(
        conn,
        "application_review_decisions",
    )
    assert conn.execute(
        "PRAGMA foreign_key_check"
    ).fetchone() is None
    close_connection(db_path)


def test_v20_init_restores_a_missing_review_authority_as_stable(
    tmp_path: Path,
) -> None:
    from jobctrl.infrastructure.gmail.feedback import (
        ensure_application_feedback_tables,
    )

    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    conn.execute("DROP TABLE application_review_decisions")
    conn.commit()
    ensure_application_feedback_tables(conn)
    assert database_module._has_application_review_reference_schema_v20(
        conn
    )
    conn.execute("DROP TABLE application_review_decisions")
    conn.commit()
    close_connection(db_path)

    reopened = init_db(db_path)
    assert "job_id" in _columns(
        reopened,
        "application_review_decisions",
    )
    assert "job_key" not in _columns(
        reopened,
        "application_review_decisions",
    )
    assert database_module._has_application_review_reference_schema_v20(
        reopened
    )
    close_connection(db_path)


def test_runtime_review_merge_preserves_append_only_history_and_tenant(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    jobs = SqliteJobRepository(conn)
    losing_id = JobId(str(uuid.uuid4()))
    surviving_id = JobId(str(uuid.uuid4()))
    losing_url = "https://example.com/jobs/review-losing"
    surviving_url = "https://example.com/jobs/review-surviving"
    jobs.save(_discovered_job(losing_url, losing_id))
    jobs.save(_discovered_job(surviving_url, surviving_id))
    other_tenant_job_id = str(surviving_id)
    other_tenant_url = "https://tenant-b.example/jobs/review"
    conn.execute(
        """
        INSERT INTO jobs (
            url, tenant_id, job_id, title, company, discovered_at
        ) VALUES (?, 'tenant-b', ?, 'Platform Engineer', 'Example', ?)
        """,
        (
            other_tenant_url,
            other_tenant_job_id,
            "2026-07-30T10:00:00+00:00",
        ),
    )
    for decision_id, reference, decision, decided_at in (
        (
            "losing-1",
            str(losing_id),
            "approve_dry_run",
            "2026-07-30T10:00:00+00:00",
        ),
        (
            "losing-2",
            str(losing_id),
            "defer",
            "2026-07-30T10:01:00+00:00",
        ),
        (
            "surviving-1",
            str(surviving_id),
            "decline",
            "2026-07-30T10:02:00+00:00",
        ),
    ):
        _insert_decision(
            conn,
            tenant_id="local",
            decision_id=decision_id,
            reference_column="job_id",
            reference=reference,
            decision=decision,
            decided_at=decided_at,
        )
    _insert_decision(
        conn,
        tenant_id="tenant-b",
        decision_id="tenant-b-1",
        reference_column="job_id",
        reference=other_tenant_job_id,
        decision="approve_submit",
        decided_at="2026-07-30T10:04:00+00:00",
    )
    conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")

    reassign_discovery_identity_references(
        conn,
        losing_job_url=losing_url,
        surviving_job_url=surviving_url,
    )
    conn.execute(
        "DELETE FROM jobs WHERE tenant_id = 'local' AND url = ?",
        (losing_url,),
    )

    assert [
        tuple(row)
        for row in conn.execute(
            """
            SELECT tenant_id, decision_id, job_id
            FROM application_review_decisions
            ORDER BY tenant_id, decision_id
            """
        ).fetchall()
    ] == [
        ("local", "losing-1", str(surviving_id)),
        ("local", "losing-2", str(surviving_id)),
        ("local", "surviving-1", str(surviving_id)),
        ("tenant-b", "tenant-b-1", other_tenant_job_id),
    ]
    assert conn.execute(
        "PRAGMA foreign_key_check"
    ).fetchone() is None
    close_connection(db_path)
