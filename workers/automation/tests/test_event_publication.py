"""record_job_event publishes through EventPublisher when one is supplied."""

from pathlib import Path

from jobctl.database import close_connection, init_db
from jobctl.domain.tenant import LOCAL_TENANT
from jobctl.infrastructure.events.in_process_bus import InProcessEventBus
from jobctl.state import record_job_event


def test_record_job_event_publishes_through_bus(tmp_path: Path) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    bus = InProcessEventBus()
    received: list = []
    bus.subscribe(None, received.append)

    try:
        record_job_event(
            conn,
            "https://example.com/job/1",
            "score",
            "StageCompleted",
            message="Fit score 9/10",
            payload={"score": 9},
            publisher=bus,
        )
        conn.commit()

        # Event was persisted...
        rows = conn.execute("SELECT event_type, message FROM job_events").fetchall()
        assert len(rows) == 1
        assert rows[0]["event_type"] == "StageCompleted"

        # ...and dispatched through the bus.
        assert len(received) == 1
        event = received[0]
        assert event.event_type == "StageCompleted"
        assert event.tenant_id == LOCAL_TENANT
        assert event.payload["job_url"] == "https://example.com/job/1"
        assert event.payload["stage"] == "score"
        assert event.payload["score"] == 9
        assert event.payload["message"] == "Fit score 9/10"
    finally:
        close_connection(db_path)


def test_record_job_event_without_publisher_only_persists(tmp_path: Path) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)

    try:
        record_job_event(
            conn,
            "https://example.com/job/2",
            "enrich",
            "StageStarted",
            message="Enrichment started",
        )
        conn.commit()

        rows = conn.execute("SELECT event_type FROM job_events").fetchall()
        assert [row["event_type"] for row in rows] == ["StageStarted"]
    finally:
        close_connection(db_path)


def test_record_job_event_typed_subscriber_only_receives_match(tmp_path: Path) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    bus = InProcessEventBus()
    started: list = []
    completed: list = []
    bus.subscribe("StageStarted", started.append)
    bus.subscribe("StageCompleted", completed.append)

    try:
        record_job_event(conn, "u", "score", "StageStarted", publisher=bus)
        record_job_event(conn, "u", "score", "StageCompleted", publisher=bus)
        record_job_event(conn, "u", "score", "StageFailed", publisher=bus)
        conn.commit()
    finally:
        close_connection(db_path)

    assert len(started) == 1
    assert len(completed) == 1
