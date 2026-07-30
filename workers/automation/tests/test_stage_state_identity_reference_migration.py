"""Schema-v13 stage-state identity migration contracts."""

from __future__ import annotations

import sqlite3
import uuid
from pathlib import Path

import pytest

import jobctrl.database as database_module
from jobctrl.database import (
    SCHEMA_VERSION,
    _reassign_stage_state_references_v13,
    close_connection,
    ensure_stage_state_references_v13,
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
from jobctrl.infrastructure.pipeline.sqlite_repository import (
    SqlitePipelineStateRepository,
)
from jobctrl.state import (
    ensure_job_stage_rows,
    get_stage_state_row,
    set_stage_state,
)


PREVIOUS_SCHEMA_VERSION = 12


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


def _downgrade_stage_state_references_to_v12(
    conn: sqlite3.Connection,
) -> None:
    conn.execute("DROP TABLE job_stage_states")
    conn.executescript(
        """
        CREATE TABLE job_stage_states (
            job_url             TEXT NOT NULL,
            stage               TEXT NOT NULL,
            state               TEXT NOT NULL DEFAULT 'pending',
            attempt_count       INTEGER DEFAULT 0,
            max_attempts        INTEGER,
            started_at          TEXT,
            updated_at          TEXT NOT NULL,
            finished_at         TEXT,
            duration_ms         INTEGER,
            error_code          TEXT,
            error_message       TEXT,
            retryable           INTEGER DEFAULT 1,
            blocked_by_json     TEXT,
            next_action         TEXT,
            metadata_json       TEXT,
            version             INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (job_url, stage),
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        );
        CREATE INDEX idx_job_stage_states_stage_state
            ON job_stage_states(stage, state, updated_at DESC);
        CREATE INDEX idx_job_stage_states_job
            ON job_stage_states(job_url, stage);
        """
    )
    conn.execute(f"PRAGMA user_version = {PREVIOUS_SCHEMA_VERSION}")
    conn.commit()


def _insert_stage(
    conn: sqlite3.Connection,
    *,
    job_url: str,
    stage: str,
    state: str,
    attempt_count: int,
    updated_at: str,
    version: int,
) -> None:
    conn.execute(
        """
        INSERT INTO job_stage_states (
            job_url, stage, state, attempt_count, max_attempts,
            started_at, updated_at, finished_at, duration_ms,
            error_code, error_message, retryable, blocked_by_json,
            next_action, metadata_json, version
        ) VALUES (?, ?, ?, ?, 5, ?, ?, ?, 100, ?, ?, 1, '[]', NULL, '{}', ?)
        """,
        (
            job_url,
            stage,
            state,
            attempt_count,
            updated_at,
            updated_at,
            updated_at if state == "succeeded" else None,
            "FIXTURE_FAILURE" if state == "failed" else None,
            "fixture failed" if state == "failed" else None,
            version,
        ),
    )


def _columns(conn: sqlite3.Connection) -> set[str]:
    return {
        str(row[1])
        for row in conn.execute(
            "PRAGMA table_info(job_stage_states)"
        ).fetchall()
    }


def test_v12_stage_states_migrate_alias_collisions_and_reopen(
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
    id_text_collision_url = (
        "https://example.com/jobs/id-text-collision"
    )
    jobs.save(_discovered_job(uuid_shaped_url, uuid_url_owner))
    jobs.save(
        _discovered_job(
            id_text_collision_url,
            JobId(uuid_shaped_url),
        )
    )

    _downgrade_stage_state_references_to_v12(conn)
    _insert_stage(
        conn,
        job_url=original_url,
        stage="score",
        state="succeeded",
        attempt_count=4,
        updated_at="2026-07-29T10:00:00+00:00",
        version=7,
    )
    _insert_stage(
        conn,
        job_url=current_url,
        stage="score",
        state="failed",
        attempt_count=2,
        updated_at="2026-07-29T10:05:00+00:00",
        version=3,
    )
    _insert_stage(
        conn,
        job_url=original_url,
        stage="cover",
        state="pending",
        attempt_count=1,
        updated_at="2026-07-29T10:01:00+00:00",
        version=2,
    )
    _insert_stage(
        conn,
        job_url=uuid_shaped_url,
        stage="apply",
        state="pending",
        attempt_count=0,
        updated_at="2026-07-29T10:02:00+00:00",
        version=1,
    )
    _insert_stage(
        conn,
        job_url=id_text_collision_url,
        stage="discover",
        state="succeeded",
        attempt_count=1,
        updated_at="2026-07-29T10:03:00+00:00",
        version=1,
    )
    conn.commit()
    close_connection(db_path)

    reopened = init_db(db_path)
    assert reopened.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
    assert "job_id" in _columns(reopened)
    assert "job_url" not in _columns(reopened)
    assert reopened.execute(
        "SELECT COUNT(*) FROM job_stage_states"
    ).fetchone()[0] == 4

    score = reopened.execute(
        """
        SELECT state, attempt_count, version
        FROM job_stage_states
        WHERE tenant_id = 'local' AND job_id = ? AND stage = 'score'
        """,
        (str(stable_job_id),),
    ).fetchone()
    assert tuple(score) == ("failed", 4, 7)
    assert [
        tuple(row)
        for row in reopened.execute(
            """
            SELECT version
            FROM job_stage_states
            WHERE tenant_id = 'local' AND job_id = ?
            ORDER BY stage
            """,
            (str(stable_job_id),),
        ).fetchall()
    ] == [(7,), (7,)]
    assert (
        reopened.execute(
            """
            SELECT job_id
            FROM job_stage_states
            WHERE tenant_id = 'local' AND stage = 'apply'
            """
        ).fetchone()[0]
        == str(uuid_url_owner)
    )

    assert get_stage_state_row(
        reopened,
        original_url,
        "score",
    )["state"] == "failed"
    set_stage_state(
        reopened,
        original_url,
        "score",
        "pending",
        validate_transition=False,
    )
    assert get_stage_state_row(
        reopened,
        current_url,
        "score",
    )["state"] == "pending"
    assert reopened.execute(
        """
        SELECT COUNT(*)
        FROM job_stage_states
        WHERE tenant_id = 'local' AND job_id = ? AND stage = 'score'
        """,
        (str(stable_job_id),),
    ).fetchone()[0] == 1

    ensure_job_stage_rows(reopened, original_url)
    aggregate = SqlitePipelineStateRepository(reopened).load(
        LOCAL_TENANT,
        original_url,
    )
    assert aggregate is not None
    assert aggregate.version == 7
    SqlitePipelineStateRepository(reopened).save(aggregate)
    assert {
        int(row[0])
        for row in reopened.execute(
            """
            SELECT version
            FROM job_stage_states
            WHERE tenant_id = 'local' AND job_id = ?
            """,
            (str(stable_job_id),),
        ).fetchall()
    } == {8}
    close_connection(db_path)


def test_v13_stage_state_migration_rolls_back_and_retries(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    job_id = JobId(str(uuid.uuid4()))
    job_url = "https://example.com/jobs/retry"
    SqliteJobRepository(conn).save(_discovered_job(job_url, job_id))
    _downgrade_stage_state_references_to_v12(conn)
    _insert_stage(
        conn,
        job_url=job_url,
        stage="score",
        state="pending",
        attempt_count=1,
        updated_at="2026-07-29T10:00:00+00:00",
        version=1,
    )
    conn.commit()

    original_verify = (
        database_module._verify_stage_state_references_v13
    )

    def _fail_verification(
        _conn: sqlite3.Connection,
        *,
        expected_count: int,
    ) -> None:
        del expected_count
        raise RuntimeError("injected stage-state verification failure")

    monkeypatch.setattr(
        database_module,
        "_verify_stage_state_references_v13",
        _fail_verification,
    )
    with pytest.raises(
        RuntimeError,
        match="injected stage-state verification failure",
    ):
        ensure_stage_state_references_v13(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 12
    assert "job_url" in _columns(conn)
    assert conn.execute(
        "SELECT COUNT(*) FROM job_stage_states"
    ).fetchone()[0] == 1

    monkeypatch.setattr(
        database_module,
        "_verify_stage_state_references_v13",
        original_verify,
    )
    assert ensure_stage_state_references_v13(conn) == [
        "job_stage_states"
    ]
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 13
    assert "job_id" in _columns(conn)
    close_connection(db_path)


def test_runtime_stage_state_merge_preserves_latest_fact_and_counters(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    jobs = SqliteJobRepository(conn)
    losing_id = JobId(str(uuid.uuid4()))
    surviving_id = JobId(str(uuid.uuid4()))
    losing_url = "https://example.com/jobs/losing"
    surviving_url = "https://example.com/jobs/surviving"
    jobs.save(_discovered_job(losing_url, losing_id))
    jobs.save(_discovered_job(surviving_url, surviving_id))

    _insert_stable_stage(
        conn,
        job_id=losing_id,
        state="succeeded",
        attempts=6,
        updated_at="2026-07-29T10:00:00+00:00",
        version=9,
    )
    _insert_stable_stage(
        conn,
        job_id=surviving_id,
        state="failed",
        attempts=2,
        updated_at="2026-07-29T10:05:00+00:00",
        version=3,
    )
    conn.commit()

    _reassign_stage_state_references_v13(
        conn,
        tenant_id="local",
        losing_job_id=str(losing_id),
        surviving_job_id=str(surviving_id),
    )
    row = conn.execute(
        """
        SELECT job_id, state, attempt_count, version
        FROM job_stage_states
        WHERE tenant_id = 'local' AND stage = 'score'
        """
    ).fetchone()
    assert tuple(row) == (str(surviving_id), "failed", 6, 9)
    close_connection(db_path)


def _insert_stable_stage(
    conn: sqlite3.Connection,
    *,
    job_id: JobId,
    state: str,
    attempts: int,
    updated_at: str,
    version: int,
) -> None:
    conn.execute(
        """
        INSERT INTO job_stage_states (
            tenant_id, job_id, stage, state, attempt_count, max_attempts,
            started_at, updated_at, finished_at, duration_ms,
            error_code, error_message, retryable, blocked_by_json,
            next_action, metadata_json, version
        ) VALUES (
            'local', ?, 'score', ?, ?, 5, ?, ?, NULL, 100,
            NULL, NULL, 1, '[]', NULL, '{}', ?
        )
        """,
        (
            str(job_id),
            state,
            attempts,
            updated_at,
            updated_at,
            version,
        ),
    )
