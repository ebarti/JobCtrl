"""Contact & Outreach bounded context — domain layer (Phase 1: Contact root)."""

from jobhunter.domain.contact.aggregate import Contact
from jobhunter.domain.contact.use_cases import (
    AttributeInput,
    ContactInputError,
    CreateContactUseCase,
    DeleteContactUseCase,
    ImportContactsUseCase,
    ImportResult,
    UpdateContactUseCase,
)
from jobhunter.domain.contact.value_objects import (
    CONTACT_CAPTURE_METHODS,
    CONTACT_SOURCE_KINDS,
    ContactAttribute,
    ContactFactProvenance,
    ContactLink,
    ContactRole,
    WarmIntroSignal,
)

__all__ = [
    "CONTACT_CAPTURE_METHODS",
    "CONTACT_SOURCE_KINDS",
    "AttributeInput",
    "Contact",
    "ContactAttribute",
    "ContactFactProvenance",
    "ContactInputError",
    "ContactLink",
    "ContactRole",
    "CreateContactUseCase",
    "DeleteContactUseCase",
    "ImportContactsUseCase",
    "ImportResult",
    "UpdateContactUseCase",
    "WarmIntroSignal",
]
