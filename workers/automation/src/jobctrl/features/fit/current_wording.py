"""Maintained wording selection is separate from immutable coverage receipts."""

from __future__ import annotations

from typing import Literal

from pydantic import Field, StrictInt, StrictStr

from jobctrl.app.errors import ConflictError

from .associations import AssociationValue
from .coverage import variant_fingerprint
from .contract import current_contract, current_qualification
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
                   "variant_id", "variant_revision", "approval_id", "relation_id", "demand_bindings")


def assignment_demand_views(record, read, profile):
    """Each demand has its own receipt. No representative relation is authority."""
    demands = read.demand_catalog_snapshot(active_only=True)["demands"]
    result = []
    for binding in record.get("demand_bindings", []):
        reasons = []
        requirement = next((row for row in demands if row["requirement_id"] == record["requirement_id"]
                            and str(row["requirement_revision"]) == str(record["requirement_revision"])
                            and row["demand_fingerprint"] == binding["demand_fingerprint"]), None)
        assessment = read.assessment(binding["assessment_id"])
        if requirement is None:
            reasons.append("demand_changed_or_unavailable")
        if profile is None:
            reasons.append("profile_unavailable")
        elif requirement is not None:
            latest = read.latest_assessment(record["profile_id"], record["requirement_id"], record["requirement_revision"],
                source_fingerprint=qualification_fingerprint(profile, requirement))
            if (not current_qualification(assessment) or latest is None
                    or latest["assessment_id"] != binding["assessment_id"]
                    or assessment.get("demand_fingerprint") != binding["demand_fingerprint"]
                    or not wording_eligible(assessment) or assessment["kind"] not in {"matched", "transferable"}
                    or record["achievement_id"] not in assessment["achievement_ids"]):
                reasons.append("qualification_changed_or_unavailable")
        variant = next((row for row in profile["approved_variants"] if row["variant_id"] == record["variant_id"]), None) if profile else None
        relation = read.coverage(record["profile_id"], record["requirement_id"], record["requirement_revision"],
                                binding["assessment_id"], record["variant_id"], record["variant_revision"])
        if (relation is None or relation["relation_id"] != binding["relation_id"]
                or relation.get("demand_fingerprint") != binding["demand_fingerprint"]
                or relation["achievement_id"] != record["achievement_id"]
                or relation["status"] != "covered" or not relation["covered"]
                or relation["approval_id"] != record["approval_id"]
                or variant is None or relation["variant_fingerprint"] != variant_fingerprint(variant)):
            reasons.append("positive_coverage_changed_or_unavailable")
        result.append({**binding, "current": not reasons, "stale_reasons": reasons})
    return result


def _assignment_state(record, read, profile):
    reasons = []
    if not current_contract(record):
        return ["contract_changed"], []
    requirement = read.requirement(record["requirement_id"])
    if requirement.get("stale"):
        reasons.extend(requirement.get("stale_reasons", ["requirement_revised"]))
    if str(requirement["revision"]) != str(record["requirement_revision"]):
        reasons.append("requirement_revised")
    if profile is None:
        return [*reasons, "profile_unavailable"], []
    inventory = achievements(profile)
    if record["achievement_id"] not in inventory:
        reasons.append("achievement_unavailable")
    variant = next((row for row in profile["approved_variants"] if row["variant_id"] == record["variant_id"]), None)
    if (variant is None or variant["achievement_id"] != record["achievement_id"]
            or str(variant["revision"]) != str(record["variant_revision"])
            or variant["approval_id"] != record["approval_id"]):
        reasons.append("approved_wording_changed_or_unavailable")
    bindings = assignment_demand_views(record, read, profile)
    if not bindings:
        reasons.append("demand_binding_unavailable")
    elif not any(row["current"] for row in bindings):
        reasons.append("qualification_changed_or_unavailable")
    return reasons, bindings


def assignment_reasons(record, read, profile):
    return _assignment_state(record, read, profile)[0]


def assignment_view(record, read, profile):
    reasons, bindings = _assignment_state(record, read, profile)
    return {**record, "demand_bindings": bindings, "current": not reasons, "stale_reasons": reasons}


def require_current_assignment(record, read, profile):
    reasons, bindings = _assignment_state(record, read, profile)
    if reasons or any(not row["current"] for row in bindings):
        raise ConflictError("Current exact approved wording and positive recorded coverage are required.", stale_reasons=reasons)
