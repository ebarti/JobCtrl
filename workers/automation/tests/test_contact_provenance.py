"""Provenance invariants for contact facts (INV-2, outreach planner plan §6)."""

from __future__ import annotations

import pytest

from jobctrl.domain.contact.value_objects import (
    CONTACT_SOURCE_KINDS,
    ContactAttribute,
    ContactFactProvenance,
)


def test_source_kind_must_be_in_allowlist() -> None:
    for source_kind in CONTACT_SOURCE_KINDS:
        assert (
            ContactFactProvenance(source_kind=source_kind, source_ref="ref").source_kind
            == source_kind
        )
    with pytest.raises(ValueError, match="source_kind"):
        ContactFactProvenance(source_kind="third_party_scrape", source_ref="ref")


def test_source_ref_is_required() -> None:
    with pytest.raises(ValueError, match="source_ref"):
        ContactFactProvenance(source_kind="user_entered", source_ref="   ")


def test_capture_method_must_be_known() -> None:
    with pytest.raises(ValueError, match="capture_method"):
        ContactFactProvenance(
            source_kind="public_web_page", source_ref="https://x", capture_method="scraped"
        )


def test_every_attribute_carries_full_provenance() -> None:
    provenance = ContactFactProvenance(
        source_kind="user_imported_list",
        source_ref="referrals.csv",
        capture_method="manual",
        captured_at="2026-07-03T00:00:00Z",
        confidence=1.0,
        user_confirmed=False,
    )
    attribute = ContactAttribute(
        attribute_id="a", kind="email", value="x@example.com", provenance=provenance
    )
    recorded = attribute.provenance.to_dict()
    assert recorded["source_kind"] == "user_imported_list"
    assert recorded["source_ref"] == "referrals.csv"
    assert recorded["capture_method"] == "manual"
    assert recorded["user_confirmed"] is False
    assert set(recorded) == {
        "source_kind",
        "source_ref",
        "capture_method",
        "captured_at",
        "confidence",
        "user_confirmed",
    }
