"""High-fit adversarial resume review helpers.

The use case owns LLM I/O. This module owns deterministic fit-score gating,
strict response schema, persona prompt context, and compact response parsing.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Mapping

from jobctl.domain.profile.snapshot import ProfileSnapshot
from jobctl.domain.scoring.value_objects import FitScore
from jobctl.domain.materials.quality import TailoringPlan


ADVERSARIAL_REVIEW_SCHEMA_VERSION = "tailor-adversarial.v2"
ADVERSARIAL_REVIEW_THRESHOLD = 0.8
ADVERSARIAL_REVIEW_PERSONAS: tuple[str, ...] = (
    "ats_parser",
    "skeptical_recruiter",
    "hiring_manager_domain_expert",
    "evidence_auditor",
    "anti_ai_voice_critic",
    "interview_defensibility_critic",
)
ADVERSARIAL_REVIEW_PERSONA_RUBRICS: dict[str, str] = {
    "ats_parser": "Check standard sections, parseable wording, and no keyword stuffing.",
    "skeptical_recruiter": (
        "Check for inflated language, vague claims, and resume wording that reads like a "
        "job-description rewrite instead of a candidate record."
    ),
    "hiring_manager_domain_expert": (
        "Check role relevance, technical plausibility, and whether seniority matches the job."
    ),
    "evidence_auditor": (
        "Check that every metric, tool, role, company, and achievement is supported by "
        "profile evidence."
    ),
    "anti_ai_voice_critic": (
        "Check for generic AI resume voice, repetitive phrasing, stock verbs, and over-polish."
    ),
    "interview_defensibility_critic": (
        "Check whether every tailored claim can survive interview follow-up questions."
    ),
}


ADVERSARIAL_REVIEW_RESPONSE_SCHEMA: dict[str, Any] = {
    "title": "TailoringAdversarialReview",
    "type": "object",
    "additionalProperties": False,
    "required": [
        "verdict",
        "score",
        "score_rationale",
        "personas",
        "blockers",
        "warnings",
        "repair_instructions",
    ],
    "properties": {
        "verdict": {"type": "string", "enum": ["PASS", "FAIL"]},
        "score": {"type": "number", "minimum": 0, "maximum": 1},
        "score_rationale": {"type": "string"},
        "personas": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "persona",
                    "verdict",
                    "score",
                    "score_rationale",
                    "blockers",
                    "warnings",
                    "repair_instructions",
                ],
                "properties": {
                    "persona": {"type": "string", "enum": list(ADVERSARIAL_REVIEW_PERSONAS)},
                    "verdict": {"type": "string", "enum": ["PASS", "FAIL"]},
                    "score": {"type": "number", "minimum": 0, "maximum": 1},
                    "score_rationale": {"type": "string"},
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
class AdversarialPromptMessage:
    role: str
    content: str

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "AdversarialPromptMessage":
        return cls(
            role=str(data.get("role") or "user").strip()[:40],
            content=str(data.get("content") or "").strip(),
        )

    def to_dict(self) -> dict[str, str]:
        return {"role": self.role, "content": self.content}


@dataclass(frozen=True)
class AdversarialPersonaFinding:
    persona: str
    verdict: str
    score: float
    score_rationale: str = ""
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
            score_rationale=str(data.get("score_rationale") or "").strip(),
            blockers=tuple(_string_list(data.get("blockers"))),
            warnings=tuple(_string_list(data.get("warnings"))),
            repair_instructions=tuple(_string_list(data.get("repair_instructions"))),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "persona": self.persona,
            "verdict": self.verdict,
            "score": self.score,
            "score_rationale": self.score_rationale,
            "prompt_rubric": ADVERSARIAL_REVIEW_PERSONA_RUBRICS.get(self.persona, ""),
            "blockers": list(self.blockers),
            "warnings": list(self.warnings),
            "repair_instructions": list(self.repair_instructions),
            "score_basis": list(_persona_score_basis(self)),
            "response": {
                "verdict": self.verdict,
                "score": self.score,
                "score_rationale": self.score_rationale,
                "blockers": list(self.blockers),
                "warnings": list(self.warnings),
                "repair_instructions": list(self.repair_instructions),
            },
        }


@dataclass(frozen=True)
class AdversarialReviewResult:
    ran: bool
    threshold: float
    normalized_fit_score: float | None
    passed: bool
    verdict: str = "PASS"
    score: float = 1.0
    blockers: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()
    repair_instructions: tuple[str, ...] = ()
    personas: tuple[AdversarialPersonaFinding, ...] = ()
    skipped_reason: str = ""
    score_rationale: str = ""
    model: str = ""
    prompt_messages: tuple[AdversarialPromptMessage, ...] = ()

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
            verdict="SKIPPED",
            skipped_reason=reason,
        )

    @classmethod
    def failed_error(
        cls,
        *,
        threshold: float,
        normalized_fit_score: float | None,
        error: str,
        model: str = "",
        prompt_messages: tuple[Mapping[str, Any], ...] = (),
    ) -> "AdversarialReviewResult":
        return cls(
            ran=True,
            threshold=threshold,
            normalized_fit_score=normalized_fit_score,
            passed=False,
            verdict="FAIL",
            score=0.0,
            blockers=(f"Adversarial review error: {error}",),
            repair_instructions=("Retry adversarial review or remove risky unsupported claims.",),
            score_rationale="The review could not be completed because the judge call failed.",
            model=model,
            prompt_messages=tuple(
                AdversarialPromptMessage.from_dict(item) for item in prompt_messages
            ),
        )

    @classmethod
    def from_response(
        cls,
        response: Mapping[str, Any],
        *,
        threshold: float,
        normalized_fit_score: float | None,
        model: str = "",
        prompt_messages: tuple[Mapping[str, Any], ...] = (),
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
        score_rationale = str(response.get("score_rationale") or "").strip()
        return cls(
            ran=True,
            threshold=threshold,
            normalized_fit_score=normalized_fit_score,
            passed=verdict == "PASS" and not blockers,
            verdict=verdict,
            score=score,
            blockers=tuple(dict.fromkeys(blockers)),
            warnings=tuple(dict.fromkeys(warnings)),
            repair_instructions=tuple(dict.fromkeys(repairs)),
            personas=personas,
            score_rationale=score_rationale,
            model=model,
            prompt_messages=tuple(
                AdversarialPromptMessage.from_dict(item) for item in prompt_messages
            ),
        )

    def to_dict(self) -> dict[str, Any]:
        response = {
            "verdict": self.verdict,
            "score": self.score,
            "score_rationale": self.score_rationale,
            "blockers": list(self.blockers),
            "warnings": list(self.warnings),
            "repair_instructions": list(self.repair_instructions),
            "personas": [persona.to_dict()["response"] for persona in self.personas],
        }
        return {
            "ran": self.ran,
            "threshold": self.threshold,
            "normalized_fit_score": self.normalized_fit_score,
            "passed": self.passed,
            "verdict": self.verdict,
            "score": self.score,
            "score_rationale": self.score_rationale,
            "blockers": list(self.blockers),
            "warnings": list(self.warnings),
            "repair_instructions": list(self.repair_instructions),
            "personas": [persona.to_dict() for persona in self.personas],
            "skipped_reason": self.skipped_reason,
            "schema_version": ADVERSARIAL_REVIEW_SCHEMA_VERSION,
            "llm_audit": {
                "model": self.model,
                "schema_version": ADVERSARIAL_REVIEW_SCHEMA_VERSION,
                "prompt_messages": [message.to_dict() for message in self.prompt_messages],
                "response": response,
            },
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
    persona_lines = "\n".join(
        f"- {persona}: {ADVERSARIAL_REVIEW_PERSONA_RUBRICS[persona]}"
        for persona in ADVERSARIAL_REVIEW_PERSONAS
    )
    return f"""You are running adversarial resume review for a high-fit JobCtl opportunity.

