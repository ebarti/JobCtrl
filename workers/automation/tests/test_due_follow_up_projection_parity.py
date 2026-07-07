"""Cross-runtime parity for ``due_follow_up_projections`` (R6 Phase 4).

The Python half of the TS<->Python drift guard. The TS half lives at
``apps/api/test/due-follow-up-projection-parity.test.ts``. Both load the SAME
shared fixture, seed the SAME canonical ``outreach_threads`` rows (with their
follow-up columns), run their OWN projection refresh, and assert the resulting
``due_follow_up_projections`` rows equal the fixture's ``expected`` block.

Only threads whose ``follow_up_state == 'scheduled'`` are projected; completed /
dismissed / unscheduled threads are dropped. Whether a scheduled follow-up is
*due* is computed at read time (a derived signal over schedule + clock), not
stored here.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from jobctl.database import init_db
from jobctl.domain.tenant import LOCAL_TENANT
from jobctl.infrastructure.events.in_process_bus import InProcessEventBus
from jobctl.infrastructure.projections.projection_builder import ProjectionBuilder
from jobctl.infrastructure.projections.sqlite_projection_store import SqliteProjectionStore

_FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages/domain-types/test/fixtures/due_follow_up_projection_parity.json"
)


def _seed_canonical(conn: sqlite3.Connection, fixture: dict[str, Any]) -> None:
    tenant = fixture["tenantId"]
    for thread in fixture["threads"]:
        conn.execute(
            """
            INSERT INTO outreach_threads (
                tenant_id, thread_id, contact_id, job_url, created_at, updated_at,
                follow_up_due_at, follow_up_basis, follow_up_state
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                tenant,
                thread["threadId"],
                thread["contactId"],
                thread["jobUrl"],
                thread["createdAt"],
                thread["updatedAt"],
                thread["followUpDueAt"],
                thread["followUpBasis"],
                thread["followUpState"],
            ),
        )
    conn.commit()


def _normalize(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "threadId": row["thread_id"],
        "contactId": row["contact_id"],
        "jobId": row["job_id"],
        "dueAt": row["due_at"],
        "basis": row["basis"],
        "state": row["state"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "lastUpdatedAt": row["last_updated_at"],
    }


def test_due_follow_up_projection_parity(tmp_path: Path) -> None:
    fixture = json.loads(_FIXTURE.read_text())
    conn = init_db(tmp_path / "jobctl.db")
    conn.row_factory = sqlite3.Row
    _seed_canonical(conn, fixture)

    builder = ProjectionBuilder(conn_factory=lambda: conn, tenant_id=LOCAL_TENANT)
    builder.subscribe_to(InProcessEventBus())
    builder.refresh()

    rows = SqliteProjectionStore(conn).fetch_due_follow_ups("local")
    projected = sorted((_normalize(row) for row in rows), key=lambda item: item["threadId"])
    expected = sorted(fixture["expected"], key=lambda item: item["threadId"])
    assert projected == expected


def test_due_follow_up_projection_rebuild_is_idempotent(tmp_path: Path) -> None:
    fixture = json.loads(_FIXTURE.read_text())
    conn = init_db(tmp_path / "jobctl.db")
    conn.row_factory = sqlite3.Row
    _seed_canonical(conn, fixture)

    builder = ProjectionBuilder(conn_factory=lambda: conn, tenant_id=LOCAL_TENANT)
    builder.subscribe_to(InProcessEventBus())
    builder.refresh()
    first = [_normalize(r) for r in SqliteProjectionStore(conn).fetch_due_follow_ups("local")]
    builder.refresh()
    second = [_normalize(r) for r in SqliteProjectionStore(conn).fetch_due_follow_ups("local")]
    assert first == second
