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

from jobctrl.database import init_db
from jobctrl.domain.contact import (
    AttributeInput,
    ContactLink,
    ContactRole,
    CreateContactUseCase,
    DeleteContactUseCase,
    ImportContactsUseCase,
    UpdateContactUseCase,
)
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.contact.sqlite_repository import SqliteContactRepository
from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
from jobctrl.infrastructure.projections.sqlite_projection_store import (
    SqliteProjectionStore,
)

_SECRET_NAME = "Jane Recruiter"
_SECRET_EMAIL = "jane@acme.example"
_JOB_ID = JobId("11111111-1111-4111-8111-111111111111")
_OTHER_JOB_ID = JobId("22222222-2222-4222-8222-222222222222")


def _setup(tmp_path: Path) -> tuple[SqliteContactRepository, sqlite3.Connection]:
    conn = init_db(tmp_path / "jobctrl.db")
    conn.row_factory = sqlite3.Row
    conn.executemany(
        """
        INSERT INTO jobs (tenant_id, job_id, url, title, discovered_at)
        VALUES ('local', ?, ?, 'Test job', '2026-07-31T12:00:00Z')
        """,
        [
            (_JOB_ID, "https://jobs.example/one"),
            (_OTHER_JOB_ID, "https://jobs.example/two"),
        ],
    )
    conn.commit()
    bus = InProcessEventBus()
    ProjectionBuilder(conn_factory=lambda: conn, tenant_id=LOCAL_TENANT).subscribe_to(bus)
    return SqliteContactRepository(conn, publisher=bus), conn


def test_create_persists_canonical_and_projects_with_provenance(tmp_path: Path) -> None:
    repo, conn = _setup(tmp_path)
    contact = CreateContactUseCase(repo).execute(
        LOCAL_TENANT,
        link=ContactLink(employer="Acme", job_id=_JOB_ID),
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
        link=ContactLink(employer="Acme", job_id=_JOB_ID),
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
        link=ContactLink(employer="Acme", job_id=_JOB_ID),
        attributes=[AttributeInput("name", _SECRET_NAME)],
    )
    assert DeleteContactUseCase(repo).execute(LOCAL_TENANT, contact.contact_id, reason="dup")
    assert repo.load(LOCAL_TENANT, contact.contact_id) is None
    assert SqliteProjectionStore(conn).fetch_contacts("local") == []
    deleted_event = conn.execute(
        "SELECT tenant_id, job_id, payload_json FROM job_events WHERE event_type = 'ContactDeleted'"
    ).fetchone()
    assert tuple(deleted_event[:2]) == (str(LOCAL_TENANT), _JOB_ID)
    assert json.loads(deleted_event["payload_json"])["jobId"] == _JOB_ID


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


def test_edit_preserves_provenance_of_unchanged_imported_facts(tmp_path: Path) -> None:
    """Regression (#331 review High): a role-only edit must not re-stamp
    imported facts as user_entered (INV-2); only new or value-edited facts
    become user-entered."""
    repo, _ = _setup(tmp_path)
    csv_text = "name,email,employer,role\nBob Manager,bob@globex.example,Globex,hiring_manager\n"
    ImportContactsUseCase(repo).execute(
        LOCAL_TENANT, filename="referrals.csv", csv_text=csv_text
    )
    imported = repo.list_for_employer(LOCAL_TENANT, "Globex")[0]
    original = {attribute.kind: attribute for attribute in imported.attributes}

    updated = UpdateContactUseCase(repo).execute(
        LOCAL_TENANT,
        imported.contact_id,
        role=ContactRole.REFERRER,
        attributes=[
            AttributeInput("name", "Bob Manager"),
            AttributeInput("email", "bob@globex.example"),
            AttributeInput("phone", "+1 555 0100"),
        ],
    )
    by_kind = {attribute.kind: attribute for attribute in updated.attributes}
    for kind in ("name", "email"):
        assert by_kind[kind].provenance.source_kind == "user_imported_list"
        assert by_kind[kind].provenance.source_ref == "referrals.csv"
        assert by_kind[kind].provenance.captured_at == original[kind].provenance.captured_at
        assert by_kind[kind].attribute_id == original[kind].attribute_id
    assert by_kind["phone"].provenance.source_kind == "user_entered"

    revalued = UpdateContactUseCase(repo).execute(
        LOCAL_TENANT,
        imported.contact_id,
        attributes=[
            AttributeInput("name", "Bob Manager"),
            AttributeInput("email", "bob.manager@globex.example"),
        ],
    )
    by_kind = {attribute.kind: attribute for attribute in revalued.attributes}
    assert by_kind["name"].provenance.source_kind == "user_imported_list"
    assert by_kind["email"].provenance.source_kind == "user_entered"


def test_list_for_job_filters_by_application(tmp_path: Path) -> None:
    repo, _ = _setup(tmp_path)
    CreateContactUseCase(repo).execute(
        LOCAL_TENANT,
        link=ContactLink(employer="Acme", job_id=_JOB_ID),
        attributes=[AttributeInput("name", "A")],
    )
    CreateContactUseCase(repo).execute(
        LOCAL_TENANT,
        link=ContactLink(employer="Acme", job_id=_OTHER_JOB_ID),
        attributes=[AttributeInput("name", "B")],
    )
    assert len(repo.list_for_job(LOCAL_TENANT, _JOB_ID)) == 1
    assert len(repo.list_for_tenant(LOCAL_TENANT)) == 2
