"""Job Discovery bounded context — domain layer.

See ddd-target.md §4.1 (Job aggregate, value objects, lifecycle).

Public API barrel: aggregate root, value objects, and the ports owned by
the Discovery context. Adapters live under
``jobctrl.infrastructure.discovery``.
"""

from jobctrl.domain.discovery.aggregate import Job
from jobctrl.domain.discovery.identity import (
    AtsKind,
    CanonicalJobIdentity,
    DuplicateJobLink,
    JobSourceObservation,
    normalize_observed_url,
)
from jobctrl.domain.discovery.value_objects import (
    Employer,
    JobMetadata,
    PostingUrl,
    SearchStrategy,
    Source,
)
from jobctrl.domain.discovery.source_registry import (
    BROAD_BOARD_LEAD_POLICY,
    SMART_EXTRACT_EXPERIMENTAL_POLICY,
    WORKDAY_API_POLICY,
    ContentFilterOverridePolicy,
    LocatorPolicy,
    ManualActionReason,
    ManualActionRequired,
    ManualCaptureMode,
    ManualCaptureProvenance,
    ManualInterventionPolicy,
    RobotsPolicy,
    SourceAuthenticationMode,
    SourceDiscoveryEvidence,
    SourceKind,
    SourceLocationCandidate,
    SourcePolicy,
    SourcePolicyMethod,
    SourcePriority,
    SourceQualityPlaceholder,
    SourceRegistryEntry,
    SourceState,
    validate_locator_candidate,
)
from jobctrl.domain.discovery.scheduler import (
    DiscoveryRun,
    DiscoveryRunCounts,
    DiscoveryRunProgress,
    DiscoveryRunStatus,
    DiscoverySchedule,
    DiscoveryScheduler,
    ScheduledSource,
    SourceQualitySnapshot,
)

__all__ = [
    "Job",
    "AtsKind",
    "CanonicalJobIdentity",
    "DuplicateJobLink",
    "JobSourceObservation",
    "normalize_observed_url",
    "Employer",
    "JobMetadata",
    "PostingUrl",
    "SearchStrategy",
    "Source",
    "BROAD_BOARD_LEAD_POLICY",
    "SMART_EXTRACT_EXPERIMENTAL_POLICY",
    "WORKDAY_API_POLICY",
    "ContentFilterOverridePolicy",
    "LocatorPolicy",
    "ManualActionReason",
    "ManualActionRequired",
    "ManualCaptureMode",
    "ManualCaptureProvenance",
    "ManualInterventionPolicy",
    "RobotsPolicy",
    "SourceAuthenticationMode",
    "SourceDiscoveryEvidence",
    "SourceKind",
    "SourceLocationCandidate",
    "SourcePolicy",
    "SourcePolicyMethod",
    "SourcePriority",
    "SourceQualityPlaceholder",
    "SourceRegistryEntry",
    "SourceState",
    "validate_locator_candidate",
    "DiscoveryRun",
    "DiscoveryRunCounts",
    "DiscoveryRunProgress",
    "DiscoveryRunStatus",
    "DiscoverySchedule",
    "DiscoveryScheduler",
    "ScheduledSource",
    "SourceQualitySnapshot",
]
