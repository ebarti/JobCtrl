"""Cross-runtime exact-v7 coverage for ``contact_projections``."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
from jobctrl.infrastructure.projections.sqlite_projection_store import (
    SqliteProjectionStore,
)

_FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages/domain-types/test/fixtures/contact_projection_parity.json"
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
    for contact in tenant["contacts"]:
        conn.execute(
            """
            INSERT INTO contacts (
                tenant_id, contact_id, employer, job_id, role,
                created_at, updated_at, deleted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
            """,
            (
                tenant_id,
                contact["contactId"],
                contact["employer"],
                contact["jobId"],
                contact["role"],
                contact["createdAt"],
                contact["updatedAt"],
            ),
        )
    for attribute in tenant["attributes"]:
        conn.execute(
            """
            INSERT INTO contact_attributes (
                tenant_id, attribute_id, contact_id, attribute_kind, value_json,
                source_kind, source_ref, capture_method, confidence,
                user_confirmed, recorded_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                tenant_id,
                attribute["attributeId"],
                attribute["contactId"],
                attribute["kind"],
                json.dumps(attribute["value"]),
                attribute["sourceKind"],
                attribute["sourceRef"],
                attribute["captureMethod"],
                attribute["confidence"],
                1 if attribute["userConfirmed"] else 0,
                attribute["recordedAt"],
            ),
        )
    conn.commit()


def _normalize(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "contactId": row["contact_id"],
        "employer": row["employer"],
        "jobId": row["job_id"],
        "role": row["role"],
        "attributeCount": row["attribute_count"],
        "confirmedCount": row["confirmed_count"],
        "sourceKinds": json.loads(row["source_kinds_json"]),
        "provenance": json.loads(row["provenance_json"]),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _projected(conn: sqlite3.Connection, tenant: dict[str, Any]) -> list[dict[str, Any]]:
    tenant_id = TenantId(tenant["tenantId"])
    builder = ProjectionBuilder(conn_factory=lambda: conn, tenant_id=tenant_id)
    builder.subscribe_to(InProcessEventBus())
    builder.refresh()
    rows = SqliteProjectionStore(conn).fetch_contacts(str(tenant_id))
    return sorted((_normalize(row) for row in rows), key=lambda item: item["contactId"])


def _expected(tenant: dict[str, Any]) -> list[dict[str, Any]]:
    return sorted(tenant["expected"], key=lambda item: item["contactId"])


def test_contact_projection_exact_v7_fixture_is_tenant_scoped() -> None:
    fixture = json.loads(_FIXTURE.read_text())
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    create_exact_v7_schema(conn)
    for tenant in fixture["tenants"]:
        _seed_canonical(conn, tenant)

    local, other = fixture["tenants"]
    assert _projected(conn, local) == _expected(local)
    assert SqliteProjectionStore(conn).fetch_contacts(other["tenantId"]) == []
    assert _projected(conn, other) == _expected(other)
    assert _projected(conn, local) == _expected(local)

    projection_text = " ".join(
        " ".join(str(value) for value in tuple(row))
        for row in SqliteProjectionStore(conn).fetch_contacts(local["tenantId"])
        + SqliteProjectionStore(conn).fetch_contacts(other["tenantId"])
    )
    for secret in fixture["sensitiveValues"]:
        assert secret not in projection_text
