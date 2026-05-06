"""Discovery value objects.

See ddd-target.md §4.1. Pure data, no I/O. All value objects are frozen
dataclasses; constructors enforce invariants up front so an instance carries
its validity. The aggregate root (``Job``) composes these into the canonical
discovery fact.

Invariants enforced here:

  ``PostingUrl``     — non-empty trimmed string. The URL syntax is NOT
                       validated against ``urlparse`` because the legacy
                       schema stores some normalised slugs that are
                       resolved later by the enrichment URL resolver. We
                       only guarantee it is a non-empty string token.
  ``Source``         — non-empty job-board identifier (``board``). This is
                       the platform where the job was found (e.g.
                       ``"linkedin"``, ``"greenhouse"``). The hiring
                       company is a SEPARATE value object (``Employer``),
                       per §4.1.
  ``Employer``       — non-empty company name. Defaults to the sentinel
                       ``"Unknown"`` if not extractable at discovery time
                       (per §4.1 lifecycle rule).
  ``SearchStrategy`` — enum of how the job was discovered. Constrained to
                       the four legal values listed in §4.1.
  ``JobMetadata``    — title + optional salary/description/location. Title
                       is the only required field — the rest are populated
                       opportunistically by different scrapers and may be
                       empty strings.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any


# ---------------------------------------------------------------------------
# PostingUrl
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PostingUrl:
    """The raw URL where the job posting was found on the source board.

    The legacy ``jobs.url`` PRIMARY KEY column maps to this value object.
    Validation here is intentionally light — some scrapers store
    normalised slugs that are resolved later (see
    ``infrastructure.network.proxy``-adjacent URL resolution in the
    enrichment context) — but the string MUST be non-empty so the
    aggregate identity ``(tenantId, postingUrl)`` cannot collide on a
    NULL/empty key.
    """

    value: str

    def __post_init__(self) -> None:
        if not isinstance(self.value, str) or not self.value.strip():
            raise ValueError("PostingUrl.value must be a non-empty string")

    def __str__(self) -> str:
        return self.value


# ---------------------------------------------------------------------------
# Source
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Source:
    """The platform where the job posting was discovered.

    Per §4.1 this is the **board**, NOT the hiring company. The legacy
    ``jobs.site`` column maps to ``Source.board``; the hiring company
    lives on ``Employer.name``. Splitting the two enables the future
    "filter by board" + "filter by employer" queries the backlog calls
    for, and stops the legacy conflation that put strings like
    ``"Greenhouse"`` (a board) into the same column as ``"Acme Corp"`` (an
    employer).
    """

    board: str

    def __post_init__(self) -> None:
        if not isinstance(self.board, str) or not self.board.strip():
            raise ValueError("Source.board must be a non-empty string")


# ---------------------------------------------------------------------------
# Employer
# ---------------------------------------------------------------------------


_UNKNOWN_EMPLOYER = "Unknown"


@dataclass(frozen=True)
class Employer:
    """The hiring company.

    Per §4.1 a Job MUST have an ``Employer`` — when discovery cannot
    extract it, callers use :func:`Employer.unknown` to record the
    sentinel ``"Unknown"`` so the invariant holds. This keeps the
    aggregate well-typed without forcing every legacy scraper to do
    employer extraction up front.
    """

    name: str = _UNKNOWN_EMPLOYER

    def __post_init__(self) -> None:
        if not isinstance(self.name, str) or not self.name.strip():
            raise ValueError("Employer.name must be a non-empty string")

    @classmethod
    def unknown(cls) -> "Employer":
        """Sentinel used when the scraper could not extract an employer."""
        return cls(name=_UNKNOWN_EMPLOYER)

    def is_unknown(self) -> bool:
        return self.name == _UNKNOWN_EMPLOYER


# ---------------------------------------------------------------------------
# SearchStrategy
# ---------------------------------------------------------------------------


class SearchStrategy(str, Enum):
    """How the job was discovered.

    Per §4.1 the legal values are ``jobspy``, ``workday_api``,
    ``smart_extract``, ``manual``. The string enum stays compatible with
    the legacy ``jobs.strategy`` TEXT column so the SQLite adapter can
    round-trip without translation.
    """

    JOBSPY = "jobspy"
    WORKDAY_API = "workday_api"
    SMART_EXTRACT = "smart_extract"
    MANUAL = "manual"

    @classmethod
    def from_optional(cls, value: Any) -> "SearchStrategy | None":
        """Parse a possibly-null legacy string into a ``SearchStrategy``.

        Returns ``None`` when the value is missing or doesn't match a
        canonical strategy — the legacy ``jobs.strategy`` column has been
        used to store free-form scraper names (``"json_ld"``,
        ``"api_response"``) over time, and we don't want a malformed
        legacy row to crash the aggregate hydrator.
        """
        if value is None:
            return None
        text = str(value).strip().lower()
        if not text:
            return None
        for member in cls:
            if member.value == text:
                return member
        return None


# ---------------------------------------------------------------------------
# JobMetadata
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class JobMetadata:
    """Discovery-time metadata captured about a job posting.

    Per §4.1: ``title`` + optional salary/description/location. The
    description here is the **discovery snippet** (typically a short
    summary captured by the board listing) — the **full** description
    is the responsibility of the Enrichment context's
    ``FullDescription`` value object.

    All four fields are stored as strings (empty string ⇒ "no value")
    rather than ``Optional[str]`` to avoid the trivalent NULL/""/missing
    distinction that plagued the legacy schema.
    """

    title: str = ""
    salary: str = ""
    description: str = ""
    location: str = ""

    def __post_init__(self) -> None:
        for name in ("title", "salary", "description", "location"):
            value = getattr(self, name)
            if not isinstance(value, str):
                raise ValueError(
                    f"JobMetadata.{name} must be a string, got {type(value).__name__}"
                )

    def to_dict(self) -> dict[str, str]:
        return {
            "title": self.title,
            "salary": self.salary,
            "description": self.description,
            "location": self.location,
        }
