"""ProjectionBuilder — watermark + backfill behaviour."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Iterator

import pytest

from jobhunter.database import close_connection, init_db
from jobhunter.infrastructure.events.in_process_bus import InProcessEventBus
from jobhunter.infrastructure.events.watermark import SqliteEventWatermarkRepository
from jobhunter.infrastructure.projections.projection_builder import (
    PROJECTION_NAME,
    ProjectionBuilder,
)
from jobhunter.state import record_job_event, utc_now


@pytest.fixture
def conn(tmp_path: Path) -> Iterator[sqlite3.Connection]:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    yield conn
    close_connection(db_path)


def _seed_job(conn: sqlite3.Connection, url: str) -> None:
    conn.execute(
        """
        INSERT INTO jobs (url, title, site, strategy, location, salary,
                          discovered_at, application_url, description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (url, "Engineer", "ExampleCo", "jobspy", "Remote", "", utc_now(), url, "x"),
    )
    conn.commit()


def test_initial_watermark_is_zero(conn: sqlite3.Connection) -> None:
    repo = SqliteEventWatermarkRepository(conn)
    assert repo.get(PROJECTION_NAME) == 0


def test_refresh_advances_watermark(conn: sqlite3.Connection) -> None:
    _seed_job(conn, "https://example.com/a")
    record_job_event(conn, "https://example.com/a", "discover", "JobDiscovered")
    conn.commit()

    builder = ProjectionBuilder(conn_factory=lambda: conn)
    builder.refresh()

    repo = SqliteEventWatermarkRepository(conn)
    last = repo.get(PROJECTION_NAME)
    assert last >= 1


def test_refresh_resumes_from_watermark(conn: sqlite3.Connection) -> None:
    _seed_job(conn, "https://example.com/r1")
    record_job_event(conn, "https://example.com/r1", "discover", "JobDiscovered")
    conn.commit()

    builder = ProjectionBuilder(conn_factory=lambda: conn)
    builder.refresh()

    # Add another event for a new job; watermark should advance only by
    # the delta.
    repo = SqliteEventWatermarkRepository(conn)
    pre_watermark = repo.get(PROJECTION_NAME)
    _seed_job(conn, "https://example.com/r2")
    record_job_event(conn, "https://example.com/r2", "discover", "JobDiscovered")
    conn.commit()

    builder.refresh()
    post_watermark = repo.get(PROJECTION_NAME)
    assert post_watermark > pre_watermark


def test_backfill_from_empty(conn: sqlite3.Connection) -> None:
    """Initial backfill — existing jobs in the table get projected even if
    no events have ever been emitted (legacy / pre-DDD-migration data).
    """
    _seed_job(conn, "https://example.com/legacy-1")
    _seed_job(conn, "https://example.com/legacy-2")
    # No record_job_event calls.

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    rows = conn.execute(
        "SELECT job_id FROM job_list_projections ORDER BY job_id"
    ).fetchall()
    assert [row[0] for row in rows] == [
        "https://example.com/legacy-1",
        "https://example.com/legacy-2",
    ]


def test_feedback_only_history_rebuilds_source_quality(conn: sqlite3.Connection) -> None:
    record_job_event(
        conn,
        "job-1",
        "discover",
        "DiscoveryFeedbackRecorded",
        payload={
            "feedback_id": "feedback-1",
            "job_id": "job-1",
            "source_id": "greenhouse:acme",
            "kind": "bad_source",
            "recorded_at": utc_now(),
        },
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        """
        SELECT observed_jobs, detail_failure_count, last_error_class
        FROM source_quality_stats
        WHERE source_id = ?
        """,
        ("greenhouse:acme",),
    ).fetchone()
    assert row is not None
    assert row[0] == 1
    assert row[1] == 1
    assert row[2] == "user_bad_source"


def test_subscribes_to_event_bus(conn: sqlite3.Connection) -> None:
    """Wiring the builder to the bus refreshes projections on publish."""
    _seed_job(conn, "https://example.com/bus")
    builder = ProjectionBuilder(conn_factory=lambda: conn)
    bus = InProcessEventBus()
    builder.subscribe_to(bus)

    # Publish via the bus AFTER recording the event in the table.
    record_job_event(conn, "https://example.com/bus", "discover", "JobDiscovered")
    conn.commit()
    from jobhunter.domain.events.base import create_domain_event
    from jobhunter.domain.tenant import LOCAL_TENANT

    bus.publish(create_domain_event("JobDiscovered", LOCAL_TENANT, {"job_url": "https://example.com/bus"}))

    row = conn.execute(
        "SELECT job_id FROM job_list_projections WHERE job_id = ?",
        ("https://example.com/bus",),
    ).fetchone()
    assert row is not None


def test_unsubscribe_stops_refreshes(conn: sqlite3.Connection) -> None:
    _seed_job(conn, "https://example.com/sub")
    builder = ProjectionBuilder(conn_factory=lambda: conn)
    bus = InProcessEventBus()
    sub = builder.subscribe_to(bus)
    sub.unsubscribe()

    from jobhunter.domain.events.base import create_domain_event
    from jobhunter.domain.tenant import LOCAL_TENANT

    bus.publish(create_domain_event("JobDiscovered", LOCAL_TENANT, {"job_url": "https://example.com/sub"}))

    rows = conn.execute("SELECT COUNT(*) FROM job_list_projections").fetchone()
    # Builder has not been called manually; nothing in projections yet.
    assert rows[0] == 0
