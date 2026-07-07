"""Candidate Profile domain events.

See ddd-target.md §4.3.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from jobctrl.domain.tenant import TenantId
from jobctrl.domain.events.base import DomainEvent, create_domain_event


@dataclass(frozen=True)
class ProfileUpdatedPayload:
    changed_sections: tuple[str, ...] = ()
    updated_at: str = ""


def create_profile_updated(tenant_id: TenantId, payload: ProfileUpdatedPayload) -> DomainEvent:
    return create_domain_event("ProfileUpdated", tenant_id, asdict(payload))


@dataclass(frozen=True)
class ProfileImportedPayload:
    source: str
    imported_sections: tuple[str, ...] = ()
    imported_at: str = ""


def create_profile_imported(tenant_id: TenantId, payload: ProfileImportedPayload) -> DomainEvent:
    return create_domain_event("ProfileImported", tenant_id, asdict(payload))
