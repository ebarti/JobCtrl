"""Interview Preparation value objects.

Interview prep is generated material for before an interview and reflection is
recorded after an interview through Apply outcomes. This module deliberately has
no live, in-session, streaming, transcript, or agent-participation state.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

InterviewPrepItemKind = Literal["theme", "star_draft", "gap_drill", "company_note"]
InterviewPrepStatus = Literal["accepted", "failed", "superseded"]

INTERVIEW_PREP_ITEM_KINDS = ("theme", "star_draft", "gap_drill", "company_note")
INTERVIEW_PREP_STATUSES = ("accepted", "failed", "superseded")


def _text_tuple(value: object) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, (list, tuple)):
        raise TypeError("expected a list/tuple of strings")
    return tuple(str(item) for item in value)


def _optional_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


@dataclass(frozen=True)
class InterviewPrepGateAudit:
    """Truthfulness-gate summary for one prep generation."""

    status: Literal["passed", "failed"]
    fabrication_findings: tuple[str, ...] = ()
    grounding_findings: tuple[str, ...] = ()
    judge_verdict: str | None = None
    warnings: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.status not in {"passed", "failed"}:
            raise ValueError(f"unknown interview prep gate status: {self.status}")

    def to_read_model(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "fabricationFindings": list(self.fabrication_findings),
            "groundingFindings": list(self.grounding_findings),
            "judgeVerdict": self.judge_verdict,
            "warnings": list(self.warnings),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "InterviewPrepGateAudit":
        data = data or {"status": "failed"}
        return cls(
            status=str(data["status"]),  # type: ignore[arg-type]
            fabrication_findings=_text_tuple(data.get("fabricationFindings")),
            grounding_findings=_text_tuple(data.get("groundingFindings")),
            judge_verdict=_optional_text(data.get("judgeVerdict")),
            warnings=_text_tuple(data.get("warnings")),
        )


@dataclass(frozen=True)
class InterviewPrepItem:
    """One generated preparation unit for a job application."""

    item_id: str
    kind: InterviewPrepItemKind
    title: str
    generated_text: str
    evidence_ids: tuple[str, ...]
    requirement_ids: tuple[str, ...]
    source_text: tuple[str, ...] = ()
    transform_type: str = "grounded_prep"
    control: str = "never_fabricate"
    grounding_audit: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()
    position: int = 0

    def __post_init__(self) -> None:
        if not self.item_id.strip():
            raise ValueError("InterviewPrepItem.item_id must be non-empty")
        if self.kind not in INTERVIEW_PREP_ITEM_KINDS:
            raise ValueError(f"unknown interview prep item kind: {self.kind}")
        if not self.title.strip():
            raise ValueError("InterviewPrepItem.title must be non-empty")
        if not self.generated_text.strip():
            raise ValueError("InterviewPrepItem.generated_text must be non-empty")
        if self.kind == "star_draft" and not self.evidence_ids:
            raise ValueError("star_draft prep items require at least one evidence id")
        if self.kind == "gap_drill" and not self.requirement_ids:
            raise ValueError("gap_drill prep items require at least one requirement id")
        if self.position < 0:
            raise ValueError("InterviewPrepItem.position must be >= 0")

    def to_read_model(self) -> dict[str, Any]:
        return {
            "itemId": self.item_id,
            "kind": self.kind,
            "title": self.title,
            "generatedText": self.generated_text,
            "evidenceIds": list(self.evidence_ids),
            "requirementIds": list(self.requirement_ids),
            "sourceText": list(self.source_text),
            "transformType": self.transform_type,
            "control": self.control,
            "groundingAudit": list(self.grounding_audit),
            "warnings": list(self.warnings),
            "position": self.position,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "InterviewPrepItem":
        return cls(
            item_id=str(data["itemId"]),
            kind=str(data["kind"]),  # type: ignore[arg-type]
            title=str(data["title"]),
            generated_text=str(data["generatedText"]),
            evidence_ids=_text_tuple(data.get("evidenceIds")),
            requirement_ids=_text_tuple(data.get("requirementIds")),
            source_text=_text_tuple(data.get("sourceText")),
            transform_type=str(data.get("transformType") or "grounded_prep"),
            control=str(data.get("control") or "never_fabricate"),
            grounding_audit=_text_tuple(data.get("groundingAudit")),
            warnings=_text_tuple(data.get("warnings")),
            position=int(data.get("position") or 0),
        )


@dataclass(frozen=True)
class InterviewPrep:
    """Generation-versioned prep for one job application."""

    job_id: str
    generation: int
    status: InterviewPrepStatus
    generated_at: str
    gate_audit: InterviewPrepGateAudit
    items: tuple[InterviewPrepItem, ...]
    model: str | None = None

    def __post_init__(self) -> None:
        if not self.job_id.strip():
            raise ValueError("InterviewPrep.job_id must be non-empty")
        if self.generation < 1:
            raise ValueError("InterviewPrep.generation must be >= 1")
        if self.status not in INTERVIEW_PREP_STATUSES:
            raise ValueError(f"unknown interview prep status: {self.status}")
        if not self.generated_at.strip():
            raise ValueError("InterviewPrep.generated_at must be non-empty")
        if not isinstance(self.gate_audit, InterviewPrepGateAudit):
            raise TypeError("InterviewPrep.gate_audit must be InterviewPrepGateAudit")
        if not isinstance(self.items, tuple):
            raise TypeError("InterviewPrep.items must be a tuple")
        for item in self.items:
            if not isinstance(item, InterviewPrepItem):
                raise TypeError("InterviewPrep.items entries must be InterviewPrepItem")
        if self.status == "accepted" and not self.items:
            raise ValueError("accepted interview prep requires at least one item")

    def to_read_model(self) -> dict[str, Any]:
        return {
            "jobId": self.job_id,
            "generation": self.generation,
            "status": self.status,
            "generatedAt": self.generated_at,
            "model": self.model,
            "gateAudit": self.gate_audit.to_read_model(),
            "items": [item.to_read_model() for item in self.items],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "InterviewPrep":
        return cls(
            job_id=str(data["jobId"]),
            generation=int(data["generation"]),
            status=str(data["status"]),  # type: ignore[arg-type]
            generated_at=str(data["generatedAt"]),
            model=_optional_text(data.get("model")),
            gate_audit=InterviewPrepGateAudit.from_dict(data.get("gateAudit")),
            items=tuple(InterviewPrepItem.from_dict(item) for item in data.get("items", ())),
        )


__all__ = [
    "INTERVIEW_PREP_ITEM_KINDS",
    "INTERVIEW_PREP_STATUSES",
    "InterviewPrep",
    "InterviewPrepGateAudit",
    "InterviewPrepItem",
]
