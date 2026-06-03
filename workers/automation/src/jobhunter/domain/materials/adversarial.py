"""High-fit adversarial resume review helpers.

The use case owns LLM I/O. This module owns deterministic fit-score gating,
strict response schema, persona prompt context, and compact response parsing.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Mapping

from jobhunter.domain.profile.snapshot import ProfileSnapshot
from jobhunter.domain.scoring.value_objects import FitScore
from jobhunter.domain.materials.quality import TailoringPlan


ADVERSARIAL_REVIEW_SCHEMA_VERSION = "tailor-adversarial.v1"
ADVERSARIAL_REVIEW_THRESHOLD = 0.8
ADVERSARIAL_REVIEW_PERSONAS: tuple[str, ...] = (
    "ats_parser",
    "skeptical_recruiter",
    "hiring_manager_domain_expert",
    "evidence_auditor",
    "anti_ai_voice_critic",
    "interview_defensibility_critic",
)


ADVERSARIAL_REVIEW_RESPONSE_SCHEMA: dict[str, Any] = {
    "title": "TailoringAdversarialReview",
    "type": "object",
    "additionalProperties": False,
    "required": ["verdict", "score", "personas", "blockers", "warnings", "repair_instructions"],
    "properties": {
        "verdict": {"type": "string", "enum": ["PASS", "FAIL"]},
        "score": {"type": "number", "minimum": 0, "maximum": 1},
        "personas": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "persona",
                    "verdict",
                    "score",
                    "blockers",
                    "warnings",
                    "repair_instructions",
                ],
                "properties": {
                    "persona": {"type": "string", "enum": list(ADVERSARIAL_REVIEW_PERSONAS)},
                    "verdict": {"type": "string", "enum": ["PASS", "FAIL"]},
                    "score": {"type": "number", "minimum": 0, "maximum": 1},
                    "blockers": {"type": "array", "items": {"type": "string"}},
                    "warnings": {"type": "array", "items": {"type": "string"}},
                    "repair_instructions": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
        "blockers": {"type": "array", "items": {"type": "string"}},
        "warnings": {"type": "array", "items": {"type": "string"}},
        "repair_instructions": {"type": "array", "items": {"type": "string"}},
    },
}


@dataclass(frozen=True)
class AdversarialPersonaFinding:
    persona: str
    verdict: str
    score: float
    blockers: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()
    repair_instructions: tuple[str, ...] = ()

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "AdversarialPersonaFinding":
        persona = str(data.get("persona") or "").strip()
        if persona not in ADVERSARIAL_REVIEW_PERSONAS:
            persona = "evidence_auditor"
        verdict = str(data.get("verdict") or "FAIL").upper()
        if verdict not in {"PASS", "FAIL"}:
            verdict = "FAIL"
        return cls(
            persona=persona,
            verdict=verdict,
            score=_score(data.get("score")),
            blockers=tuple(_string_list(data.get("blockers"))),
            warnings=tuple(_string_list(data.get("warnings"))),
            repair_instructions=tuple(_string_list(data.get("repair_instructions"))),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "persona": self.persona,
            "verdict": self.verdict,
            "score": self.score,
            "blockers": list(self.blockers),
            "warnings": list(self.warnings),
            "repair_instructions": list(self.repair_instructions),
        }


@dataclass(frozen=True)
class AdversarialReviewResult:
    ran: bool
    threshold: float
    normalized_fit_score: float | None
    passed: bool
    score: float = 1.0
    blockers: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()
    repair_instructions: tuple[str, ...] = ()
    personas: tuple[AdversarialPersonaFinding, ...] = ()
    skipped_reason: str = ""

    @classmethod
    def skipped(
        cls,
        *,
        threshold: float,
        normalized_fit_score: float | None,
        reason: str,
    ) -> "AdversarialReviewResult":
        return cls(
            ran=False,
            threshold=threshold,
            normalized_fit_score=normalized_fit_score,
            passed=True,
            skipped_reason=reason,
        )

    @classmethod
    def failed_error(
        cls,
        *,
        threshold: float,
        normalized_fit_score: float | None,
        error: str,
    ) -> "AdversarialReviewResult":
        return cls(
            ran=True,
            threshold=threshold,
            normalized_fit_score=normalized_fit_score,
            passed=False,
            score=0.0,
            blockers=(f"Adversarial review error: {error}",),
            repair_instructions=("Retry adversarial review or remove risky unsupported claims.",),
        )

    @classmethod
    def from_response(
        cls,
        response: Mapping[str, Any],
        *,
        threshold: float,
        normalized_fit_score: float | None,
    ) -> "AdversarialReviewResult":
        personas = tuple(
            AdversarialPersonaFinding.from_dict(item)
            for item in response.get("personas", [])
            if isinstance(item, Mapping)
        )
        blockers = [
            *_string_list(response.get("blockers")),
            *[blocker for persona in personas for blocker in persona.blockers],
        ]
        warnings = [
            *_string_list(response.get("warnings")),
            *[warning for persona in personas for warning in persona.warnings],
        ]
        repairs = [
            *_string_list(response.get("repair_instructions")),
            *[repair for persona in personas for repair in persona.repair_instructions],
        ]
        verdict = str(response.get("verdict") or "FAIL").upper()
        score = _score(response.get("score"))
        return cls(
            ran=True,
            threshold=threshold,
            normalized_fit_score=normalized_fit_score,
            passed=verdict == "PASS" and not blockers,
            score=score,
            blockers=tuple(dict.fromkeys(blockers)),
            warnings=tuple(dict.fromkeys(warnings)),
            repair_instructions=tuple(dict.fromkeys(repairs)),
            personas=personas,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "ran": self.ran,
            "threshold": self.threshold,
            "normalized_fit_score": self.normalized_fit_score,
            "passed": self.passed,
            "score": self.score,
            "blockers": list(self.blockers),
            "warnings": list(self.warnings),
            "repair_instructions": list(self.repair_instructions),
            "personas": [persona.to_dict() for persona in self.personas],
            "skipped_reason": self.skipped_reason,
            "schema_version": ADVERSARIAL_REVIEW_SCHEMA_VERSION,
        }


def normalized_job_fit_score(job: Mapping[str, Any]) -> float | None:
    """Return a 0..1 fit score from current 1..10 or explicit normalized fields."""
    fit_score = FitScore.from_optional(job.get("fit_score", job.get("fitScore")))
    if fit_score is not None:
        return fit_score.value / 10.0
    for key in ("normalized_fit_score", "normalizedFitScore"):
        raw = job.get(key)
        try:
            normalized = float(raw)
        except (TypeError, ValueError):
            continue
        if 0.0 <= normalized <= 1.0:
            return normalized
    return None


def should_run_adversarial_review(
    job: Mapping[str, Any],
    *,
    threshold: float = ADVERSARIAL_REVIEW_THRESHOLD,
) -> bool:
    normalized = normalized_job_fit_score(job)
    return normalized is not None and normalized >= threshold


def build_adversarial_review_prompt(
    *,
    profile_snapshot: ProfileSnapshot,
    tailoring_plan: TailoringPlan,
) -> str:
    profile = profile_snapshot.as_dict()
    resume = profile.get("resume", {})
    return f"""You are running adversarial resume review for a high-fit JobHunter opportunity.

