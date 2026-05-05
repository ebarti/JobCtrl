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
  ``JudgeVerdict``     — LLM judge output; ``approved`` reflects PASS/FAIL,
                         ``score`` is a 0..1 quality estimate, ``notes`` is
                         the judge's prose.
"""

from __future__ import annotations

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
    """

    CANDIDATE = "candidate"
    APPROVED = "approved"
    REJECTED = "rejected"
    SUPERSEDED = "superseded"


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
    ``notes`` carries the judge's prose explanation (verbatim).
    """

    approved: bool
    score: float = 0.0
    notes: str = ""

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

    @classmethod
    def passed(cls, *, score: float = 1.0, notes: str = "") -> "JudgeVerdict":
        return cls(approved=True, score=score, notes=notes)

    @classmethod
    def failed(cls, *, score: float = 0.0, notes: str = "") -> "JudgeVerdict":
        return cls(approved=False, score=score, notes=notes)

    @classmethod
    def from_dict(cls, data: dict | None) -> "JudgeVerdict | None":
        if not data:
            return None
        return cls(
            approved=bool(data.get("approved", False)),
            score=float(data.get("score", 0.0) or 0.0),
            notes=str(data.get("notes") or ""),
        )

    def to_dict(self) -> dict:
        return {
            "approved": self.approved,
            "score": self.score,
            "notes": self.notes,
        }


__all__ = [
    "ArtifactStatus",
    "ArtifactType",
    "JudgeVerdict",
    "RenderFormat",
    "ValidationResult",
]


# Suppress unused-import warning for ``field``: we re-export the symbol so
# downstream modules can continue to import it from this package.
_ = field
