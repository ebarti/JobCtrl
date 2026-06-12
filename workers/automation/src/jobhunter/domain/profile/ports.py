"""Driven ports for the Candidate Profile context.

See ddd-target.md §5.3:

  ProfileRepository — persistence port for the Profile aggregate.
  PdfParserPort     — extracts a draft profile from a resume PDF.

These are pure protocols; the local-mode adapters live under
``infrastructure/profile/`` and the cloud counterparts (PostgresProfile-
Repository, etc.) will land when fitness functions trigger evolution.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from jobhunter.domain.tenant import TenantId
from jobhunter.domain.profile.aggregate import Profile
from jobhunter.domain.profile.snapshot import ProfileSnapshot


class ProfileRepository(Protocol):
    """Persistence port for the Profile aggregate.

    All methods are tenant-scoped. Local adapters accept ``tenant_id`` and
    ignore it (single-tenant); hosted adapters use it for row isolation.
    """

    def load(self, tenant_id: TenantId) -> Profile | None:
        """Return the stored Profile, or None when no profile is configured."""
        ...

    def save(self, tenant_id: TenantId, profile: Profile) -> ProfileSnapshot:
        """Persist the Profile aggregate.

        Returns a fresh ``ProfileSnapshot`` reflecting the saved state and
        publishes a ``ProfileUpdated`` domain event.
        """
        ...

    def load_snapshot(self, tenant_id: TenantId) -> ProfileSnapshot:
        """Return the current ``ProfileSnapshot``.

        Raises ``FileNotFoundError`` (or the cloud equivalent) when the
        profile has not been initialized.
        """
        ...

    def import_from_pdf(
        self,
        tenant_id: TenantId,
        pdf_bytes: bytes,
        *,
        filename: str = "resume.pdf",
    ) -> "ProfileImportResult":
        """Parse a resume PDF into a draft profile + style payload.

        Implementation detail: adapters delegate to a ``PdfParserPort`` for
        the actual extraction; the repository is the use-case seam that
        publishes ``ProfileImported`` and returns the result.
        """
        ...


class PdfParserPort(Protocol):
    """Extracts a draft profile + style dict from raw PDF bytes."""

    def parse(
        self,
        pdf_bytes: bytes,
        *,
        filename: str,
        base_profile: dict[str, Any] | None,
        base_style: dict[str, Any] | None,
    ) -> dict[str, Any]:
        """Return ``{"profile": ..., "style": ..., "source": ...}``.

        ``profile`` is a dict in the canonical profile shape (a draft for the
        user to review). ``style`` is the resume rendering style shape.
        ``source`` carries diagnostics (filename, page count, warnings).
        """
        ...


# ---------------------------------------------------------------------------
# Lightweight result type — used by ImportProfileUseCase / repository
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ProfileImportResult:
    """Output of ``ProfileRepository.import_from_pdf`` and the matching
    use case. Carries the draft profile dict (for the UI to review and
    then post back via ``UpdateProfileUseCase``), the inferred style, and
    diagnostic source metadata."""

    profile: dict[str, Any]
    style: dict[str, Any]
    source: dict[str, Any]
    snapshot: ProfileSnapshot | None = None
