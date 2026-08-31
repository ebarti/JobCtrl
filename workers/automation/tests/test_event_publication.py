"""record_job_event publishes through EventPublisher when one is supplied."""

from pathlib import Path

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.domain.identifiers import generate_job_id
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
from jobctrl.state import record_job_event


def _seed_job(conn, job_id) -> None:
    conn.execute(
        "INSERT INTO jobs (tenant_id, job_id, url) VALUES (?, ?, ?)",
        (str(LOCAL_TENANT), str(job_id), f"https://jobs.example.test/{job_id}"),
    )


def test_record_job_event_publishes_through_bus(tmp_path: Path) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    bus = InProcessEventBus()
    received: list = []
    bus.subscribe(None, received.append)

    try:
        job_id = generate_job_id()
        _seed_job(conn, job_id)
        record_job_event(
            conn,
            job_id,
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
        assert event.payload["jobId"] == str(job_id)
        assert event.payload["stage"] == "score"
        assert event.payload["score"] == 9
        assert event.payload["message"] == "Fit score 9/10"
    finally:
        close_connection(db_path)


def test_record_job_event_without_publisher_only_persists(tmp_path: Path) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)

    try:
        job_id = generate_job_id()
        _seed_job(conn, job_id)
        record_job_event(
            conn,
            job_id,
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
        job_id = generate_job_id()
        _seed_job(conn, job_id)
        record_job_event(conn, job_id, "score", "StageStarted", publisher=bus)
        record_job_event(conn, job_id, "score", "StageCompleted", publisher=bus)
        record_job_event(conn, job_id, "score", "StageFailed", publisher=bus)
        conn.commit()
    finally:
        close_connection(db_path)

    assert len(started) == 1
    assert len(completed) == 1


@pytest.mark.parametrize(
    "event_type",
    ["", "stage_completed", "stageCompleted", "Stage-Completed", "Stage Completed"],
)
def test_record_job_event_rejects_non_pascal_case_types(
    tmp_path: Path,
    event_type: str,
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)

    try:
        job_id = generate_job_id()
        _seed_job(conn, job_id)
        with pytest.raises(ValueError, match="PascalCase ASCII identifier"):
            record_job_event(conn, job_id, "score", event_type)

        count = conn.execute("SELECT COUNT(*) FROM job_events").fetchone()[0]
        assert count == 0
    finally:
        close_connection(db_path)
