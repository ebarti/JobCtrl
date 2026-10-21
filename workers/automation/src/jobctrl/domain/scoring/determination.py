"""Typed model-owned fit and eligibility judgments over canonical sources."""

from typing import Literal
from pydantic import Field, StrictStr
from jobctrl.domain.determinations import Citation, DeterminationModel, DeterminationFailure


class Blocker(DeterminationModel):
    category: Literal[
        "work_authorization",
        "application_language",
        "seniority",
        "explicit_exclusion",
        "clearance",
        "citizenship",
        "qualification",
    ]
    reason: StrictStr = Field(min_length=1, max_length=1000)
    citations: list[Citation] = Field(min_length=1, max_length=8)


class Warning(DeterminationModel):
    category: Literal[
        "compensation_preference", "location_preference", "work_model_preference", "uncertain_constraint", "other"
    ]
    reason: StrictStr = Field(min_length=1, max_length=1000)
    citations: list[Citation] = Field(min_length=1, max_length=8)


class EligibilityDecision(DeterminationModel):
    status: Literal["eligible", "warning", "blocked", "unknown"]
    blockers: list[Blocker] = Field(max_length=30)
    warnings: list[Warning] = Field(max_length=30)


class RequirementFit(DeterminationModel):
    kind: Literal["matched", "transferable", "missing", "blocked", "not_assessed"]
    evidence_ids: list[StrictStr] = Field(max_length=30)
    strength: Literal["direct", "strong"] | None
    gap: StrictStr | None
    bridge: StrictStr | None
    reason: StrictStr | None
    blocker: StrictStr | None


class RequirementAssessment(DeterminationModel):
    requirement_id: StrictStr
    requirement_text: StrictStr
    tier: Literal["must_have", "nice_to_have"]
    weight: float = Field(ge=0, le=1)
    job_evidence_span: StrictStr = Field(
        description="Copy a non-empty contiguous verbatim span from the outer requirement source whose source_id equals requirement_id. Preserve whitespace, case and punctuation; never substitute requirement_text or join/rewrite source fields.",
    )
    fit: RequirementFit
    target_keywords: list[StrictStr] = Field(max_length=40)
    citations: list[Citation] = Field(min_length=1, max_length=8)


class DiscoveryFeedback(DeterminationModel):
    verdict: Literal["propose_exact_title_exclusion", "none"]
    reason: StrictStr = Field(min_length=1, max_length=1000)
    citations: list[Citation] = Field(min_length=1, max_length=8)


class ScoringDecision(DeterminationModel):
    score: int = Field(ge=1, le=10)
    technical_fit: int = Field(ge=0, le=10)
    experience_fit: int = Field(ge=0, le=10)
    role_fit: int = Field(ge=0, le=10)
    fit_band: Literal["excellent", "strong", "plausible", "stretch", "poor"]
    confidence: Literal["high", "medium", "low"]
    eligibility: EligibilityDecision
    matched_signals: list[StrictStr] = Field(max_length=40)
    missing_signals: list[StrictStr] = Field(max_length=40)
    transferable_signals: list[StrictStr] = Field(max_length=40)
    requirement_assessments: list[RequirementAssessment] = Field(max_length=200)
    keywords: list[StrictStr] = Field(min_length=1, max_length=80)
    discovery_feedback: DiscoveryFeedback
    reasoning: StrictStr = Field(min_length=1, max_length=4000)
    citations: list[Citation] = Field(min_length=1, max_length=30)

    def validate_inventory(self, *, requirements, evidence_ids):
        ids = [row.requirement_id for row in self.requirement_assessments]
        failures = []
        if set(ids) != set(requirements) or len(set(ids)) != len(ids):
            failures.append({
                "code": "foreign_or_missing_requirement_id", "field": "requirement_id",
                "path": ["requirement_assessments"],
                "missing_ids": sorted(set(requirements) - set(ids)),
                "foreign_ids": sorted(set(ids) - set(requirements)),
                "duplicate_ids": sorted({ident for ident in ids if ids.count(ident) > 1}),
            })
        for index, row in enumerate(self.requirement_assessments):
            context = {"requirement_id": row.requirement_id, "path": ["requirement_assessments", index]}
            canonical = requirements.get(row.requirement_id)
            if canonical is not None and (not row.job_evidence_span.strip() or row.job_evidence_span not in canonical):
                failures.append({
                    **context, "code": "non_verbatim_quote", "field": "job_evidence_span",
                    "submitted_value": row.job_evidence_span, "canonical_value": canonical,
                })
            invalid_evidence = sorted(set(row.fit.evidence_ids) - set(evidence_ids))
            if invalid_evidence:
                failures.append({
                    **context, "code": "foreign_source_id", "field": "fit.evidence_ids",
                    "foreign_ids": invalid_evidence, "allowed_ids": sorted(evidence_ids),
                })
            if row.fit.kind in {"matched", "transferable"} and not row.fit.evidence_ids:
                failures.append({
                    **context, "code": "missing_evidence_citation", "field": "fit.evidence_ids",
                    "fit_kind": row.fit.kind, "allowed_ids": sorted(evidence_ids),
                })
        if bool(self.eligibility.blockers) != (self.eligibility.status == "blocked"):
            failures.append({
                "code": "inconsistent_verdict", "field": "eligibility.status", "path": ["eligibility"],
                "status": self.eligibility.status, "has_blockers": bool(self.eligibility.blockers),
            })
        if failures:
            raise DeterminationFailure(failures[0]["code"], repair_context={
                "binding_failures": failures, "allowed_requirement_ids": sorted(requirements),
            })

    def score_payload(self):
        result = self.model_dump()
        result["eligibility"] = {
            "status": self.eligibility.status,
            "hard_blockers": [row.reason for row in self.eligibility.blockers],
            "hard_blocker_categories": [row.category for row in self.eligibility.blockers],
            "hard_blocker_citations": [
                [cite.model_dump() for cite in row.citations] for row in self.eligibility.blockers
            ],
            "warnings": [row.reason for row in self.eligibility.warnings],
        }
        return result
