"""Driven ports for the Materials Generation context.

See ddd-target.md §5.5. Two ports here:

  ``MaterialsRepository`` — persistence for the :class:`MaterialsSet`
                             aggregate root (one aggregate per ``(tenant,
                             job, generation)`` triple).
  ``PdfRendererPort``      — render text artifacts to PDF; the resume HTML
                             adapter and cover-letter adapter wrap Playwright
                             headless Chromium, with LaTeX kept as an
                             opt-in compatibility adapter.

Both protocols are tenant-scoped: local adapters accept ``tenant_id`` and
ignore it (single-tenant); hosted adapters use it for row isolation.
"""

from __future__ import annotations

from typing import Protocol

from jobhunter.domain.identifiers import JobId
from jobhunter.domain.materials.aggregate import MaterialsSet
from jobhunter.domain.materials.analysis import (
    EmployerAnalysis,
    JobAnalysis,
    JobAnalysisDraft,
)
from jobhunter.domain.materials.entities import Artifact
from jobhunter.domain.materials.policy import TailoringPolicy
from jobhunter.domain.materials.provenance import BulletProvenanceSet
from jobhunter.domain.materials.value_objects import (
    ArtifactStatus,
    ArtifactType,
    RenderFormat,
)
from jobhunter.domain.materials.voice import VoiceRequest, VoiceResult
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
      * :meth:`load_current_approved` returns the newest generation whose
        tailored resume is approved. Rejected re-tailor attempts remain history
        and must not hide the last accepted artifact from downstream stages.

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

    def load_current_approved(
        self,
        tenant_id: TenantId,
        job_id: JobId,
    ) -> MaterialsSet | None:
        """Return the newest approved tailored resume generation, if any."""
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

    def suppress_active_artifacts(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        *,
        reason: str,
        suppressed_at: str,
    ) -> MaterialsSet | None:
        """Soft-suppress latest active artifacts without deleting history."""
        ...


class TailoringPolicyRepository(Protocol):
    """Persistence port for the current versioned tailoring policy."""

    def get_current(self, tenant_id: TenantId) -> TailoringPolicy | None:
        """Return the latest persisted tailoring policy, or ``None``."""
        ...

    def save(self, policy: TailoringPolicy) -> None:
        """Persist a tailoring policy version."""
        ...

    def resolve_current(self, candidate: TailoringPolicy) -> TailoringPolicy:
        """Return current policy, creating a new version when config changed."""
        ...


# ---------------------------------------------------------------------------
# Employer-analysis ports (Phase 1 — hexagonal seam for the 3-SDK ensemble)
# ---------------------------------------------------------------------------


class AnalysisDraftPort(Protocol):
    """One ensemble leg: produce a typed analysis draft from a JD snapshot.

    The use case + ensemble orchestrator depend on this port, never on a
    concrete SDK. One adapter per provider (``ClaudeAnalysisAdapter``,
    ``CodexAnalysisAdapter``, ``AntigravityAnalysisAdapter`` — the
    Google/Gemini leg, D-03). ``draft`` runs the leg to completion with NO
    wall-clock timeout (D-19); the only stop is cooperative task cancellation
    by the caller.
    """

    @property
    def model_id(self) -> str:
        """The SDK/model id this adapter drives (tags the draft for audit)."""
        ...

    async def draft(self, system_prompt: str, jd_snapshot: str) -> JobAnalysisDraft:
        """Return a schema-validated draft, or raise on SDK/parse failure."""
        ...


class AnalysisSynthesizerPort(Protocol):
    """Reconcile per-model drafts into one canonical analysis (D-06/D-07).

    Itself an agent-SDK call (Claude Agent SDK per D-07). Receives the typed
    surviving drafts + the JD snapshot and emits the canonical
    :class:`JobAnalysis`, which the use case re-validates for grounding before
    persistence.
    """

    async def reconcile(
        self,
        system_prompt: str,
        *,
        drafts: tuple[JobAnalysisDraft, ...],
        jd_snapshot: str,
    ) -> JobAnalysis:
        """Return the reconciled canonical analysis."""
        ...


class EmployerAnalysisRepository(Protocol):
    """Persistence port for the :class:`EmployerAnalysis` aggregate.

    Versioning mirrors :class:`MaterialsRepository` (D-13): :meth:`save`
    allocates the next generation per ``(tenant, job)`` and supersedes — never
    destroys — prior accepted analyses. :meth:`get_by_cache_key` short-circuits
    the ensemble when an analysis already exists for the same
    ``(snapshot_hash, prompt_version, sdk_set_version)`` cache key (D-11/D-12).
    """

    def load(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        *,
        generation: int | None = None,
    ) -> EmployerAnalysis | None:
        """Return the requested analysis (latest generation by default)."""
        ...

    def get_by_cache_key(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        cache_key: str,
    ) -> EmployerAnalysis | None:
        """Return the cached analysis for ``cache_key``, or ``None`` (D-11)."""
        ...

    def save(self, analysis: EmployerAnalysis) -> None:
        """Persist a new generation, superseding prior ones atomically (D-13)."""
        ...


