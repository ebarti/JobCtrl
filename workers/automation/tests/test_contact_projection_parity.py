"""Exact-v7 coverage for ``contact_projections`` (R6 Phase 1).

The shared parity fixture remains on the legacy TypeScript projection contract.
This test derives a local exact-v7 fixture using canonical JobIds, then asserts
the resulting ``contact_projections`` rows and the sensitive-value boundary.
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
from jobctrl.infrastructure.projections.sqlite_projection_store import (
    SqliteProjectionStore,
)

_FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages/domain-types/test/fixtures/contact_projection_parity.json"
)
_V7_JOB_IDS = {
    "https://boards.example.com/acme/eng-1": "11111111-1111-4111-8111-111111111111",
}


def _exact_v7_fixture() -> dict[str, Any]:
    fixture = json.loads(_FIXTURE.read_text())
    for contact in fixture["contacts"]:
        job_url = contact.pop("jobUrl")
        contact["jobId"] = _V7_JOB_IDS[job_url] if job_url else None
    for expected in fixture["expected"]:
        job_url = expected.get("jobId")
        expected["jobId"] = _V7_JOB_IDS[job_url] if job_url else None
    return fixture


def _seed_canonical(conn: sqlite3.Connection, fixture: dict[str, Any]) -> None:
    tenant = fixture["tenantId"]
    for contact in fixture["contacts"]:
        if contact["jobId"] is None:
            continue
        conn.execute(
            """
            INSERT INTO jobs (tenant_id, job_id, url, title, discovered_at)
            VALUES (?, ?, ?, 'Fixture job', '2026-07-31T12:00:00Z')
            """,
            (tenant, contact["jobId"], f"https://fixtures.example/{contact['contactId']}"),
        )
    for contact in fixture["contacts"]:
        conn.execute(
            """
            INSERT INTO contacts (
                tenant_id, contact_id, employer, job_id, role,
                created_at, updated_at, deleted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
            """,
            (
                tenant,
                contact["contactId"],
                contact["employer"],
                contact["jobId"],
                contact["role"],
                contact["createdAt"],
                contact["updatedAt"],
            ),
        )
    for attribute in fixture["attributes"]:
        conn.execute(
            """
            INSERT INTO contact_attributes (
                tenant_id, attribute_id, contact_id, attribute_kind, value_json,
                source_kind, source_ref, capture_method, confidence,
                user_confirmed, recorded_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                tenant,
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


def test_contact_projection_exact_v7_fixture(tmp_path: Path) -> None:
    fixture = _exact_v7_fixture()
    conn = init_db(tmp_path / "jobctrl.db")
    conn.row_factory = sqlite3.Row
    _seed_canonical(conn, fixture)

    builder = ProjectionBuilder(conn_factory=lambda: conn, tenant_id=LOCAL_TENANT)
    builder.subscribe_to(InProcessEventBus())
    builder.refresh()

    rows = SqliteProjectionStore(conn).fetch_contacts("local")
    projected = sorted((_normalize(row) for row in rows), key=lambda item: item["contactId"])
    expected = sorted(fixture["expected"], key=lambda item: item["contactId"])
    assert projected == expected

    projection_text = " ".join(
        " ".join(str(value) for value in tuple(row)) for row in rows
    )
    for secret in fixture["sensitiveValues"]:
        assert secret not in projection_text
