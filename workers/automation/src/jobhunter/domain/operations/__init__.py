"""Operations / Read-Side bounded context — projection types.

Per ddd-target.md §4.8 this context owns no aggregates of its own; it
maintains denormalized read-model projections built from domain events
emitted by every other context.

The projection dataclasses defined under this package are immutable
value objects.  They name the read-model shape that lives in the
``*_projections`` SQLite tables.  Both the ``ProjectionBuilder``
(infrastructure adapter that materialises the projections) and any
consumer (CLI, tests, future hosted read-model API) speak in these
types — never in raw rows.
"""

from jobhunter.domain.operations.projections import (
    ApplyRunProjection,
    ArtifactListProjection,
    DashboardFunnelStage,
    DashboardProjection,
    JobDetailProjection,
    JobListProjection,
    StageProjection,
)
from jobhunter.domain.operations.evidence_map import (
    EvidenceFreshness,
    EvidenceGap,
    EvidenceMapEntry,
    EvidenceReusableStory,
    EvidenceUsageRef,
)

__all__ = [
    "ApplyRunProjection",
    "ArtifactListProjection",
    "DashboardFunnelStage",
    "DashboardProjection",
    "EvidenceFreshness",
    "EvidenceGap",
    "EvidenceMapEntry",
    "EvidenceReusableStory",
    "EvidenceUsageRef",
    "JobDetailProjection",
    "JobListProjection",
    "StageProjection",
]
