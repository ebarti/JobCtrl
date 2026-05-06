"""Read-model projection infrastructure (Phase 9 / S-32).

Adapters that materialise the ``domain/operations/projections`` value
objects into SQLite tables and keep them fresh as domain events flow
through the in-process bus.
"""

from jobhunter.infrastructure.projections.sqlite_projection_store import (
    PROJECTION_TABLES,
    SqliteProjectionStore,
    ensure_projection_tables,
)
from jobhunter.infrastructure.projections.projection_builder import (
    PROJECTION_NAME,
    ProjectionBuilder,
)

__all__ = [
    "PROJECTION_NAME",
    "PROJECTION_TABLES",
    "ProjectionBuilder",
    "SqliteProjectionStore",
    "ensure_projection_tables",
]
