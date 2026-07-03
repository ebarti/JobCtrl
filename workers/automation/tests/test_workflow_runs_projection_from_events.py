"""P0: ``workflow_run_projections`` is folded from the ``Workflow*`` event
family emitted by finalize activities / the reconciler.

Each workflow run is a ``WorkflowStarted`` marker plus exactly one terminal
event, keyed by ``workflowId`` (camelCase — the events cross the SSE / TS
boundary). Workflow events carry ``job_url = None`` because a run (e.g. a
pipeline orchestrator batch) is not tied to a single job.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Iterator

import pytest

from jobhunter.database import close_connection, init_db
from jobhunter.domain.events import (
    create_workflow_canceled,
    create_workflow_completed,
    create_workflow_failed,
    create_workflow_started,
)
from jobhunter.domain.events.workflow import (
    WorkflowCanceledPayload,
    WorkflowCompletedPayload,
    WorkflowFailedPayload,
    WorkflowStartedPayload,
)
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.projections.projection_builder import ProjectionBuilder
from jobhunter.state import record_job_event


@pytest.fixture
def conn(tmp_path: Path) -> Iterator[sqlite3.Connection]:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    yield conn
    close_connection(db_path)


def _record(conn: sqlite3.Connection, event) -> None:
    """Persist a Workflow* domain event through the same writer finalize uses."""
    record_job_event(
        conn,
        None,
        "workflow",
        event.event_type,
        payload=dict(event.payload),
    )


def _row_value(row, key, default=None):
    if row is None:
        return default
    try:
        value = row[key]
    except (KeyError, IndexError, TypeError):
        return default
    return value if value is not None else default


def test_started_event_opens_row(conn: sqlite3.Connection) -> None:
    _record(
        conn,
        create_workflow_started(
            LOCAL_TENANT,
            WorkflowStartedPayload(
                workflow_id="run-1",
                workflow_type="JobPipelineWorkflow",
                input_summary={"stages": ["discover"]},
                started_at="2026-05-04T13:00:00+00:00",
                temporal_run_id="temporal-1",
            ),
        ),
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        "SELECT * FROM workflow_run_projections WHERE workflow_id = ?", ("run-1",)
    ).fetchone()
    assert row is not None
    assert _row_value(row, "status") == "in_progress"
    assert _row_value(row, "workflow_type") == "JobPipelineWorkflow"
    assert _row_value(row, "started_at") == "2026-05-04T13:00:00+00:00"
    assert _row_value(row, "temporal_run_id") == "temporal-1"
    assert json.loads(_row_value(row, "input_summary_json", "{}")) == {
        "stages": ["discover"]
    }


def test_completed_event_terminates_row_as_succeeded(conn: sqlite3.Connection) -> None:
    _record(
        conn,
        create_workflow_started(
            LOCAL_TENANT,
            WorkflowStartedPayload(
                workflow_id="run-2",
                workflow_type="JobPipelineWorkflow",
                started_at="2026-05-04T13:00:00+00:00",
            ),
        ),
    )
    _record(
        conn,
        create_workflow_completed(
            LOCAL_TENANT,
            WorkflowCompletedPayload(
                workflow_id="run-2",
                workflow_type="JobPipelineWorkflow",
                finished_at="2026-05-04T13:05:00+00:00",
                duration_ms=300_000,
            ),
        ),
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        "SELECT * FROM workflow_run_projections WHERE workflow_id = ?", ("run-2",)
    ).fetchone()
    assert _row_value(row, "status") == "succeeded"
    assert _row_value(row, "finished_at") == "2026-05-04T13:05:00+00:00"
    assert _row_value(row, "duration_ms") == 300_000


def test_failed_event_records_error_and_retryable(conn: sqlite3.Connection) -> None:
    _record(
        conn,
        create_workflow_started(
            LOCAL_TENANT,
            WorkflowStartedPayload(workflow_id="run-3", workflow_type="ApplyWorkflow"),
        ),
    )
    _record(
        conn,
        create_workflow_failed(
            LOCAL_TENANT,
            WorkflowFailedPayload(
                workflow_id="run-3",
                workflow_type="ApplyWorkflow",
                error_code="activity_error",
                error_message="boom",
                retryable=True,
                finished_at="2026-05-04T13:02:00+00:00",
                duration_ms=120_000,
            ),
        ),
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        "SELECT * FROM workflow_run_projections WHERE workflow_id = ?", ("run-3",)
    ).fetchone()
    assert _row_value(row, "status") == "failed"
    assert _row_value(row, "error_code") == "activity_error"
    assert _row_value(row, "error_message") == "boom"
    assert _row_value(row, "retryable") == 1


def test_canceled_event_terminates_row(conn: sqlite3.Connection) -> None:
    _record(
        conn,
        create_workflow_started(
            LOCAL_TENANT,
            WorkflowStartedPayload(workflow_id="run-4", workflow_type="ApplyWorkflow"),
        ),
    )
    _record(
        conn,
        create_workflow_canceled(
            LOCAL_TENANT,
            WorkflowCanceledPayload(
                workflow_id="run-4",
                workflow_type="ApplyWorkflow",
                finished_at="2026-05-04T13:01:00+00:00",
                duration_ms=60_000,
            ),
        ),
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        "SELECT status FROM workflow_run_projections WHERE workflow_id = ?", ("run-4",)
    ).fetchone()
    assert _row_value(row, "status") == "canceled"


def test_fold_is_first_terminal_wins(conn: sqlite3.Connection) -> None:
    """A later terminal event must not overwrite the first terminal (M-1 review).

    Root cause: ``JobPipelineWorkflow`` / ``ApplyWorkflow`` encode stage/apply
    failure in their return value, so the Temporal execution closes COMPLETED
    while finalize already recorded ``WorkflowFailed``. A reconciler describe
    (COMPLETED) racing that finalize once appended ``WorkflowCompleted`` and the
    last-terminal-wins fold flipped ``failed`` -> ``succeeded``. The fold is now
    first-terminal-wins: the first terminal event owns the run's status.
    """
    _record(
        conn,
        create_workflow_started(
            LOCAL_TENANT,
            WorkflowStartedPayload(workflow_id="run-race", workflow_type="ApplyWorkflow"),
        ),
    )
    _record(
        conn,
        create_workflow_failed(
            LOCAL_TENANT,
            WorkflowFailedPayload(
                workflow_id="run-race",
                workflow_type="ApplyWorkflow",
                error_code="apply_failed",
                error_message="boom",
                finished_at="2026-05-04T13:02:00+00:00",
            ),
        ),
    )
    # A stray later terminal for the same id (mis-emitted / reconciler race).
    _record(
        conn,
        create_workflow_completed(
            LOCAL_TENANT,
            WorkflowCompletedPayload(
                workflow_id="run-race",
                workflow_type="ApplyWorkflow",
                finished_at="2026-05-04T13:03:00+00:00",
            ),
        ),
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        "SELECT status, error_message FROM workflow_run_projections WHERE workflow_id = ?",
        ("run-race",),
    ).fetchone()
    # First terminal (WorkflowFailed) wins; the later WorkflowCompleted does not
    # flip it, and the first terminal's error detail is preserved.
    assert _row_value(row, "status") == "failed"
    assert _row_value(row, "error_message") == "boom"


def test_outcome_without_start_marker_still_terminalizes(conn: sqlite3.Connection) -> None:
    """A terminal outcome with no preceding ``WorkflowStarted`` still lands a row.

    Regression (L-2 review): the fold is create-if-missing from the outcome
    event, so a run whose start marker never recorded still terminalizes in the
    read-model (giving the reconciler / UI a row) rather than vanishing.
    """
    _record(
        conn,
        create_workflow_failed(
            LOCAL_TENANT,
            WorkflowFailedPayload(
                workflow_id="run-no-start",
                workflow_type="ApplyWorkflow",
                error_code="workflow_error",
                error_message="died before the start marker recorded",
                finished_at="2026-05-04T13:09:00+00:00",
            ),
        ),
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        "SELECT status, workflow_type FROM workflow_run_projections WHERE workflow_id = ?",
        ("run-no-start",),
    ).fetchone()
    assert row is not None
    assert _row_value(row, "status") == "failed"
    assert _row_value(row, "workflow_type") == "ApplyWorkflow"


def test_timeline_collected_and_rebuild_deterministic(conn: sqlite3.Connection) -> None:
    _record(
        conn,
        create_workflow_started(
            LOCAL_TENANT,
            WorkflowStartedPayload(workflow_id="run-5", workflow_type="JobPipelineWorkflow"),
        ),
    )
    _record(
        conn,
        create_workflow_completed(
            LOCAL_TENANT,
            WorkflowCompletedPayload(
                workflow_id="run-5",
                workflow_type="JobPipelineWorkflow",
                finished_at="t9",
                duration_ms=10,
            ),
        ),
    )
    conn.commit()

    builder = ProjectionBuilder(conn_factory=lambda: conn)
    builder.refresh()
    builder.refresh()  # second pass must not duplicate or churn

    rows = conn.execute(
        "SELECT events_json FROM workflow_run_projections WHERE workflow_id = ?",
        ("run-5",),
    ).fetchall()
    assert len(rows) == 1
    timeline = json.loads(_row_value(rows[0], "events_json", "[]"))
    assert [event.get("eventType") for event in timeline] == [
        "WorkflowStarted",
        "WorkflowCompleted",
    ]
