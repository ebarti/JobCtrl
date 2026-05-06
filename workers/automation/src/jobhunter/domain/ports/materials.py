"""Driven ports for the Materials Generation context.

See ddd-target.md §5.5. Two ports here:

  ``MaterialsRepository`` — persistence for the :class:`MaterialsSet`
                             aggregate root (one aggregate per ``(tenant,
                             job, generation)`` triple).
  ``PdfRendererPort``      — render text artifacts to PDF; the LaTeX
                             adapter wraps ``pdflatex``, the HTML adapter
                             wraps Playwright headless Chromium.

Both protocols are tenant-scoped: local adapters accept ``tenant_id`` and
ignore it (single-tenant); hosted adapters use it for row isolation.
"""

from __future__ import annotations

from typing import Protocol

from jobhunter.domain.identifiers import JobId
from jobhunter.domain.materials.aggregate import MaterialsSet
from jobhunter.domain.materials.entities import Artifact
from jobhunter.domain.materials.value_objects import (
    ArtifactStatus,
    ArtifactType,
    RenderFormat,
)
from jobhunter.domain.tenant import TenantId


# ---------------------------------------------------------------------------
# MaterialsRepository
# ---------------------------------------------------------------------------


class MaterialsRepository(Protocol):
    """Persistence port for the :class:`MaterialsSet` aggregate.

    Versioning contract:

      * :meth:`save` enforces that ``materials.generation`` is exactly one
        greater than the latest persisted generation for ``(tenant_id,
        job_id)`` — or ``1`` when none exists. The same generation may be
        saved multiple times (idempotent overwrite within the generation;
        artifact additions during the same generation use this path).
      * :meth:`load` returns the LATEST generation by default. Pass
        ``generation=`` to read a specific historical row.

    The selectors (``list_pending_*``) return job URLs, not full
    aggregates, so the queue runner can decide whether to load each one.
    """

    def load(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        *,
        generation: int | None = None,
    ) -> MaterialsSet | None:
        """Return the requested ``MaterialsSet`` or ``None``.

        ``generation=None`` (the default) returns the latest generation.
        """
        ...

    def save(self, materials: MaterialsSet) -> None:
        """Persist a new generation or update artifacts within an existing one.

        The repository is responsible for:

          * Allocating ``generation`` monotonically per ``(tenant_id,
            job_id)`` — re-saving the *same* generation overwrites the
            row (used when adding artifacts mid-flow).
          * Persisting every artifact slot atomically with the parent
            row. SQLite uses a transaction; the cloud adapter will use
            an outbox.
        """
        ...

    def list_pending_tailor(
        self,
        tenant_id: TenantId,
        *,
        min_score: int = 7,
        limit: int = 0,
        retailor: bool = False,
    ) -> list[JobId]:
        """Return job URLs eligible for tailoring.

        Eligibility: full description present, ``fit_score >= min_score``,
        and either no MaterialsSet exists yet OR ``retailor=True`` (the
        latter unlocks re-tailoring of jobs that already have an approved
        resume — the use case will mint a new generation).
        """
        ...

    def list_pending_cover(
        self,
        tenant_id: TenantId,
        *,
        min_score: int = 7,
        limit: int = 0,
    ) -> list[JobId]:
        """Return job URLs that have an approved tailored resume but no
        approved cover letter in the latest generation."""
        ...

    def list_pending_pdf(
        self,
        tenant_id: TenantId,
        *,
        limit: int = 0,
    ) -> list[JobId]:
        """Return job URLs whose latest generation has text artifacts but
        is missing one or more PDFs."""
        ...

    def list_by_status(
        self,
        tenant_id: TenantId,
        status: ArtifactStatus,
        *,
        limit: int = 0,
    ) -> list[MaterialsSet]:
        """Return latest-generation MaterialsSets whose tailored resume
        carries the requested artifact status."""
        ...


# ---------------------------------------------------------------------------
# PdfRendererPort
# ---------------------------------------------------------------------------


class PdfRendererPort(Protocol):
    """Render text artifacts to PDF.

    Two distinct rendering paths today:

      * ``LatexPdfAdapter`` consumes a structured tailored-resume payload
        plus a profile snapshot, builds a moderncv LaTeX document, and
        compiles it with ``pdflatex``. Used for resumes only — the LaTeX
        template carries the visual identity.
      * ``PlaywrightHtmlPdfAdapter`` wraps a plain-text cover letter into
        a minimal HTML document and prints it to PDF via headless
        Chromium. Used for cover letters only.

    Both methods return a fully populated :class:`Artifact` value object
    (status ``CANDIDATE``) — the use case is responsible for promoting
    it to ``APPROVED`` via :meth:`MaterialsSet.with_resume_pdf` or
    :meth:`MaterialsSet.with_cover_letter_pdf`.
    """

    def render_resume_to_pdf(
        self,
        *,
        tailored_payload: dict,
        profile_dict: dict,
        output_path: str,
        created_at: str,
    ) -> Artifact:
        """Compile a tailored-resume payload to PDF at ``output_path``.

        ``tailored_payload`` is the JSON the tailor LLM returned (after
        sanitisation). ``profile_dict`` is the augmented snapshot dict.
        """
        ...

    def render_cover_letter_to_pdf(
        self,
        *,
        cover_letter_text: str,
        output_path: str,
        created_at: str,
    ) -> Artifact:
        """Render plain-text cover letter to PDF at ``output_path``."""
        ...


__all__ = [
    "ArtifactStatus",
    "ArtifactType",
    "MaterialsRepository",
    "PdfRendererPort",
    "RenderFormat",
]
