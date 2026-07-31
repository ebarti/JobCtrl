"""Requirement-led tailoring coverage graph value objects and validators."""

from __future__ import annotations

import json
import re
from collections.abc import Iterable as IterableABC
from collections.abc import Mapping as MappingABC
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.materials.analysis import EmployerAnalysis
from jobctrl.domain.materials.policy import RequirementLedTailoringControls

if TYPE_CHECKING:  # pragma: no cover - type-only without runtime import cycle
    from jobctrl.domain.materials.claim_grounding import ClaimGrounding
    from jobctrl.domain.scoring.value_objects import RequirementFitReport

COVERAGE_KINDS = ("direct", "transferable", "adjacent", "enhancement")
COVERAGE_STRENGTHS = ("direct", "strong", "moderate", "weak", "draft")
CLAIM_POLICIES = (
    "verified_only",
    "evidence_reframing",
    "adjacent_translation",
    "draft_requires_confirmation",
)
GENERATED_CLAIM_LABELS = (
    "verified",
    "evidence_reframed",
    "adjacent_translation",
    "draft_requires_confirmation",
    "pinned",
    "positioning",
    "structure",
)
NON_REQUIREMENT_REASONS = ("pinned", "positioning", "structure")
BULLET_LIMIT_OVERFLOW_REASONS = (
    "pinned_required_bullet",
    "requirement_coverage",
    "enhancement_coverage",
)

_POLICY_RANK = {
    "verified_only": 0,
    "evidence_reframing": 1,
    "adjacent_translation": 2,
    "draft_requires_confirmation": 3,
}
_LABEL_REQUIRED_POLICY = {
    "verified": "verified_only",
    "evidence_reframed": "evidence_reframing",
    "adjacent_translation": "adjacent_translation",
    "draft_requires_confirmation": "draft_requires_confirmation",
}
_METRIC_RE = re.compile(
    r"(?ix)"
    r"(?:\$\s?\d+(?:[,.]\d+)*(?:\.\d+)?\s?(?:k|m|b|million|billion)?)"
    r"|(?:\b\d+(?:\.\d+)?\s?%)"
    r"|(?:\b\d+(?:\.\d+)?\s?x\b)"
    r"|(?:\b\d+(?:[,.]\d+)*(?:\.\d+)?\s?"
    r"(?:ms|milliseconds?|s|sec|seconds?|minutes?|hours?|days?|weeks?|months?|years?|"
    r"users?|customers?|engineers?|teams?|services?|systems?|pipelines?|applications?|"
    r"requests?|req/s|qps|revenue|cost|latency|uptime)\b)"
)


@dataclass(frozen=True)
class TargetRequirement:
    requirement_id: str
    text: str
    tier: str
    weight: float = 0.0
    source_span: str = ""
    keywords: tuple[str, ...] = ()
    fit_kind: str = "not_assessed"
    prohibited_claims: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "requirement_id", _required_text(self.requirement_id, "requirement_id"))
        object.__setattr__(self, "text", _required_text(self.text, "text"))
        tier = str(self.tier or "nice_to_have").strip()
        if tier not in {"must_have", "nice_to_have"}:
            raise ValueError("TargetRequirement.tier must be must_have or nice_to_have")
        object.__setattr__(self, "tier", tier)
        try:
            weight = float(self.weight)
        except (TypeError, ValueError):
            weight = 0.0
        if weight < 0.0 or weight > 1.0:
            raise ValueError("TargetRequirement.weight must be in [0.0, 1.0]")
        object.__setattr__(self, "weight", weight)
        object.__setattr__(self, "source_span", str(self.source_span or "").strip())
        object.__setattr__(self, "keywords", _clean_string_tuple(self.keywords))
        object.__setattr__(self, "fit_kind", str(self.fit_kind or "not_assessed").strip())
        object.__setattr__(self, "prohibited_claims", _clean_string_tuple(self.prohibited_claims))

    def to_prompt_dict(self) -> dict[str, Any]:
        return {
            "requirement_id": self.requirement_id,
            "text": self.text,
            "tier": self.tier,
            "weight": self.weight,
            "source_span": self.source_span,
            "keywords": list(self.keywords),
            "pre_tailor_fit": self.fit_kind,
            "prohibited_claims": list(self.prohibited_claims),
        }

    def to_safe_metadata(self) -> dict[str, Any]:
        return {
            "requirement_id": self.requirement_id,
            "text_excerpt": _excerpt(self.text),
            "tier": self.tier,
            "weight": self.weight,
            "keywords": list(self.keywords),
            "pre_tailor_fit": self.fit_kind,
        }


@dataclass(frozen=True)
class TargetProfile:
    job_id: str
    target_role: str
    seniority: str
    must_have_requirements: tuple[TargetRequirement, ...] = ()
    nice_to_have_requirements: tuple[TargetRequirement, ...] = ()
    hard_skills: tuple[str, ...] = ()
    ats_keywords: tuple[str, ...] = ()
    profile_achievements: tuple[AchievementNode, ...] = ()
    requirement_weights: dict[str, float] = field(default_factory=dict)
    source_spans: dict[str, str] = field(default_factory=dict)

    @property
    def requirements(self) -> tuple[TargetRequirement, ...]:
        return (*self.must_have_requirements, *self.nice_to_have_requirements)

    def __post_init__(self) -> None:
        object.__setattr__(self, "job_id", str(self.job_id or "").strip())
        object.__setattr__(self, "target_role", str(self.target_role or "").strip())
        object.__setattr__(self, "seniority", str(self.seniority or "").strip())
        object.__setattr__(self, "hard_skills", _clean_string_tuple(self.hard_skills))
        object.__setattr__(self, "ats_keywords", _clean_string_tuple(self.ats_keywords))
        object.__setattr__(
            self,
            "requirement_weights",
            {str(key): float(value) for key, value in dict(self.requirement_weights or {}).items()},
        )
        object.__setattr__(
            self,
            "source_spans",
            {str(key): str(value) for key, value in dict(self.source_spans or {}).items()},
        )

    def to_prompt_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "target_role": self.target_role,
            "seniority": self.seniority,
            "must_have_requirements": [
                requirement.to_prompt_dict() for requirement in self.must_have_requirements
            ],
            "nice_to_have_requirements": [
                requirement.to_prompt_dict() for requirement in self.nice_to_have_requirements
            ],
            "hard_skills": list(self.hard_skills),
            "ats_keywords": list(self.ats_keywords),
            "profile_achievements": [
                achievement.to_dict() for achievement in self.profile_achievements
            ],
        }

    def to_safe_metadata(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "target_role": self.target_role,
            "seniority": self.seniority,
            "must_have_requirement_ids": [
                requirement.requirement_id for requirement in self.must_have_requirements
            ],
            "nice_to_have_requirement_ids": [
                requirement.requirement_id for requirement in self.nice_to_have_requirements
            ],
            "hard_skills": list(self.hard_skills[:24]),
            "ats_keywords": list(self.ats_keywords[:32]),
            "requirements": [requirement.to_safe_metadata() for requirement in self.requirements],
            "profile_achievement_ids": [
                achievement.achievement_evidence_id for achievement in self.profile_achievements
            ],
        }