class BulletProvenanceRepository(Protocol):
    """Persistence port for the :class:`BulletProvenanceSet` (Phase 2).

    Generation-versioned exactly like :class:`MaterialsRepository`: :meth:`save`
    writes the rows for the set's generation; prior generations are NEVER deleted
    (Anti-Pattern 4 / success criterion 5), so a failed re-tailor that writes a
    fresh generation leaves the last accepted generation's provenance intact.
    :meth:`load` returns the latest generation's rows by default.
    """

    def load(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        *,
        generation: int | None = None,
    ) -> BulletProvenanceSet | None:
        """Return the requested provenance set (latest generation by default)."""
        ...

    def save(self, provenance: BulletProvenanceSet) -> None:
        """Persist the rows for ``provenance.generation`` (idempotent re-save)."""
        ...


# ---------------------------------------------------------------------------
# VoicePort (Phase 3 — the de-buzzword / vary-structure voice pass)
# ---------------------------------------------------------------------------


class VoicePort(Protocol):
    """Humanise the SELECTED candidate's prose — de-buzzword + vary structure.

    The voice pass (VOICE-01/02/03) is a NEW AI transform implemented via an agent
    SDK (Claude Agent SDK), mirroring the employer-analysis adapters — NOT the
    legacy httpx client (the all-new-AI-via-SDK directive). The use case + the
    tailor flow depend on this port, never on a concrete SDK; the local adapter is
    :class:`~jobhunter.infrastructure.materials.voice_adapter.ClaudeVoiceAdapter`.

    ``rewrite`` runs the leg to completion with NO wall-clock timeout (mirrors the
    analysis adapters' D-19); the only stop is cooperative task cancellation by the
    caller. It returns the voiced prose as a typed :class:`VoiceResult`; the use
    case then RE-RUNS the deterministic never-fabricate detector + provenance
    builder against the voiced text (VOICE-03), so the prompt is never trusted — the
    gate is. An adapter that errors must raise so the use case can fall back to the
    pre-voice candidate rather than ship an un-voiced/partly-voiced resume silently.
    """

    @property
    def model_id(self) -> str:
        """The SDK/model id this adapter drives (tags the voice audit record)."""
        ...

    async def rewrite(self, system_prompt: str, request: VoiceRequest) -> VoiceResult:
        """Return the voiced prose, or raise on SDK/parse failure."""
        ...


# ---------------------------------------------------------------------------
# PdfRendererPort
# ---------------------------------------------------------------------------


class PdfRendererPort(Protocol):
    """Render text artifacts to PDF.

    Two distinct default rendering paths today:

      * ``HtmlResumePdfAdapter`` consumes a structured tailored-resume
        payload plus a profile snapshot, builds a print HTML/CSS document,
        records layout boxes, and prints it to PDF via headless Chromium.
        Used for resumes only.
      * ``PlaywrightHtmlPdfAdapter`` wraps a plain-text cover letter into
        a minimal HTML document and prints it to PDF via headless
        Chromium. Used for cover letters only.

    ``LatexPdfAdapter`` remains available for legacy resume rendering when
    explicitly selected by local wiring.

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
        resume_theme: dict | None = None,
        resume_template: dict | None = None,
    ) -> Artifact:
        """Compile a tailored-resume payload to PDF at ``output_path``.

        ``tailored_payload`` is the JSON the tailor LLM returned (after
        sanitisation). ``profile_dict`` is the augmented snapshot dict.
        ``resume_theme`` is optional normalized template style data; omitted
        callers get the built-in HTML/CSS renderer style. ``resume_template``
        is safe audit metadata snapshotted into the generated artifact.
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
    "AnalysisDraftPort",
    "AnalysisSynthesizerPort",
    "ArtifactStatus",
    "ArtifactType",
    "BulletProvenanceRepository",
    "EmployerAnalysisRepository",
    "MaterialsRepository",
    "PdfRendererPort",
    "RenderFormat",
    "TailoringPolicyRepository",
    "VoicePort",
]


# Re-export to silence unused-import warnings for the schema types referenced
# only in port signatures above.
_ = (EmployerAnalysis, JobAnalysis, JobAnalysisDraft, BulletProvenanceSet, VoiceRequest, VoiceResult)
