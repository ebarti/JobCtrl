"""Contact aggregate invariants (R6 Phase 1, outreach planner plan §4.1)."""

from __future__ import annotations

import pytest

from jobctl.domain.contact.aggregate import Contact
from jobctl.domain.contact.value_objects import (
    ContactAttribute,
    ContactFactProvenance,
    ContactLink,
    ContactRole,
)
from jobctl.domain.identifiers import ContactId
from jobctl.domain.tenant import LOCAL_TENANT


def _provenance() -> ContactFactProvenance:
    return ContactFactProvenance(
        source_kind="user_entered",
        source_ref="user_entered",
        capture_method="manual",
        captured_at="2026-07-01T00:00:00Z",
        confidence=1.0,
        user_confirmed=True,
    )


def _attribute(kind: str = "name", value: str = "Jane") -> ContactAttribute:
    return ContactAttribute(
        attribute_id="attr-1", kind=kind, value=value, provenance=_provenance()
    )


def test_contact_links_to_at_least_one_of_employer_or_job() -> None:
    with pytest.raises(ValueError, match="at least one of"):
        ContactLink(employer=None, job_id=None)
    with pytest.raises(ValueError, match="at least one of"):
        ContactLink(employer="  ", job_id="")

    # Either alone is valid.
    assert ContactLink(employer="Acme").employer == "Acme"
    assert ContactLink(job_id="https://job/1").job_id == "https://job/1"


def test_contact_attribute_requires_provenance() -> None:
    with pytest.raises(ValueError, match="provenance is required"):
        ContactAttribute(attribute_id="a", kind="name", value="Jane", provenance=None)  # type: ignore[arg-type]


def test_contact_is_valid_with_link_and_provenanced_attributes() -> None:
    contact = Contact.create(
        tenant_id=LOCAL_TENANT,
        contact_id=ContactId("contact-1"),
        link=ContactLink(employer="Acme", job_id="https://job/1"),
        role=ContactRole.RECRUITER,
        attributes=(_attribute("name", "Jane Recruiter"),),
        created_at="2026-07-01T00:00:00Z",
    )
    assert contact.display_name == "Jane Recruiter"
    assert contact.role is ContactRole.RECRUITER
    assert contact.attributes[0].provenance.source_kind == "user_entered"


def test_contact_rejects_empty_id() -> None:
    with pytest.raises(ValueError, match="contact_id"):
        Contact(
            tenant_id=LOCAL_TENANT,
            contact_id=ContactId("  "),
            link=ContactLink(employer="Acme"),
        )


def test_revise_preserves_identity_and_created_at() -> None:
    contact = Contact.create(
        tenant_id=LOCAL_TENANT,
        contact_id=ContactId("contact-1"),
        link=ContactLink(employer="Acme"),
        role=ContactRole.OTHER,
        attributes=(_attribute(),),
        created_at="2026-07-01T00:00:00Z",
    )
    revised = contact.revise(role=ContactRole.REFERRER, updated_at="2026-07-05T00:00:00Z")
    assert revised.contact_id == contact.contact_id
    assert revised.created_at == "2026-07-01T00:00:00Z"
    assert revised.updated_at == "2026-07-05T00:00:00Z"
    assert revised.role is ContactRole.REFERRER


def test_mark_deleted_sets_timestamp() -> None:
    contact = Contact.create(
        tenant_id=LOCAL_TENANT,
        contact_id=ContactId("contact-1"),
        link=ContactLink(employer="Acme"),
        created_at="2026-07-01T00:00:00Z",
    )
    deleted = contact.mark_deleted(deleted_at="2026-07-09T00:00:00Z")
    assert deleted.is_deleted
    assert deleted.deleted_at == "2026-07-09T00:00:00Z"