@dataclass(frozen=True)
class RequirementNode:
    requirement_id: str
    text: str
    tier: str
    weight: float = 0.0
    source_span: str = ""
    keywords: tuple[str, ...] = ()
    blocker: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(self, "requirement_id", _required_text(self.requirement_id, "requirement_id"))
        object.__setattr__(self, "text", _required_text(self.text, "text"))
        tier = str(self.tier or "nice_to_have").strip()
        if tier not in {"must_have", "nice_to_have"}:
            raise ValueError("RequirementNode.tier must be must_have or nice_to_have")
        object.__setattr__(self, "tier", tier)
        try:
            weight = float(self.weight)
        except (TypeError, ValueError):
            weight = 0.0
        if weight < 0.0 or weight > 1.0:
            raise ValueError("RequirementNode.weight must be in [0.0, 1.0]")
        object.__setattr__(self, "weight", weight)
        object.__setattr__(self, "source_span", str(self.source_span or "").strip())
        object.__setattr__(self, "keywords", _clean_string_tuple(self.keywords))
        object.__setattr__(self, "blocker", bool(self.blocker))

    def to_dict(self) -> dict[str, Any]:
        return {
            "requirement_id": self.requirement_id,
            "text": self.text,
            "tier": self.tier,
            "weight": self.weight,
            "source_span": self.source_span,
            "keywords": list(self.keywords),
            "blocker": self.blocker,
        }


@dataclass(frozen=True)
class AchievementNode:
    achievement_evidence_id: str
    experience_entry_id: str
    source_text: str
    metrics: tuple[str, ...] = ()
    tools: tuple[str, ...] = ()
    evidence_strength: str = ""
    user_confirmed: bool = False
    pinned: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "achievement_evidence_id",
            _required_text(self.achievement_evidence_id, "achievement_evidence_id"),
        )
        object.__setattr__(
            self,
            "experience_entry_id",
            _required_text(self.experience_entry_id, "experience_entry_id"),
        )
        object.__setattr__(self, "source_text", _required_text(self.source_text, "source_text"))
        object.__setattr__(self, "metrics", _clean_string_tuple(self.metrics))
        object.__setattr__(self, "tools", _clean_string_tuple(self.tools))
        object.__setattr__(self, "evidence_strength", str(self.evidence_strength or "").strip())
        object.__setattr__(self, "user_confirmed", bool(self.user_confirmed))
        object.__setattr__(self, "pinned", bool(self.pinned))

    def to_dict(self) -> dict[str, Any]:
        return {
            "achievement_evidence_id": self.achievement_evidence_id,
            "experience_entry_id": self.experience_entry_id,
            "source_text": self.source_text,
            "metrics": list(self.metrics),
            "tools": list(self.tools),
            "evidence_strength": self.evidence_strength,
            "user_confirmed": self.user_confirmed,
            "pinned": self.pinned,
        }


@dataclass(frozen=True)
class CoverageEdge:
    edge_id: str
    requirement_id: str
    achievement_evidence_id: str
    coverage_kind: str
    strength: str
    required_claim_policy: str
    target_terms: tuple[str, ...] = ()
    rationale: str = ""

    def __post_init__(self) -> None:
        for name in ("edge_id", "requirement_id", "achievement_evidence_id"):
            object.__setattr__(self, name, _required_text(getattr(self, name), name))
        object.__setattr__(
            self,
            "coverage_kind",
            _clean_enum(self.coverage_kind, COVERAGE_KINDS, "coverage_kind"),
        )
        object.__setattr__(
            self,
            "strength",
            _clean_enum(self.strength, COVERAGE_STRENGTHS, "strength"),
        )
        object.__setattr__(
            self,
            "required_claim_policy",
            _clean_enum(self.required_claim_policy, CLAIM_POLICIES, "required_claim_policy"),
        )
        object.__setattr__(self, "target_terms", _clean_string_tuple(self.target_terms))
        object.__setattr__(self, "rationale", str(self.rationale or "").strip())

    def to_dict(self) -> dict[str, Any]:
        return {
            "edge_id": self.edge_id,
            "requirement_id": self.requirement_id,
            "achievement_evidence_id": self.achievement_evidence_id,
            "coverage_kind": self.coverage_kind,
            "strength": self.strength,
            "required_claim_policy": self.required_claim_policy,
            "target_terms": list(self.target_terms),
            "rationale": self.rationale,
        }


@dataclass(frozen=True)
class UncoveredRequirement:
    requirement_id: str
    reason: str = ""
    prohibited_claims: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "requirement_id", _required_text(self.requirement_id, "requirement_id"))
        object.__setattr__(self, "reason", str(self.reason or "").strip())
        object.__setattr__(self, "prohibited_claims", _clean_string_tuple(self.prohibited_claims))

    def to_dict(self) -> dict[str, Any]:
        return {
            "requirement_id": self.requirement_id,
            "reason": self.reason,
            "prohibited_claims": list(self.prohibited_claims),
        }


@dataclass(frozen=True)
class UnusedAchievement:
    achievement_evidence_id: str
    reason: str = ""
    pinned: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "achievement_evidence_id",
            _required_text(self.achievement_evidence_id, "achievement_evidence_id"),
        )
        object.__setattr__(self, "reason", str(self.reason or "").strip())
        object.__setattr__(self, "pinned", bool(self.pinned))

    def to_dict(self) -> dict[str, Any]:
        return {
            "achievement_evidence_id": self.achievement_evidence_id,
            "reason": self.reason,
            "pinned": self.pinned,
        }


