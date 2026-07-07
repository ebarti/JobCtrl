"""Canonical employer-analysis domain model (Phase 1).

The persisted, inspectable "ideal candidate" understanding of a job posting
that replaces the flakey ``_extract_job_keywords`` heuristic and becomes the
single source of truth driving downstream tailoring.

This module is **pure data** (Pydantic + frozen dataclasses, no I/O). The
ensemble orchestration, SDK adapters, persistence, and event publishing live
in the ports / infrastructure / application layers. The grounding validator
(literal-substring evidence check, the cardinal gate) lives in the sibling
``analysis_grounding.py``.

Locked decisions realised here:

  * **D-14** — every :class:`Requirement` carries an explicit ``tier``
    (``must_have`` / ``nice_to_have``) AND a ``weight`` in ``[0, 1]``.
  * **D-15** — evidence is a quoted JD span (``evidence_span``); char offsets
    are derived at render time, never stored.
  * **D-16** — rich ideal-candidate depth: ``role_framing`` +
    ``inferred_seniority`` + ``ideal_candidate_narrative``.
  * **D-17** — each :class:`ReasonedKeyword` links to the requirement it
    supports (``requirement_ref``); orphans are allowed but flagged.
  * **D-08** — the persisted :class:`EmployerAnalysis` retains the canonical
    synthesized record PLUS every per-model sub-analysis, the per-leg
    failures, and the cross-model agreement signal.
  * **D-11/D-12** — the analysis is keyed by a snapshot hash + prompt/SDK-set
    version cache key so the stochastic ensemble is reproducible by reuse.
  * **D-13** — generation-versioned; a forced/failed re-analyze supersedes but
    never destroys the last accepted analysis.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from jobctl.domain.identifiers import JobId
from jobctl.domain.materials.analysis_eeo_screen import EeoScreenHit
from jobctl.domain.tenant import LOCAL_TENANT, TenantId

# Bump whenever the analysis system prompt changes so stale cached analyses are
# recomputed rather than silently served (D-12). The cache key combines this
# with the JD snapshot hash and the SDK-set version.
PROMPT_VERSION = "employer-analysis-v1"

# Identifies the default ensemble model/SDK set. Bump when the default leg set
# or model ids change so the cache invalidates (D-12). The local composition
# root overrides this with ``JOBCTL_ANALYSIS_LEGS`` when a user intentionally
# disables a leg, so cache keys also reflect degraded-mode setup choices.
SDK_SET_VERSION = "claude+codex+antigravity-v1"

RequirementTier = Literal["must_have", "nice_to_have"]


# ---------------------------------------------------------------------------
# Structured analysis content (the schema every SDK leg + synthesizer emits)
# ---------------------------------------------------------------------------


class ReasonedKeyword(BaseModel):
    """A genuine screened-on skill/tool/qualification tied to JD evidence.

    ``evidence_span`` MUST be a literal substring of the persisted JD snapshot
    (D-15); the deterministic grounding validator enforces this — the schema
    cannot. ``requirement_ref`` links the keyword to the requirement it
    supports (D-17); a keyword with no resolvable parent is flagged
    ``is_orphan`` (allowed, but surfaced as audit data).
    """

    model_config = ConfigDict(extra="ignore")

    keyword: str
    evidence_span: str = Field(
        ...,
        description="LITERAL substring of the JD snapshot the keyword is drawn from (D-15).",
    )
    requirement_ref: str | None = Field(
        default=None,
        description="id of the parent Requirement this keyword supports; None = orphan (D-17).",
    )
    rationale: str = ""
    is_orphan: bool = False


class Requirement(BaseModel):
    """One employer requirement, classified and weighted (D-14)."""

    model_config = ConfigDict(extra="ignore")

    id: str
    text: str
    tier: RequirementTier = Field(
        ...,
        description="must_have = a genuine deal-breaker; nice_to_have = preferred/bonus (D-14).",
    )
    weight: float = Field(
        ...,
        ge=0.0,
        le=1.0,
        description="0-1 priority weight ranking importance within the analysis (D-14).",
    )
    evidence_span: str = Field(
        ...,
        description="LITERAL substring of the JD snapshot supporting this requirement (D-15).",
    )


class JobAnalysis(BaseModel):
    """The structured "ideal candidate" reading of one job posting (D-16).

    This is the shape each SDK leg emits via its native structured-output mode
    and the shape the synthesizer reconciles into the canonical record. The
    grounding invariant (every ``evidence_span`` is a literal JD substring) is
    NOT expressible in JSON Schema — it is enforced separately by
    ``analysis_grounding.validate_evidence_spans``.
    """

    model_config = ConfigDict(extra="ignore")

    role_framing: str = Field(
        ...,
        description="How the role is framed — what the team is hiring this person to do.",
    )
    inferred_seniority: str = Field(
        ...,
        description="Inferred level read from scope/ownership/leadership signals, not one token.",
    )
    ideal_candidate_narrative: str = Field(
        ...,
        description="'What they're really looking for' — the role's center of gravity (D-16).",
    )
    requirements: list[Requirement] = Field(default_factory=list)
    keywords: list[ReasonedKeyword] = Field(default_factory=list)

    @model_validator(mode="after")
    def _flag_orphans(self) -> JobAnalysis:
        """Flag keywords whose ``requirement_ref`` does not resolve (D-17)."""
        valid_ids = {req.id for req in self.requirements}
        for keyword in self.keywords:
            keyword.is_orphan = (
                keyword.requirement_ref is None or keyword.requirement_ref not in valid_ids
            )
        return self

    @property
    def must_have_requirements(self) -> list[Requirement]:
        return [req for req in self.requirements if req.tier == "must_have"]

    @property
    def nice_to_have_requirements(self) -> list[Requirement]:
        return [req for req in self.requirements if req.tier == "nice_to_have"]


class JobAnalysisDraft(JobAnalysis):
    """A single SDK leg's draft, tagged with the model that produced it."""

    model_id: str = Field(..., description="The SDK/model id that produced this draft.")


