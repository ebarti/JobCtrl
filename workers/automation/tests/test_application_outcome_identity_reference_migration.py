"""Schema-v21 reviewed application-outcome JobId reference contracts."""

from __future__ import annotations

import sqlite3
import uuid
from pathlib import Path

import pytest

import jobctrl.database as database_module
from jobctrl.database import (
    SCHEMA_VERSION,
    close_connection,
    ensure_application_outcome_references_v21,
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


PREVIOUS_SCHEMA_VERSION = 20


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


def _downgrade_application_outcomes_to_v20(
    conn: sqlite3.Connection,
) -> None:
    conn.execute("DROP TABLE application_outcomes")
    conn.executescript(
        """
        CREATE TABLE application_outcomes (
            tenant_id                 TEXT NOT NULL DEFAULT 'local',
            outcome_id                TEXT NOT NULL,
            job_key                   TEXT NOT NULL,
            kind                      TEXT NOT NULL,
            source                    TEXT NOT NULL,
            note                      TEXT,
            occurred_at               TEXT NOT NULL,
            recorded_at               TEXT NOT NULL,
            suggestion_id             TEXT,
            evidence_id               TEXT,
            created_by                TEXT NOT NULL DEFAULT 'user',
            interview_prep_generation INTEGER,
            PRIMARY KEY (tenant_id, outcome_id)
        );
        CREATE INDEX idx_application_outcomes_job
        ON application_outcomes(
            tenant_id,
            job_key,
            occurred_at DESC,
            recorded_at DESC
        );
        """
    )
    conn.execute(f"PRAGMA user_version = {PREVIOUS_SCHEMA_VERSION}")
    conn.commit()


def _insert_outcome(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    outcome_id: str,
    reference_column: str,
    reference: str,
    kind: str,
    occurred_at: str,
    generation: int | None = None,
) -> None:
    conn.execute(
        f"""
        INSERT INTO application_outcomes (
            tenant_id, outcome_id, {reference_column}, kind, source, note,
            occurred_at, recorded_at, suggestion_id, evidence_id,
            created_by, interview_prep_generation
        ) VALUES (?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, 'user', ?)
        """,
        (
            tenant_id,
            outcome_id,
            reference,
            kind,
            f"note:{outcome_id}",
            occurred_at,
            occurred_at,
            f"suggestion:{outcome_id}",
            f"evidence:{outcome_id}",
            generation,
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


def _insert_stable_prep(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    job_id: JobId,
    generation: int,
    marker: str,
    generated_at: str,
) -> None:
    conn.execute(
        """
        INSERT INTO job_interview_prep (
            tenant_id, job_id, generation, status, model,
            generated_at, gate_status, fabrication_findings_json,
            grounding_findings_json, judge_verdict, warnings_json,
            failure_reason, origin_run_id
        ) VALUES (
            ?, ?, ?, 'accepted', 'test-model', ?, 'passed', '[]', '[]',
            'pass:1.00', '[]', '', ?
        )
        """,
        (
            tenant_id,
            str(job_id),
            generation,
            generated_at,
            f"run:{marker}",
        ),
    )


def test_v20_outcomes_migrate_every_alias_uuid_url_and_tenant(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    jobs = SqliteJobRepository(conn)
    stable_job_id = JobId(str(uuid.uuid4()))
    storage_url = "https://boards.example/jobs/outcome"
    alias_url = "https://careers.example/jobs/outcome"
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
    other_tenant_url = "https://tenant-b.example/jobs/outcome"
    conn.execute(
        """
        INSERT INTO jobs (
            url, tenant_id, job_id, title, company, discovered_at
        ) VALUES (?, 'tenant-b', ?, 'Platform Engineer', 'Example', ?)
        """,
        (
            other_tenant_url,
            str(stable_job_id),
            "2026-07-30T10:00:00+00:00",
        ),
    )

    _downgrade_application_outcomes_to_v20(conn)
    for tenant_id, outcome_id, job_key, kind, occurred_at, generation in (
        (
            "local",
            "storage-outcome",
            storage_url,
            "applied_confirmation",
            "2026-07-30T10:00:00+00:00",
            1,
        ),
        (
            "local",
            "alias-outcome",
            alias_url,
            "interview",
            "2026-07-30T10:01:00+00:00",
            2,
        ),
        (
            "local",
            "shared-outcome",
            uuid_shaped_url,
            "offer",
            "2026-07-30T10:02:00+00:00",
            None,
        ),
        (
            "tenant-b",
            "shared-outcome",
            other_tenant_url,
            "rejection",
            "2026-07-30T10:03:00+00:00",
            None,
        ),
    ):
        _insert_outcome(
            conn,
            tenant_id=tenant_id,
            outcome_id=outcome_id,
            reference_column="job_key",
            reference=job_key,
            kind=kind,
            occurred_at=occurred_at,
            generation=generation,
        )
    conn.commit()
    close_connection(db_path)

    reopened = init_db(db_path)
    assert (
        reopened.execute("PRAGMA user_version").fetchone()[0]
        == SCHEMA_VERSION
        == 27
    )
    assert "job_id" in _columns(reopened, "application_outcomes")
    assert "job_key" not in _columns(reopened, "application_outcomes")
    assert [
        tuple(row)
        for row in reopened.execute(
            """
            SELECT tenant_id, outcome_id, job_id, kind, suggestion_id,
                   evidence_id, interview_prep_generation
            FROM application_outcomes
            ORDER BY tenant_id, outcome_id
            """
        ).fetchall()
    ] == [
        (
            "local",
            "alias-outcome",
            str(stable_job_id),
            "interview",
            "suggestion:alias-outcome",
            "evidence:alias-outcome",
            2,
        ),
        (
            "local",
            "shared-outcome",
            str(uuid_url_owner),
            "offer",
            "suggestion:shared-outcome",
            "evidence:shared-outcome",
            None,
        ),
        (
            "local",
            "storage-outcome",
            str(stable_job_id),
            "applied_confirmation",
            "suggestion:storage-outcome",
            "evidence:storage-outcome",
            1,
        ),
        (
            "tenant-b",
            "shared-outcome",
            str(stable_job_id),
            "rejection",
            "suggestion:shared-outcome",
            "evidence:shared-outcome",
            None,
        ),
    ]
    assert reopened.execute(
        "PRAGMA foreign_key_check"
    ).fetchone() is None
    close_connection(db_path)

    reopened_again = init_db(db_path)
    assert reopened_again.execute(
        "SELECT COUNT(*) FROM application_outcomes"
    ).fetchone()[0] == 4
    close_connection(db_path)


def test_v21_outcome_migration_rolls_back_and_retries(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    job_id = JobId(str(uuid.uuid4()))
    job_url = "https://example.com/jobs/outcome-retry"
    SqliteJobRepository(conn).save(_discovered_job(job_url, job_id))
    _downgrade_application_outcomes_to_v20(conn)
    _insert_outcome(
        conn,
        tenant_id="local",
        outcome_id="retry-outcome",
        reference_column="job_key",
        reference=job_url,
        kind="interview",
        occurred_at="2026-07-30T10:00:00+00:00",
    )
    conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")
    original_verify = (
        database_module._verify_application_outcome_references_v21
    )

    def _fail_verification(
        _conn: sqlite3.Connection,
        *,
        expected_count: int,
    ) -> None:
        del expected_count
        raise RuntimeError("injected outcome verification failure")

    monkeypatch.setattr(
        database_module,
        "_verify_application_outcome_references_v21",
        _fail_verification,
    )
    with pytest.raises(
        RuntimeError,
        match="injected outcome verification failure",
    ):
        ensure_application_outcome_references_v21(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 20
    assert "job_key" in _columns(conn, "application_outcomes")
    assert conn.execute(
        "SELECT kind FROM application_outcomes"
    ).fetchone()[0] == "interview"

    monkeypatch.setattr(
        database_module,
        "_verify_application_outcome_references_v21",
        original_verify,
    )
    assert ensure_application_outcome_references_v21(conn) == [
        "application_outcomes"
    ]
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 21
    assert "job_id" in _columns(conn, "application_outcomes")
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None
    close_connection(db_path)


@pytest.mark.parametrize(
    ("schema_version", "expected_reference"),
    (
        (0, "job_key"),
        (20, "job_key"),
        (21, "job_id"),
        (22, "job_id"),
    ),
)
def test_missing_outcome_table_recovery_is_version_aware(
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
    database_module._ensure_application_outcome_table_for_version(
        conn,
        current_version=schema_version,
    )
    columns = _columns(conn, "application_outcomes")
    assert expected_reference in columns
    assert (
        {"job_id", "job_key"} - {expected_reference}
    ).isdisjoint(columns)
    if schema_version >= 21:
        assert (
            database_module
            ._has_application_outcome_reference_schema_v21(conn)
        )
    conn.close()


def test_gmail_v21_recovers_missing_outcome_table_with_fk_and_index() -> None:
    from jobctrl.infrastructure.gmail.feedback import (
        ensure_application_feedback_tables,
    )

    conn = sqlite3.connect(":memory:")
    conn.executescript(
        """
        CREATE TABLE jobs (
            url TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL DEFAULT 'local',
            job_id TEXT NOT NULL,
            UNIQUE (tenant_id, job_id)
        );
        PRAGMA user_version = 21;
        """
    )

    ensure_application_feedback_tables(conn)

    columns = _columns(conn, "application_outcomes")
    assert "job_id" in columns
    assert "job_key" not in columns
    assert database_module._has_composite_job_id_foreign_key(
        conn,
        "application_outcomes",
        "job_id",
    )
    assert [
        str(row[2])
        for row in conn.execute(
            "PRAGMA index_info(idx_application_outcomes_job)"
        ).fetchall()
    ] == [
        "tenant_id",
        "job_id",
        "occurred_at",
        "recorded_at",
    ]
    assert database_module._has_application_outcome_reference_schema_v21(
        conn
    )
    conn.close()


def test_runtime_outcome_merge_preserves_history_generation_and_tenant(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    jobs = SqliteJobRepository(conn)
    losing_id = JobId(str(uuid.uuid4()))
    surviving_id = JobId(str(uuid.uuid4()))
    other_tenant_id = JobId(str(uuid.uuid4()))
    losing_url = "https://example.com/jobs/outcome-losing"
    surviving_url = "https://example.com/jobs/outcome-surviving"
    other_tenant_url = "https://tenant-b.example/jobs/outcome"
    jobs.save(_discovered_job(losing_url, losing_id))
    jobs.save(_discovered_job(surviving_url, surviving_id))
    conn.execute(
        """
        INSERT INTO jobs (
            url, tenant_id, job_id, title, company, discovered_at
        ) VALUES (?, 'tenant-b', ?, 'Platform Engineer', 'Example', ?)
        """,
        (
            other_tenant_url,
            str(other_tenant_id),
            "2026-07-30T10:00:00+00:00",
        ),
    )
    _insert_stable_prep(
        conn,
        tenant_id="local",
        job_id=losing_id,
        generation=1,
        marker="losing",
        generated_at="2026-07-30T10:00:00+00:00",
    )
    _insert_stable_prep(
        conn,
        tenant_id="local",
        job_id=surviving_id,
        generation=1,
        marker="surviving",
        generated_at="2026-07-30T10:01:00+00:00",
    )
    _insert_stable_prep(
        conn,
        tenant_id="tenant-b",
        job_id=other_tenant_id,
        generation=1,
        marker="tenant-b",
        generated_at="2026-07-30T10:02:00+00:00",
    )
    _insert_outcome(
        conn,
        tenant_id="local",
        outcome_id="losing-outcome",
        reference_column="job_id",
        reference=str(losing_id),
        kind="interview",
        occurred_at="2026-07-30T11:00:00+00:00",
        generation=1,
    )
    _insert_outcome(
        conn,
        tenant_id="local",
        outcome_id="surviving-outcome",
        reference_column="job_id",
        reference=str(surviving_id),
        kind="offer",
        occurred_at="2026-07-30T11:01:00+00:00",
        generation=1,
    )
    _insert_outcome(
        conn,
        tenant_id="tenant-b",
        outcome_id="tenant-b-outcome",
        reference_column="job_id",
        reference=str(other_tenant_id),
        kind="rejection",
        occurred_at="2026-07-30T11:02:00+00:00",
        generation=1,
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
            SELECT tenant_id, outcome_id, job_id,
                   interview_prep_generation
            FROM application_outcomes
            ORDER BY tenant_id, outcome_id
            """
        ).fetchall()
    ] == [
        ("local", "losing-outcome", str(surviving_id), 1),
        ("local", "surviving-outcome", str(surviving_id), 2),
        ("tenant-b", "tenant-b-outcome", str(other_tenant_id), 1),
    ]
    assert [
        tuple(row)
        for row in conn.execute(
            """
            SELECT outcomes.outcome_id, prep.origin_run_id
            FROM application_outcomes AS outcomes
            JOIN job_interview_prep AS prep
              ON prep.tenant_id = outcomes.tenant_id
             AND prep.job_id = outcomes.job_id
             AND prep.generation =
                 outcomes.interview_prep_generation
            WHERE outcomes.tenant_id = 'local'
            ORDER BY outcomes.outcome_id
            """
        ).fetchall()
    ] == [
        ("losing-outcome", "run:losing"),
        ("surviving-outcome", "run:surviving"),
    ]
    assert conn.execute(
        "SELECT COUNT(*) FROM application_outcomes"
    ).fetchone()[0] == 3
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None
    close_connection(db_path)


def test_gmail_anchor_projects_url_from_stable_outcome_reference(
    tmp_path: Path,
) -> None:
    from jobctrl.infrastructure.gmail.feedback import _outcome_anchors

    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    job_id = JobId(str(uuid.uuid4()))
    job_url = "https://example.com/jobs/stable-outcome-anchor"
    SqliteJobRepository(conn).save(_discovered_job(job_url, job_id))
    _insert_outcome(
        conn,
        tenant_id="local",
        outcome_id="anchor-outcome",
        reference_column="job_id",
        reference=str(job_id),
        kind="interview",
        occurred_at="2026-07-30T11:00:00+00:00",
    )
    conn.commit()

    anchors = _outcome_anchors(conn)

    assert len(anchors) == 1
    assert anchors[0].job_key == job_url
    assert anchors[0].title == "Platform Engineer"
    assert anchors[0].company == "Example"
    close_connection(db_path)
