"""Forward-only v29 -> v30 event identity migration coverage."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from jobctrl.database import (
    backup_database,
    close_connection,
    ensure_job_event_identity_v30,
    init_db,
)
from jobctrl.infrastructure.events.identity_upcast import (
    EventIdentityUpcastError,
)

JOB_ID = "11111111-1111-4111-8111-111111111111"
POSTING_URL = "https://jobs.example/current"
OLD_POSTING_URL = "https://jobs.example/old"


@pytest.fixture
def v29_database(tmp_path: Path) -> tuple[Path, sqlite3.Connection]:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    conn.execute(
        """
        INSERT INTO jobs (
            url, tenant_id, job_id, title, company, discovered_at
        ) VALUES (?, 'local', ?, 'Engineer', 'Example', ?)
        """,
        (POSTING_URL, JOB_ID, "2026-07-30T08:00:00+00:00"),
    )
    conn.execute(
        """
        INSERT INTO job_identity_aliases (
            tenant_id,
            alias_kind,
            alias_value,
            job_id,
            created_at,
            retired_at
        ) VALUES ('local', 'posting_url', ?, ?, ?, ?)
        """,
        (
            OLD_POSTING_URL,
            JOB_ID,
            "2026-07-30T08:00:00+00:00",
            "2026-07-30T09:00:00+00:00",
        ),
    )
    conn.executemany(
        """
        INSERT INTO job_events (
            event_id,
            job_url,
            stage,
            event_type,
            level,
            message,
            occurred_at,
            payload_json,
            entity_kind,
            entity_ref,
            idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            (
                7,
                OLD_POSTING_URL,
                "score",
                "JobScored",
                "info",
                "Scored.",
                "2026-07-30T09:10:00+00:00",
                json.dumps(
                    {
                        "jobUrl": OLD_POSTING_URL,
                        "score": 8,
                    }
                ),
                "job",
                OLD_POSTING_URL,
                "score-once",
            ),
            (
                11,
                None,
                "workflow",
                "WorkflowStarted",
                "info",
                "Started.",
                "2026-07-30T09:11:00+00:00",
                json.dumps(
                    {
                        "jobId": "pipeline",
                        "workflowId": "pipeline-score-1",
                    }
                ),
                "workflow",
                "pipeline-score-1",
                None,
            ),
            (
                15,
                None,
                None,
                "DigestReviewed",
                "info",
                "Reviewed.",
                "2026-07-30T09:12:00+00:00",
                None,
                "digest",
                "daily",
                None,
            ),
        ),
    )
    conn.commit()
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 29
    try:
        yield db_path, conn
    finally:
        close_connection(db_path)


def test_v30_migrates_event_identity_without_changing_history(
    v29_database: tuple[Path, sqlite3.Connection],
) -> None:
    db_path, conn = v29_database

    assert ensure_job_event_identity_v30(conn) == ["job_events"]
    conn.commit()

    assert conn.execute("PRAGMA user_version").fetchone()[0] == 30
    columns = {
        str(row[1])
        for row in conn.execute("PRAGMA table_info(job_events)").fetchall()
    }
    assert columns == {
        "event_id",
        "tenant_id",
        "job_id",
        "identity_version",
        "stage",
        "event_type",
        "level",
        "message",
        "occurred_at",
        "payload_json",
        "entity_kind",
        "entity_ref",
        "idempotency_key",
    }
    assert "job_url" not in columns

    rows = conn.execute(
        """
        SELECT
            event_id,
            tenant_id,
            job_id,
            identity_version,
            payload_json,
            entity_kind,
            entity_ref,
            idempotency_key
        FROM job_events
        ORDER BY event_id
        """
    ).fetchall()
    assert [int(row[0]) for row in rows] == [7, 11, 15]
    assert tuple(rows[0][1:4]) == ("local", JOB_ID, 1)
    assert json.loads(str(rows[0][4])) == {
        "jobId": JOB_ID,
        "score": 8,
    }
    assert tuple(rows[0][5:8]) == (
        "job",
        OLD_POSTING_URL,
        "score-once",
    )
    assert tuple(rows[1][1:4]) == ("local", None, 1)
    assert json.loads(str(rows[1][4])) == {
        "jobId": "pipeline",
        "workflowId": "pipeline-score-1",
    }
    assert tuple(rows[2][1:5]) == ("local", None, 1, None)

    indexes = {
        str(row[1])
        for row in conn.execute("PRAGMA index_list(job_events)").fetchall()
    }
    assert {
        "idx_job_events_idempotency_key",
        "idx_job_events_job_time",
        "idx_job_events_tenant_eid",
        "idx_job_events_stage_time",
        "idx_job_events_entity",
    }.issubset(indexes)
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []

    # Forward recovery is idempotent and the migrated file reopens exactly.
    assert ensure_job_event_identity_v30(conn) == ["job_events"]
    close_connection(db_path)
    reopened = sqlite3.connect(db_path)
    try:
        assert reopened.execute("PRAGMA user_version").fetchone()[0] == 30
        assert reopened.execute(
            "SELECT event_id FROM job_events ORDER BY event_id"
        ).fetchall() == [(7,), (11,), (15,)]
    finally:
        reopened.close()


def test_v30_failure_rolls_back_table_and_version(
    v29_database: tuple[Path, sqlite3.Connection],
) -> None:
    _db_path, conn = v29_database
    conn.execute(
        """
        INSERT INTO job_events (
            event_id,
            job_url,
            stage,
            event_type,
            level,
            occurred_at,
            payload_json
        ) VALUES (?, ?, 'score', 'JobScored', 'info', ?, ?)
        """,
        (
            20,
            "https://jobs.example/unresolved",
            "2026-07-30T09:20:00+00:00",
            "{}",
        ),
    )
    conn.commit()

    with pytest.raises(EventIdentityUpcastError) as exc_info:
        ensure_job_event_identity_v30(conn)

    assert exc_info.value.code == "event_job_identity_unresolved"
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 29
    assert "job_url" in {
        str(row[1])
        for row in conn.execute("PRAGMA table_info(job_events)").fetchall()
    }
    assert [
        int(row[0])
        for row in conn.execute(
            "SELECT event_id FROM job_events ORDER BY event_id"
        ).fetchall()
    ] == [7, 11, 15, 20]
    assert conn.execute(
        """
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'job_events_v30'
        """
    ).fetchone() is None


def test_pre_upgrade_backup_reopens_with_v29_schema(
    v29_database: tuple[Path, sqlite3.Connection],
    tmp_path: Path,
) -> None:
    db_path, conn = v29_database
    snapshot = backup_database(
        tmp_path / "pre-v30.db",
        db_path=db_path,
    )

    ensure_job_event_identity_v30(conn)
    conn.commit()
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 30

    restored = init_db(snapshot)
    try:
        assert restored.execute("PRAGMA user_version").fetchone()[0] == 29
        assert "job_url" in {
            str(row[1])
            for row in restored.execute(
                "PRAGMA table_info(job_events)"
            ).fetchall()
        }
        assert [
            int(row[0])
            for row in restored.execute(
                "SELECT event_id FROM job_events ORDER BY event_id"
            ).fetchall()
        ] == [7, 11, 15]
    finally:
        close_connection(snapshot)