Return ONLY JSON matching the provided schema. Do not include markdown.

Evaluate the tailored resume from every persona below:
{persona_lines}

For each persona, explain score_rationale in one concise sentence. A 1.0 score
requires PASS, no blockers, no warnings, and a defensible reason grounded in the
persona rubric. Lower scores must name the concrete risk.

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


def _persona_score_basis(persona: AdversarialPersonaFinding) -> tuple[str, ...]:
    basis = [
        f"LLM verdict: {persona.verdict}",
        f"LLM score: {persona.score:.2f}",
    ]
    if persona.score_rationale:
        basis.append(persona.score_rationale)
    if persona.blockers:
        basis.append(f"Blockers: {len(persona.blockers)}")
    else:
        basis.append("Blockers: none")
    if persona.warnings:
        basis.append(f"Warnings: {len(persona.warnings)}")
    else:
        basis.append("Warnings: none")
    return tuple(basis)


__all__ = [
    "ADVERSARIAL_REVIEW_PERSONAS",
    "ADVERSARIAL_REVIEW_PERSONA_RUBRICS",
    "ADVERSARIAL_REVIEW_RESPONSE_SCHEMA",
    "ADVERSARIAL_REVIEW_SCHEMA_VERSION",
    "ADVERSARIAL_REVIEW_THRESHOLD",
    "AdversarialPromptMessage",
    "AdversarialPersonaFinding",
    "AdversarialReviewResult",
    "build_adversarial_review_prompt",
    "normalized_job_fit_score",
    "should_run_adversarial_review",
]
