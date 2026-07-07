"""Job Enrichment bounded context — domain layer.

See ddd-target.md §4.2 (JobEnrichment aggregate, EnrichmentAttempt entity,
extraction tiers, lifecycle).

PR3 additions: ``PostingSnapshotSet`` aggregate plus its
``PostingContentSnapshot`` value objects, the ``ActiveState`` /
``QuarantineReason`` / ``SnapshotConfidence`` enums, the
``DuplicateEvidence`` / ``ContentDuplicateCandidate`` records, and the
``FilterOverrideAudit`` for policy-compliant overrides. See
``docs/plans/implemented/2026-05-12-job-search-discovery-rfc.md`` §"Domain
Model Additions" and §"Content Acquisition Pipeline".

Public API barrel: aggregate roots, child entities/value objects, and
ports re-exports. Adapters live under
``jobctrl.infrastructure.enrichment``.
"""

from jobctrl.domain.enrichment.aggregate import (
    EnrichmentLifecycle,
    EnrichmentStatus,
    JobEnrichment,
)
from jobctrl.domain.enrichment.entities import (
    AttemptStatus,
    EnrichmentAttempt,
)
from jobctrl.domain.enrichment.snapshot_set import (
    ContentDuplicateCandidate,
    PostingSnapshotSet,
    SnapshotCaptureFailure,
)
from jobctrl.domain.enrichment.snapshot_value_objects import (
    ActiveState,
    DuplicateEvidence,
    DuplicateEvidenceKind,
    FilterOverrideAudit,
    PostingContentSnapshot,
    QuarantineReason,
    SnapshotApplyUrl,
    SnapshotConfidence,
    SnapshotDescriptionHash,
)
from jobctrl.domain.enrichment.value_objects import (
    ApplicationUrl,
    DetailPage,
    EnrichmentError,
    ExtractionTier,
    FullDescription,
)

__all__ = [
    "ActiveState",
    "ApplicationUrl",
    "AttemptStatus",
    "ContentDuplicateCandidate",
    "DetailPage",
    "DuplicateEvidence",
    "DuplicateEvidenceKind",
    "EnrichmentAttempt",
    "EnrichmentError",
    "EnrichmentLifecycle",
    "EnrichmentStatus",
    "ExtractionTier",
    "FilterOverrideAudit",
    "FullDescription",
    "JobEnrichment",
    "PostingContentSnapshot",
    "PostingSnapshotSet",
    "QuarantineReason",
    "SnapshotApplyUrl",
    "SnapshotCaptureFailure",
    "SnapshotConfidence",
    "SnapshotDescriptionHash",
]
