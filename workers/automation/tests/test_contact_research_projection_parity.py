"""Cross-runtime exact-v7 coverage for ``contact_research_task_projections``."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
from jobctrl.infrastructure.projections.sqlite_projection_store import SqliteProjectionStore

_FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages/domain-types/test/fixtures/contact_research_projection_parity.json"
)


def _seed_canonical(conn: sqlite3.Connection, tenant: dict[str, Any]) -> None:
    tenant_id = tenant["tenantId"]
    for job in tenant["jobs"]:
        conn.execute(
            """
            INSERT INTO jobs (tenant_id, job_id, url, title, discovered_at)
            VALUES (?, ?, ?, 'Fixture job', '2026-07-31T12:00:00Z')
            """,
            (tenant_id, job["jobId"], job["url"]),
        )
    for task in tenant["tasks"]:
        conn.execute(
            """
            INSERT INTO contact_research_tasks (
                tenant_id, task_id, employer, job_id, status, source_attempts_json,
                started_at, updated_at, needs_review_at, completed_at, failed_at, error_class
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                tenant_id,
                task["taskId"],
                task["employer"],
                task["jobId"],
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
    for candidate in tenant["candidates"]:
        conn.execute(
            """
            INSERT INTO contact_candidates (
                tenant_id, candidate_id, task_id, role, attributes_json,
                source_kind, source_ref, capture_method, confidence, status,
                proposed_at, confirmed_contact_id, confirmed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                tenant_id,
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


def _projected(conn: sqlite3.Connection, tenant: dict[str, Any]) -> list[dict[str, Any]]:
    tenant_id = TenantId(tenant["tenantId"])
    builder = ProjectionBuilder(conn_factory=lambda: conn, tenant_id=tenant_id)
    builder.subscribe_to(InProcessEventBus())
    builder.refresh()
    rows = SqliteProjectionStore(conn).fetch_contact_research_tasks(str(tenant_id))
    return sorted((_normalize(row) for row in rows), key=lambda item: item["taskId"])


def _expected(tenant: dict[str, Any]) -> list[dict[str, Any]]:
    return sorted(tenant["expected"], key=lambda item: item["taskId"])


def test_contact_research_projection_exact_v7_fixture_is_tenant_scoped() -> None:
    fixture = json.loads(_FIXTURE.read_text())
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    create_exact_v7_schema(conn)
    for tenant in fixture["tenants"]:
        _seed_canonical(conn, tenant)

    local, other = fixture["tenants"]
    assert _projected(conn, local) == _expected(local)
    assert SqliteProjectionStore(conn).fetch_contact_research_tasks(other["tenantId"]) == []
    assert _projected(conn, other) == _expected(other)
    assert _projected(conn, local) == _expected(local)

    projection_text = " ".join(
        " ".join(str(value) for value in tuple(row))
        for row in SqliteProjectionStore(conn).fetch_contact_research_tasks(local["tenantId"])
        + SqliteProjectionStore(conn).fetch_contact_research_tasks(other["tenantId"])
    )
    for secret in fixture["sensitiveValues"]:
        assert secret not in projection_text
