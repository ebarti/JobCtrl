"""Driving use cases for the Candidate Profile context.

See ddd-target.md §5.3 — ``GetProfileUseCase``, ``UpdateProfileUseCase``,
``ImportProfileUseCase``. Each use case owns the orchestration that the API,
CLI, and other contexts drive through; each delegates persistence to the
``ProfileRepository`` port and event publishing happens in the adapter.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from jobhunter.domain.tenant import LOCAL_TENANT, TenantId
from jobhunter.domain.profile.aggregate import Profile
from jobhunter.domain.profile.ports import (
    ProfileImportResult,
    ProfileRepository,
)
from jobhunter.domain.profile.snapshot import ProfileSnapshot


@dataclass(frozen=True)
class GetProfileUseCase:
    """Return the current ``ProfileSnapshot`` for a tenant."""

    repository: ProfileRepository

    def __call__(self, tenant_id: TenantId = LOCAL_TENANT) -> ProfileSnapshot:
        return self.repository.load_snapshot(tenant_id)


@dataclass(frozen=True)
class UpdateProfileUseCase:
    """Persist a profile dict (e.g. from the wizard or PATCH /v1/profile).

    The dict is parsed through ``Profile.from_dict`` so invariants are
    enforced before anything is written. Returns the resulting snapshot.
    """

    repository: ProfileRepository

    def __call__(
        self,
        data: dict[str, Any],
        *,
        tenant_id: TenantId = LOCAL_TENANT,
    ) -> ProfileSnapshot:
        profile = Profile.from_dict(tenant_id, data)
        return self.repository.save(tenant_id, profile)


@dataclass(frozen=True)
class ImportProfileUseCase:
    """Import a draft profile from a resume PDF.

    Returns a ``ProfileImportResult`` carrying the draft profile dict (for
    the user to review and then post back through ``UpdateProfileUseCase``)
    plus the inferred style. Does NOT mutate the persisted profile — that is
    the user's explicit save action.
    """

    repository: ProfileRepository

    def __call__(
        self,
        pdf_bytes: bytes,
        *,
        filename: str = "resume.pdf",
        tenant_id: TenantId = LOCAL_TENANT,
    ) -> ProfileImportResult:
        return self.repository.import_from_pdf(
            tenant_id,
            pdf_bytes,
            filename=filename,
        )
