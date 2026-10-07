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
                         were produced (historical PDF, HTML→PDF, plain text).
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


class RenderFormat(str, Enum):
    """How an artifact's bytes were produced.

    ``LATEX_PDF`` — historical resume PDF rows produced by the retired renderer.
    ``HTML_PDF``  — Playwright headless Chromium prints HTML to PDF.
    ``TEXT``      — plain UTF-8 text, no rendering pass.
    """

    LATEX_PDF = "latex_pdf"
    HTML_PDF = "html_pdf"
    TEXT = "text"


class TransformType(str, Enum):
    """The closed taxonomy of how a tailored bullet relates to its source (GROUND-04).

    Every :class:`~jobctrl.domain.materials.provenance.BulletProvenance` row
    records exactly one of these. The taxonomy is the user-facing contract — the
    inspector shows it per bullet — so it is a closed enumeration the read model,
    projection, and detector all read as the source of truth.

    ``VERBATIM``               — the line is the profile fact unchanged (preserved).
    ``REPHRASE``               — same fact, reworded for the target (always allowed).
    ``REFRAME``                — same fact, re-angled to emphasise a job requirement.
    ``SYNTHESIZE_FROM_RELATED`` — drafted from closely-related profile evidence
                                  (permitted only under the invent-closely-related
                                  control; never invents facts wholesale).
    ``QUANTIFY_FROM_EVIDENCE`` — surfaces a metric that is already recorded in
                                  profile evidence (NEVER an invented number — the
                                  deterministic detector enforces this).
    ``VOICE``                  — the explicit voice pass (VOICE-01/02) rewrote this
                                  line to de-buzzword it / vary its structure AFTER
                                  the selected candidate was chosen and BEFORE the
                                  final audit. It is the OUTERMOST transform: it
                                  records that the shipped wording is the voiced
                                  wording, not a hidden prompt tweak. Provenance +
                                  the never-fabricate detector are re-run against the
                                  voiced text (VOICE-03), so a voiced line is held to
                                  the same grounding floor as any other transform.
    """

    VERBATIM = "verbatim"
    REPHRASE = "rephrase"
    REFRAME = "reframe"
    SYNTHESIZE_FROM_RELATED = "synthesize_from_related"
    QUANTIFY_FROM_EVIDENCE = "quantify_from_evidence"
    VOICE = "voice"
    UNRECORDED = "unrecorded"


class ControlRule(str, Enum):
    """The granular tailoring rule that GOVERNED one bullet decision (CONTROL-01/02).

    Recorded per bullet so the user can see what policy produced each line. The
    rules encode the never-fabricate trust floor:

    ``REPHRASE_ALLOWED``        — rewording a real profile fact is always permitted.
    ``INVENT_CLOSELY_RELATED``  — drafting from closely-related experience is
                                  permitted (governs ``SYNTHESIZE_FROM_RELATED``);
                                  only reachable when the active policy allows
                                  adjacent achievement drafts.
    ``NEVER_FABRICATE_METRICS`` — metrics must trace to recorded evidence
                                  (governs ``QUANTIFY_FROM_EVIDENCE``).
    ``NEVER_FABRICATE_TITLES``  — titles/seniority must trace to the profile.
    ``NEVER_FABRICATE_DATES``   — dates/durations must trace to the profile.
    ``NEVER_FABRICATE_EMPLOYERS`` — employers/companies must trace to the profile.
    ``NEVER_FABRICATE_SKILLS``  — a job-target skill/tool woven into an experience
                                  bullet or the executive summary must trace to a
                                  profile-backed skill/tool or the evidence corpus;
                                  claiming a tool the candidate cannot discuss is
                                  interview-fatal.

    The ``NEVER_FABRICATE_*`` rules are the ones the deterministic
    ``fabrication_detector`` enforces independently of the prompt (CONTROL-03).
    """

    REPHRASE_ALLOWED = "rephrase_allowed"
    CLAIM_VERIFICATION = "claim_verification"
    INVENT_CLOSELY_RELATED = "invent_closely_related"
    NEVER_FABRICATE_METRICS = "never_fabricate_metrics"
    NEVER_FABRICATE_TITLES = "never_fabricate_titles"
    NEVER_FABRICATE_DATES = "never_fabricate_dates"
    NEVER_FABRICATE_EMPLOYERS = "never_fabricate_employers"
    NEVER_FABRICATE_SKILLS = "never_fabricate_skills"


# ---------------------------------------------------------------------------
# ValidationResult
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# JudgeVerdict
# ---------------------------------------------------------------------------


_MODEL_SPEC_RE = re.compile(r"^[A-Za-z0-9._/-]+$")
_MODEL_SPEC_SENTINELS = {"", "default"}
_PROVIDER_PREFIXES = {"claude", "codex", "gemini", "google"}


@dataclass(frozen=True)
class LlmModelSpec:
    """Safe model selector for tailoring LLM calls.

    A spec is either a bare model name, which uses the currently configured
    provider, or ``provider:model`` where provider is one of
    ``claude``, ``codex``, ``gemini``, or ``google``.
    It deliberately carries no URL,
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
                raise ValueError("LlmModelSpec.model must be a model id, not a URL, secret, or provider config")
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
    "ArtifactType",
    "ControlRule",
    "LlmModelSpec",
    "RenderFormat",
    "TransformType",
]


# Suppress unused-import warning for ``field``: we re-export the symbol so
# downstream modules can continue to import it from this package.
_ = field
