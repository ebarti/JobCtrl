"""Schema-v14 generic artifact-registry identity migration contracts."""

from __future__ import annotations

import json
import sqlite3
import uuid
from pathlib import Path

import pytest

import jobctrl.database as database_module
from jobctrl.database import (
    SCHEMA_VERSION,
    _reassign_artifact_registry_references_v14,
    close_connection,
    ensure_artifact_registry_references_v14,
    get_connection,
    init_db,
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
from jobctrl.infrastructure.projections.projection_builder import (
    ProjectionBuilder,
)
from jobctrl.state import record_job_artifact


PREVIOUS_SCHEMA_VERSION = 13


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


def _downgrade_artifact_registry_to_v13(
    conn: sqlite3.Connection,
) -> None:
    conn.execute("DROP TABLE job_artifacts")
    conn.executescript(
        """
        CREATE TABLE job_artifacts (
            artifact_id         INTEGER PRIMARY KEY AUTOINCREMENT,
            job_url             TEXT NOT NULL,
            stage               TEXT NOT NULL,
            artifact_type       TEXT NOT NULL,
            status              TEXT NOT NULL DEFAULT 'candidate',
            path                TEXT NOT NULL,
            created_at          TEXT NOT NULL,
            size_bytes          INTEGER,
            metadata_json       TEXT,
            UNIQUE(job_url, stage, artifact_type, path),
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        );
        CREATE INDEX idx_job_artifacts_job_stage
            ON job_artifacts(job_url, stage, status);
        """
    )
    conn.execute(f"PRAGMA user_version = {PREVIOUS_SCHEMA_VERSION}")
    conn.commit()


def _insert_legacy_artifact(
    conn: sqlite3.Connection,
    *,
    job_url: str,
    path: str,
    created_at: str,
    status: str = "active",
    size_bytes: int = 10,
    metadata: dict[str, object] | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO job_artifacts (
            job_url, stage, artifact_type, status, path, created_at,
            size_bytes, metadata_json
        ) VALUES (?, 'apply', 'apply_log', ?, ?, ?, ?, ?)
        """,
        (
            job_url,
            status,
            path,
            created_at,
            size_bytes,
            json.dumps(metadata or {}, sort_keys=True),
        ),
    )


def _columns(conn: sqlite3.Connection) -> set[str]:
    return {str(row[1]) for row in conn.execute("PRAGMA table_info(job_artifacts)").fetchall()}


def test_v13_artifact_registry_migrates_alias_collisions_and_reopens(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    jobs = SqliteJobRepository(conn)

    stable_job_id = JobId(str(uuid.uuid4()))
    original_url = "https://boards.example/jobs/123"
    current_url = "https://careers.example/jobs/platform-engineer"
    jobs.save(_discovered_job(original_url, stable_job_id))
    jobs.save(_discovered_job(current_url, stable_job_id))

    uuid_shaped_url = str(uuid.uuid4())
    uuid_url_owner = JobId(str(uuid.uuid4()))
    id_text_collision_url = "https://example.com/jobs/id-text-collision"
    jobs.save(_discovered_job(uuid_shaped_url, uuid_url_owner))
    jobs.save(
        _discovered_job(
            id_text_collision_url,
            JobId(uuid_shaped_url),
        )
    )

    _downgrade_artifact_registry_to_v13(conn)
    _insert_legacy_artifact(
        conn,
        job_url=original_url,
        path="/tmp/shared.log",
        created_at="2026-07-29T10:00:00+00:00",
        status="candidate",
        size_bytes=5,
        metadata={"source": "old"},
    )
    _insert_legacy_artifact(
        conn,
        job_url=current_url,
        path="/tmp/shared.log",
        created_at="2026-07-29T10:05:00+00:00",
        status="active",
        size_bytes=9,
        metadata={"source": "new"},
    )
    _insert_legacy_artifact(
        conn,
        job_url=original_url,
        path="/tmp/original-only.log",
        created_at="2026-07-29T10:01:00+00:00",
    )
    _insert_legacy_artifact(
        conn,
        job_url=uuid_shaped_url,
        path="/tmp/uuid-url-owner.log",
        created_at="2026-07-29T10:02:00+00:00",
    )
    conn.commit()
    close_connection(db_path)

    reopened = init_db(db_path)
    assert reopened.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
    assert "job_id" in _columns(reopened)
    assert "job_url" not in _columns(reopened)
    assert reopened.execute("SELECT COUNT(*) FROM job_artifacts").fetchone()[0] == 3

    shared = reopened.execute(
        """
        SELECT status, size_bytes, metadata_json
        FROM job_artifacts
        WHERE tenant_id = 'local' AND job_id = ? AND path = ?
        """,
        (str(stable_job_id), "/tmp/shared.log"),
    ).fetchone()
    assert tuple(shared[:2]) == ("active", 9)
    assert json.loads(shared["metadata_json"]) == {"source": "new"}
    assert reopened.execute(
        """
            SELECT job_id
            FROM job_artifacts
            WHERE tenant_id = 'local' AND path = ?
            """,
        ("/tmp/uuid-url-owner.log",),
    ).fetchone()[0] == str(uuid_url_owner)

    record_job_artifact(
        reopened,
        original_url,
        "apply",
        "apply_log",
        "/tmp/shared.log",
        status="approved",
        created_at="2026-07-29T10:10:00+00:00",
        metadata={"source": "runtime"},
    )
    assert (
        reopened.execute(
            """
        SELECT status
        FROM job_artifacts
        WHERE tenant_id = 'local' AND job_id = ? AND path = ?
        """,
            (str(stable_job_id), "/tmp/shared.log"),
        ).fetchone()[0]
        == "approved"
    )

    record_job_artifact(
        reopened,
        uuid_shaped_url,
        "apply",
        "apply_log",
        "/tmp/uuid-url-runtime.log",
        status="approved",
        created_at="2026-07-29T10:10:00+00:00",
    )
    uuid_runtime = reopened.execute(
        """
        SELECT job_id, status
        FROM job_artifacts
        WHERE tenant_id = 'local' AND path = ?
        """,
        ("/tmp/uuid-url-runtime.log",),
    ).fetchone()
    assert tuple(uuid_runtime) == (str(uuid_url_owner), "approved")

    ProjectionBuilder(conn_factory=lambda: get_connection(db_path)).refresh()
    assert (
        reopened.execute(
            """
        SELECT COUNT(*)
        FROM artifact_list_projections
        WHERE local_path = '/tmp/shared.log'
        """
        ).fetchone()[0]
        == 1
    )
    close_connection(db_path)


def test_v14_artifact_registry_migration_rolls_back_and_retries(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    job_id = JobId(str(uuid.uuid4()))
    job_url = "https://example.com/jobs/retry"
    SqliteJobRepository(conn).save(_discovered_job(job_url, job_id))
    _downgrade_artifact_registry_to_v13(conn)
    _insert_legacy_artifact(
        conn,
        job_url=job_url,
        path="/tmp/retry.log",
        created_at="2026-07-29T10:00:00+00:00",
    )
    conn.commit()

    original_verify = database_module._verify_artifact_registry_references_v14

    def _fail_verification(
        _conn: sqlite3.Connection,
        *,
        expected_count: int,
    ) -> None:
        del expected_count
        raise RuntimeError("injected artifact verification failure")

    monkeypatch.setattr(
        database_module,
        "_verify_artifact_registry_references_v14",
        _fail_verification,
    )
    with pytest.raises(
        RuntimeError,
        match="injected artifact verification failure",
    ):
        ensure_artifact_registry_references_v14(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 13
    assert "job_url" in _columns(conn)
    assert conn.execute("SELECT COUNT(*) FROM job_artifacts").fetchone()[0] == 1

    monkeypatch.setattr(
        database_module,
        "_verify_artifact_registry_references_v14",
        original_verify,
    )
    assert ensure_artifact_registry_references_v14(conn) == ["job_artifacts"]
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 14
    assert "job_id" in _columns(conn)
    close_connection(db_path)


def test_runtime_artifact_registry_merge_preserves_latest_registration(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    jobs = SqliteJobRepository(conn)
    losing_id = JobId(str(uuid.uuid4()))
    surviving_id = JobId(str(uuid.uuid4()))
    jobs.save(
        _discovered_job(
            "https://example.com/jobs/losing",
            losing_id,
        )
    )
    jobs.save(
        _discovered_job(
            "https://example.com/jobs/surviving",
            surviving_id,
        )
    )
    conn.execute(
        """
        INSERT INTO job_artifacts (
            tenant_id, job_id, stage, artifact_type, status, path,
            created_at, size_bytes, metadata_json
        ) VALUES
            ('local', ?, 'apply', 'apply_log', 'candidate', '/tmp/shared.log',
             '2026-07-29T10:00:00+00:00', 5, '{"source":"losing"}'),
            ('local', ?, 'apply', 'apply_log', 'active', '/tmp/shared.log',
             '2026-07-29T10:05:00+00:00', 9, '{"source":"surviving"}'),
            ('local', ?, 'apply', 'apply_log', 'active', '/tmp/only-losing.log',
             '2026-07-29T10:01:00+00:00', 7, '{}')
        """,
        (
            str(losing_id),
            str(surviving_id),
            str(losing_id),
        ),
    )
    conn.commit()

    _reassign_artifact_registry_references_v14(
        conn,
        tenant_id="local",
        losing_job_id=str(losing_id),
        surviving_job_id=str(surviving_id),
    )
    assert conn.execute("SELECT COUNT(*) FROM job_artifacts").fetchone()[0] == 2
    rows = conn.execute(
        """
        SELECT job_id, status, path, size_bytes, metadata_json
        FROM job_artifacts
        ORDER BY path
        """
    ).fetchall()
    assert {row["job_id"] for row in rows} == {str(surviving_id)}
    shared = next(row for row in rows if row["path"] == "/tmp/shared.log")
    assert shared["status"] == "active"
    assert shared["size_bytes"] == 9
    assert json.loads(shared["metadata_json"]) == {"source": "surviving"}
    close_connection(db_path)
