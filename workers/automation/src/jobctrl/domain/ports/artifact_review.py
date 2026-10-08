"""Shared artifact lifecycle and persisted review records; no text interpretation."""

from __future__ import annotations
from dataclasses import dataclass, field
from enum import Enum


class ArtifactStatus(str, Enum):
    """Lifecycle states of one :class:`Artifact`.

    ``candidate``  — produced but not yet approved (validator failed or
                     judge has not run yet).
    ``approved``   — validator + judge both passed; this is the artifact
                     downstream consumers should use.
    ``rejected``   — validator or judge rejected the artifact; kept for
                     audit, not for use.
    ``superseded`` — replaced by a newer generation's artifact of the
                     same type. Set when ``MaterialsSetFactory.next_generation``
                     creates a fresh aggregate.
    ``suppressed`` — hidden from active/default use by policy while retained
                     for audit and historical inspection.
    """

    CANDIDATE = "candidate"
    APPROVED = "approved"
    REJECTED = "rejected"
    SUPERSEDED = "superseded"
    SUPPRESSED = "suppressed"


@dataclass(frozen=True)
class ValidationResult:
    """Outcome of running :class:`ContentValidator` over text.

    ``passed`` is derived from ``errors``: an instance carrying any error
    cannot claim to have passed. Warnings never block; they exist so the
    UI can surface advisory issues (banned words in normal mode, etc.).
    """

    passed: bool
    errors: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        for label, items in (("errors", self.errors), ("warnings", self.warnings)):
            if not isinstance(items, tuple):
                raise TypeError(f"ValidationResult.{label} must be a tuple")
            for item in items:
                if not isinstance(item, str):
                    raise TypeError(f"ValidationResult.{label} entries must be str, got {type(item).__name__}")
        # Recompute passed so the flag and the list cannot disagree.
        derived_pass = len(self.errors) == 0
        if self.passed != derived_pass:
            object.__setattr__(self, "passed", derived_pass)

    @classmethod
    def success(cls, *, warnings: tuple[str, ...] = ()) -> "ValidationResult":
        return cls(passed=True, errors=(), warnings=warnings)

    @classmethod
    def failure(
        cls,
        errors: tuple[str, ...],
        *,
        warnings: tuple[str, ...] = (),
    ) -> "ValidationResult":
        if not errors:
            raise ValueError("ValidationResult.failure requires at least one error")
        return cls(passed=False, errors=errors, warnings=warnings)

    @classmethod
    def from_dict(cls, data: dict | None) -> "ValidationResult":
        data = data or {}
        return cls(
            passed=bool(data.get("passed", True)),
            errors=tuple(str(e) for e in (data.get("errors") or ())),
            warnings=tuple(str(w) for w in (data.get("warnings") or ())),
        )

    def to_dict(self) -> dict:
        return {
            "passed": self.passed,
            "errors": list(self.errors),
            "warnings": list(self.warnings),
        }