# ---------------------------------------------------------------------------
# Ensemble audit signal (per-model contributions + failures + agreement)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AnalysisFailure:
    """A leg that errored / timed out / returned malformed output (D-08).

    Persisted as degraded-ensemble audit data — a failed leg is NEVER silently
    dropped (failure mode #2). ``raw_output`` is the model's last raw response
    when available (for the schema/grounding rejection case).
    """

    model_id: str
    error: str
    raw_output: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "model_id": self.model_id,
            "error": self.error,
            "raw_output": self.raw_output,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> AnalysisFailure:
        return cls(
            model_id=str(data.get("model_id") or ""),
            error=str(data.get("error") or ""),
            raw_output=(str(data["raw_output"]) if data.get("raw_output") is not None else None),
        )


@dataclass(frozen=True)
class AnalysisAgreement:
    """Cross-model agreement signal over the surviving drafts (D-06/D-08).

    ``score`` is the whole-analysis agreement in ``[0, 1]``. The flagged lists
    capture requirement/keyword items where the legs diverged — divergence is
    first-class audit data, surfaced for review, never silently resolved.
    """

    score: float = 0.0
    flagged_requirements: tuple[str, ...] = ()
    flagged_keywords: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "score": self.score,
            "flagged_requirements": list(self.flagged_requirements),
            "flagged_keywords": list(self.flagged_keywords),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> AnalysisAgreement:
        data = data or {}
        return cls(
            score=float(data.get("score") or 0.0),
            flagged_requirements=tuple(str(item) for item in (data.get("flagged_requirements") or ())),
            flagged_keywords=tuple(str(item) for item in (data.get("flagged_keywords") or ())),
        )


# ---------------------------------------------------------------------------
# EmployerAnalysis aggregate (the canonical persisted record)
# ---------------------------------------------------------------------------


def compute_snapshot_hash(jd_snapshot: str) -> str:
    """Return the stable SHA-256 of the JD snapshot the analysis reasoned from.

    The cache (D-11/D-12) keys on this hash + ``PROMPT_VERSION`` +
    ``SDK_SET_VERSION``. Reproducibility is delivered by reuse, not by trying to
    make a stochastic agent loop byte-identical.
    """
    return hashlib.sha256(jd_snapshot.encode("utf-8")).hexdigest()


