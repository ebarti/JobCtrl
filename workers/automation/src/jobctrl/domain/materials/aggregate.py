"""MaterialsSet aggregate root.

See ddd-target.md §4.5. ``MaterialsSet`` is the canonical fact about the
generated job-application materials for one (TenantId, JobId) pair.
Identity is the triple ``(tenant_id, job_id, generation: int)`` — each
re-tailoring round bumps ``generation`` so the previous generation's
artifacts can be marked ``superseded`` for audit instead of overwritten.

Lifecycle (per §4.5):

  resume_in_progress → resume_approved → cover_letter_ready → complete

A new generation starts in ``resume_in_progress``. Once the validator +
judge accept the tailored resume the aggregate transitions to
``resume_approved``. Adding a cover letter moves it to
``cover_letter_ready``; rendering both PDFs completes the set.

Invariants enforced here:

  * resume must be present before cover letter (§4.5).
  * text artifacts must be present before their PDF render.
  * artifact-type uniqueness (one tailored_resume per generation, etc.).
  * generation is a strictly positive integer.
  * supersede semantics live on the factory, not on the aggregate.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field, replace
from typing import Any, Mapping

from jobctrl.domain.identifiers import JobId
from jobctrl.domain.materials.entities import Artifact
from jobctrl.domain.materials.value_objects import (
    ArtifactStatus,
    ArtifactType,
    JudgeVerdict,
    ValidationResult,
)
from jobctrl.domain.tenant import TenantId


# ---------------------------------------------------------------------------
# Lifecycle states (closed enumeration)
# ---------------------------------------------------------------------------


class MaterialsLifecycle:
    """Pseudo-enum of the four §4.5 lifecycle states.

    Implemented as bare string constants instead of an Enum so callers
    serialise to/from SQLite without an extra converter and so the
    aggregate's ``status`` field stays ``str``.
    """

    RESUME_IN_PROGRESS = "resume_in_progress"
    RESUME_APPROVED = "resume_approved"
    COVER_LETTER_READY = "cover_letter_ready"
    COMPLETE = "complete"


_VALID_STATUSES: frozenset[str] = frozenset(
    {
        MaterialsLifecycle.RESUME_IN_PROGRESS,
        MaterialsLifecycle.RESUME_APPROVED,
        MaterialsLifecycle.COVER_LETTER_READY,
        MaterialsLifecycle.COMPLETE,
    }
)


# ---------------------------------------------------------------------------
# Aggregate root
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MaterialsSet:
    """Aggregate root — the generation-versioned materials for one job.

    Identity: ``(tenant_id, job_id, generation)``. Re-tailoring creates a
    new aggregate via :class:`MaterialsSetFactory.next_generation`, which
    also rewrites the previous generation's artifacts to status
    ``superseded`` for audit.

    The aggregate is immutable; every helper returns a new instance.
    """

    tenant_id: TenantId
    job_id: JobId
    generation: int
    status: str = MaterialsLifecycle.RESUME_IN_PROGRESS
    created_at: str = ""
    updated_at: str = ""
    tailored_resume: Artifact | None = None
    cover_letter: Artifact | None = None
    resume_pdf: Artifact | None = None
    cover_letter_pdf: Artifact | None = None
    last_validation: ValidationResult | None = None
    last_verdict: JudgeVerdict | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    lineage_id: str = field(
        default_factory=lambda: uuid.uuid4().hex,
        repr=False,
        compare=False,
    )

    # ------------------------------------------------------------------
    # Invariants
    # ------------------------------------------------------------------

    def __post_init__(self) -> None:
        if not isinstance(self.generation, int) or isinstance(self.generation, bool):
            raise TypeError("MaterialsSet.generation must be an int")
        if self.generation < 1:
            raise ValueError(
                f"MaterialsSet.generation must be >= 1, got {self.generation}"
            )
        if self.status not in _VALID_STATUSES:
            raise ValueError(
                f"MaterialsSet.status must be one of {sorted(_VALID_STATUSES)}, "
                f"got {self.status!r}"
            )
        if not isinstance(self.created_at, str):
            raise TypeError("MaterialsSet.created_at must be a str")
        if not isinstance(self.updated_at, str):
            raise TypeError("MaterialsSet.updated_at must be a str")
        if not isinstance(self.metadata, dict):
            raise TypeError("MaterialsSet.metadata must be a dict")
        try:
            lineage_uuid = uuid.UUID(hex=self.lineage_id)
        except (AttributeError, TypeError, ValueError) as exc:
            raise ValueError("MaterialsSet.lineage_id must be a UUID hex string") from exc
        if lineage_uuid.hex != self.lineage_id:
            raise ValueError("MaterialsSet.lineage_id must be canonical lowercase UUID hex")

        # Type sanity per slot.
        for slot, expected in (
            ("tailored_resume", ArtifactType.TAILORED_RESUME),
            ("cover_letter", ArtifactType.COVER_LETTER),
            ("resume_pdf", ArtifactType.RESUME_PDF),
            ("cover_letter_pdf", ArtifactType.COVER_LETTER_PDF),
        ):
            artifact = getattr(self, slot)
            if artifact is None:
                continue
            if not isinstance(artifact, Artifact):
                raise TypeError(
                    f"MaterialsSet.{slot} must be an Artifact, got {type(artifact).__name__}"
                )
            if artifact.type is not expected:
                raise ValueError(
                    f"MaterialsSet.{slot} expects ArtifactType.{expected.name}, "
                    f"got {artifact.type.name}"
                )

        # §4.5: cover requires resume; PDF requires its corresponding text.
        if self.cover_letter is not None and self.tailored_resume is None:
            raise ValueError(
                "MaterialsSet invariant violated: cover letter present without tailored resume"
            )
        if self.resume_pdf is not None and self.tailored_resume is None:
            raise ValueError(
                "MaterialsSet invariant violated: resume PDF present without tailored resume"
            )
        if self.cover_letter_pdf is not None and self.cover_letter is None:
            raise ValueError(
                "MaterialsSet invariant violated: cover-letter PDF present without cover-letter text"
            )

    # ------------------------------------------------------------------
    # Construction helpers
    # ------------------------------------------------------------------

    @classmethod
    def initial(
        cls,
        *,
        tenant_id: TenantId,
        job_id: JobId,
        created_at: str,
    ) -> "MaterialsSet":
        """Create the first generation of a MaterialsSet (generation=1)."""
        return cls(
            tenant_id=tenant_id,
            job_id=job_id,
            generation=1,
            status=MaterialsLifecycle.RESUME_IN_PROGRESS,
            created_at=created_at,
            updated_at=created_at,
        )

    # ------------------------------------------------------------------
    # Slot accessors
    # ------------------------------------------------------------------

    @property
    def artifacts(self) -> tuple[Artifact, ...]:
        """Return the present artifacts in deterministic slot order."""
        out: list[Artifact] = []
        for slot in ("tailored_resume", "cover_letter", "resume_pdf", "cover_letter_pdf"):
            artifact = getattr(self, slot)
            if artifact is not None:
                out.append(artifact)
        return tuple(out)

    def artifact_for(self, artifact_type: ArtifactType) -> Artifact | None:
        slot = _SLOT_FOR_TYPE[artifact_type]
        return getattr(self, slot)

    @property
    def is_resume_approved(self) -> bool:
        artifact = self.tailored_resume
        return artifact is not None and artifact.status is ArtifactStatus.APPROVED

    @property
    def is_complete(self) -> bool:
        return self.status == MaterialsLifecycle.COMPLETE

    # ------------------------------------------------------------------
    # Lifecycle mutators (pure — return a new instance)
    # ------------------------------------------------------------------

    def with_resume_attempt(
        self,
        artifact: Artifact,
        *,
        validation: ValidationResult,
        verdict: JudgeVerdict | None,
        review_required: bool = False,
        updated_at: str,
    ) -> "MaterialsSet":
        """Record a tailor attempt — approved or rejected.

        Status flips to ``RESUME_APPROVED`` only when validator + judge passed
        and no policy review is required. Review-required attempts remain
        inspectable candidate artifacts; failed attempts are rejected for audit.

        Round-2 review L1: when the new attempt is REJECTED on a
        same-generation re-save, downstream artifacts (cover_letter +
        both PDFs) are stale and inconsistent — they were derived from a
        previous resume that is no longer the canonical one. Clear them
        so the aggregate's invariants stay coherent (cover letter exists
        only when the tailored resume is approved; same for PDFs).
        """
        if artifact.type is not ArtifactType.TAILORED_RESUME:
            raise ValueError(
                "with_resume_attempt requires an ArtifactType.TAILORED_RESUME artifact"
            )
        passed = validation.passed and (verdict is None or verdict.approved)
        approved = passed and not review_required
        next_status = (
            MaterialsLifecycle.RESUME_APPROVED
            if approved
            else MaterialsLifecycle.RESUME_IN_PROGRESS
        )
        artifact_status = (
            ArtifactStatus.APPROVED
            if approved
            else ArtifactStatus.CANDIDATE
            if passed and review_required
            else ArtifactStatus.REJECTED
        )
        if approved:
            # Approved attempt — the cover/PDFs (if any from a prior
            # state) stay valid because the new resume is the canonical
            # one for this generation.
            return replace(
                self,
                tailored_resume=artifact.with_status(artifact_status),
                last_validation=validation,
                last_verdict=verdict,
                status=next_status,
                updated_at=updated_at,
            )
        # Rejected attempt — drop downstream artifacts so the aggregate
        # doesn't carry an APPROVED cover/PDF paired with a REJECTED
        # tailored_resume.
        return replace(
            self,
            tailored_resume=artifact.with_status(artifact_status),
            cover_letter=None,
            resume_pdf=None,
            cover_letter_pdf=None,
            last_validation=validation,
            last_verdict=verdict,
            status=next_status,
            updated_at=updated_at,
        )

    def with_cover_letter(
        self,
        artifact: Artifact,
        *,
        validation: ValidationResult,
        updated_at: str,
    ) -> "MaterialsSet":
        if artifact.type is not ArtifactType.COVER_LETTER:
            raise ValueError(
                "with_cover_letter requires an ArtifactType.COVER_LETTER artifact"
            )
        if not self.is_resume_approved:
            raise ValueError(
                "Cannot attach cover letter before tailored resume is approved (§4.5)"
            )
        approved_artifact = (
            artifact.with_status(ArtifactStatus.APPROVED)
            if validation.passed
            else artifact.with_status(ArtifactStatus.REJECTED)
        )
        next_status = (
            MaterialsLifecycle.COVER_LETTER_READY
            if validation.passed
            else self.status
        )
        cover_letter_pdf = self.cover_letter_pdf
        if (
            validation.passed
            and cover_letter_pdf is not None
            and cover_letter_pdf.status is ArtifactStatus.APPROVED
        ):
            cover_letter_pdf = cover_letter_pdf.supersede(at=updated_at)
        return replace(
            self,
            cover_letter=approved_artifact,
            cover_letter_pdf=cover_letter_pdf,
            last_validation=validation,
            status=next_status,
            updated_at=updated_at,
        )

    def with_resume_pdf(self, artifact: Artifact, *, updated_at: str) -> "MaterialsSet":
        if artifact.type is not ArtifactType.RESUME_PDF:
            raise ValueError(
                "with_resume_pdf requires an ArtifactType.RESUME_PDF artifact"
            )
        if self.tailored_resume is None:
            raise ValueError(
                "Cannot attach resume PDF before tailored resume is present (§4.5)"
            )
        approved = artifact.with_status(ArtifactStatus.APPROVED)
        next_status = self.status
        if (
            self.cover_letter_pdf is not None
            and self.cover_letter is not None
            and self.cover_letter.status is ArtifactStatus.APPROVED
        ):
            next_status = MaterialsLifecycle.COMPLETE
        return replace(
            self,
            resume_pdf=approved,
            status=next_status,
            updated_at=updated_at,
        )

    def with_cover_letter_pdf(
        self, artifact: Artifact, *, updated_at: str
    ) -> "MaterialsSet":
        if artifact.type is not ArtifactType.COVER_LETTER_PDF:
            raise ValueError(
                "with_cover_letter_pdf requires an ArtifactType.COVER_LETTER_PDF artifact"
            )
        if self.cover_letter is None:
            raise ValueError(
                "Cannot attach cover-letter PDF before cover-letter text is present (§4.5)"
            )
        approved = artifact.with_status(ArtifactStatus.APPROVED)
        next_status = self.status
        if (
            self.resume_pdf is not None
            and self.resume_pdf.status is ArtifactStatus.APPROVED
            and self.cover_letter is not None
            and self.cover_letter.status is ArtifactStatus.APPROVED
        ):
            next_status = MaterialsLifecycle.COMPLETE
        return replace(
            self,
            cover_letter_pdf=approved,
            status=next_status,
            updated_at=updated_at,
        )

    def supersede_all(self, *, at: str) -> "MaterialsSet":
        """Mark every present artifact as superseded.

        Used by :meth:`MaterialsSetFactory.next_generation` when minting a
        fresh generation: the prior generation is rewritten so its
        artifacts can be retained for audit but are no longer downstream-
        consumable. Status itself does not move past COMPLETE — supersede
        only touches the artifact lifecycle.
        """
        return replace(
            self,
            tailored_resume=(
                self.tailored_resume.supersede(at=at)
                if self.tailored_resume is not None
                else None
            ),
            cover_letter=(
                self.cover_letter.supersede(at=at)
                if self.cover_letter is not None
                else None
            ),
            resume_pdf=(
                self.resume_pdf.supersede(at=at) if self.resume_pdf is not None else None
            ),
            cover_letter_pdf=(
                self.cover_letter_pdf.supersede(at=at)
                if self.cover_letter_pdf is not None
                else None
            ),
            updated_at=at,
        )

    def suppress_active_artifacts(self, *, at: str, reason: str) -> "MaterialsSet":
        """Soft-hide approved artifacts while retaining their audit rows."""

        def _suppress(artifact: Artifact | None) -> Artifact | None:
            if artifact is None or artifact.status is not ArtifactStatus.APPROVED:
                return artifact
            return artifact.suppress(at=at, reason=reason)

        return replace(
            self,
            tailored_resume=_suppress(self.tailored_resume),
            cover_letter=_suppress(self.cover_letter),
            resume_pdf=_suppress(self.resume_pdf),
            cover_letter_pdf=_suppress(self.cover_letter_pdf),
            metadata={
                **dict(self.metadata),
                "suppression": {
                    "reason": " ".join(str(reason or "").split()) or "policy_suppressed",
                    "suppressed_at": at,
                },
            },
            updated_at=at,
        )

    def with_metadata(self, metadata: Mapping[str, Any], *, updated_at: str | None = None) -> "MaterialsSet":
        return replace(
            self,
            metadata=dict(metadata),
            updated_at=updated_at if updated_at is not None else self.updated_at,
        )

    # ------------------------------------------------------------------
    # Serialization (used by the SQLite repository adapter)
    # ------------------------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        return {
            "tenant_id": str(self.tenant_id),
            "job_id": str(self.job_id),
            "generation": self.generation,
            "status": self.status,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "tailored_resume": (
                self.tailored_resume.to_dict() if self.tailored_resume else None
            ),
            "cover_letter": (
                self.cover_letter.to_dict() if self.cover_letter else None
            ),
            "resume_pdf": self.resume_pdf.to_dict() if self.resume_pdf else None,
            "cover_letter_pdf": (
                self.cover_letter_pdf.to_dict() if self.cover_letter_pdf else None
            ),
            "last_validation": (
                self.last_validation.to_dict() if self.last_validation else None
            ),
            "last_verdict": (
                self.last_verdict.to_dict() if self.last_verdict else None
            ),
            "metadata": dict(self.metadata),
        }


_SLOT_FOR_TYPE: dict[ArtifactType, str] = {
    ArtifactType.TAILORED_RESUME: "tailored_resume",
    ArtifactType.COVER_LETTER: "cover_letter",
    ArtifactType.RESUME_PDF: "resume_pdf",
    ArtifactType.COVER_LETTER_PDF: "cover_letter_pdf",
}


# ---------------------------------------------------------------------------
# Factory — owns the generation-bumping rules
# ---------------------------------------------------------------------------


class MaterialsSetFactory:
    """Constructs new generations of :class:`MaterialsSet` aggregates.

    The factory is the only sanctioned producer of a *non-initial*
    generation: it consults the repository for the current highest
    generation, supersedes its artifacts, and returns a fresh aggregate
    at ``generation + 1``.
    """

    @staticmethod
    def initial(
        *,
        tenant_id: TenantId,
        job_id: JobId,
        created_at: str,
    ) -> MaterialsSet:
        return MaterialsSet.initial(
            tenant_id=tenant_id,
            job_id=job_id,
            created_at=created_at,
        )

    @staticmethod
    def next_generation(
        previous: MaterialsSet,
        *,
        created_at: str,
    ) -> tuple[MaterialsSet, MaterialsSet]:
        """Return ``(superseded_previous, fresh_next)``.

        The caller is responsible for persisting both — the previous
        aggregate so its artifacts carry ``superseded_at``, and the new
        aggregate so the queue selectors pick it up.
        """
        if not isinstance(previous, MaterialsSet):
            raise TypeError(
                "next_generation requires a MaterialsSet as the previous aggregate"
            )
        superseded = previous.supersede_all(at=created_at)
        fresh = MaterialsSet(
            tenant_id=previous.tenant_id,
            job_id=previous.job_id,
            generation=previous.generation + 1,
            status=MaterialsLifecycle.RESUME_IN_PROGRESS,
            created_at=created_at,
            updated_at=created_at,
        )
        return superseded, fresh


__all__ = [
    "MaterialsLifecycle",
    "MaterialsSet",
    "MaterialsSetFactory",
]


# Suppress unused-import warning for ``Mapping``/``field``: these are
# referenced via dataclass machinery / typing annotations.
_ = Mapping
