"""SQLite ContactRepository + use cases + sensitivity rule (R6 Phase 1).

Covers: create/load/list/update/soft-delete, CSV import (resolved decision 4),
projection materialisation with provenance (INV-2), and the sensitivity rule —
attribute VALUES never appear in job_events payloads or the projection
(outreach planner plan §6; CLAUDE.md).
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from jobhunter.database import init_db
from jobhunter.domain.contact import (
    AttributeInput,
    ContactLink,
    ContactRole,
    CreateContactUseCase,
    DeleteContactUseCase,
    ImportContactsUseCase,
    UpdateContactUseCase,
)
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.contact.sqlite_repository import SqliteContactRepository
from jobhunter.infrastructure.events.in_process_bus import InProcessEventBus
from jobhunter.infrastructure.projections.projection_builder import ProjectionBuilder
from jobhunter.infrastructure.projections.sqlite_projection_store import (
    SqliteProjectionStore,
)

_SECRET_NAME = "Jane Recruiter"
_SECRET_EMAIL = "jane@acme.example"


def _setup(tmp_path: Path) -> tuple[SqliteContactRepository, sqlite3.Connection]:
    conn = init_db(tmp_path / "jobhunter.db")
    conn.row_factory = sqlite3.Row
    bus = InProcessEventBus()
    ProjectionBuilder(conn_factory=lambda: conn, tenant_id=LOCAL_TENANT).subscribe_to(bus)
    return SqliteContactRepository(conn, publisher=bus), conn


def test_create_persists_canonical_and_projects_with_provenance(tmp_path: Path) -> None:
    repo, conn = _setup(tmp_path)
    contact = CreateContactUseCase(repo).execute(
        LOCAL_TENANT,
        link=ContactLink(employer="Acme", job_id="https://job/1"),
        role=ContactRole.RECRUITER,
        attributes=[
            AttributeInput("name", _SECRET_NAME),
            AttributeInput("email", _SECRET_EMAIL),
        ],
    )

    loaded = repo.load(LOCAL_TENANT, contact.contact_id)
    assert loaded is not None
    assert loaded.display_name == _SECRET_NAME
    assert loaded.attribute("email").value == _SECRET_EMAIL
    assert loaded.attribute("email").provenance.source_kind == "user_entered"

    row = SqliteProjectionStore(conn).fetch_contacts("local")[0]
    assert row["role"] == "recruiter"
    assert row["attribute_count"] == 2
    assert row["confirmed_count"] == 2
    assert json.loads(row["source_kinds_json"]) == ["user_entered"]
    provenance = json.loads(row["provenance_json"])
    assert {p["attributeKind"] for p in provenance} == {"name", "email"}
    assert all(p["sourceKind"] == "user_entered" for p in provenance)


def test_values_never_leak_into_events_or_projection(tmp_path: Path) -> None:
    repo, conn = _setup(tmp_path)
    CreateContactUseCase(repo).execute(
        LOCAL_TENANT,
        link=ContactLink(employer="Acme", job_id="https://job/1"),
        role=ContactRole.RECRUITER,
        attributes=[
            AttributeInput("name", _SECRET_NAME),
            AttributeInput("email", _SECRET_EMAIL),
        ],
    )

    event_payloads = " ".join(
        str(row["payload_json"])
        for row in conn.execute("SELECT payload_json FROM job_events").fetchall()
    )
    assert _SECRET_NAME not in event_payloads
    assert _SECRET_EMAIL not in event_payloads

    projection_text = " ".join(
        " ".join(str(value) for value in tuple(row))
        for row in SqliteProjectionStore(conn).fetch_contacts("local")
    )
    assert _SECRET_NAME not in projection_text
    assert _SECRET_EMAIL not in projection_text


def test_contact_events_carry_contact_entity_reference(tmp_path: Path) -> None:
    repo, conn = _setup(tmp_path)
    contact = CreateContactUseCase(repo).execute(
        LOCAL_TENANT,
        link=ContactLink(employer="Acme"),
        attributes=[AttributeInput("name", _SECRET_NAME)],
    )
    rows = conn.execute(
        "SELECT event_type, entity_kind, entity_ref FROM job_events ORDER BY event_id"
    ).fetchall()
    assert [r["event_type"] for r in rows] == ["ContactCreated", "ContactAttributeRecorded"]
    for row in rows:
        assert row["entity_kind"] == "contact"
        assert row["entity_ref"] == str(contact.contact_id)


def test_update_changes_role_and_reprojects(tmp_path: Path) -> None:
    repo, conn = _setup(tmp_path)
    contact = CreateContactUseCase(repo).execute(
        LOCAL_TENANT,
        link=ContactLink(employer="Acme"),
        role=ContactRole.OTHER,
        attributes=[AttributeInput("name", _SECRET_NAME)],
    )
    UpdateContactUseCase(repo).execute(
        LOCAL_TENANT,
        contact.contact_id,
        role=ContactRole.REFERRER,
        attributes=[AttributeInput("name", "Jane R"), AttributeInput("title", "Staff")],
    )
    row = SqliteProjectionStore(conn).fetch_contacts("local")[0]
    assert row["role"] == "referrer"
    assert row["attribute_count"] == 2


def test_soft_delete_drops_projection_and_hides_from_load(tmp_path: Path) -> None:
    repo, conn = _setup(tmp_path)
    contact = CreateContactUseCase(repo).execute(
        LOCAL_TENANT,
        link=ContactLink(employer="Acme"),
        attributes=[AttributeInput("name", _SECRET_NAME)],
    )
    assert DeleteContactUseCase(repo).execute(LOCAL_TENANT, contact.contact_id, reason="dup")
    assert repo.load(LOCAL_TENANT, contact.contact_id) is None
    assert SqliteProjectionStore(conn).fetch_contacts("local") == []
    deleted_events = conn.execute(
        "SELECT COUNT(*) FROM job_events WHERE event_type = 'ContactDeleted'"
    ).fetchone()[0]
    assert deleted_events == 1


def test_csv_import_tags_provenance_and_skips_linkless_rows(tmp_path: Path) -> None:
    repo, conn = _setup(tmp_path)
    csv_text = (
        "name,email,employer,role\n"
        "Bob Manager,bob@globex.example,Globex,hiring_manager\n"
        "Orphan,orphan@nowhere.example,,\n"
    )
    result = ImportContactsUseCase(repo).execute(
        LOCAL_TENANT, filename="referrals.csv", csv_text=csv_text
    )
    assert result.imported == 1
    assert result.skipped == 1

    contacts = repo.list_for_employer(LOCAL_TENANT, "Globex")
    assert len(contacts) == 1
    imported = contacts[0]
    assert imported.role is ContactRole.HIRING_MANAGER
    for attribute in imported.attributes:
        assert attribute.provenance.source_kind == "user_imported_list"
        assert attribute.provenance.source_ref == "referrals.csv"
        assert attribute.provenance.capture_method == "manual"


def test_list_for_job_filters_by_application(tmp_path: Path) -> None:
    repo, _ = _setup(tmp_path)
    CreateContactUseCase(repo).execute(
        LOCAL_TENANT,
        link=ContactLink(employer="Acme", job_id="https://job/1"),
        attributes=[AttributeInput("name", "A")],
    )
    CreateContactUseCase(repo).execute(
        LOCAL_TENANT,
        link=ContactLink(employer="Acme", job_id="https://job/2"),
        attributes=[AttributeInput("name", "B")],
    )
    assert len(repo.list_for_job(LOCAL_TENANT, "https://job/1")) == 1
    assert len(repo.list_for_tenant(LOCAL_TENANT)) == 2
