"""Materials Generation value objects.

See ddd-target.md §4.5. Pure data, no I/O. Frozen dataclasses; constructors
enforce invariants up front so an instance carries its validity.

Invariants:

  ``ArtifactType``     — closed enumeration of the four artifact roles
                         a :class:`MaterialsSet` may carry.
  ``ArtifactStatus``   — closed lifecycle: ``candidate`` → ``approved``
                         (or ``rejected``); approved entries become
                         ``superseded`` when a newer generation lands.
  ``RenderFormat``     — closed enumeration of how an artifact's bytes
                         were produced (LaTeX→PDF, HTML→PDF, plain text).
  ``ValidationResult`` — passed/failed plus error/warning lists from the
                         pure :class:`ContentValidator` domain service.
                         ``passed`` is recomputed from ``errors`` so the
                         flag and the list cannot disagree.
  ``JudgeVerdict``     — structured LLM judge output; ``approved`` reflects
                         PASS/FAIL, ``score`` is a 0..1 quality estimate,
                         criterion scores and issues carry the audit trail.
  ``LlmModelSpec``     — safe provider/model selector that cannot carry raw
                         URLs or credentials.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum


# ---------------------------------------------------------------------------
# Enums (closed sets — every other module reads them as the source of truth)
# ---------------------------------------------------------------------------


class ArtifactType(str, Enum):
    """The four artifact roles a :class:`MaterialsSet` may hold.

    Inheriting from ``str`` keeps the enum JSON-serialisable and lets the
    SQLite repository store the bare string without a custom converter.
    """

    TAILORED_RESUME = "tailored_resume"
    COVER_LETTER = "cover_letter"
    RESUME_PDF = "resume_pdf"
    COVER_LETTER_PDF = "cover_letter_pdf"


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


class RenderFormat(str, Enum):
    """How an artifact's bytes were produced.

    ``LATEX_PDF`` — moderncv LaTeX template compiled with pdflatex.
    ``HTML_PDF``  — Playwright headless Chromium prints HTML to PDF.
    ``TEXT``      — plain UTF-8 text, no rendering pass.
    """

    LATEX_PDF = "latex_pdf"
    HTML_PDF = "html_pdf"
    TEXT = "text"


# ---------------------------------------------------------------------------
# ValidationResult
# ---------------------------------------------------------------------------


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
                    raise TypeError(
                        f"ValidationResult.{label} entries must be str, got {type(item).__name__}"
                    )
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


# ---------------------------------------------------------------------------
# JudgeVerdict
# ---------------------------------------------------------------------------


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
            raise ValueError(
                f"JudgeVerdict.score must be in [0.0, 1.0], got {self.score}"
            )
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
                raise ValueError(
                    f"JudgeVerdict.criterion_scores[{key!r}] must be in [0.0, 1.0], got {score}"
                )
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
                str(key): float(value)
                for key, value in dict(data.get("criterion_scores") or {}).items()
            },
            issues=issues,
            selected_candidate_id=(
                str(data["selected_candidate_id"])
                if data.get("selected_candidate_id")
                else None
            ),
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
            selected_candidate_id=(
                str(data["selected_candidate_id"])
                if data.get("selected_candidate_id")
                else None
            ),
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


_MODEL_SPEC_RE = re.compile(r"^[A-Za-z0-9._/-]+$")
_MODEL_SPEC_SENTINELS = {"", "default", "local-default"}
_PROVIDER_PREFIXES = {"gemini", "openai", "local"}


@dataclass(frozen=True)
class LlmModelSpec:
    """Safe model selector for tailoring LLM calls.

    A spec is either a bare model name, which uses the currently configured
    provider, or ``provider:model`` where provider is one of
    ``gemini``, ``openai``, or ``local``. It deliberately carries no URL,
    API key, or provider configuration.
    """

    provider: str | None = None
    model: str | None = None

    def __post_init__(self) -> None:
        if self.provider is not None:
            provider = self.provider.strip().lower()
            if provider not in _PROVIDER_PREFIXES:
                raise ValueError(
                    f"LlmModelSpec.provider must be one of {sorted(_PROVIDER_PREFIXES)}, got {self.provider!r}"
                )
            object.__setattr__(self, "provider", provider)
        if self.model is not None:
            model = self.model.strip()
            if not model or model.lower() in _MODEL_SPEC_SENTINELS:
                object.__setattr__(self, "model", None)
                return
            if "://" in model or not _MODEL_SPEC_RE.fullmatch(model):
                raise ValueError(
                    "LlmModelSpec.model must be a model id, not a URL, secret, or provider config"
                )
            object.__setattr__(self, "model", model)

    @classmethod
    def default(cls) -> "LlmModelSpec":
        return cls()

    @classmethod
    def parse(cls, value: str | None) -> "LlmModelSpec":
        raw = (value or "").strip()
        if raw.lower() in _MODEL_SPEC_SENTINELS:
            return cls.default()
        if "://" in raw:
            raise ValueError("Model specs must not include URLs or raw provider config")
        if ":" in raw:
            provider, model = raw.split(":", 1)
            return cls(provider=provider, model=model)
        return cls(model=raw)

    @property
    def model_arg(self) -> str | None:
        if self.provider and self.model:
            return f"{self.provider}:{self.model}"
        if self.provider:
            return f"{self.provider}:default"
        return self.model

    @property
    def safe_label(self) -> str:
        if self.provider and self.model:
            return f"{self.provider}:{self.model}"
        if self.provider:
            return f"{self.provider}:default"
        return self.model or "default"

    def to_dict(self) -> dict:
        return {"provider": self.provider, "model": self.model, "label": self.safe_label}


__all__ = [
    "ArtifactStatus",
    "ArtifactType",
    "JudgeVerdict",
    "LlmModelSpec",
    "RenderFormat",
    "ValidationResult",
]


# Suppress unused-import warning for ``field``: we re-export the symbol so
# downstream modules can continue to import it from this package.
_ = field