def cache_key(snapshot_hash: str, *, prompt_version: str = PROMPT_VERSION, sdk_set_version: str = SDK_SET_VERSION) -> str:
    """Return the canonical cache key string for an analysis."""
    return f"{snapshot_hash}:{prompt_version}:{sdk_set_version}"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class EmployerAnalysis:
    """The canonical persisted employer analysis for one ``(tenant, job)``.

    Generation-versioned like :class:`MaterialsSet` (D-13): a forced/failed
    re-analyze supersedes but never destroys the last accepted analysis. The
    record carries the reconciled canonical :class:`JobAnalysis` plus the full
    ensemble audit trail (every per-model draft, the per-leg failures, the
    agreement signal, and any EEO red-flag screen hits) so the inspector can
    later prove every displayed claim.

    ``eeo_screen_hits`` records each requirement/keyword the deterministic EEO
    red-flag screen dropped before persistence (AI-SPEC §6 Dimension 9). It is
    persisted as canonical audit data (the ``eeo_screen_json`` column) and
    round-trips on load; surfacing it in the projection read model + the TS
    inspector lands with the Phase 5 inspector UI, so ``to_read_model()`` does
    NOT yet emit it (keeping the cross-runtime projection parity intact).
    """

    tenant_id: TenantId
    job_id: JobId
    generation: int
    snapshot_hash: str
    prompt_version: str
    sdk_set_version: str
    canonical: JobAnalysis
    sub_analyses: tuple[JobAnalysisDraft, ...]
    failures: tuple[AnalysisFailure, ...]
    agreement: AnalysisAgreement
    legs_attempted: int
    # EEO red-flag screen audit notes (AI-SPEC §6 Dimension 9). Each entry is one
    # requirement/keyword dropped because it matched a protected-attribute signal;
    # empty is the clean case. Persisted as canonical audit data (never a blob).
    eeo_screen_hits: tuple[EeoScreenHit, ...] = ()
    created_at: str = field(default_factory=_utc_now)

    def __post_init__(self) -> None:
        if self.generation < 1:
            raise ValueError(f"EmployerAnalysis.generation must be >= 1, got {self.generation}")
        if self.legs_attempted < 1:
            raise ValueError("EmployerAnalysis.legs_attempted must be >= 1")
        if not isinstance(self.canonical, JobAnalysis):
            raise TypeError("EmployerAnalysis.canonical must be a JobAnalysis")

    @property
    def cache_key(self) -> str:
        return cache_key(
            self.snapshot_hash,
            prompt_version=self.prompt_version,
            sdk_set_version=self.sdk_set_version,
        )

    @property
    def legs_succeeded(self) -> int:
        return len(self.sub_analyses)

    @property
    def ensemble_completeness(self) -> str:
        """The 'legs succeeded / legs attempted' degraded-ensemble signal (D-08)."""
        return f"{self.legs_succeeded}/{self.legs_attempted}"

    @property
    def is_degraded(self) -> bool:
        """True when fewer legs succeeded than were attempted (failure mode #2)."""
        return self.legs_succeeded < self.legs_attempted

    @classmethod
    def build(
        cls,
        *,
        tenant_id: TenantId,
        job_id: JobId,
        generation: int,
        snapshot_hash: str,
        canonical: JobAnalysis,
        sub_analyses: tuple[JobAnalysisDraft, ...],
        failures: tuple[AnalysisFailure, ...],
        agreement: AnalysisAgreement,
        legs_attempted: int,
        eeo_screen_hits: tuple[EeoScreenHit, ...] = (),
        prompt_version: str = PROMPT_VERSION,
        sdk_set_version: str = SDK_SET_VERSION,
        created_at: str | None = None,
    ) -> EmployerAnalysis:
        return cls(
            tenant_id=tenant_id,
            job_id=job_id,
            generation=generation,
            snapshot_hash=snapshot_hash,
            prompt_version=prompt_version,
            sdk_set_version=sdk_set_version,
            canonical=canonical,
            sub_analyses=sub_analyses,
            failures=failures,
            agreement=agreement,
            legs_attempted=legs_attempted,
            eeo_screen_hits=eeo_screen_hits,
            created_at=created_at or _utc_now(),
        )

    def to_read_model(self) -> dict[str, Any]:
        """Serialise the inspectable read shape (the projection/DTO source).

        This is the single owner of the analysis read shape — the Python
        projection builder and (mirrored) the TS projection builder both
        materialise this exact dict so the read model is parity-checked.
        """
        return {
            "generation": self.generation,
            "snapshot_hash": self.snapshot_hash,
            "prompt_version": self.prompt_version,
            "sdk_set_version": self.sdk_set_version,
            "cache_key": self.cache_key,
            "created_at": self.created_at,
            "ensemble_completeness": self.ensemble_completeness,
            "legs_attempted": self.legs_attempted,
            "legs_succeeded": self.legs_succeeded,
            "is_degraded": self.is_degraded,
            "agreement": self.agreement.to_dict(),
            "role_framing": self.canonical.role_framing,
            "inferred_seniority": self.canonical.inferred_seniority,
            "ideal_candidate_narrative": self.canonical.ideal_candidate_narrative,
            "requirements": [req.model_dump() for req in self.canonical.requirements],
            "keywords": [kw.model_dump() for kw in self.canonical.keywords],
            "sub_analyses": [
                {"model_id": draft.model_id, **draft.model_dump(exclude={"model_id"})}
                for draft in self.sub_analyses
            ],
            "failures": [failure.to_dict() for failure in self.failures],
        }


@dataclass(frozen=True)
class EnsembleOutcome:
    """The result of running the ensemble (pre-persistence).

    Carries the reconciled canonical analysis, the surviving per-model drafts,
    the per-leg failures, the agreement signal, and how many legs were
    attempted (so ``ensemble_completeness`` can be recorded — D-08).
    """

    canonical: JobAnalysis
    drafts: tuple[JobAnalysisDraft, ...]
    failures: tuple[AnalysisFailure, ...]
    agreement: AnalysisAgreement
    legs_attempted: int


class EnsembleError(RuntimeError):
    """Raised when ALL ensemble legs fail — the only hard-fail (failure mode #2).

    A degraded ensemble (some legs failed) is published, clearly marked
    degraded; only zero surviving drafts is a hard error surfaced to the user.
    """

    def __init__(self, message: str, failures: tuple[AnalysisFailure, ...]) -> None:
        super().__init__(message)
        self.failures = failures


__all__ = [
    "PROMPT_VERSION",
    "SDK_SET_VERSION",
    "RequirementTier",
    "ReasonedKeyword",
    "Requirement",
    "JobAnalysis",
    "JobAnalysisDraft",
    "AnalysisFailure",
    "AnalysisAgreement",
    "EeoScreenHit",
    "EmployerAnalysis",
    "EnsembleOutcome",
    "EnsembleError",
    "compute_snapshot_hash",
    "cache_key",
]


# Re-export to silence unused-import warnings for symbols kept for callers.
_ = (LOCAL_TENANT,)
