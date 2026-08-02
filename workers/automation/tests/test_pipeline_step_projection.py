"""Cross-runtime parity for the pipeline-step lifecycle projection.

The TypeScript half lives in
``apps/api/test/pipeline-step-projection-parity.test.ts``. Both runtimes fold
the same shared event fixture so duplicate, retry, late-event, privacy, and
shared-watermark behavior cannot drift independently.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from jobctrl.database import init_db
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.projections.projection_builder import (
    PROJECTION_NAME,
    ProjectionBuilder,
)

_FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages/domain-types/test/fixtures/pipeline_step_projection_parity.json"
)


def _load_fixture() -> dict[str, Any]:
    return json.loads(_FIXTURE.read_text())


def _seed_events(conn: sqlite3.Connection, fixture: dict[str, Any]) -> None:
    for event_id, event in enumerate(fixture["events"], start=1):
        conn.execute(
            """
            INSERT INTO job_events (
                event_id, tenant_id, job_id, identity_version, stage,
                event_type, level, message, occurred_at, payload_json
            ) VALUES (?, ?, NULL, 1, 'workflow', ?, 'info', NULL, ?, ?)
            """,
            (
                event_id,
                str(LOCAL_TENANT),
                event["eventType"],
                event["occurredAt"],
                json.dumps(event["payload"], sort_keys=True),
            ),
        )
    conn.commit()


def _normalize(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "workflowId": row["discover_workflow_id"],
        "temporalRunId": row["discover_run_id"],
        "stepKind": row["step_kind"],
        "itemKey": row["item_key"],
        "state": row["state"],
        "attempt": row["attempt"],
        "queuedAt": row["queued_at"],
        "startedAt": row["started_at"],
        "finishedAt": row["finished_at"],
        "durationMs": row["duration_ms"],
        "errorCode": row["error_code"],
        "retryable": bool(row["retryable"]),
        "detailCode": row["detail_code"],
        "detailCount": row["detail_count"],
        "lastEventId": row["last_event_id"],
        "lastUpdatedAt": row["last_updated_at"],
    }


def _projected(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT *
        FROM pipeline_step_projections
        WHERE tenant_id = ?
        ORDER BY discover_workflow_id, discover_run_id, step_kind, item_key
        """,
        (str(LOCAL_TENANT),),
    ).fetchall()
    return [_normalize(row) for row in rows]


def _seeded_connection(tmp_path: Path) -> tuple[sqlite3.Connection, dict[str, Any]]:
    fixture = _load_fixture()
    conn = init_db(tmp_path / "jobctrl.db")
    conn.row_factory = sqlite3.Row
    _seed_events(conn, fixture)
    return conn, fixture


def test_pipeline_step_projection_matches_shared_attempt_aware_fixture(
    tmp_path: Path,
) -> None:
    conn, fixture = _seeded_connection(tmp_path)

    ProjectionBuilder(conn_factory=lambda: conn, tenant_id=LOCAL_TENANT).refresh()

    assert _projected(conn) == fixture["expected"]
    projection_rows = conn.execute(
        "SELECT * FROM pipeline_step_projections"
    ).fetchall()
    serialized = json.dumps([dict(row) for row in projection_rows])
    for sensitive_value in fixture["sensitiveValues"]:
        assert sensitive_value not in serialized


def test_pipeline_step_projection_rebuild_is_idempotent(tmp_path: Path) -> None:
    conn, _fixture = _seeded_connection(tmp_path)
    builder = ProjectionBuilder(conn_factory=lambda: conn, tenant_id=LOCAL_TENANT)

    builder.refresh()
    first = _projected(conn)
    builder.refresh()

    assert _projected(conn) == first


def test_pipeline_step_projection_backfills_past_shared_watermark(
    tmp_path: Path,
) -> None:
    conn, fixture = _seeded_connection(tmp_path)
    max_event_id = len(fixture["events"])
    conn.execute(
        """
        INSERT INTO event_watermarks (projection_name, last_event_id, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(projection_name) DO UPDATE SET
            last_event_id = excluded.last_event_id,
            updated_at = excluded.updated_at
        """,
        (PROJECTION_NAME, max_event_id, fixture["events"][-1]["occurredAt"]),
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn, tenant_id=LOCAL_TENANT).refresh()

    assert _projected(conn) == fixture["expected"]
    watermark = conn.execute(
        "SELECT last_event_id FROM event_watermarks WHERE projection_name = ?",
        (PROJECTION_NAME,),
    ).fetchone()
    assert watermark is not None
    assert watermark["last_event_id"] == max_event_id
