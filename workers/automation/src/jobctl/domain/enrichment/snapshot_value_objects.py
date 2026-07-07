"""Value objects for PR3 PostingSnapshotSet aggregate.

See ``docs/plans/implemented/2026-05-12-job-search-discovery-rfc.md`` §"Domain
Model Additions" and §"Content Acquisition Pipeline".

These value objects support the recurring detail-refresh / active-state /
content-dedupe lifecycle that ``PostingSnapshotSet`` owns. They live
alongside the existing Enrichment value objects (``FullDescription``,
``ApplicationUrl``, ``ExtractionTier``, ``DetailPage``) so the canonical
``JobEnrichment`` invariants are unchanged.

The new value objects are:

  * ``ActiveState`` — the verified live-state of a posting at a snapshot
    version. ``unknown`` is the seed; ``active`` / ``closed`` /
    ``expired`` / ``removed`` / ``location_incompatible`` are terminal
    until the next snapshot.
  * ``QuarantineReason`` — why a snapshot was held back from confident
    auto-promotion. Quarantine is a per-snapshot decision, not an
    aggregate-wide state.
  * ``SnapshotConfidence`` — three-bucket confidence label that mirrors
    the extraction-schema field in the RFC ("high|medium|low").
  * ``SnapshotDescriptionHash`` / ``SnapshotApplyUrl`` — typed identity
    fields used by the content-dedupe service.
  * ``DuplicateEvidence`` — explanation attached to a
    ``ContentDuplicateCandidate``: which signal matched, with what
    confidence, and the matched value (hash or apply URL).
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from enum import Enum


# ---------------------------------------------------------------------------
# ActiveState
# ---------------------------------------------------------------------------


class ActiveState(str, Enum):
    """Verified live-state of a posting at a snapshot version.

    Mirrors the RFC §"Content Acquisition Pipeline" extraction schema
    "active_state" field. ``UNKNOWN`` is the seed; the verifier moves
    snapshots into ``ACTIVE`` / ``CLOSED`` / ``EXPIRED`` / ``REMOVED``
    once it has supporting evidence. ``LOCATION_INCOMPATIBLE`` is the
    terminal state for postings that succeeded extraction but whose
    location/work-mode rules out the project owner's search profile.
    """

    UNKNOWN = "unknown"
    ACTIVE = "active"
    CLOSED = "closed"
    EXPIRED = "expired"
    REMOVED = "removed"
    LOCATION_INCOMPATIBLE = "location_incompatible"

    @classmethod
    def from_optional(cls, value: object) -> "ActiveState | None":
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
# QuarantineReason
# ---------------------------------------------------------------------------


class QuarantineReason(str, Enum):
    """Why a single snapshot is quarantined.

    A snapshot may be quarantined even though the aggregate as a whole
    contains earlier confident snapshots. The reason is what the queue
    UI surfaces to the operator who decides whether to approve or
    discard the snapshot.
    """

    NONE = "none"
    LOW_CONFIDENCE_EXTRACTION = "low_confidence_extraction"
    UNKNOWN_ACTIVE_STATE = "unknown_active_state"
    BROAD_BOARD_ONLY = "broad_board_only"
    POLICY_OVERRIDE_PENDING = "policy_override_pending"
    DUPLICATE_CANDIDATE = "duplicate_candidate"
    SHORT_DESCRIPTION = "short_description"

    @classmethod
    def from_optional(cls, value: object) -> "QuarantineReason | None":
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
# SnapshotConfidence
# ---------------------------------------------------------------------------


class SnapshotConfidence(str, Enum):
    """Three-bucket confidence label aligned with the RFC schema."""

    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"

    @classmethod
    def from_optional(cls, value: object) -> "SnapshotConfidence | None":
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
# SnapshotDescriptionHash
# ---------------------------------------------------------------------------


_NORMALIZE_WHITESPACE = re.compile(r"\s+")


@dataclass(frozen=True)
class SnapshotDescriptionHash:
    """Deterministic hash over a cleaned posting description.

    The hash is what the content-dedupe service joins on. We compute
    the hash inside the value object so two callers with the same
    cleaned text always produce the same identity, regardless of
    incidental upstream whitespace.
    """

    value: str

    def __post_init__(self) -> None:
        if not isinstance(self.value, str) or not self.value.strip():
            raise ValueError("SnapshotDescriptionHash.value must be a non-empty string")

    def __str__(self) -> str:
        return self.value

    @classmethod
    def from_text(cls, cleaned_text: str) -> "SnapshotDescriptionHash":
        """Compute the hash from a cleaned description string.

        ``cleaned_text`` is expected to be the output of the existing
        ``_clean_description`` helper. We collapse remaining whitespace,
        case-fold, then SHA-256 the bytes. Empty input is a programmer
        error: dedupe never runs on empty descriptions.
        """
        if not isinstance(cleaned_text, str) or not cleaned_text.strip():
            raise ValueError(
                "SnapshotDescriptionHash.from_text requires non-empty cleaned text"
            )
        normalized = _NORMALIZE_WHITESPACE.sub(" ", cleaned_text.strip()).casefold()
        digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
        return cls(value=digest)


# ---------------------------------------------------------------------------
# SnapshotApplyUrl
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SnapshotApplyUrl:
    """Normalized apply URL recorded per snapshot.

    Distinct from the canonical ``ApplicationUrl`` value object on
    ``JobEnrichment``: this one carries the apply URL observed at a
    specific snapshot version so downstream dedupe sees per-snapshot
    history instead of only the terminal value.
    """

    value: str

    def __post_init__(self) -> None:
        if not isinstance(self.value, str) or not self.value.strip():
            raise ValueError("SnapshotApplyUrl.value must be a non-empty string")

    def __str__(self) -> str:
        return self.value


# ---------------------------------------------------------------------------
# DuplicateEvidence
# ---------------------------------------------------------------------------


class DuplicateEvidenceKind(str, Enum):
    DESCRIPTION_HASH_MATCH = "description_hash_match"
    APPLY_URL_MATCH = "apply_url_match"
    HIGH_CONFIDENCE_CONTENT_SIMILARITY = "high_confidence_content_similarity"


@dataclass(frozen=True)
class DuplicateEvidence:
    """Per-signal evidence supporting a content-duplicate candidate.

    Each evidence carries the matched signal and a confidence in
    [0, 1]. The value-objects are wrapped in a tuple on
    ``ContentDuplicateCandidate``.
    """

    kind: DuplicateEvidenceKind
    matched_value: str
    confidence: float

    def __post_init__(self) -> None:
        if not isinstance(self.matched_value, str) or not self.matched_value.strip():
            raise ValueError(
                "DuplicateEvidence.matched_value must be a non-empty string"
            )
        if not 0.0 <= self.confidence <= 1.0:
            raise ValueError("DuplicateEvidence.confidence must be between 0 and 1")


# ---------------------------------------------------------------------------
# FilterOverrideReason
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FilterOverrideAudit:
    """Audit row for a policy-compliant internal filter override.

    Recorded whenever a snapshot is admitted because the source's
    ``ContentFilterOverridePolicy`` allows the user/operator to
    override one of JobCtl's own filters (low-confidence extraction,
    short description, missing salary, ...). This is policy-internal:
    third-party access controls remain out of scope per the RFC
    §"Policy For Content Acquisition".
    """

    source_id: str
    overridden_filter: str
    reason: str
    requested_by: str
    overridden_at: str

    def __post_init__(self) -> None:
        if not isinstance(self.source_id, str) or not self.source_id.strip():
            raise ValueError("FilterOverrideAudit.source_id must be a non-empty string")
        if not isinstance(self.overridden_filter, str) or not self.overridden_filter.strip():
            raise ValueError(
                "FilterOverrideAudit.overridden_filter must be a non-empty string"
            )
        if not isinstance(self.reason, str) or not self.reason.strip():
            raise ValueError("FilterOverrideAudit.reason must be a non-empty string")
        if not isinstance(self.requested_by, str) or not self.requested_by.strip():
            raise ValueError(
                "FilterOverrideAudit.requested_by must be a non-empty string"
            )
        if not isinstance(self.overridden_at, str) or not self.overridden_at.strip():
            raise ValueError(
                "FilterOverrideAudit.overridden_at must be a non-empty timestamp"
            )


# ---------------------------------------------------------------------------
# PostingContentSnapshot
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PostingContentSnapshot:
    """One versioned content-extraction result inside ``PostingSnapshotSet``.

    See RFC §"Content Acquisition Pipeline" step 8.

    The snapshot carries everything Operations and the dedupe service
    need to make a decision about this run, without re-fetching the
    detail page:

      * ``snapshot_version`` — monotonic per ``PostingSnapshotSet``
        starting at 1.
      * ``source_id`` / ``extraction_tier`` — provenance.
      * ``description_hash`` / ``apply_url`` — dedupe identity.
      * ``active_state`` / ``confidence`` — per-snapshot judgement;
        the aggregate keeps the latest value at the top level for
        cheap reads but the per-snapshot history stays here.
      * ``quarantine_reason`` — non-``NONE`` means this snapshot was
        held; an operator must approve before downstream automation
        consumes it.
      * ``filter_override`` — populated when the snapshot was admitted
        through a policy-compliant filter override.
      * ``raw_text_hash`` — sha256 over the *raw* extracted text
        (before cleaning), used for spans and forensics. ``""`` when
        the extractor did not retain raw bytes.
      * ``captured_at`` — ISO-8601 timestamp.
    """

    snapshot_version: int
    source_id: str
    extraction_tier: str
    description_hash: SnapshotDescriptionHash
    apply_url: SnapshotApplyUrl | None
    active_state: ActiveState
    confidence: SnapshotConfidence
    quarantine_reason: QuarantineReason
    captured_at: str
    raw_text_hash: str = ""
    filter_override: FilterOverrideAudit | None = None
    evidence: tuple[str, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        if not isinstance(self.snapshot_version, int) or self.snapshot_version < 1:
            raise ValueError(
                "PostingContentSnapshot.snapshot_version must be >= 1, "
                f"got {self.snapshot_version!r}"
            )
        if not isinstance(self.source_id, str) or not self.source_id.strip():
            raise ValueError(
                "PostingContentSnapshot.source_id must be a non-empty string"
            )
        if not isinstance(self.extraction_tier, str) or not self.extraction_tier.strip():
            raise ValueError(
                "PostingContentSnapshot.extraction_tier must be a non-empty string"
            )
        if not isinstance(self.description_hash, SnapshotDescriptionHash):
            raise ValueError(
                "PostingContentSnapshot.description_hash must be a SnapshotDescriptionHash"
            )
        if self.apply_url is not None and not isinstance(self.apply_url, SnapshotApplyUrl):
            raise ValueError(
                "PostingContentSnapshot.apply_url must be a SnapshotApplyUrl or None"
            )
        if not isinstance(self.active_state, ActiveState):
            raise ValueError(
                "PostingContentSnapshot.active_state must be an ActiveState"
            )
        if not isinstance(self.confidence, SnapshotConfidence):
            raise ValueError(
                "PostingContentSnapshot.confidence must be a SnapshotConfidence"
            )
        if not isinstance(self.quarantine_reason, QuarantineReason):
            raise ValueError(
                "PostingContentSnapshot.quarantine_reason must be a QuarantineReason"
            )
        if not isinstance(self.captured_at, str) or not self.captured_at.strip():
            raise ValueError(
                "PostingContentSnapshot.captured_at must be a non-empty timestamp"
            )
        if self.filter_override is not None and not isinstance(
            self.filter_override, FilterOverrideAudit
        ):
            raise ValueError(
                "PostingContentSnapshot.filter_override must be a FilterOverrideAudit or None"
            )
        if not isinstance(self.evidence, tuple):
            raise ValueError("PostingContentSnapshot.evidence must be a tuple")

    @property
    def is_quarantined(self) -> bool:
        return self.quarantine_reason is not QuarantineReason.NONE

    @property
    def is_high_confidence(self) -> bool:
        return self.confidence is SnapshotConfidence.HIGH

    def to_dict(self) -> dict[str, object]:
        return {
            "snapshot_version": self.snapshot_version,
            "source_id": self.source_id,
            "extraction_tier": self.extraction_tier,
            "description_hash": self.description_hash.value,
            "apply_url": self.apply_url.value if self.apply_url else None,
            "active_state": self.active_state.value,
            "confidence": self.confidence.value,
            "quarantine_reason": self.quarantine_reason.value,
            "captured_at": self.captured_at,
            "raw_text_hash": self.raw_text_hash,
            "filter_override": (
                {
                    "source_id": self.filter_override.source_id,
                    "overridden_filter": self.filter_override.overridden_filter,
                    "reason": self.filter_override.reason,
                    "requested_by": self.filter_override.requested_by,
                    "overridden_at": self.filter_override.overridden_at,
                }
                if self.filter_override
                else None
            ),
            "evidence": list(self.evidence),
        }


__all__ = [
    "ActiveState",
    "DuplicateEvidence",
    "DuplicateEvidenceKind",
    "FilterOverrideAudit",
    "PostingContentSnapshot",
    "QuarantineReason",
    "SnapshotApplyUrl",
    "SnapshotConfidence",
    "SnapshotDescriptionHash",
]