@dataclass(frozen=True)
class GeneratedClaimMapping:
    claim_id: str
    location: str
    text: str
    claim_label: str
    coverage_edge_ids: tuple[str, ...] = ()
    requirement_ids: tuple[str, ...] = ()
    evidence_ids: tuple[str, ...] = ()
    non_requirement_reason: str = ""
    review_required: bool = False

    def __post_init__(self) -> None:
        for name in ("claim_id", "location", "text"):
            object.__setattr__(self, name, _required_text(getattr(self, name), name))
        object.__setattr__(
            self,
            "claim_label",
            _clean_enum(self.claim_label, GENERATED_CLAIM_LABELS, "claim_label"),
        )
        object.__setattr__(self, "coverage_edge_ids", _clean_string_tuple(self.coverage_edge_ids))
        object.__setattr__(self, "requirement_ids", _clean_string_tuple(self.requirement_ids))
        object.__setattr__(self, "evidence_ids", _clean_string_tuple(self.evidence_ids))
        reason = str(self.non_requirement_reason or "").strip()
        if reason and reason not in NON_REQUIREMENT_REASONS:
            raise ValueError("GeneratedClaimMapping.non_requirement_reason is unsupported")
        object.__setattr__(self, "non_requirement_reason", reason)
        object.__setattr__(self, "review_required", bool(self.review_required))

    def to_dict(self) -> dict[str, Any]:
        return {
            "claim_id": self.claim_id,
            "location": self.location,
            "text": self.text,
            "claim_label": self.claim_label,
            "coverage_edge_ids": list(self.coverage_edge_ids),
            "requirement_ids": list(self.requirement_ids),
            "evidence_ids": list(self.evidence_ids),
            "non_requirement_reason": self.non_requirement_reason,
            "review_required": self.review_required,
        }


@dataclass(frozen=True)
class BulletLimitOverflow:
    experience_entry_id: str
    max_bullets: int
    actual_bullets: int
    reason: str
    evidence_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "experience_entry_id",
            _required_text(self.experience_entry_id, "experience_entry_id"),
        )
        max_bullets = _non_negative_int(self.max_bullets, "max_bullets")
        actual_bullets = _non_negative_int(self.actual_bullets, "actual_bullets")
        if actual_bullets <= max_bullets:
            raise ValueError("BulletLimitOverflow requires actual_bullets > max_bullets")
        object.__setattr__(self, "max_bullets", max_bullets)
        object.__setattr__(self, "actual_bullets", actual_bullets)
        object.__setattr__(
            self,
            "reason",
            _clean_enum(self.reason, BULLET_LIMIT_OVERFLOW_REASONS, "reason"),
        )
        object.__setattr__(self, "evidence_ids", _clean_string_tuple(self.evidence_ids))

    def to_dict(self) -> dict[str, Any]:
        return {
            "experience_entry_id": self.experience_entry_id,
            "max_bullets": self.max_bullets,
            "actual_bullets": self.actual_bullets,
            "reason": self.reason,
            "evidence_ids": list(self.evidence_ids),
        }


@dataclass(frozen=True)
class PostGenerationFitScore:
    score: int
    must_have_coverage: float
    covered_requirement_ids: tuple[str, ...] = ()
    uncovered_requirement_ids: tuple[str, ...] = ()
    claimed_only_requirement_ids: tuple[str, ...] = ()
    prioritized_fixes: tuple[str, ...] = ()
    review_blockers: tuple[str, ...] = ()
    coverage_basis: str = ""

    def __post_init__(self) -> None:
        score = _non_negative_int(self.score, "score")
        if score < 1:
            score = 1
        if score > 10:
            score = 10
        object.__setattr__(self, "score", score)
        try:
            coverage = float(self.must_have_coverage)
        except (TypeError, ValueError):
            coverage = 0.0
        if coverage < 0.0 or coverage > 1.0:
            raise ValueError("PostGenerationFitScore.must_have_coverage must be in [0.0, 1.0]")
        object.__setattr__(self, "must_have_coverage", coverage)
        object.__setattr__(self, "covered_requirement_ids", _clean_string_tuple(self.covered_requirement_ids))
        object.__setattr__(self, "uncovered_requirement_ids", _clean_string_tuple(self.uncovered_requirement_ids))
        object.__setattr__(
            self,
            "claimed_only_requirement_ids",
            _clean_string_tuple(self.claimed_only_requirement_ids),
        )
        object.__setattr__(self, "prioritized_fixes", _clean_string_tuple(self.prioritized_fixes))
        object.__setattr__(self, "review_blockers", _clean_string_tuple(self.review_blockers))
        object.__setattr__(self, "coverage_basis", str(self.coverage_basis or "").strip())

    def to_dict(self) -> dict[str, Any]:
        return {
            "score": self.score,
            "must_have_coverage": self.must_have_coverage,
            "covered_requirement_ids": list(self.covered_requirement_ids),
            "uncovered_requirement_ids": list(self.uncovered_requirement_ids),
            "claimed_only_requirement_ids": list(self.claimed_only_requirement_ids),
            "prioritized_fixes": list(self.prioritized_fixes),
            "review_blockers": list(self.review_blockers),
            "coverage_basis": self.coverage_basis,
        }


@dataclass(frozen=True)
class RevisionDecision:
    threshold_failed: bool
    should_revise: bool
    review_blocked: bool
    enhancement_allowed: bool
    reason: str
    attempt: int = 1
    max_revision_attempts: int = 1
    prioritized_fixes: tuple[str, ...] = ()
    review_blockers: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "threshold_failed", bool(self.threshold_failed))
        object.__setattr__(self, "should_revise", bool(self.should_revise))
        object.__setattr__(self, "review_blocked", bool(self.review_blocked))
        object.__setattr__(self, "enhancement_allowed", bool(self.enhancement_allowed))
        object.__setattr__(self, "reason", str(self.reason or "").strip())
        object.__setattr__(self, "attempt", _non_negative_int(self.attempt, "attempt"))
        object.__setattr__(
            self,
            "max_revision_attempts",
            _non_negative_int(self.max_revision_attempts, "max_revision_attempts"),
        )
        object.__setattr__(self, "prioritized_fixes", _clean_string_tuple(self.prioritized_fixes))
        object.__setattr__(self, "review_blockers", _clean_string_tuple(self.review_blockers))

    def to_dict(self) -> dict[str, Any]:
        return {
            "threshold_failed": self.threshold_failed,
            "should_revise": self.should_revise,
            "review_blocked": self.review_blocked,
            "enhancement_allowed": self.enhancement_allowed,
            "reason": self.reason,
            "attempt": self.attempt,
            "max_revision_attempts": self.max_revision_attempts,
            "prioritized_fixes": list(self.prioritized_fixes),
            "review_blockers": list(self.review_blockers),
        }


