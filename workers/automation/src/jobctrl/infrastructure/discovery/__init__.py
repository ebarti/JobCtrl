"""Discovery infrastructure adapters.

See ddd-target.md §5.1 and PR 2 of the Job Search Discovery RFC.

Two adapter families live here:

* ``SqliteJobRepository`` — local-mode persistence for the Discovery
  ``Job`` aggregate, source observations, canonical identity, and
  duplicate links.
* ATS board adapters (``WorkdayBoardAdapter``, ``GreenhouseBoardAdapter``,
  ``LeverBoardAdapter``, ``AshbyBoardAdapter``) — local-mode
  ``JobBoardScraperPort`` implementations for the Tier 1 sources called
  out in the RFC §"Source Hierarchy" table.
"""

from jobctrl.infrastructure.discovery.ats_adapters import (
    AshbyBoardAdapter,
    GreenhouseBoardAdapter,
    HttpFetcher,
    LeverBoardAdapter,
    WorkdayBoardAdapter,
    WorkdayEmployer,
)
from jobctrl.infrastructure.discovery.sqlite_repository import (
    SqliteJobRepository,
)
from jobctrl.infrastructure.discovery.sqlite_execution_repository import (
    SqliteDiscoveryExecutionRepository,
)
from jobctrl.infrastructure.discovery.sqlite_run_repository import (
    SqliteDiscoveryRunRepository,
)
from jobctrl.infrastructure.discovery.production_wiring import (
    DiscoveryAcceptanceReport,
    ManualCaptureImport,
    ManualCaptureImportOutcome,
    SourceControlSeedSummary,
    build_discovery_acceptance_report,
    enqueue_manual_action_for_sources,
    import_manual_capture_item,
    run_scheduled_ats_sources,
    seed_discovery_control_queues,
    seed_source_registry_controls,
)

__all__ = [
    "AshbyBoardAdapter",
    "GreenhouseBoardAdapter",
    "HttpFetcher",
    "LeverBoardAdapter",
    "DiscoveryAcceptanceReport",
    "ManualCaptureImport",
    "ManualCaptureImportOutcome",
    "SourceControlSeedSummary",
    "SqliteDiscoveryRunRepository",
    "SqliteDiscoveryExecutionRepository",
    "SqliteJobRepository",
    "WorkdayBoardAdapter",
    "WorkdayEmployer",
    "build_discovery_acceptance_report",
    "enqueue_manual_action_for_sources",
    "import_manual_capture_item",
    "run_scheduled_ats_sources",
    "seed_discovery_control_queues",
    "seed_source_registry_controls",
]
