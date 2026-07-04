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
    create_workflow_terminated,
)
from jobhunter.domain.events.workflow import (
    WorkflowCanceledPayload,
    WorkflowCompletedPayload,
    WorkflowFailedPayload,
    WorkflowStartedPayload,
    WorkflowTerminatedPayload,
)
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.projections.projection_builder import ProjectionBuilder
from jobhunter.infrastructure.projections.sqlite_projection_store import _ensure_column
from jobhunter.state import record_job_event


@pytest.fixture
def conn(tmp_path: Path) -> Iterator[sqlite3.Connection]:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    yield conn
    close_connection(db_path)


def _record(conn: sqlite3.Connection, event, occurred_at: str | None = None) -> None:
    """Persist a Workflow* domain event through the same writer finalize uses."""
    record_job_event(
        conn,
        None,
        "workflow",
        event.event_type,
        payload=dict(event.payload),
        occurred_at=occurred_at,
    )


def _row_value(row, key, default=None):
    if row is None:
        return default
    try:
        value = row[key]
    except (KeyError, IndexError, TypeError):
        return default
    return value if value is not None else default


def _replace_workflow_projection_schema_with_legacy_shape(
    conn: sqlite3.Connection,
) -> None:
    conn.execute("DROP TABLE workflow_run_projections")
    conn.execute(
        """
        CREATE TABLE workflow_run_projections (
            workflow_id            TEXT PRIMARY KEY,
            run_id                 TEXT NOT NULL DEFAULT '',
            tenant_id              TEXT NOT NULL DEFAULT 'local',
            workflow_type          TEXT NOT NULL DEFAULT 'pipeline',
            job_id                 TEXT NOT NULL DEFAULT '',
            title                  TEXT NOT NULL DEFAULT '',
            company                TEXT NOT NULL DEFAULT '',
            status                 TEXT NOT NULL DEFAULT 'starting',
            result                 TEXT,
            dry_run                INTEGER NOT NULL DEFAULT 0,
            model                  TEXT,
            started_at             TEXT,
            finished_at            TEXT,
            duration_ms            INTEGER,
            stages_json            TEXT NOT NULL DEFAULT '[]',
            events_json            TEXT NOT NULL DEFAULT '[]'
        )
        """
    )
    conn.commit()


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
    last_event_id = conn.execute("SELECT MAX(event_id) FROM job_events").fetchone()[0]
    conn.execute(
        """
        INSERT INTO event_watermarks (projection_name, last_event_id, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(projection_name) DO UPDATE SET
            last_event_id = excluded.last_event_id,
            updated_at = excluded.updated_at
        """,
        ("operations_projections", last_event_id, "2026-07-04T08:36:17Z"),
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


def test_legacy_workflow_projection_schema_is_migrated_before_fold(
    conn: sqlite3.Connection,
) -> None:
    """Existing local DBs may have the old workflow projection table shape.

    The finalize activity records a WorkflowStarted event, then immediately
    refreshes projections. If the table is not upgraded before the refresh, the
    activity fails and Temporal retries forever before source discovery starts.
    """
    _replace_workflow_projection_schema_with_legacy_shape(conn)
    _record(
        conn,
        create_workflow_started(
            LOCAL_TENANT,
            WorkflowStartedPayload(
                workflow_id="discover-local",
                workflow_type="DiscoverWorkflow",
                input_summary={"limit": 1000, "workers": 10},
                started_at="2026-07-04T07:57:11+00:00",
                temporal_run_id="temporal-discover",
            ),
        ),
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(workflow_run_projections)")
    }
    assert {
        "input_summary_json",
        "error_code",
        "error_message",
        "retryable",
        "temporal_run_id",
    }.issubset(columns)
    row = conn.execute(
        "SELECT * FROM workflow_run_projections WHERE workflow_id = ?",
        ("discover-local",),
    ).fetchone()
    assert row is not None
    assert _row_value(row, "status") == "in_progress"
    assert _row_value(row, "workflow_type") == "DiscoverWorkflow"
    assert _row_value(row, "temporal_run_id") == "temporal-discover"
    assert json.loads(_row_value(row, "input_summary_json", "{}")) == {
        "limit": 1000,
        "workers": 10,
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


class _StaleCheckCursor:
    def __init__(self, rows: list) -> None:
        self._rows = rows

    def fetchall(self) -> list:
        return self._rows


class _StaleCheckConnection:
    """Reproduces the cross-process check-then-ALTER race on the shared SQLite
    file: the first ``PRAGMA table_info`` check reports the column missing
    while the other process has already added it, so the ALTER fails with
    "duplicate column"."""

    def __init__(self, real: sqlite3.Connection, table: str, column: str) -> None:
        self._real = real
        self._table = table
        self._column = column
        self._stale_check_pending = True

    def execute(self, sql: str, *args):
        is_column_check = sql.strip().startswith(f"PRAGMA table_info({self._table})")
        if self._stale_check_pending and is_column_check:
            self._stale_check_pending = False
            rows = self._real.execute(sql, *args).fetchall()
            return _StaleCheckCursor([row for row in rows if row[1] != self._column])
        return self._real.execute(sql, *args)


def test_ensure_column_tolerates_concurrent_column_add(
    conn: sqlite3.Connection,
) -> None:
    """The TS API and the Python worker both upgrade the schema at startup;
    the loser of the ALTER race must not fail initialization."""
    racing = _StaleCheckConnection(
        conn, "workflow_run_projections", "input_summary_json"
    )

    assert (
        _ensure_column(
            racing,
            "workflow_run_projections",
            "input_summary_json",
            "TEXT NOT NULL DEFAULT '{}'",
        )
        is True
    )


def _record_restart_reusing_workflow_id(conn: sqlite3.Connection) -> None:
    """The 2026-07-04 chimera sequence.

    An earlier ``discover-local`` run closed by the reconciler
    (``terminated`` / ``reconciled_not_found``), then a new Temporal execution
    reusing the same workflow_id that fails on its own environment error.
    """
    _record(
        conn,
        create_workflow_started(
            LOCAL_TENANT,
            WorkflowStartedPayload(
                workflow_id="discover-local",
                workflow_type="DiscoverWorkflow",
                started_at="2026-07-04T11:00:00+00:00",
                temporal_run_id="temporal-A",
            ),
        ),
        occurred_at="2026-07-04T11:00:00+00:00",
    )
    _record(
        conn,
        create_workflow_terminated(
            LOCAL_TENANT,
            WorkflowTerminatedPayload(
                workflow_id="discover-local",
                workflow_type="DiscoverWorkflow",
                error_code="reconciled_not_found",
                error_message="closed by the describe reconciler",
                finished_at="2026-07-04T11:16:55+00:00",
                temporal_run_id="temporal-A",
            ),
        ),
        occurred_at="2026-07-04T11:16:55+00:00",
    )
    _record(
        conn,
        create_workflow_started(
            LOCAL_TENANT,
            WorkflowStartedPayload(
                workflow_id="discover-local",
                workflow_type="DiscoverWorkflow",
                started_at="2026-07-04T12:00:00+00:00",
                temporal_run_id="temporal-B",
            ),
        ),
        occurred_at="2026-07-04T12:00:00+00:00",
    )
    _record(
        conn,
        create_workflow_failed(
            LOCAL_TENANT,
            WorkflowFailedPayload(
                workflow_id="discover-local",
                workflow_type="DiscoverWorkflow",
                error_code="configuration",
                error_message="BrowserType.launch: Executable doesn't exist",
                retryable=False,
                finished_at="2026-07-04T14:08:43+00:00",
                temporal_run_id="temporal-B",
            ),
        ),
        occurred_at="2026-07-04T14:08:43+00:00",
    )


def test_new_execution_reopens_stale_terminal_row(conn: sqlite3.Connection) -> None:
    """A restart reusing the workflow_id must not inherit the prior run's terminal.

    Incident 2026-07-04: the reconciler closed an earlier ``discover-local`` run
    as ``terminated`` / ``reconciled_not_found``; a new Temporal execution reused
    the workflow_id and failed, but the global first-terminal-wins fold kept the
    stale ``terminated`` status and dropped the new run's ``WorkflowFailed`` — a
    chimera row (terminated status carrying the new run's ``started_at``). The
    fold is now run-scoped: the new execution's ``WorkflowStarted`` reopens the
    row so its own terminal applies.
    """
    _record_restart_reusing_workflow_id(conn)
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        "SELECT * FROM workflow_run_projections WHERE workflow_id = ?",
        ("discover-local",),
    ).fetchone()
    assert _row_value(row, "status") == "failed"
    assert _row_value(row, "error_code") == "configuration"
    assert (
        _row_value(row, "error_message")
        == "BrowserType.launch: Executable doesn't exist"
    )
    assert _row_value(row, "finished_at") == "2026-07-04T14:08:43+00:00"
    assert _row_value(row, "started_at") == "2026-07-04T12:00:00+00:00"
    assert _row_value(row, "temporal_run_id") == "temporal-B"
    assert _row_value(row, "retryable") == 0
    timeline = json.loads(_row_value(row, "events_json", "[]"))
    assert [event.get("eventType") for event in timeline] == [
        "WorkflowStarted",
        "WorkflowTerminated",
        "WorkflowStarted",
        "WorkflowFailed",
    ]


def test_duplicate_started_for_folded_new_run_is_idempotent(
    conn: sqlite3.Connection,
) -> None:
    """Replaying the new run's ``WorkflowStarted`` after it terminalized is a no-op.

    At-least-once delivery can redeliver the new execution's start marker after
    its ``WorkflowFailed`` folded. The same run id (even redelivered with an
    occurredAt later than the failure) must not reopen the row.
    """
    _record_restart_reusing_workflow_id(conn)
    _record(
        conn,
        create_workflow_started(
            LOCAL_TENANT,
            WorkflowStartedPayload(
                workflow_id="discover-local",
                workflow_type="DiscoverWorkflow",
                started_at="2026-07-04T12:00:00+00:00",
                temporal_run_id="temporal-B",
            ),
        ),
        occurred_at="2026-07-04T14:10:00+00:00",
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        "SELECT status, error_code, finished_at, temporal_run_id "
        "FROM workflow_run_projections WHERE workflow_id = ?",
        ("discover-local",),
    ).fetchone()
    assert _row_value(row, "status") == "failed"
    assert _row_value(row, "error_code") == "configuration"
    assert _row_value(row, "finished_at") == "2026-07-04T14:08:43+00:00"
    assert _row_value(row, "temporal_run_id") == "temporal-B"


def test_within_run_duplicate_started_does_not_reopen_terminal(
    conn: sqlite3.Connection,
) -> None:
    """A late ``WorkflowStarted`` for the SAME run must not reopen its terminal.

    This is the reconciler-describe vs finalize backstop kept intact by the
    run-scoped fold: identical run id, so a start redelivered after the terminal
    (carrying the run's original early ``startedAt`` / occurredAt) preserves the
    outcome.
    """
    _record(
        conn,
        create_workflow_started(
            LOCAL_TENANT,
            WorkflowStartedPayload(
                workflow_id="run-same",
                workflow_type="ApplyWorkflow",
                started_at="2026-07-04T13:00:00+00:00",
                temporal_run_id="temporal-same",
            ),
        ),
        occurred_at="2026-07-04T13:00:00+00:00",
    )
    _record(
        conn,
        create_workflow_terminated(
            LOCAL_TENANT,
            WorkflowTerminatedPayload(
                workflow_id="run-same",
                workflow_type="ApplyWorkflow",
                error_code="reconciled_not_found",
                error_message="closed by the describe reconciler",
                finished_at="2026-07-04T13:02:00+00:00",
                temporal_run_id="temporal-same",
            ),
        ),
        occurred_at="2026-07-04T13:02:00+00:00",
    )
    _record(
        conn,
        create_workflow_started(
            LOCAL_TENANT,
            WorkflowStartedPayload(
                workflow_id="run-same",
                workflow_type="ApplyWorkflow",
                started_at="2026-07-04T13:00:00+00:00",
                temporal_run_id="temporal-same",
            ),
        ),
        occurred_at="2026-07-04T13:00:00+00:00",
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        "SELECT status, error_code, finished_at FROM workflow_run_projections "
        "WHERE workflow_id = ?",
        ("run-same",),
    ).fetchone()
    assert _row_value(row, "status") == "terminated"
    assert _row_value(row, "error_code") == "reconciled_not_found"
    assert _row_value(row, "finished_at") == "2026-07-04T13:02:00+00:00"


def test_two_started_markers_for_same_run_are_idempotent(
    conn: sqlite3.Connection,
) -> None:
    """Two ``WorkflowStarted`` markers for one run (19ms apart in the incident)
    fold to a single row that still terminalizes on its own terminal.
    """
    _record(
        conn,
        create_workflow_started(
            LOCAL_TENANT,
            WorkflowStartedPayload(
                workflow_id="discover-local",
                workflow_type="DiscoverWorkflow",
                input_summary={"limit": 1000, "workers": 10},
                started_at="2026-07-04T07:57:11+00:00",
                temporal_run_id="temporal-X",
            ),
        ),
        occurred_at="2026-07-04T07:57:11.000000+00:00",
    )
    _record(
        conn,
        create_workflow_started(
            LOCAL_TENANT,
            WorkflowStartedPayload(
                workflow_id="discover-local",
                workflow_type="DiscoverWorkflow",
                input_summary={"limit": 1000, "workers": 10},
                started_at="2026-07-04T07:57:11+00:00",
                temporal_run_id="temporal-X",
            ),
        ),
        occurred_at="2026-07-04T07:57:11.019000+00:00",
    )
    _record(
        conn,
        create_workflow_completed(
            LOCAL_TENANT,
            WorkflowCompletedPayload(
                workflow_id="discover-local",
                workflow_type="DiscoverWorkflow",
                finished_at="2026-07-04T08:30:00+00:00",
                duration_ms=1_969_000,
                temporal_run_id="temporal-X",
            ),
        ),
        occurred_at="2026-07-04T08:30:00+00:00",
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    rows = conn.execute(
        "SELECT * FROM workflow_run_projections WHERE workflow_id = ?",
        ("discover-local",),
    ).fetchall()
    assert len(rows) == 1
    row = rows[0]
    assert _row_value(row, "status") == "succeeded"
    assert _row_value(row, "started_at") == "2026-07-04T07:57:11+00:00"
    assert _row_value(row, "finished_at") == "2026-07-04T08:30:00+00:00"
    assert _row_value(row, "temporal_run_id") == "temporal-X"
    timeline = json.loads(_row_value(row, "events_json", "[]"))
    assert [event.get("eventType") for event in timeline] == [
        "WorkflowStarted",
        "WorkflowStarted",
        "WorkflowCompleted",
    ]


def test_new_execution_reopen_falls_back_to_occurred_at_without_run_ids(
    conn: sqlite3.Connection,
) -> None:
    """Without Temporal run ids, a start after the folded finish reopens the row.

    Older workflow events may not carry ``temporalRunId``; the fold then orders
    executions by wall clock — a ``WorkflowStarted`` occurring after the folded
    run's ``finished_at`` is a new execution.
    """
    _record(
        conn,
        create_workflow_started(
            LOCAL_TENANT,
            WorkflowStartedPayload(
                workflow_id="legacy-run",
                workflow_type="DiscoverWorkflow",
                started_at="2026-07-04T09:00:00+00:00",
            ),
        ),
        occurred_at="2026-07-04T09:00:00+00:00",
    )
    _record(
        conn,
        create_workflow_terminated(
            LOCAL_TENANT,
            WorkflowTerminatedPayload(
                workflow_id="legacy-run",
                workflow_type="DiscoverWorkflow",
                error_code="reconciled_not_found",
                error_message="closed by the describe reconciler",
                finished_at="2026-07-04T09:10:00+00:00",
            ),
        ),
        occurred_at="2026-07-04T09:10:00+00:00",
    )
    _record(
        conn,
        create_workflow_started(
            LOCAL_TENANT,
            WorkflowStartedPayload(
                workflow_id="legacy-run",
                workflow_type="DiscoverWorkflow",
                started_at="2026-07-04T10:00:00+00:00",
            ),
        ),
        occurred_at="2026-07-04T10:00:00+00:00",
    )
    _record(
        conn,
        create_workflow_failed(
            LOCAL_TENANT,
            WorkflowFailedPayload(
                workflow_id="legacy-run",
                workflow_type="DiscoverWorkflow",
                error_code="discovery_enrichment_failed",
                error_message="all sites failed",
                finished_at="2026-07-04T10:30:00+00:00",
            ),
        ),
        occurred_at="2026-07-04T10:30:00+00:00",
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        "SELECT status, error_code, finished_at FROM workflow_run_projections "
        "WHERE workflow_id = ?",
        ("legacy-run",),
    ).fetchone()
    assert _row_value(row, "status") == "failed"
    assert _row_value(row, "error_code") == "discovery_enrichment_failed"
    assert _row_value(row, "finished_at") == "2026-07-04T10:30:00+00:00"