@dataclass(frozen=True)
class CoverageGraph:
    requirements: tuple[RequirementNode, ...] = ()
    achievements: tuple[AchievementNode, ...] = ()
    coverage_edges: tuple[CoverageEdge, ...] = ()
    uncovered_requirements: tuple[UncoveredRequirement, ...] = ()
    unused_achievements: tuple[UnusedAchievement, ...] = ()

    @property
    def requirement_ids(self) -> set[str]:
        return {item.requirement_id for item in self.requirements}

    @property
    def achievement_ids(self) -> set[str]:
        return {item.achievement_evidence_id for item in self.achievements}

    @property
    def edge_ids(self) -> set[str]:
        return {item.edge_id for item in self.coverage_edges}

    def to_dict(self) -> dict[str, Any]:
        return {
            "requirements": [item.to_dict() for item in self.requirements],
            "achievements": [item.to_dict() for item in self.achievements],
            "coverage_edges": [item.to_dict() for item in self.coverage_edges],
            "uncovered_requirements": [item.to_dict() for item in self.uncovered_requirements],
            "unused_achievements": [item.to_dict() for item in self.unused_achievements],
        }

    def to_safe_metadata(self) -> dict[str, Any]:
        return {
            "requirement_count": len(self.requirements),
            "achievement_count": len(self.achievements),
            "coverage_edge_count": len(self.coverage_edges),
            "covered_requirement_ids": list(
                dict.fromkeys(edge.requirement_id for edge in self.coverage_edges)
            ),
            "uncovered_requirements": [
                {
                    "requirement_id": item.requirement_id,
                    "reason": _excerpt(item.reason),
                    "prohibited_claims": [_excerpt(claim) for claim in item.prohibited_claims],
                }
                for item in self.uncovered_requirements
            ],
            "unused_achievement_ids": [
                item.achievement_evidence_id for item in self.unused_achievements
            ],
            "coverage_edges": [
                {
                    "edge_id": edge.edge_id,
                    "requirement_id": edge.requirement_id,
                    "achievement_evidence_id": edge.achievement_evidence_id,
                    "coverage_kind": edge.coverage_kind,
                    "strength": edge.strength,
                    "required_claim_policy": edge.required_claim_policy,
                    "target_terms": list(edge.target_terms),
                    "rationale": _excerpt(edge.rationale),
                }
                for edge in self.coverage_edges
            ],
        }


COVERAGE_PLANNER_RESPONSE_SCHEMA: dict[str, Any] = {
    "title": "CoveragePlannerResponse",
    "type": "object",
    "additionalProperties": False,
    "required": ["coverage_edges", "uncovered_requirements", "unused_achievements"],
    "properties": {
        "coverage_edges": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "requirement_id",
                    "achievement_evidence_id",
                    "coverage_kind",
                    "strength",
                    "required_claim_policy",
                    "target_terms",
                    "rationale",
                ],
                "properties": {
                    "requirement_id": {"type": "string"},
                    "achievement_evidence_id": {"type": "string"},
                    "coverage_kind": {"type": "string", "enum": list(COVERAGE_KINDS)},
                    "strength": {"type": "string", "enum": list(COVERAGE_STRENGTHS)},
                    "required_claim_policy": {"type": "string", "enum": list(CLAIM_POLICIES)},
                    "target_terms": {"type": "array", "items": {"type": "string"}},
                    "rationale": {"type": "string"},
                },
            },
        },
        "uncovered_requirements": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["requirement_id", "reason", "prohibited_claims"],
                "properties": {
                    "requirement_id": {"type": "string"},
                    "reason": {"type": "string"},
                    "prohibited_claims": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
        "unused_achievements": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["achievement_evidence_id", "reason"],
                "properties": {
                    "achievement_evidence_id": {"type": "string"},
                    "reason": {"type": "string"},
                },
            },
        },
    },
}


def build_target_profile(
    *,
    employer_analysis: EmployerAnalysis,
    requirement_fit_report: "RequirementFitReport | None",
    job: MappingABC[str, Any],
    evidence_items: IterableABC[Any],
    pinned_evidence_ids: IterableABC[str] = (),
) -> TargetProfile:
    assessment_by_requirement = {
        str(getattr(assessment, "requirement_id", "") or ""): assessment
        for assessment in getattr(requirement_fit_report, "assessments", ()) or ()
    }
    keyword_by_requirement: dict[str, list[str]] = {}
    all_keywords: list[str] = []
    for keyword in employer_analysis.canonical.keywords:
        normalized = _normalize_phrase(getattr(keyword, "keyword", ""))
        if not normalized:
            continue
        all_keywords.append(normalized)
        ref = str(getattr(keyword, "requirement_ref", "") or "")
        if ref:
            keyword_by_requirement.setdefault(ref, []).append(normalized)

    source_requirements = list(employer_analysis.canonical.requirements)
    if not source_requirements and assessment_by_requirement:
        source_requirements = [
            _RequirementLike(
                id=str(getattr(assessment, "requirement_id", "")),
                text=str(getattr(assessment, "requirement_text", "")),
                tier=str(getattr(assessment, "tier", "nice_to_have")),
                weight=float(getattr(assessment, "weight", 0.0) or 0.0),
                evidence_span=str(getattr(assessment, "job_evidence_span", "")),
            )
            for assessment in assessment_by_requirement.values()
        ]

    requirements: list[TargetRequirement] = []
    for requirement in source_requirements:
        requirement_id = str(getattr(requirement, "id", "") or "")
        assessment = assessment_by_requirement.get(requirement_id)
        fit = getattr(assessment, "fit", None)
        tailoring = getattr(assessment, "tailoring", None)
        target_keywords = _merge_clean_strings(
            keyword_by_requirement.get(requirement_id, ()),
            tuple(
                _normalize_phrase(keyword)
                for keyword in (
                    getattr(tailoring, "target_keywords", ()) if tailoring is not None else ()
                )
            ),
        )
        requirements.append(
            TargetRequirement(
                requirement_id=requirement_id,
                text=str(getattr(requirement, "text", "")),
                tier=str(getattr(requirement, "tier", "nice_to_have")),
                weight=float(getattr(requirement, "weight", 0.0) or 0.0),
                source_span=str(getattr(requirement, "evidence_span", "")),
                keywords=target_keywords,
                fit_kind=str(getattr(fit, "kind", "not_assessed") or "not_assessed"),
                prohibited_claims=tuple(
                    getattr(tailoring, "prohibited_claims", ()) if tailoring is not None else ()
                ),
            )
        )

    pinned_ids = set(_clean_string_tuple(pinned_evidence_ids))
    achievements = tuple(
        _achievement_node_from_item(item, pinned=item_id in pinned_ids)
        for item in evidence_items
        if (item_id := _item_attr(item, "evidence_id", "id"))
    )
    must_have = tuple(requirement for requirement in requirements if requirement.tier == "must_have")
    nice_to_have = tuple(requirement for requirement in requirements if requirement.tier != "must_have")
    job_skills = _clean_string_tuple(job.get("skills", ()))
    return TargetProfile(
        job_id=str(canonical_job_id(str(job["job_id"]))),
        target_role=str(job.get("title") or job.get("role_title") or ""),
        seniority=str(employer_analysis.canonical.inferred_seniority or ""),
        must_have_requirements=must_have,
        nice_to_have_requirements=nice_to_have,
        hard_skills=_merge_clean_strings(job_skills, all_keywords),
        ats_keywords=_merge_clean_strings(all_keywords, job_skills),
        profile_achievements=achievements,
        requirement_weights={item.requirement_id: item.weight for item in requirements},
        source_spans={item.requirement_id: item.source_span for item in requirements},
    )


