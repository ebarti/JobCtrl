"""Cross-runtime parity for ``contact_projections`` (R6 Phase 1).

The Python half of the TS<->Python drift guard. The TS half lives at
``apps/api/test/contact-projection-parity.test.ts``. Both load the SAME shared
fixture (``packages/domain-types/test/fixtures/contact_projection_parity.json``),
seed the SAME canonical ``contacts`` / ``contact_attributes`` rows, run their OWN
projection refresh, and assert the resulting ``contact_projections`` rows equal
the fixture's ``expected`` block (JSON columns compared parsed). It also asserts
no attribute VALUE leaks into the projection (sensitivity rule, plan §6).
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


def _seed_canonical(conn: sqlite3.Connection, fixture: dict[str, Any]) -> None:
    tenant = fixture["tenantId"]
    for contact in fixture["contacts"]:
        conn.execute(
            """
            INSERT INTO contacts (
                tenant_id, contact_id, employer, job_url, role,
                created_at, updated_at, deleted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
            """,
            (
                tenant,
                contact["contactId"],
                contact["employer"],
                contact["jobUrl"],
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


def test_contact_projection_parity(tmp_path: Path) -> None:
    fixture = json.loads(_FIXTURE.read_text())
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
