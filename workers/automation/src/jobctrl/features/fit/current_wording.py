"""Maintained wording selection is separate from immutable coverage receipts."""

from __future__ import annotations

from typing import Literal

from pydantic import Field, StrictInt, StrictStr

from jobctrl.app.errors import ConflictError

from .associations import AssociationValue
from .coverage import variant_fingerprint
from .contract import current_contract
from .sources import achievements, qualification_fingerprint, wording_eligible


class CurrentWordingInput(AssociationValue):
    profile_id: StrictStr = Field(default="default", min_length=1, max_length=120)
    expected_profile_revision: StrictInt = Field(ge=1)
    expected_revision: StrictInt = Field(ge=0)
    achievement_id: StrictStr = Field(min_length=1, max_length=200)
    requirement_id: StrictStr = Field(min_length=1, max_length=120)
    requirement_revision: StrictInt = Field(ge=1)
    variant_id: StrictStr = Field(min_length=1, max_length=200)
    variant_revision: StrictInt = Field(ge=1)
    approval_id: StrictStr = Field(min_length=1, max_length=200)
    relation_id: StrictStr = Field(min_length=1, max_length=200)


class CurrentWordingState(AssociationValue):
    profile_id: StrictStr = Field(default="default", min_length=1, max_length=120)
    expected_revision: StrictInt = Field(ge=1)
    state: Literal["active", "removed"]


ASSIGNMENT_PINS = ("profile_id", "achievement_id", "requirement_id", "requirement_revision",
                   "variant_id", "variant_revision", "approval_id", "relation_id")


def assignment_reasons(record, read, profile):
    """Inspect recorded IDs and exact current bindings; never choose wording."""
    reasons = []
    if not current_contract(record):
        return ["contract_changed"]
    requirement = read.requirement(record["requirement_id"])
    if str(requirement["revision"]) != str(record["requirement_revision"]):
        reasons.append("requirement_revised")
    if profile is None:
        return [*reasons, "profile_unavailable"]
    inventory = achievements(profile)
    if record["achievement_id"] not in inventory:
        reasons.append("achievement_unavailable")
    assessment = read.latest_assessment(record["profile_id"], record["requirement_id"], record["requirement_revision"],
                                        source_fingerprint=qualification_fingerprint(profile, requirement))
    if (assessment is None or str(assessment["requirement_revision"]) != str(record["requirement_revision"])
            or assessment["source_fingerprint"] != qualification_fingerprint(profile, requirement)
            or not wording_eligible(assessment) or assessment["kind"] not in {"matched", "transferable"}
            or record["achievement_id"] not in assessment["achievement_ids"]):
        reasons.append("qualification_changed_or_unavailable")
    variant = next((row for row in profile["approved_variants"] if row["variant_id"] == record["variant_id"]), None)
    if (variant is None or variant["achievement_id"] != record["achievement_id"]
            or str(variant["revision"]) != str(record["variant_revision"])
            or variant["approval_id"] != record["approval_id"]):
        reasons.append("approved_wording_changed_or_unavailable")
    relation = read.coverage(record["profile_id"], record["requirement_id"], record["requirement_revision"],
                            assessment["assessment_id"] if assessment else "", record["variant_id"], record["variant_revision"])
    if (relation is None or relation["relation_id"] != record["relation_id"]
            or relation["achievement_id"] != record["achievement_id"]
            or relation["status"] != "covered" or not relation["covered"]
            or relation["approval_id"] != record["approval_id"]
            or variant is None or relation["variant_fingerprint"] != variant_fingerprint(variant)):
        reasons.append("positive_coverage_changed_or_unavailable")
    return reasons


def assignment_view(record, read, profile):
    reasons = assignment_reasons(record, read, profile)
    return {**record, "current": not reasons, "stale_reasons": reasons}


def require_current_assignment(record, read, profile):
    reasons = assignment_reasons(record, read, profile)
    if reasons:
        raise ConflictError("Current exact approved wording and positive recorded coverage are required.", stale_reasons=reasons)
