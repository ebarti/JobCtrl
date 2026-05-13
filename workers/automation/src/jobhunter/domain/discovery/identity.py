"""Discovery canonical identity, source observations, and duplicate links.

See ddd-target.md §4.1 and the PR 2 section of the
`Job Search Discovery RFC` (`docs/plans/proposed/2026-05-12-job-search-discovery-rfc.md`).

Three types live here:

* :class:`AtsKind` enumerates the ATS families recognised by the canonical
  identity service. It mirrors the ``ats_api`` source-kind family on the
  TypeScript side and is intentionally extensible: PR 2 ships the four
  Tier 1 families (Workday, Greenhouse, Lever, Ashby) and reserves
  ``other`` for Smart Extract / broad-board callers that have not yet
  been canonicalised.
* :class:`CanonicalJobIdentity` is the immutable value object Discovery
  attaches to a Job once the canonical URL, ATS kind, and source-native
  id have been resolved. It is the dedupe key the Discovery write
  boundary uses to collapse repeated observations into a single Job
  aggregate.
* :class:`JobSourceObservation` is a child entity of the Discovery Job
  aggregate. Each observation records that a particular source saw a
  posting at a particular URL during a particular run. Observations are
  preserved even after a duplicate is merged so source quality and
  attribution are not lost.
* :class:`DuplicateJobLink` is the audit record produced when two
  observations resolve to the same canonical identity but are split
  across distinct Job aggregates (or when a fuzzy candidate is merged
  into a surviving Job). The link is reversible per the RFC failure
  mode "A duplicate link points to a job the user later dismisses".

Pure data — no I/O. Persistence is the job of ``JobRepository`` (see
``jobhunter.domain.ports.discovery``).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from urllib.parse import urlsplit, urlunsplit


class AtsKind(str, Enum):
    """ATS family for the canonical identity record.

    Mirrors the Tier 1 sources called out in the RFC. ``other`` is the
    catch-all for Smart Extract / broad-board observations that have
    not yet been canonicalised — it lets the Job aggregate carry an
    identity even before a Tier 1 adapter has resolved the lead.
    """

    WORKDAY = "workday"
    GREENHOUSE = "greenhouse"
    LEVER = "lever"
    ASHBY = "ashby"
    OTHER = "other"

    @classmethod
    def from_optional(cls, value: object) -> "AtsKind":
        """Parse a free-form string into an ``AtsKind``, defaulting to ``OTHER``."""
        if value is None:
            return cls.OTHER
        text = str(value).strip().lower()
        if not text:
            return cls.OTHER
        for member in cls:
            if member.value == text:
                return member
        return cls.OTHER


def normalize_observed_url(url: str) -> str:
    """Normalise an observed posting URL for tenant-scoped uniqueness.

    The RFC §"Deduplication Boundary" requires that observation URLs
    are unique on ``(tenant_id, normalized_observed_url)``. Two different
    boards often advertise the same canonical posting under cosmetically
    different URLs (trailing slash, query-string tracking parameters,
    fragment identifiers). This normaliser collapses the obvious
    cosmetic variants without trying to canonicalise across employer
    domains — that is the canonical-identity service's job.

    Rules:
      * Lowercase the scheme and host.
      * Strip trailing whitespace and a single trailing slash from the
        path.
      * Drop fragment identifiers entirely.
      * Drop common tracking query parameters (utm_*, gh_jid,
        ashby_jid, lever-source, gh_src, gh_jrid, gh_id).

    The function keeps the original URL when the input is not a syntactic
    URL (it just trims surrounding whitespace) so adapters that hand in
    canonical slugs (``"/career/abc"``) round-trip without surprise.
    """

    text = (url or "").strip()
    if not text:
        return ""
    try:
        parts = urlsplit(text)
    except ValueError:
        return text
    if not parts.scheme or not parts.netloc:
        return text
    scheme = parts.scheme.lower()
    netloc = parts.netloc.lower()
    path = parts.path.rstrip()
    if path.endswith("/") and len(path) > 1:
        path = path.rstrip("/")
    query = _strip_tracking_params(parts.query)
    return urlunsplit((scheme, netloc, path, query, ""))


_TRACKING_PARAM_PREFIXES: tuple[str, ...] = ("utm_",)
_TRACKING_PARAM_NAMES: frozenset[str] = frozenset(
    {
        "gh_jid",
        "gh_src",
        "gh_jrid",
        "gh_id",
        "ashby_jid",
        "lever-source",
        "lever_source",
        "src",
        "ref",
    }
)


def _strip_tracking_params(query: str) -> str:
    if not query:
        return ""
    kept: list[str] = []
    for pair in query.split("&"):
        if not pair:
            continue
        name = pair.split("=", 1)[0]
        lower = name.lower()
        if lower in _TRACKING_PARAM_NAMES:
            continue
        if any(lower.startswith(prefix) for prefix in _TRACKING_PARAM_PREFIXES):
            continue
        kept.append(pair)
    return "&".join(kept)


@dataclass(frozen=True)
class CanonicalJobIdentity:
    """Discovery-owned identity decision for a Job.

    The trio ``(canonical_url, ats_kind, source_native_id)`` is the
    authoritative dedupe key for the Discovery write boundary. The
    ``confidence`` scalar lets Operations chart canonicalisation quality
    over time (low-confidence identities should be quarantined per the
    RFC §"Deduplication Boundary").
    """

    canonical_url: str
    ats_kind: AtsKind
    source_native_id: str
    confidence: float

    def __post_init__(self) -> None:
        if not isinstance(self.canonical_url, str) or not self.canonical_url.strip():
            raise ValueError("CanonicalJobIdentity.canonical_url must be a non-empty string")
        if not isinstance(self.ats_kind, AtsKind):
            raise ValueError("CanonicalJobIdentity.ats_kind must be an AtsKind")
        if not isinstance(self.source_native_id, str) or not self.source_native_id.strip():
            raise ValueError(
                "CanonicalJobIdentity.source_native_id must be a non-empty string"
            )
        if not isinstance(self.confidence, (int, float)):
            raise ValueError("CanonicalJobIdentity.confidence must be numeric")
        if not 0.0 <= float(self.confidence) <= 1.0:
            raise ValueError("CanonicalJobIdentity.confidence must be between 0.0 and 1.0")


@dataclass(frozen=True)
class JobSourceObservation:
    """Per-source evidence for a canonical Job aggregate.

    The Discovery write boundary attaches one observation per scraper
    hit. Repeated observations from the same source for the same
    canonical Job replace the previous observation rather than creating
    a duplicate row. Observations are preserved across duplicate-link
    decisions so source quality, attribution, and broad-board
    backtraces survive a merge.
    """

    source_observation_id: str
    source_id: str
    source_native_id: str
    observed_url: str
    run_id: str
    observed_at: str

    def __post_init__(self) -> None:
        for name in (
            "source_observation_id",
            "source_id",
            "source_native_id",
            "observed_url",
            "run_id",
            "observed_at",
        ):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"JobSourceObservation.{name} must be a non-empty string")

    @property
    def normalized_observed_url(self) -> str:
        """Tenant-scoped uniqueness key — see :func:`normalize_observed_url`."""

        return normalize_observed_url(self.observed_url)


@dataclass(frozen=True)
class DuplicateJobLink:
    """A reversible link recording a duplicate decision.

    ``surviving_job_id`` is the Job aggregate that wins the merge. The
    ``superseded`` reference may be either a Job aggregate id (when two
    Jobs were collapsed) or a JobSourceObservation id (when a duplicate
    observation was attached to an existing Job). The ``reason`` is a
    short machine-readable code (``source_native_id_match``,
    ``canonical_url_match``, ``ats_identity_match``, ``user_correction``)
    so Operations can group duplicates by cause.
    """

    duplicate_link_id: str
    surviving_job_id: str
    superseded_job_or_observation_id: str
    reason: str
    confidence: float
    linked_at: str

    def __post_init__(self) -> None:
        if not isinstance(self.duplicate_link_id, str) or not self.duplicate_link_id.strip():
            raise ValueError("DuplicateJobLink.duplicate_link_id must be a non-empty string")
        if not isinstance(self.surviving_job_id, str) or not self.surviving_job_id.strip():
            raise ValueError("DuplicateJobLink.surviving_job_id must be a non-empty string")
        if (
            not isinstance(self.superseded_job_or_observation_id, str)
            or not self.superseded_job_or_observation_id.strip()
        ):
            raise ValueError(
                "DuplicateJobLink.superseded_job_or_observation_id must be a non-empty string"
            )
        if not isinstance(self.reason, str) or not self.reason.strip():
            raise ValueError("DuplicateJobLink.reason must be a non-empty string")
        if not isinstance(self.confidence, (int, float)):
            raise ValueError("DuplicateJobLink.confidence must be numeric")
        if not 0.0 <= float(self.confidence) <= 1.0:
            raise ValueError("DuplicateJobLink.confidence must be between 0.0 and 1.0")
        if not isinstance(self.linked_at, str) or not self.linked_at.strip():
            raise ValueError("DuplicateJobLink.linked_at must be a non-empty ISO-8601 timestamp")
