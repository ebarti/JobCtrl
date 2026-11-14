"""Generation and literal item boundaries for Fit's accepted authority."""

from __future__ import annotations

from jobctrl.app.errors import AppError

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


def assessment_fields(requirement):
    """Job occurrence metadata never changes a reusable qualification's meaning."""
    return {key: requirement[key] for key in (
        "category", "name", "occurrence_ids", "source_note", "original",
    ) if key in requirement} | {
        "text": requirement.get("text", requirement.get("name", requirement["definition"])),
        "posting_provenance": {key: requirement.get(key) for key in (
            "source_id", "source_revision", "source_hash", "spans", "evidence_refs",
            "extraction_determination_id", "equivalence_determination_ids",
        )},
    }