def seed_coverage_graph(
    *,
    target_profile: TargetProfile,
    requirement_fit_report: "RequirementFitReport | None",
) -> CoverageGraph:
    requirements = tuple(
        RequirementNode(
            requirement_id=requirement.requirement_id,
            text=requirement.text,
            tier=requirement.tier,
            weight=requirement.weight,
            source_span=requirement.source_span,
            keywords=requirement.keywords,
            blocker=requirement.fit_kind == "blocked",
        )
        for requirement in target_profile.requirements
    )
    achievements = target_profile.profile_achievements
    edges: list[CoverageEdge] = []
    fit_by_requirement: dict[str, Any] = {}
    if requirement_fit_report is not None:
        for assessment in getattr(requirement_fit_report, "assessments", ()) or ():
            requirement_id = str(getattr(assessment, "requirement_id", "") or "")
            fit_by_requirement[requirement_id] = assessment
            fit = getattr(assessment, "fit", None)
            fit_kind = str(getattr(fit, "kind", "") or "")
            if fit_kind not in {"matched", "transferable"}:
                continue
            coverage_kind = "direct" if fit_kind == "matched" else "transferable"
            required_policy = "verified_only" if coverage_kind == "direct" else "evidence_reframing"
            strength = str(getattr(fit, "strength", "") or "")
            if not strength or strength not in COVERAGE_STRENGTHS:
                strength = "direct" if coverage_kind == "direct" else "moderate"
            for evidence_id in _clean_string_tuple(getattr(fit, "evidence_ids", ())):
                edges.append(
                    CoverageEdge(
                        edge_id=_edge_id(requirement_id, evidence_id, coverage_kind),
                        requirement_id=requirement_id,
                        achievement_evidence_id=evidence_id,
                        coverage_kind=coverage_kind,
                        strength=strength,
                        required_claim_policy=required_policy,
                        target_terms=_requirement_keywords(target_profile, requirement_id),
                        rationale=str(getattr(fit, "bridge", "") or getattr(fit, "reason", "") or ""),
                    )
                )
    covered_requirements = {edge.requirement_id for edge in edges}
    uncovered = []
    for requirement in target_profile.requirements:
        if requirement.requirement_id in covered_requirements:
            continue
        assessment = fit_by_requirement.get(requirement.requirement_id)
        fit = getattr(assessment, "fit", None)
        reason = str(
            getattr(fit, "reason", "")
            or getattr(fit, "blocker", "")
            or "No seeded requirement-achievement coverage."
        )
        uncovered.append(
            UncoveredRequirement(
                requirement_id=requirement.requirement_id,
                reason=reason,
                prohibited_claims=requirement.prohibited_claims,
            )
        )
    covered_achievements = {edge.achievement_evidence_id for edge in edges}
    unused = tuple(
        UnusedAchievement(
            achievement_evidence_id=achievement.achievement_evidence_id,
            reason="No seeded target requirement coverage.",
            pinned=achievement.pinned,
        )
        for achievement in achievements
        if achievement.achievement_evidence_id not in covered_achievements
    )
    return CoverageGraph(
        requirements=requirements,
        achievements=achievements,
        coverage_edges=tuple(edges),
        uncovered_requirements=tuple(uncovered),
        unused_achievements=unused,
    )


def build_coverage_planner_prompt(
    *,
    target_profile: TargetProfile,
    seeded_graph: CoverageGraph,
) -> str:
    return (
        "You are JobCtrl's requirement-achievement coverage planner.\n"
        "Return ONLY JSON matching the provided schema. Do not include markdown.\n"
        "Task: propose additional coverage edges between existing job requirement IDs "
        "and existing profile achievement evidence IDs.\n\n"
        "Hard constraints:\n"
        "- Use only requirement_id values present in TARGET_PROFILE.\n"
        "- Use only achievement_evidence_id values present in TARGET_PROFILE.\n"
        "- Do not invent tools, metrics, titles, credentials, dates, employers, or direct experience.\n"
        "- Classify direct evidence as direct, adjacent support as adjacent, and transferable experience as transferable.\n"
        "- If a requirement has no safe edge, list it in uncovered_requirements with prohibited claims.\n"
        "- If an achievement covers no target requirement, list it in unused_achievements.\n"
        "- Keep rationale concise and evidence-grounded.\n\n"
        "TARGET_PROFILE:\n"
        f"{_json_dumps(target_profile.to_prompt_dict())}\n\n"
        "SEEDED_COVERAGE_GRAPH:\n"
        f"{_json_dumps(seeded_graph.to_dict())}\n\n"
        "Return the JSON now."
    )


def apply_coverage_planner_response(
    *,
    seeded_graph: CoverageGraph,
    response: MappingABC[str, Any],
    controls: RequirementLedTailoringControls,
) -> tuple[CoverageGraph, tuple[str, ...]]:
    errors: list[str] = []
    planned_edges: list[CoverageEdge] = list(seeded_graph.coverage_edges)
    for raw in response.get("coverage_edges", ()) if isinstance(response, MappingABC) else ():
        if not isinstance(raw, MappingABC):
            errors.append("Planner coverage edge entry is not an object.")
            continue
        try:
            requirement_id = str(raw.get("requirement_id") or "")
            achievement_id = str(raw.get("achievement_evidence_id") or "")
            coverage_kind = str(raw.get("coverage_kind") or "")
            planned_edges.append(
                CoverageEdge(
                    edge_id=_edge_id(requirement_id, achievement_id, coverage_kind),
                    requirement_id=requirement_id,
                    achievement_evidence_id=achievement_id,
                    coverage_kind=coverage_kind,
                    strength=str(raw.get("strength") or "moderate"),
                    required_claim_policy=str(raw.get("required_claim_policy") or "evidence_reframing"),
                    target_terms=_clean_string_tuple(raw.get("target_terms", ())),
                    rationale=str(raw.get("rationale") or ""),
                )
            )
        except ValueError as exc:
            errors.append(str(exc))

    uncovered = list(seeded_graph.uncovered_requirements)
    for raw in response.get("uncovered_requirements", ()) if isinstance(response, MappingABC) else ():
        if not isinstance(raw, MappingABC):
            errors.append("Planner uncovered requirement entry is not an object.")
            continue
        try:
            uncovered.append(
                UncoveredRequirement(
                    requirement_id=str(raw.get("requirement_id") or ""),
                    reason=str(raw.get("reason") or ""),
                    prohibited_claims=_clean_string_tuple(raw.get("prohibited_claims", ())),
                )
            )
        except ValueError as exc:
            errors.append(str(exc))

    unused = list(seeded_graph.unused_achievements)
    for raw in response.get("unused_achievements", ()) if isinstance(response, MappingABC) else ():
        if not isinstance(raw, MappingABC):
            errors.append("Planner unused achievement entry is not an object.")
            continue
        try:
            unused.append(
                UnusedAchievement(
                    achievement_evidence_id=str(raw.get("achievement_evidence_id") or ""),
                    reason=str(raw.get("reason") or ""),
                )
            )
        except ValueError as exc:
            errors.append(str(exc))

    graph = CoverageGraph(
        requirements=seeded_graph.requirements,
        achievements=seeded_graph.achievements,
        coverage_edges=tuple(planned_edges),
        uncovered_requirements=tuple(_dedupe_uncovered(uncovered, planned_edges)),
        unused_achievements=tuple(_dedupe_unused(unused, planned_edges)),
    )
    return graph, tuple([*errors, *validate_coverage_graph(graph, controls=controls)])


