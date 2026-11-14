"""User intent is inspectable and revision-bound, never semantic authority."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr

from jobctrl.app.errors import AppError, ConflictError

from .contract import CONTRACT_VERSION, current_contract, require_contract
from .sources import achievements, fingerprint


class AssociationValue(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)


class AssociationSource(AssociationValue):
    source_id: StrictStr = Field(min_length=1, max_length=500)
    revision: StrictInt = Field(ge=1)


class AssociationWording(AssociationValue):
    variant_id: StrictStr = Field(min_length=1, max_length=200)
    variant_revision: StrictInt = Field(ge=1)
    exact_text: StrictStr = Field(min_length=1, max_length=30000)
    source_refs: list[AssociationSource] = Field(max_length=200)


class CreateAssociation(AssociationValue):
    association_id: StrictStr = Field(min_length=1, max_length=200)
    profile_id: StrictStr = Field(default="default", min_length=1, max_length=120)
    expected_profile_revision: StrictInt = Field(ge=1)
    requirement_id: StrictStr = Field(min_length=1, max_length=120)
    requirement_revision: StrictInt = Field(ge=1)
    achievement_id: StrictStr = Field(min_length=1, max_length=200)
    achievement_source_refs: list[AssociationSource] = Field(min_length=1, max_length=200)
    wording: AssociationWording | None = None


class AssociationState(AssociationValue):
    profile_id: StrictStr = Field(default="default", min_length=1, max_length=120)
    expected_revision: StrictInt = Field(ge=1)
    state: Literal["active", "removed"]


class ReviseAssociation(CreateAssociation):
    expected_revision: StrictInt = Field(ge=1)


def exact_refs(refs):
    """Order is not authority; duplicate identities are invalid, never merged."""
    values = [(ref["source_id"], ref["revision"]) for ref in refs]
    if len({ident for ident, _ in values}) != len(values):
        raise AppError("fit_association_duplicate_source", "Select each source once.", 422)
    return sorted(values)


def binding_fingerprint(record):
    binding = {key: record[key] for key in (
        "profile_id", "requirement_id", "requirement_revision", "achievement_id", "achievement_source_refs", "wording",
    )}
    binding["achievement_source_refs"] = exact_refs(record["achievement_source_refs"])
    if record["wording"] is not None:
        binding["wording"] = {**record["wording"], "source_refs": exact_refs(record["wording"]["source_refs"])}
    return fingerprint(binding)


def association_stale_reasons(record, requirement, profile, wording_library):
    reasons = [] if current_contract(record) else ["contract_changed"]
    if requirement is None or str(record["requirement_revision"]) != str(requirement["revision"]):
        reasons.append("requirement_revised")
    if profile is None:
        return [*reasons, "profile_unavailable"]
    achievement = achievements(profile).get(record["achievement_id"])
    if achievement is None:
        reasons.append("achievement_unavailable")
    elif exact_refs(record["achievement_source_refs"]) != exact_refs(achievement["source_refs"]):
        reasons.append("achievement_sources_changed")
    if achievement is not None and record.get("role_id", achievement["role_id"]) != achievement["role_id"]:
        reasons.append("achievement_role_changed")
    sources = {row["source_id"]: row for row in profile["evidence_sources"]}
    if any(ref["source_id"] not in sources or sources[ref["source_id"]]["revision"] != ref["revision"]
           for ref in record["achievement_source_refs"]):
        reasons.append("source_changed_or_unavailable")
    if record["wording"] is not None:
        pinned = record["wording"]
        variant = next((row for row in wording_library["variants"] if row["variant_id"] == pinned["variant_id"]), None)
        if (variant is None or variant["achievement_id"] != record["achievement_id"]
                or variant["revision"] != pinned["variant_revision"] or variant["text"] != pinned["exact_text"]
                or exact_refs(variant["source_refs"]) != exact_refs(pinned["source_refs"])
                or variant["status"] == "stale"):
            reasons.append("wording_changed_or_unavailable")
    return reasons


def validate_association(record, requirement, profile, wording_library):
    require_contract(requirement)
    if profile["profile_revision"] != record["expected_profile_revision"]:
        raise ConflictError("The reviewed Profile changed before the association was saved.")
    reasons = association_stale_reasons({**record, "contract_version": CONTRACT_VERSION}, requirement, profile, wording_library)
    if reasons:
        raise ConflictError("The selected requirement, achievement or wording changed. Review its current revision.",
                            stale_reasons=reasons)


def association_view(record, requirement, profile, wording_library):
    reasons = association_stale_reasons(record, requirement, profile, wording_library)
    return {**record, "current": not reasons, "stale_reasons": reasons}
