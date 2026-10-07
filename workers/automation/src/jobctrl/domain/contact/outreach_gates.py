"""Persisted outreach determinations and their cited provenance."""

from __future__ import annotations
from dataclasses import dataclass, field
from collections.abc import Mapping
from typing import Any
from jobctrl.domain.ports.artifact_review import JudgeVerdict, ValidationResult

COMPUTED_AGAINST_DRAFT = "rendered_draft"


@dataclass(frozen=True)
class OutreachClaimProvenance:
    """One claim in a draft bound to the confirmed fact(s) it rests on (INV-2).

    ``generated_text`` is the actual claim text (the anchor coverage/grounding is
    computed against — never the target). ``contact_fact_ids`` are the confirmed
    contact attribute ids the claim references; ``profile_grounded`` records
    whether the claim's non-recipient content traces to the profile evidence
    corpus. Both are computed against the rendered draft text.
    """

    claim_id: str
    section: str
    generated_text: str
    contact_fact_ids: tuple[str, ...] = field(default_factory=tuple)
    profile_grounded: bool = False
    rationale: str = ""

    def to_read_model(self) -> dict[str, Any]:
        return {
            "claimId": self.claim_id,
            "section": self.section,
            "generatedText": self.generated_text,
            "contactFactIds": list(self.contact_fact_ids),
            "profileGrounded": self.profile_grounded,
            "rationale": self.rationale,
        }

    @classmethod
    def from_read_model(cls, data: Mapping[str, Any]) -> "OutreachClaimProvenance":
        return cls(
            claim_id=str(data.get("claimId") or data.get("claim_id") or ""),
            section=str(data.get("section") or ""),
            generated_text=str(data.get("generatedText") or data.get("generated_text") or ""),
            contact_fact_ids=tuple(
                str(item) for item in (data.get("contactFactIds") or data.get("contact_fact_ids") or ())
            ),
            profile_grounded=bool(data.get("profileGrounded") or data.get("profile_grounded")),
            rationale=str(data.get("rationale") or ""),
        )


@dataclass(frozen=True)
class DraftGateResults:
    """The persisted outcome of the truthfulness gate stack for one draft.

    ``passed`` is the single authority draft approval is gated on (INV-5): a draft
    passes only when the deterministic detector found NO fabrications, the content
    validator passed, and the judge approved. Serialised to
    ``outreach_drafts.gate_results_json`` and surfaced (labelled by lifecycle) in
    the review UI per the CLAUDE.md root-cause/auditability discipline.
    """

    fabrications: tuple[dict[str, Any], ...] = field(default_factory=tuple)
    validation: ValidationResult = field(default_factory=ValidationResult.success)
    judge: JudgeVerdict | None = None
    computed_against: str = COMPUTED_AGAINST_DRAFT
    determination_ids: tuple[str, ...] = ()
    line_anchors: tuple[dict[str, Any], ...] = ()

    @property
    def passed(self) -> bool:
        return not self.fabrications and self.validation.passed and self.judge is not None and self.judge.approved

    def to_read_model(self) -> dict[str, Any]:
        judge = self.judge
        judge_shape: dict[str, Any] | None = None
        if judge is not None:
            judge_shape = {
                "approved": judge.approved,
                "score": judge.score,
                "criterionScores": dict(judge.criterion_scores),
                "issues": list(judge.issues),
                "notes": judge.notes,
            }
        return {
            "passed": self.passed,
            "computedAgainst": self.computed_against,
            "determinationIds": list(self.determination_ids),
            "lineAnchors": list(self.line_anchors),
            "fabrications": [dict(finding) for finding in self.fabrications],
            "validation": {
                "passed": self.validation.passed,
                "errors": list(self.validation.errors),
                "warnings": list(self.validation.warnings),
            },
            "judge": judge_shape,
        }

    @classmethod
    def from_read_model(cls, data: Mapping[str, Any] | None) -> "DraftGateResults":
        if not data:
            return cls()
        validation = ValidationResult.from_dict(data.get("validation"))
        judge_data = data.get("judge")
        judge: JudgeVerdict | None = None
        if isinstance(judge_data, Mapping):
            judge = JudgeVerdict(
                approved=bool(judge_data.get("approved")),
                score=float(judge_data.get("score") or 0.0),
                notes=str(judge_data.get("notes") or ""),
                criterion_scores={
                    str(key): float(value)
                    for key, value in dict(
                        judge_data.get("criterionScores") or judge_data.get("criterion_scores") or {}
                    ).items()
                },
                issues=tuple(str(item) for item in (judge_data.get("issues") or ())),
            )
        fabrications = tuple(
            dict(finding) for finding in (data.get("fabrications") or ()) if isinstance(finding, Mapping)
        )
        return cls(
            fabrications=fabrications,
            validation=validation,
            judge=judge,
            computed_against=str(data.get("computedAgainst") or COMPUTED_AGAINST_DRAFT),
            determination_ids=tuple(data.get("determinationIds") or ()),
            line_anchors=tuple(data.get("lineAnchors") or ()),
        )
