"""Job Enrichment bounded context — domain layer.

See ddd-target.md §4.2 (JobEnrichment aggregate, EnrichmentAttempt entity,
extraction tiers, lifecycle).

PR3 additions: ``PostingSnapshotSet`` aggregate plus its
``PostingContentSnapshot`` value objects, the ``ActiveState`` /
``QuarantineReason`` / ``SnapshotConfidence`` enums, the
``DuplicateEvidence`` / ``ContentDuplicateCandidate`` records, and the
``FilterOverrideAudit`` for policy-compliant overrides. See
``docs/plans/proposed/2026-05-12-job-search-discovery-rfc.md`` §"Domain
Model Additions" and §"Content Acquisition Pipeline".

Public API barrel: aggregate roots, child entities/value objects, and
ports re-exports. Adapters live under
``jobhunter.infrastructure.enrichment``.
"""

from jobhunter.domain.enrichment.aggregate import (
    EnrichmentLifecycle,
    EnrichmentStatus,
    JobEnrichment,
)
from jobhunter.domain.enrichment.entities import (
    AttemptStatus,
    EnrichmentAttempt,
)
from jobhunter.domain.enrichment.snapshot_set import (
    ContentDuplicateCandidate,
    PostingSnapshotSet,
    SnapshotCaptureFailure,
)
from jobhunter.domain.enrichment.snapshot_value_objects import (
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
from jobhunter.domain.enrichment.value_objects import (
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