Return ONLY JSON matching the provided schema. Do not include markdown.

Evaluate the tailored resume from every persona below:
- ats_parser: standard sections, parseable wording, no keyword stuffing.
- skeptical_recruiter: no inflated language, vague claims, or resume-that-reads-like-job-description.
- hiring_manager_domain_expert: role relevance, technical plausibility, seniority match.
- evidence_auditor: every metric, tool, role, company, and achievement is supported by the profile.
- anti_ai_voice_critic: no generic AI resume voice, repetitive phrasing, or stock verbs.
- interview_defensibility_critic: every claim can survive interview follow-up questions.

Blockers must include unsupported metrics, invented tools, inflated seniority,
ATS parseability failures, AI-sounding voice that damages credibility, or
claims the candidate could not defend in an interview. Warnings should be
non-blocking improvements only.

CANONICAL PROFILE RESUME:
{json.dumps(resume, indent=2, ensure_ascii=False)}

TAILORING QUALITY PLAN:
{json.dumps(tailoring_plan.to_prompt_dict(), indent=2, ensure_ascii=False)}
"""


def _score(value: Any) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, parsed))


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, (list, tuple)):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


__all__ = [
    "ADVERSARIAL_REVIEW_PERSONAS",
    "ADVERSARIAL_REVIEW_RESPONSE_SCHEMA",
    "ADVERSARIAL_REVIEW_SCHEMA_VERSION",
    "ADVERSARIAL_REVIEW_THRESHOLD",
    "AdversarialPersonaFinding",
    "AdversarialReviewResult",
    "build_adversarial_review_prompt",
    "normalized_job_fit_score",
    "should_run_adversarial_review",
]
