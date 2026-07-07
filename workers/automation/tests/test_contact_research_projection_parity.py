"""Cross-runtime parity for ``contact_research_task_projections`` (R6 Phase 2).

The Python half of the TS<->Python drift guard. The TS half lives at
``apps/api/test/contact-research-projection-parity.test.ts``. Both load the SAME
shared fixture, seed the SAME canonical ``contact_research_tasks`` /
``contact_candidates`` rows, run their OWN projection refresh, and assert the
resulting projection rows equal the fixture's ``expected`` block (JSON columns
compared parsed). It also asserts no candidate VALUE leaks into the projection
(sensitivity rule, plan §6).
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from jobctrl.database import init_db
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
from jobctrl.infrastructure.projections.sqlite_projection_store import SqliteProjectionStore

_FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages/domain-types/test/fixtures/contact_research_projection_parity.json"
)


def _seed_canonical(conn: sqlite3.Connection, fixture: dict[str, Any]) -> None:
    tenant = fixture["tenantId"]
    for task in fixture["tasks"]:
        conn.execute(
            """
            INSERT INTO contact_research_tasks (
                tenant_id, task_id, employer, job_url, status, source_attempts_json,
                started_at, updated_at, needs_review_at, completed_at, failed_at, error_class
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                tenant,
                task["taskId"],
                task["employer"],
                task["jobUrl"],
                task["status"],
                json.dumps(task["sourceAttempts"]),
                task["startedAt"],
                task["updatedAt"],
                task["needsReviewAt"],
                task["completedAt"],
                task["failedAt"],
                task["errorClass"],
            ),
        )
    for candidate in fixture["candidates"]:
        conn.execute(
            """
            INSERT INTO contact_candidates (
                tenant_id, candidate_id, task_id, role, attributes_json,
                source_kind, source_ref, capture_method, confidence, status,
                proposed_at, confirmed_contact_id, confirmed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                tenant,
                candidate["candidateId"],
                candidate["taskId"],
                candidate["role"],
                json.dumps(candidate["attributes"]),
                candidate["sourceKind"],
                candidate["sourceRef"],
                candidate["captureMethod"],
                candidate["confidence"],
                candidate["status"],
                candidate["proposedAt"],
                candidate["confirmedContactId"],
                candidate["confirmedAt"],
            ),
        )
    conn.commit()


def _normalize(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "taskId": row["task_id"],
        "employer": row["employer"],
        "jobId": row["job_id"],
        "status": row["status"],
        "candidateCount": row["candidate_count"],
        "needsReviewCount": row["needs_review_count"],
        "confirmedCount": row["confirmed_count"],
        "sourceAttempts": json.loads(row["source_attempts_json"]),
        "candidates": json.loads(row["candidates_json"]),
        "startedAt": row["started_at"],
        "updatedAt": row["updated_at"],
        "needsReviewAt": row["needs_review_at"],
        "completedAt": row["completed_at"],
        "failedAt": row["failed_at"],
        "errorClass": row["error_class"],
    }


def test_contact_research_projection_parity(tmp_path: Path) -> None:
    fixture = json.loads(_FIXTURE.read_text())
    conn = init_db(tmp_path / "jobctrl.db")
    conn.row_factory = sqlite3.Row
    _seed_canonical(conn, fixture)

    builder = ProjectionBuilder(conn_factory=lambda: conn, tenant_id=LOCAL_TENANT)
    builder.subscribe_to(InProcessEventBus())
    builder.refresh()

    rows = SqliteProjectionStore(conn).fetch_contact_research_tasks("local")
    projected = sorted((_normalize(row) for row in rows), key=lambda item: item["taskId"])
    expected = sorted(fixture["expected"], key=lambda item: item["taskId"])
    assert projected == expected

    projection_text = " ".join(
        " ".join(str(value) for value in tuple(row)) for row in rows
    )
    for secret in fixture["sensitiveValues"]:
        assert secret not in projection_text
