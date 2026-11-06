"""Deterministic policy over already qualified person evidence.

This retains the previous requirement-fit-v2-scoped arithmetic. The only inputs
that decide support are recorded model decisions or explicit user corrections.
Wording coverage is deliberately absent from this calculation.
"""

from __future__ import annotations

import math
from typing import Any

FORMULA_VERSION = "requirement-fit-v2-scoped"
FIT_VALUES = {"direct": 1.0, "strong": 0.85, "transferable": 0.6}


def fit_band(score: int) -> str:
    for minimum, band in ((9, "excellent"), (7, "strong"), (5, "plausible"), (3, "stretch")):
        if score >= minimum:
            return band
    return "poor"


def calculate_score(assessments: list[dict[str, Any]]) -> dict[str, Any]:
    """Arithmetic only; every row must already join its canonical requirement."""
    total = awarded = must_total = must_awarded = 0.0
    capability_blockers = 0
    missing_high_weight = 0
    rows: list[dict[str, Any]] = []
    blockers: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    unknown_condition = False
    confidences: list[str] = []
    for assessment in assessments:
        row = dict(assessment)
        weight = float(row["weight"])
        scope = row["scope"]
        tier = row["tier"]
        if not math.isfinite(weight) or not 0 <= weight <= 1:
            raise ValueError("invalid_requirement_weight")
        if tier not in {"must_have", "nice_to_have"}:
            raise ValueError("invalid_requirement_tier")
        if scope not in {"resume", "eligibility", "logistics", "employer_condition"}:
            raise ValueError("invalid_requirement_scope")
        maximum = round(weight * (1.25 if tier == "must_have" else 1.0), 4) if scope == "resume" else 0.0
        credit = 0.0
        if row["kind"] == "matched":
            credit = FIT_VALUES[row["strength"]]
        elif row["kind"] == "transferable":
            credit = FIT_VALUES["transferable"]
        points = round(maximum * credit, 4)
        row["contribution"] = {"max_points": maximum, "awarded_points": points, "scope": scope}
        total += maximum
        awarded += points
        if scope == "resume":
            capability_blockers += row["kind"] == "blocked"
            missing_high_weight += row["kind"] in {"missing", "blocked"} and weight >= 0.75
            if tier == "must_have":
                must_total += maximum
                must_awarded += points
        condition = {
            "requirement_id": row["requirement_id"], "rationale": row["rationale"],
            "evidence_refs": row["evidence_refs"], "determination_id": row["determination_id"],
        }
        if row["eligibility"] == "blocked":
            blockers.append({**condition, "category": row.get("blocker_category")})
        elif row["eligibility"] == "warning":
            warnings.append({**condition, "category": row.get("warning_category")})
        elif scope != "resume" and row["eligibility"] == "unknown":
            unknown_condition = True
        confidences.append(row["confidence"])
        rows.append(row)
    if total <= 0:
        raise ValueError("no_weighted_capability_requirements")
    coverage = awarded / total
    resolved = max(1, min(10, 1 + math.floor(9 * coverage + 0.5)))
    if capability_blockers:
        resolved = min(resolved, 4)
    status = "blocked" if blockers else "warning" if warnings else "unknown" if unknown_condition else "eligible"
    return {
        "score": resolved, "computed_score": resolved, "fit_band": fit_band(resolved),
        "formula_version": FORMULA_VERSION,
        "confidence": "low" if "low" in confidences else "medium" if "medium" in confidences else "high",
        "summary": {
            "weighted_fit": round(coverage, 4),
            "must_have_coverage": round(must_awarded / must_total, 4) if must_total else 0.0,
            "blocker_count": capability_blockers, "missing_high_weight_count": missing_high_weight,
        },
        "eligibility": {"status": status, "blockers": blockers, "warnings": warnings},
        "assessments": rows,
    }