def validate_coverage_graph(
    graph: CoverageGraph,
    *,
    controls: RequirementLedTailoringControls,
) -> tuple[str, ...]:
    errors: list[str] = []
    requirement_ids = graph.requirement_ids
    achievement_ids = graph.achievement_ids
    edge_ids: set[str] = set()
    edge_keys: set[tuple[str, str, str]] = set()

    if len(requirement_ids) != len(graph.requirements):
        errors.append("Coverage graph contains duplicate requirement IDs.")
    if len(achievement_ids) != len(graph.achievements):
        errors.append("Coverage graph contains duplicate achievement evidence IDs.")

    for edge in graph.coverage_edges:
        if edge.edge_id in edge_ids:
            errors.append(f"Coverage edge {edge.edge_id} is duplicated.")
        edge_ids.add(edge.edge_id)
        key = (edge.requirement_id, edge.achievement_evidence_id, edge.coverage_kind)
        if key in edge_keys:
            errors.append(
                "Coverage edge duplicates requirement/evidence/kind: "
                f"{edge.requirement_id}/{edge.achievement_evidence_id}/{edge.coverage_kind}."
            )
        edge_keys.add(key)
        if edge.requirement_id not in requirement_ids:
            errors.append(f"Coverage edge {edge.edge_id} references unknown requirement {edge.requirement_id}.")
        if edge.achievement_evidence_id not in achievement_ids:
            errors.append(
                f"Coverage edge {edge.edge_id} references unknown achievement evidence "
                f"{edge.achievement_evidence_id}."
            )
        if not _policy_allows(controls.claim_policy, edge.required_claim_policy):
            errors.append(
                f"Coverage edge {edge.edge_id} requires {edge.required_claim_policy}, "
                f"but claim policy is {controls.claim_policy}."
            )

    covered_requirements = {edge.requirement_id for edge in graph.coverage_edges}
    for uncovered in graph.uncovered_requirements:
        if uncovered.requirement_id not in requirement_ids:
            errors.append(f"Uncovered requirement {uncovered.requirement_id} is not in the graph.")
        if uncovered.requirement_id in covered_requirements:
            errors.append(f"Requirement {uncovered.requirement_id} is both covered and uncovered.")

    covered_achievements = {edge.achievement_evidence_id for edge in graph.coverage_edges}
    for unused in graph.unused_achievements:
        if unused.achievement_evidence_id not in achievement_ids:
            errors.append(f"Unused achievement {unused.achievement_evidence_id} is not in the graph.")
        if unused.achievement_evidence_id in covered_achievements:
            errors.append(f"Achievement {unused.achievement_evidence_id} is both covered and unused.")

    return tuple(errors)


def validate_generated_claim_mappings(
    mappings: IterableABC[GeneratedClaimMapping],
    graph: CoverageGraph,
    *,
    controls: RequirementLedTailoringControls,
) -> tuple[str, ...]:
    errors: list[str] = []
    edge_ids = graph.edge_ids
    requirement_ids = graph.requirement_ids
    achievement_ids = graph.achievement_ids
    coverage_by_edge_id = {edge.edge_id: edge for edge in graph.coverage_edges}

    for mapping in mappings:
        if not mapping.coverage_edge_ids and not mapping.non_requirement_reason:
            errors.append(f"Generated claim {mapping.claim_id} has no coverage edge or non-requirement reason.")
        if mapping.non_requirement_reason and mapping.coverage_edge_ids:
            errors.append(f"Generated claim {mapping.claim_id} mixes requirement and non-requirement reasons.")
        for edge_id in mapping.coverage_edge_ids:
            if edge_id not in edge_ids:
                errors.append(f"Generated claim {mapping.claim_id} references unknown coverage edge {edge_id}.")
                continue
            edge = coverage_by_edge_id[edge_id]
            if edge.requirement_id not in mapping.requirement_ids:
                errors.append(f"Generated claim {mapping.claim_id} omits requirement {edge.requirement_id}.")
            if edge.achievement_evidence_id not in mapping.evidence_ids:
                errors.append(
                    f"Generated claim {mapping.claim_id} omits evidence {edge.achievement_evidence_id}."
                )
        for requirement_id in mapping.requirement_ids:
            if requirement_id not in requirement_ids:
                errors.append(f"Generated claim {mapping.claim_id} references unknown requirement {requirement_id}.")
        for evidence_id in mapping.evidence_ids:
            if evidence_id not in achievement_ids:
                errors.append(f"Generated claim {mapping.claim_id} references unknown evidence {evidence_id}.")
        required_policy = _LABEL_REQUIRED_POLICY.get(mapping.claim_label)
        if required_policy and not _policy_allows(controls.claim_policy, required_policy):
            errors.append(
                f"Generated claim {mapping.claim_id} label {mapping.claim_label} "
                f"is not allowed by {controls.claim_policy}."
            )
        if mapping.claim_label == "draft_requires_confirmation" and not mapping.review_required:
            errors.append(f"Generated draft claim {mapping.claim_id} must require review.")
        if (
            mapping.claim_label == "adjacent_translation"
            and "adjacent_translation" not in controls.auto_approval_policy.auto_approvable_claim_labels
            and not mapping.review_required
        ):
            errors.append(f"Adjacent claim {mapping.claim_id} must require review.")
    return tuple(errors)


def validate_metric_support(
    generated_text: str,
    *,
    verified_metrics: IterableABC[str],
) -> tuple[str, ...]:
    allowed = " ".join(_normalize_metric(metric) for metric in verified_metrics).lower()
    unsupported: list[str] = []
    for match in _METRIC_RE.finditer(generated_text.lower()):
        metric = _normalize_metric(match.group(0))
        if metric and metric not in allowed:
            unsupported.append(metric)
    return tuple(dict.fromkeys(unsupported))


def validate_prohibited_claims(
    generated_text: str,
    prohibited_claims: IterableABC[str],
) -> tuple[str, ...]:
    normalized_text = _normalize_claim(generated_text)
    found: list[str] = []
    for claim in prohibited_claims:
        normalized = _normalize_claim(claim)
        if normalized and normalized in normalized_text:
            found.append(str(claim).strip())
    return tuple(dict.fromkeys(found))


