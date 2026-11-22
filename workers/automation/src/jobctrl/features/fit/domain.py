"""Equal deterministic arithmetic over recorded, source-bound qualifications."""

from __future__ import annotations

import math
from typing import Any

from .contract import CONTRACT_VERSION, require_contract

FORMULA_VERSION = "requirement-fit-v3-equal"
FIT_VALUES = {"direct": 1.0, "strong": 0.85, "transferable": 0.6}


def fit_band(score: int) -> str:
    for minimum, band in ((9, "excellent"), (7, "strong"), (5, "plausible"), (3, "stretch")):
        if score >= minimum:
            return band
    return "poor"


def calculate_score(assessments: list[dict[str, Any]]) -> dict[str, Any]:
    """Count a canonical meaning or job-local alternatives group exactly once."""
    rows, confidences = [], []
    seen = set()
    awarded = 0.0
    for assessment in assessments:
        require_contract(assessment)
        ident = assessment["requirement_id"]
        if ident in seen:
            raise ValueError("duplicate_requirement")
        seen.add(ident)
        row = dict(assessment)
        if row["category"] not in {"skill", "professional_experience", "education", "language"}:
            raise ValueError("invalid_requirement_category")
        credit = (FIT_VALUES[row["strength"]] if row["kind"] == "matched" else
                  FIT_VALUES["transferable"] if row["kind"] == "transferable" else 0.0)
        row["contribution"] = {"max_points": 1, "awarded_points": credit}
        awarded += credit
        confidences.append(row["confidence"])
        rows.append(row)
    count = len(rows)
    coverage = awarded / count if count else None
    resolved = max(1, min(10, 1 + math.floor(9 * coverage + 0.5))) if count else None
    return {
        "contract_version": CONTRACT_VERSION,
        "score": resolved, "computed_score": resolved, "fit_band": fit_band(resolved) if resolved is not None else None,
        "formula_version": FORMULA_VERSION,
        "confidence": ("low" if "low" in confidences else "medium" if "medium" in confidences else "high") if count else None,
        "summary": {"qualification_coverage": round(coverage, 4) if count else None,
                    "weighted_fit": round(coverage, 4) if count else None,
                    "assessed_count": count,
                    "supported_count": sum(row["kind"] in {"matched", "transferable"} for row in rows),
                    "blocker_count": sum(row["kind"] == "blocked" for row in rows)},
        "eligibility": {"status": "unknown", "blockers": [], "warnings": []},
        "assessments": rows,
    }
