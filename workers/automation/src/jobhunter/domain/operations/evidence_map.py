"""Career Evidence Map read-model value objects.

The evidence map is derived Operations data: it inverts profile evidence,
bullet provenance, requirement-fit rows, and coverage audits so the user can
inspect where each profile proof point or skill was used. It owns no canonical
facts of its own.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

EvidenceMapEntryKind = Literal["achievement_evidence", "skill"]
EvidenceUsageRefKind = Literal["resume_bullet", "requirement_fit", "skill_coverage"]
EvidenceGapKind = Literal[
    "missing_requirement",
    "blocked_requirement",
    "transferable_requirement",
    "missing_skill",
]

_ENTRY_KINDS = {"achievement_evidence", "skill"}
_USAGE_KINDS = {"resume_bullet", "requirement_fit", "skill_coverage"}
_GAP_KINDS = {
    "missing_requirement",
    "blocked_requirement",
    "transferable_requirement",
    "missing_skill",
}


def _optional_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _text_tuple(value: object) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, (list, tuple)):
        raise TypeError("expected a list/tuple of strings")
    return tuple(str(item) for item in value)


@dataclass(frozen=True)
class EvidenceUsageRef:
    """One recorded use of a proof point or skill in an existing artifact/audit."""

    kind: EvidenceUsageRefKind
    job_key: str
    job_title: str | None = None
    employer: str | None = None
    artifact_id: str | None = None
    bullet_id: str | None = None
    generation: int | None = None
    generated_text_preview: str | None = None
    score_version: int | None = None
    requirement_id: str | None = None
    requirement_text: str | None = None
    requirement_fit_kind: str | None = None
    artifact_coverage_state: str | None = None
    keyword: str | None = None
    coverage_state: str | None = None
    occurred_at: str | None = None

    def __post_init__(self) -> None:
        if self.kind not in _USAGE_KINDS:
            raise ValueError(f"unknown evidence usage kind: {self.kind}")
        if not self.job_key.strip():
            raise ValueError("EvidenceUsageRef.job_key must be non-empty")
        if self.generation is not None and self.generation < 1:
            raise ValueError("EvidenceUsageRef.generation must be >= 1")
        if self.score_version is not None and self.score_version < 1:
            raise ValueError("EvidenceUsageRef.score_version must be >= 1")

    def to_read_model(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "jobKey": self.job_key,
            "jobTitle": self.job_title,
            "employer": self.employer,
            "artifactId": self.artifact_id,
            "bulletId": self.bullet_id,
            "generation": self.generation,
            "generatedTextPreview": self.generated_text_preview,
            "scoreVersion": self.score_version,
            "requirementId": self.requirement_id,
            "requirementText": self.requirement_text,
            "requirementFitKind": self.requirement_fit_kind,
            "artifactCoverageState": self.artifact_coverage_state,
            "keyword": self.keyword,
            "coverageState": self.coverage_state,
            "occurredAt": self.occurred_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "EvidenceUsageRef":
        return cls(
            kind=str(data["kind"]),  # type: ignore[arg-type]
            job_key=str(data["jobKey"]),
            job_title=_optional_text(data.get("jobTitle")),
            employer=_optional_text(data.get("employer")),
            artifact_id=_optional_text(data.get("artifactId")),
            bullet_id=_optional_text(data.get("bulletId")),
            generation=(int(data["generation"]) if data.get("generation") is not None else None),
            generated_text_preview=_optional_text(data.get("generatedTextPreview")),
            score_version=(int(data["scoreVersion"]) if data.get("scoreVersion") is not None else None),
            requirement_id=_optional_text(data.get("requirementId")),
            requirement_text=_optional_text(data.get("requirementText")),
            requirement_fit_kind=_optional_text(data.get("requirementFitKind")),
            artifact_coverage_state=_optional_text(data.get("artifactCoverageState")),
            keyword=_optional_text(data.get("keyword")),
            coverage_state=_optional_text(data.get("coverageState")),
            occurred_at=_optional_text(data.get("occurredAt")),
        )


@dataclass(frozen=True)
class EvidenceFreshness:
    """Profile freshness signals joined into an evidence-map entry."""

    evidence_date_range: str | None = None
    evidence_strength: str | None = None
    user_confirmed: bool = False
    claim_confidence: float | None = None
    last_used_at: str | None = None

    def to_read_model(self) -> dict[str, Any]:
        return {
            "evidenceDateRange": self.evidence_date_range,
            "evidenceStrength": self.evidence_strength,
            "userConfirmed": self.user_confirmed,
            "claimConfidence": self.claim_confidence,
            "lastUsedAt": self.last_used_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "EvidenceFreshness":
        data = data or {}
        return cls(
            evidence_date_range=_optional_text(data.get("evidenceDateRange")),
            evidence_strength=_optional_text(data.get("evidenceStrength")),
            user_confirmed=bool(data.get("userConfirmed", False)),
            claim_confidence=(
                float(data["claimConfidence"]) if data.get("claimConfidence") is not None else None
            ),
            last_used_at=_optional_text(data.get("lastUsedAt")),
        )


@dataclass(frozen=True)
class EvidenceReusableStory:
    """STAR raw material from a profile achievement proof point."""

    scope: str = ""
    action: str = ""
    outcome: str = ""
    metrics: tuple[str, ...] = ()

    def to_read_model(self) -> dict[str, Any]:
        return {
            "scope": self.scope,
            "action": self.action,
            "outcome": self.outcome,
            "metrics": list(self.metrics),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "EvidenceReusableStory | None":
        if data is None:
            return None
        return cls(
            scope=str(data.get("scope") or ""),
            action=str(data.get("action") or ""),
            outcome=str(data.get("outcome") or ""),
            metrics=_text_tuple(data.get("metrics")),
        )


@dataclass(frozen=True)
class EvidenceGap:
    """A demanded requirement or skill that recorded evidence does not cover."""

    gap_id: str
    kind: EvidenceGapKind
    requirement_text: str
    reason: str
    job_refs: tuple[EvidenceUsageRef, ...]
    requirement_id: str | None = None
    demanded_skill: str | None = None
    tier: str | None = None
    weight: float | None = None
    fit_kind: str | None = None

    def __post_init__(self) -> None:
        if not self.gap_id.strip():
            raise ValueError("EvidenceGap.gap_id must be non-empty")
        if self.kind not in _GAP_KINDS:
            raise ValueError(f"unknown evidence gap kind: {self.kind}")
        if not self.requirement_text.strip():
            raise ValueError("EvidenceGap.requirement_text must be non-empty")
        if not isinstance(self.job_refs, tuple):
            raise TypeError("EvidenceGap.job_refs must be a tuple")

    def to_read_model(self) -> dict[str, Any]:
        return {
            "gapId": self.gap_id,
            "kind": self.kind,
            "requirementId": self.requirement_id,
            "requirementText": self.requirement_text,
            "demandedSkill": self.demanded_skill,
            "tier": self.tier,
            "weight": self.weight,
            "fitKind": self.fit_kind,
            "reason": self.reason,
            "jobRefs": [ref.to_read_model() for ref in self.job_refs],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "EvidenceGap":
        refs = tuple(EvidenceUsageRef.from_dict(item) for item in data.get("jobRefs", ()))
        return cls(
            gap_id=str(data["gapId"]),
            kind=str(data["kind"]),  # type: ignore[arg-type]
            requirement_id=_optional_text(data.get("requirementId")),
            requirement_text=str(data["requirementText"]),
            demanded_skill=_optional_text(data.get("demandedSkill")),
            tier=_optional_text(data.get("tier")),
            weight=(float(data["weight"]) if data.get("weight") is not None else None),
            fit_kind=_optional_text(data.get("fitKind")),
            reason=str(data.get("reason") or ""),
            job_refs=refs,
        )


@dataclass(frozen=True)
class EvidenceMapEntry:
    """One proof point or skill inventory row in the Career Evidence Map."""

    entry_id: str
    kind: EvidenceMapEntryKind
    title: str
    freshness: EvidenceFreshness
    evidence_id: str | None = None
    skill_id: str | None = None
    story: EvidenceReusableStory | None = None
    skills: tuple[str, ...] = ()
    tags: tuple[str, ...] = ()
    resume_usages: tuple[EvidenceUsageRef, ...] = ()
    requirement_usages: tuple[EvidenceUsageRef, ...] = ()
    coverage_usages: tuple[EvidenceUsageRef, ...] = ()
    gaps: tuple[EvidenceGap, ...] = ()

    def __post_init__(self) -> None:
        if not self.entry_id.strip():
            raise ValueError("EvidenceMapEntry.entry_id must be non-empty")
        if self.kind not in _ENTRY_KINDS:
            raise ValueError(f"unknown evidence map entry kind: {self.kind}")
        if not self.title.strip():
            raise ValueError("EvidenceMapEntry.title must be non-empty")
        if self.kind == "achievement_evidence" and not self.evidence_id:
            raise ValueError("achievement evidence entries require evidence_id")
        if self.kind == "skill" and not self.skill_id:
            raise ValueError("skill entries require skill_id")

    def to_read_model(self) -> dict[str, Any]:
        return {
            "entryId": self.entry_id,
            "kind": self.kind,
            "evidenceId": self.evidence_id,
            "skillId": self.skill_id,
            "title": self.title,
            "story": self.story.to_read_model() if self.story else None,
            "skills": list(self.skills),
            "tags": list(self.tags),
            "freshness": self.freshness.to_read_model(),
            "resumeUsages": [usage.to_read_model() for usage in self.resume_usages],
            "requirementUsages": [usage.to_read_model() for usage in self.requirement_usages],
            "coverageUsages": [usage.to_read_model() for usage in self.coverage_usages],
            "gaps": [gap.to_read_model() for gap in self.gaps],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "EvidenceMapEntry":
        return cls(
            entry_id=str(data["entryId"]),
            kind=str(data["kind"]),  # type: ignore[arg-type]
            evidence_id=_optional_text(data.get("evidenceId")),
            skill_id=_optional_text(data.get("skillId")),
            title=str(data["title"]),
            story=EvidenceReusableStory.from_dict(data.get("story")),
            skills=_text_tuple(data.get("skills")),
            tags=_text_tuple(data.get("tags")),
            freshness=EvidenceFreshness.from_dict(data.get("freshness")),
            resume_usages=tuple(
                EvidenceUsageRef.from_dict(item) for item in data.get("resumeUsages", ())
            ),
            requirement_usages=tuple(
                EvidenceUsageRef.from_dict(item) for item in data.get("requirementUsages", ())
            ),
            coverage_usages=tuple(
                EvidenceUsageRef.from_dict(item) for item in data.get("coverageUsages", ())
            ),
            gaps=tuple(EvidenceGap.from_dict(item) for item in data.get("gaps", ())),
        )


__all__ = [
    "EvidenceFreshness",
    "EvidenceGap",
    "EvidenceMapEntry",
    "EvidenceReusableStory",
    "EvidenceUsageRef",
]