def validate_pinned_content_preserved(
    generated_text: str,
    required_bullets_by_experience_id: dict[str, tuple[str, ...]],
) -> tuple[str, ...]:
    normalized_text = _normalize_claim(generated_text)
    missing: list[str] = []
    for entry_id, bullets in required_bullets_by_experience_id.items():
        for bullet in bullets:
            if _normalize_claim(bullet) not in normalized_text:
                missing.append(f"{entry_id}: {bullet}")
    return tuple(missing)


def validate_mandatory_covered_achievements(
    graph: CoverageGraph,
    mappings: IterableABC[GeneratedClaimMapping],
) -> tuple[str, ...]:
    represented = {
        evidence_id
        for mapping in mappings
        for evidence_id in mapping.evidence_ids
        if mapping.coverage_edge_ids
    }
    covered = {edge.achievement_evidence_id for edge in graph.coverage_edges}
    return tuple(sorted(covered - represented))


def score_generated_resume_against_target(
    *,
    target_profile: TargetProfile,
    mappings: IterableABC[GeneratedClaimMapping],
    grounding: ClaimGrounding,
) -> PostGenerationFitScore:
    """Score shipped requirement coverage — grounded, never claim-trusted.

    A requirement is covered ONLY when ``grounding`` bound at least one of its
    coverage-bearing claims to a line the resume actually ships. A requirement
    asserted solely by ungrounded claims is ``claimed_only``: it counts as
    UNCOVERED (the shipped artifact does not carry it) and its prioritized fix
    says so explicitly, so the revision loop repairs the real gap instead of
    trusting the model's self-assessment.
    """
    mapping_tuple = tuple(mappings)
    covered_set = set(grounding.grounded_requirement_ids)
    claimed_only_set = set(grounding.claimed_only_requirement_ids)
    all_requirements = target_profile.requirements
    covered = tuple(
        requirement.requirement_id
        for requirement in all_requirements
        if requirement.requirement_id in covered_set
    )
    claimed_only = tuple(
        requirement.requirement_id
        for requirement in all_requirements
        if requirement.requirement_id in claimed_only_set
    )
    uncovered_requirements = tuple(
        requirement
        for requirement in all_requirements
        if requirement.requirement_id not in covered_set
    )
    must_have = target_profile.must_have_requirements
    covered_must_have = [
        requirement
        for requirement in must_have
        if requirement.requirement_id in covered_set
    ]
    must_have_coverage = len(covered_must_have) / len(must_have) if must_have else 1.0
    total_weight = sum(requirement.weight or 0.0 for requirement in all_requirements)
    if total_weight > 0:
        weighted_coverage = sum(
            requirement.weight
            for requirement in all_requirements
            if requirement.requirement_id in covered_set
        ) / total_weight
    else:
        weighted_coverage = 1.0 if not uncovered_requirements else 0.0
    score = max(1, min(10, round(weighted_coverage * 10)))
    prioritized_fixes = tuple(
        _uncovered_fix_text(requirement, claimed_only=requirement.requirement_id in claimed_only_set)
        for requirement in sorted(
            uncovered_requirements,
            key=lambda item: (item.tier != "must_have", -item.weight, item.requirement_id),
        )
    )
    review_blockers = tuple(
        f"{mapping.claim_id}: {mapping.claim_label}"
        for mapping in mapping_tuple
        if mapping.review_required
    )
    return PostGenerationFitScore(
        score=score,
        must_have_coverage=round(must_have_coverage, 4),
        covered_requirement_ids=covered,
        uncovered_requirement_ids=tuple(
            requirement.requirement_id for requirement in uncovered_requirements
        ),
        claimed_only_requirement_ids=claimed_only,
        prioritized_fixes=prioritized_fixes,
        review_blockers=review_blockers,
        coverage_basis=grounding.basis,
    )


def _uncovered_fix_text(requirement: TargetRequirement, *, claimed_only: bool) -> str:
    if claimed_only:
        return (
            f"{requirement.requirement_id}: {requirement.text} — a claim mapped this "
            "requirement but its text does not appear in the shipped resume; rewrite a "
            "rendered bullet to carry it or drop the claim."
        )
    return f"{requirement.requirement_id}: {requirement.text}"


def decide_score_gated_revision(
    *,
    fit_score: PostGenerationFitScore,
    controls: RequirementLedTailoringControls,
    attempt: int,
) -> RevisionDecision:
    gates = controls.revision_gates
    score_failed = fit_score.score < gates.min_fit_score
    coverage_failed = fit_score.must_have_coverage < gates.must_have_coverage
    threshold_failed = score_failed or coverage_failed
    review_blocked = bool(fit_score.review_blockers)
    enhancement_allowed = controls.claim_policy in {
        "adjacent_translation",
        "draft_requires_confirmation",
    }
    attempts_remaining = max(0, gates.max_revision_attempts - max(0, attempt - 1))
    should_revise = threshold_failed and enhancement_allowed and attempts_remaining > 0
    if review_blocked:
        reason = "review_blocked_claims"
    elif score_failed and coverage_failed:
        reason = "fit_score_and_must_have_coverage_below_threshold"
    elif score_failed:
        reason = "fit_score_below_threshold"
    elif coverage_failed:
        reason = "must_have_coverage_below_threshold"
    else:
        reason = "passed"
    return RevisionDecision(
        threshold_failed=threshold_failed,
        should_revise=should_revise,
        review_blocked=review_blocked,
        enhancement_allowed=enhancement_allowed,
        reason=reason,
        attempt=attempt,
        max_revision_attempts=gates.max_revision_attempts,
        prioritized_fixes=fit_score.prioritized_fixes,
        review_blockers=fit_score.review_blockers,
    )


def append_enhancement_claim_mappings(
    *,
    selected_mappings: IterableABC[GeneratedClaimMapping],
    enhancement_mappings: IterableABC[GeneratedClaimMapping],
    controls: RequirementLedTailoringControls,
) -> tuple[tuple[GeneratedClaimMapping, ...], tuple[str, ...]]:
    selected = tuple(selected_mappings)
    enhancements = tuple(enhancement_mappings)
    errors: list[str] = []
    for mapping in enhancements:
        if mapping.claim_label not in {"adjacent_translation", "draft_requires_confirmation"}:
            errors.append(
                f"Enhancement claim {mapping.claim_id} must be adjacent_translation or draft_requires_confirmation."
            )
        if mapping.claim_label == "draft_requires_confirmation" and not mapping.review_required:
            errors.append(f"Enhancement draft claim {mapping.claim_id} must require review.")
        if (
            mapping.claim_label == "adjacent_translation"
            and "adjacent_translation" not in controls.auto_approval_policy.auto_approvable_claim_labels
            and not mapping.review_required
        ):
            errors.append(f"Enhancement adjacent claim {mapping.claim_id} must require review.")
    return (*selected, *enhancements), tuple(errors)


