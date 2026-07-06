"""Cross-runtime parity for ``outreach_thread_projections`` (R6 Phase 3).

The Python half of the TS<->Python drift guard. The TS half lives at
``apps/api/test/outreach-projection-parity.test.ts``. Both load the SAME shared
fixture, seed the SAME canonical ``outreach_threads`` / ``outreach_drafts`` rows,
run their OWN projection refresh, and assert the resulting projection rows equal
the fixture's ``expected`` block (JSON columns compared parsed). It also asserts
that no draft body, gate internal, or provenance rationale leaks into the
projection (sensitivity rule, plan §6): the projection carries lifecycle SUMMARY
plus per-draft METADATA only.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from jobhunter.database import init_db
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.events.in_process_bus import InProcessEventBus
from jobhunter.infrastructure.projections.projection_builder import ProjectionBuilder
from jobhunter.infrastructure.projections.sqlite_projection_store import SqliteProjectionStore

_FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages/domain-types/test/fixtures/outreach_thread_projection_parity.json"
)


def _seed_canonical(conn: sqlite3.Connection, fixture: dict[str, Any]) -> None:
    tenant = fixture["tenantId"]
    for thread in fixture["threads"]:
        conn.execute(
            """
            INSERT INTO outreach_threads (
                tenant_id, thread_id, contact_id, job_url, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                tenant,
                thread["threadId"],
                thread["contactId"],
                thread["jobUrl"],
                thread["createdAt"],
                thread["updatedAt"],
            ),
        )
    for draft in fixture["drafts"]:
        conn.execute(
            """
            INSERT INTO outreach_drafts (
                tenant_id, draft_id, thread_id, generation, kind, status, body_text,
                gate_results_json, provenance_json, created_at, approved_at,
                rejected_at, reason
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                tenant,
                draft["draftId"],
                draft["threadId"],
                draft["generation"],
                draft["kind"],
                draft["status"],
                draft["bodyText"],
                json.dumps(draft["gateResults"]),
                json.dumps(draft["provenance"]),
                draft["createdAt"],
                draft["approvedAt"],
                draft["rejectedAt"],
                draft["reason"],
            ),
        )
    conn.commit()


def _normalize(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "threadId": row["thread_id"],
        "contactId": row["contact_id"],
        "jobId": row["job_id"],
        "draftCount": row["draft_count"],
        "latestGeneration": row["latest_generation"],
        "hasApprovedDraft": bool(row["has_approved_draft"]),
        "approvedDraftId": row["approved_draft_id"],
        "latestStatus": row["latest_status"],
        "drafts": json.loads(row["drafts_json"]),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "lastUpdatedAt": row["last_updated_at"],
    }


def test_outreach_projection_parity(tmp_path: Path) -> None:
    fixture = json.loads(_FIXTURE.read_text())
    conn = init_db(tmp_path / "jobhunter.db")
    conn.row_factory = sqlite3.Row
    _seed_canonical(conn, fixture)

    builder = ProjectionBuilder(conn_factory=lambda: conn, tenant_id=LOCAL_TENANT)
    builder.subscribe_to(InProcessEventBus())
    builder.refresh()

    rows = SqliteProjectionStore(conn).fetch_outreach_threads("local")
    projected = sorted((_normalize(row) for row in rows), key=lambda item: item["threadId"])
    expected = sorted(fixture["expected"], key=lambda item: item["threadId"])
    assert projected == expected

    projection_text = " ".join(
        " ".join(str(value) for value in tuple(row)) for row in rows
    )
    for secret in fixture["sensitiveValues"]:
        assert secret not in projection_text


def test_outreach_projection_rebuild_is_idempotent(tmp_path: Path) -> None:
    fixture = json.loads(_FIXTURE.read_text())
    conn = init_db(tmp_path / "jobhunter.db")
    conn.row_factory = sqlite3.Row
    _seed_canonical(conn, fixture)

    builder = ProjectionBuilder(conn_factory=lambda: conn, tenant_id=LOCAL_TENANT)
    builder.subscribe_to(InProcessEventBus())
    builder.refresh()
    first = [_normalize(row) for row in SqliteProjectionStore(conn).fetch_outreach_threads("local")]
    builder.refresh()
    second = [_normalize(row) for row in SqliteProjectionStore(conn).fetch_outreach_threads("local")]
    assert first == second
