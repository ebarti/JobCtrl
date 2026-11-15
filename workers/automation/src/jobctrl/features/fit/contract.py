"""Generation and literal item boundaries for Fit's accepted authority."""

from __future__ import annotations

from jobctrl.app.errors import AppError

from .models import QUALIFICATION_PROMPT_VERSION, QUALIFICATION_SEMANTICS_VERSION
from .serialization import encoded

CONTRACT_VERSION = "requirements-v2"
REUSABLE_CATEGORIES = frozenset({"skill", "professional_experience"})
DIRECT_CATEGORIES = frozenset({"education", "language"})


def current_contract(value):
    return isinstance(value, dict) and value.get("contract_version") == CONTRACT_VERSION


def require_contract(value):
    if not current_contract(value):
        raise AppError("contract_changed", "This saved Fit authority belongs to an earlier requirements contract. Start a new assessment or manual refresh.", 409)


def reusable(value):
    return current_contract(value) and value.get("category") in REUSABLE_CATEGORIES


def qualification_binding(value):
    return {"requirement_id": value["requirement_id"],
            "requirement_revision": str(value.get("requirement_revision", value.get("revision"))),
            "demand_fingerprint": value.get("demand_fingerprint") if value.get("category") not in DIRECT_CATEGORIES else None}


def qualification_key(value):
    """A JSON-safe tuple key; canonical IDs alone cannot identify a job demand."""
    row = qualification_binding(value)
    return encoded([row["requirement_id"], row["requirement_revision"], row["demand_fingerprint"]])


def wording_selection_inputs(heads):
    """Exact semantic selection pins; raw head revisions retain their separate CAS."""
    fields = ("profile_id", "achievement_id", "requirement_id", "requirement_revision",
              "variant_id", "variant_revision", "approval_id", "state", "demand_bindings")
    return sorted(({**{key: row.get(key) for key in fields if key != "demand_bindings"},
                    "demand_bindings": sorted(({key: binding[key] for key in
                        ("demand_fingerprint", "assessment_id", "relation_id")} for binding in row.get("demand_bindings", [])),
                        key=lambda binding: binding["demand_fingerprint"])} for row in heads),
                  key=lambda row: (row["achievement_id"], row["requirement_id"]))


def current_qualification(value):
    return (current_contract(value)
            and value.get("qualification_semantics_version") == QUALIFICATION_SEMANTICS_VERSION
            and value.get("qualification_prompt_version") == QUALIFICATION_PROMPT_VERSION)


def require_demand(value):
    require_contract(value)
    if reusable(value) and (not isinstance(value.get("demand_fingerprint"), str) or not value["demand_fingerprint"]
                            or not isinstance(value.get("capability_definition"), str)
                            or not value.get("normalization_version")):
        raise AppError("requirements_consolidation_required",
                       "Consolidate the saved requirements before using source-bound Fit authority.", 409)


def assessment_fields(requirement):
    """Attach the exact demand and occurrence provenance without altering its decision."""
    return {key: requirement[key] for key in (
        "category", "name", "occurrence_ids", "source_note", "original", "capability_definition",
        "definition", "demand_fingerprint", "demand_provenance", "normalization_version",
    ) if key in requirement} | {
        "text": requirement.get("text", requirement.get("name", requirement["definition"])),
        "posting_provenance": {key: requirement.get(key) for key in (
            "source_id", "source_revision", "source_hash", "spans", "evidence_refs",
            "extraction_determination_id", "equivalence_determination_ids",
        )},
    }
