"""Canonical per-bullet provenance domain model (Phase 2).

Every generated resume bullet (and executive-profile / skills line) carries one
:class:`BulletProvenance` record: the canonical profile evidence it derives from
(``evidence_ids``), the job requirement it serves (``requirement_ids``, FK into
the persisted :class:`EmployerAnalysis` requirements), the transform that produced
it (``transform_type``, a closed taxonomy — GROUND-04), the granular policy rule
that governed the decision (``control`` — CONTROL-01/02), a human-readable
rationale, and the actual rendered bullet text (``generated_text``) — the anchor
against which coverage and fabrication are computed (never inferred from the job
description — the auditability rule).

This module is **pure data** (frozen dataclasses, no I/O). The computation that
turns a selected tailored payload + the persisted analysis into these rows lives
in ``provenance_builder.py``; the deterministic never-fabricate gate lives in
``fabrication_detector.py``; persistence lives in the infrastructure layer.

Locked decisions realised here:

  * **GROUND-05 / canonical-rows** — provenance is foreign-key bindings, not
    model-authored free text. ``evidence_ids`` and ``requirement_ids`` are
    validated against the real profile + analysis at build time; a fabricated id
    is rejected before a row is ever constructed.
  * **GROUND-04** — ``transform_type`` is a member of the closed
    :class:`TransformType` enum.
  * **CONTROL-02** — ``control`` records the governing :class:`ControlRule`.
  * **Anti-Pattern 4 / success criterion 5** — provenance is generation-versioned
    via :class:`BulletProvenanceSet` and superseded with its artifact; a failed
    re-tailor writes a fresh generation and never destroys the prior one.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from jobhunter.domain.identifiers import JobId
from jobhunter.domain.materials.value_objects import ControlRule, TransformType
from jobhunter.domain.tenant import TenantId


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class BulletProvenance:
    """One canonical provenance record for a single generated resume line.

    ``bullet_id`` is stable within ``(job, generation, section, index)`` so the
    same line keeps its identity across re-saves of a generation while a new
    generation mints fresh ids. Invariants are enforced up front so an instance
    carries its validity (mirrors :class:`Artifact`).
    """

    bullet_id: str
    section: str
    source_id: str | None
    evidence_ids: tuple[str, ...]
    requirement_ids: tuple[str, ...]
    matched_keywords: tuple[str, ...]
    transform_type: TransformType
    control: ControlRule
    rationale: str
    generated_text: str

    def __post_init__(self) -> None:
        if not isinstance(self.bullet_id, str) or not self.bullet_id.strip():
            raise ValueError("BulletProvenance.bullet_id must be a non-empty string")
        if not isinstance(self.section, str) or not self.section.strip():
            raise ValueError("BulletProvenance.section must be a non-empty string")
        if not isinstance(self.transform_type, TransformType):
            raise TypeError(
                "BulletProvenance.transform_type must be a TransformType, "
                f"got {type(self.transform_type).__name__}"
            )
        if not isinstance(self.control, ControlRule):
            raise TypeError(
                f"BulletProvenance.control must be a ControlRule, got {type(self.control).__name__}"
            )
        for label, value in (
            ("evidence_ids", self.evidence_ids),
            ("requirement_ids", self.requirement_ids),
            ("matched_keywords", self.matched_keywords),
        ):
            if not isinstance(value, tuple):
                raise TypeError(f"BulletProvenance.{label} must be a tuple")
            for item in value:
                if not isinstance(item, str):
                    raise TypeError(f"BulletProvenance.{label} entries must be str")
        if not isinstance(self.generated_text, str) or not self.generated_text.strip():
            raise ValueError("BulletProvenance.generated_text must be non-empty (the coverage anchor)")

    def to_dict(self) -> dict[str, Any]:
        return {
            "bullet_id": self.bullet_id,
            "section": self.section,
            "source_id": self.source_id,
            "evidence_ids": list(self.evidence_ids),
            "requirement_ids": list(self.requirement_ids),
            "matched_keywords": list(self.matched_keywords),
            "transform_type": self.transform_type.value,
            "control": self.control.value,
            "rationale": self.rationale,
            "generated_text": self.generated_text,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> BulletProvenance:
        return cls(
            bullet_id=str(data["bullet_id"]),
            section=str(data["section"]),
            source_id=(str(data["source_id"]) if data.get("source_id") is not None else None),
            evidence_ids=tuple(str(item) for item in (data.get("evidence_ids") or ())),
            requirement_ids=tuple(str(item) for item in (data.get("requirement_ids") or ())),
            matched_keywords=tuple(str(item) for item in (data.get("matched_keywords") or ())),
            transform_type=TransformType(str(data["transform_type"])),
            control=ControlRule(str(data["control"])),
            rationale=str(data.get("rationale") or ""),
            generated_text=str(data["generated_text"]),
        )


@dataclass(frozen=True)
class BulletProvenanceSet:
    """All provenance rows for one ``(tenant, job, generation)`` tailoring run.

    Generation-versioned exactly like :class:`MaterialsSet` /
    :class:`EmployerAnalysis` (Anti-Pattern 4 / success criterion 5): a forced or
    failed re-tailor writes a higher generation and the prior generation's rows
    are retained as audit history — never deleted. The set is bound to the
    artifact it explains via ``artifact_id`` so the read model can join an
    artifact to its exact provenance.
    """

    tenant_id: TenantId
    job_id: JobId
    generation: int
    artifact_id: str
    bullets: tuple[BulletProvenance, ...]
    created_at: str = field(default_factory=_utc_now)

    def __post_init__(self) -> None:
        if self.generation < 1:
            raise ValueError(f"BulletProvenanceSet.generation must be >= 1, got {self.generation}")
        if not isinstance(self.artifact_id, str) or not self.artifact_id.strip():
            raise ValueError("BulletProvenanceSet.artifact_id must be a non-empty string")
        if not isinstance(self.bullets, tuple):
            raise TypeError("BulletProvenanceSet.bullets must be a tuple")
        for bullet in self.bullets:
            if not isinstance(bullet, BulletProvenance):
                raise TypeError("BulletProvenanceSet.bullets entries must be BulletProvenance")

    @property
    def is_empty(self) -> bool:
        return not self.bullets

    def to_read_model(self) -> list[dict[str, Any]]:
        """Serialise the inspectable read shape (the projection/DTO source).

        The single owner of the provenance read shape: the Python projection
        builder and (mirrored) the TS projection builder both materialise this
        exact list so the read model is parity-checked. Ordered as produced so the
        inspector renders bullets section-by-section in document order.
        """
        return [bullet.to_dict() for bullet in self.bullets]


__all__ = [
    "BulletProvenance",
    "BulletProvenanceSet",
]