def bullet_limit_overflows(
    *,
    experience_entry_id: str,
    max_bullets: int,
    actual_bullets: int,
    pinned_required_bullet_count: int = 0,
    requirement_covered_evidence_ids: tuple[str, ...] = (),
    enhancement_covered_evidence_ids: tuple[str, ...] = (),
) -> tuple[BulletLimitOverflow, ...]:
    if actual_bullets <= max_bullets:
        return ()
    if enhancement_covered_evidence_ids:
        return (
            BulletLimitOverflow(
                experience_entry_id=experience_entry_id,
                max_bullets=max_bullets,
                actual_bullets=actual_bullets,
                reason="enhancement_coverage",
                evidence_ids=enhancement_covered_evidence_ids,
            ),
        )
    if requirement_covered_evidence_ids:
        return (
            BulletLimitOverflow(
                experience_entry_id=experience_entry_id,
                max_bullets=max_bullets,
                actual_bullets=actual_bullets,
                reason="requirement_coverage",
                evidence_ids=requirement_covered_evidence_ids,
            ),
        )
    if pinned_required_bullet_count:
        return (
            BulletLimitOverflow(
                experience_entry_id=experience_entry_id,
                max_bullets=max_bullets,
                actual_bullets=actual_bullets,
                reason="pinned_required_bullet",
            ),
        )
    return ()


def _policy_allows(active_policy: str, required_policy: str) -> bool:
    return _POLICY_RANK.get(active_policy, 0) >= _POLICY_RANK.get(required_policy, 0)


@dataclass(frozen=True)
class _RequirementLike:
    id: str
    text: str
    tier: str
    weight: float
    evidence_span: str


def _achievement_node_from_item(item: Any, *, pinned: bool) -> AchievementNode:
    return AchievementNode(
        achievement_evidence_id=_item_attr(item, "evidence_id", "id"),
        experience_entry_id=_item_attr(item, "experience_entry_id"),
        source_text=_item_attr(item, "source_text"),
        metrics=_item_tuple(item, "metrics"),
        tools=_item_tuple(item, "tools"),
        evidence_strength=_item_attr(item, "evidence_strength"),
        user_confirmed=bool(_item_value(item, "user_confirmed", False)),
        pinned=pinned,
    )


def _item_attr(item: Any, *names: str) -> str:
    for name in names:
        value = _item_value(item, name, None)
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def _item_tuple(item: Any, name: str) -> tuple[str, ...]:
    return _clean_string_tuple(_item_value(item, name, ()))


def _item_value(item: Any, name: str, default: Any) -> Any:
    if isinstance(item, MappingABC):
        return item.get(name, default)
    return getattr(item, name, default)


def _merge_clean_strings(*groups: IterableABC[Any]) -> tuple[str, ...]:
    values: list[str] = []
    for group in groups:
        values.extend(_clean_string_tuple(group))
    return tuple(dict.fromkeys(values))


def _normalize_phrase(value: Any) -> str:
    return " ".join(re.findall(r"[a-z0-9][a-z0-9+#./-]*", str(value or "").lower())).strip()


def _requirement_keywords(target_profile: TargetProfile, requirement_id: str) -> tuple[str, ...]:
    for requirement in target_profile.requirements:
        if requirement.requirement_id == requirement_id:
            return requirement.keywords
    return ()


def _edge_id(requirement_id: str, achievement_evidence_id: str, coverage_kind: str) -> str:
    return "edge_" + "_".join(
        _slug(part) for part in (requirement_id, achievement_evidence_id, coverage_kind)
    )


def _slug(value: Any) -> str:
    return re.sub(r"[^a-zA-Z0-9_.-]+", "_", str(value or "").strip()).strip("_") or "unknown"


def _dedupe_uncovered(
    items: list[UncoveredRequirement],
    edges: list[CoverageEdge],
) -> list[UncoveredRequirement]:
    covered = {edge.requirement_id for edge in edges}
    out: dict[str, UncoveredRequirement] = {}
    for item in items:
        if item.requirement_id in covered:
            continue
        out[item.requirement_id] = item
    return list(out.values())


def _dedupe_unused(
    items: list[UnusedAchievement],
    edges: list[CoverageEdge],
) -> list[UnusedAchievement]:
    covered = {edge.achievement_evidence_id for edge in edges}
    out: dict[str, UnusedAchievement] = {}
    for item in items:
        if item.achievement_evidence_id in covered:
            continue
        out[item.achievement_evidence_id] = item
    return list(out.values())


def _excerpt(value: Any, *, max_chars: int = 240) -> str:
    return " ".join(str(value or "").split())[:max_chars]


def _json_dumps(value: Any) -> str:
    return json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True)


def _required_text(value: Any, field_name: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{field_name} must be non-empty")
    return text


def _clean_enum(value: Any, allowed: tuple[str, ...], field_name: str) -> str:
    text = str(value or "").strip()
    if text not in allowed:
        raise ValueError(f"{field_name} must be one of {allowed}, got {text!r}")
    return text


def _clean_string_tuple(value: Any) -> tuple[str, ...]:
    if value is None or isinstance(value, (str, bytes)):
        values = [value] if value else []
    else:
        try:
            values = list(value)
        except TypeError:
            values = []
    return tuple(dict.fromkeys(text for item in values if (text := str(item or "").strip())))


def _non_negative_int(value: Any, field_name: str) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = 0
    if parsed < 0:
        raise ValueError(f"{field_name} must be non-negative")
    return parsed


def _normalize_metric(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def _normalize_claim(value: Any) -> str:
    return " ".join(str(value or "").lower().split())


__all__ = [
    "AchievementNode",
    "BulletLimitOverflow",
    "CoverageEdge",
    "CoverageGraph",
    "COVERAGE_PLANNER_RESPONSE_SCHEMA",
    "GeneratedClaimMapping",
    "PostGenerationFitScore",
    "RequirementNode",
    "RevisionDecision",
    "TargetProfile",
    "TargetRequirement",
    "UncoveredRequirement",
    "UnusedAchievement",
    "apply_coverage_planner_response",
    "append_enhancement_claim_mappings",
    "bullet_limit_overflows",
    "build_coverage_planner_prompt",
    "build_target_profile",
    "decide_score_gated_revision",
    "seed_coverage_graph",
    "score_generated_resume_against_target",
    "validate_coverage_graph",
    "validate_generated_claim_mappings",
    "validate_mandatory_covered_achievements",
    "validate_metric_support",
    "validate_pinned_content_preserved",
    "validate_prohibited_claims",
]