@dataclass(frozen=True)
class JudgeVerdict:
    """LLM judge result for a tailored resume.

    ``approved`` is the binary PASS/FAIL signal use cases gate on.
    ``score`` is a 0..1 estimate the judge supplies for diagnostics.
    ``criterion_scores`` carries the structured rubric breakdown, and
    ``issues`` captures blocking judge findings as structured prose.
    """

    approved: bool
    score: float = 0.0
    notes: str = ""
    criterion_scores: dict[str, float] = field(default_factory=dict)
    issues: tuple[str, ...] = ()
    selected_candidate_id: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.approved, bool):
            raise TypeError("JudgeVerdict.approved must be a bool")
        if not isinstance(self.score, (int, float)) or isinstance(self.score, bool):
            raise TypeError("JudgeVerdict.score must be a number")
        if self.score < 0.0 or self.score > 1.0:
            raise ValueError(f"JudgeVerdict.score must be in [0.0, 1.0], got {self.score}")
        if not isinstance(self.notes, str):
            raise TypeError("JudgeVerdict.notes must be a str")
        if not isinstance(self.criterion_scores, dict):
            raise TypeError("JudgeVerdict.criterion_scores must be a dict")
        cleaned_scores: dict[str, float] = {}
        for key, value in self.criterion_scores.items():
            if not isinstance(key, str) or not key.strip():
                raise ValueError("JudgeVerdict.criterion_scores keys must be non-empty strings")
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                raise TypeError("JudgeVerdict.criterion_scores values must be numbers")
            score = float(value)
            if score < 0.0 or score > 1.0:
                raise ValueError(f"JudgeVerdict.criterion_scores[{key!r}] must be in [0.0, 1.0], got {score}")
            cleaned_scores[key] = score
        object.__setattr__(self, "criterion_scores", cleaned_scores)
        if not isinstance(self.issues, tuple):
            raise TypeError("JudgeVerdict.issues must be a tuple")
        for issue in self.issues:
            if not isinstance(issue, str):
                raise TypeError("JudgeVerdict.issues entries must be str")
        if self.selected_candidate_id is not None and not isinstance(self.selected_candidate_id, str):
            raise TypeError("JudgeVerdict.selected_candidate_id must be a str or None")

    @classmethod
    def passed(
        cls,
        *,
        score: float = 1.0,
        notes: str = "",
        criterion_scores: dict[str, float] | None = None,
        issues: tuple[str, ...] = (),
        selected_candidate_id: str | None = None,
    ) -> "JudgeVerdict":
        return cls(
            approved=True,
            score=score,
            notes=notes,
            criterion_scores=criterion_scores or {},
            issues=issues,
            selected_candidate_id=selected_candidate_id,
        )

    @classmethod
    def failed(
        cls,
        *,
        score: float = 0.0,
        notes: str = "",
        criterion_scores: dict[str, float] | None = None,
        issues: tuple[str, ...] = (),
        selected_candidate_id: str | None = None,
    ) -> "JudgeVerdict":
        return cls(
            approved=False,
            score=score,
            notes=notes,
            criterion_scores=criterion_scores or {},
            issues=issues,
            selected_candidate_id=selected_candidate_id,
        )

    @classmethod
    def from_dict(cls, data: dict | None) -> "JudgeVerdict | None":
        if not data:
            return None
        raw_issues = data.get("issues") or ()
        if isinstance(raw_issues, str):
            issues = (raw_issues,) if raw_issues and raw_issues != "none" else ()
        else:
            issues = tuple(str(issue) for issue in raw_issues)
        approved = bool(data.get("approved", False))
        verdict = str(data.get("verdict") or "").upper()
        if verdict in {"PASS", "APPROVED"}:
            approved = True
        elif verdict in {"FAIL", "REJECTED"}:
            approved = False
        return cls(
            approved=approved,
            score=float(data.get("score", 0.0) or 0.0),
            notes=str(data.get("notes") or ""),
            criterion_scores={
                str(key): float(value) for key, value in dict(data.get("criterion_scores") or {}).items()
            },
            issues=issues,
            selected_candidate_id=(str(data["selected_candidate_id"]) if data.get("selected_candidate_id") else None),
        )

    @classmethod
    def from_structured_judge(cls, data: dict) -> "JudgeVerdict":
        if not isinstance(data, dict):
            raise TypeError("structured judge response must be a dict")
        verdict = str(data.get("verdict") or "").strip().upper()
        if verdict not in {"PASS", "FAIL"}:
            raise ValueError("structured judge verdict must be PASS or FAIL")
        score = float(data["score"])
        raw_scores = data.get("criterion_scores")
        if not isinstance(raw_scores, dict) or not raw_scores:
            raise ValueError("structured judge response requires criterion_scores")
        raw_issues = data.get("issues")
        if not isinstance(raw_issues, list):
            raise ValueError("structured judge response requires issues as a list")
        issues: list[str] = []
        for issue in raw_issues:
            if isinstance(issue, dict):
                message = str(issue.get("message") or "").strip()
                criterion = str(issue.get("criterion") or "").strip()
                severity = str(issue.get("severity") or "").strip()
                parts = [part for part in (severity, criterion, message) if part]
                if parts:
                    issues.append(": ".join(parts))
            elif str(issue).strip():
                issues.append(str(issue).strip())
        notes = str(data.get("notes") or "; ".join(issues) or "none")
        return cls(
            approved=verdict == "PASS",
            score=score,
            notes=notes,
            criterion_scores={str(key): float(value) for key, value in raw_scores.items()},
            issues=tuple(issues),
            selected_candidate_id=(str(data["selected_candidate_id"]) if data.get("selected_candidate_id") else None),
        )

    def to_dict(self) -> dict:
        return {
            "approved": self.approved,
            "verdict": "PASS" if self.approved else "FAIL",
            "score": self.score,
            "notes": self.notes,
            "criterion_scores": dict(self.criterion_scores),
            "issues": list(self.issues),
            "selected_candidate_id": self.selected_candidate_id,
        }
